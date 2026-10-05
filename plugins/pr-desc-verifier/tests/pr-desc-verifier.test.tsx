import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CHARS_PER_ROW, buildReview, rowCost, summaryLines } from '../hooks/preview'
import { findPrCommands } from '../hooks/parse'
import type { PrCommand } from '../hooks/parse'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

const CREATE = 'gh pr create --title "Add retry" --body "## Summary\nRetries login." --base main -r alice'
const BODY_FILE = 'gh pr create -t "From file" --body-file pr.md'

type Asked = { question: string; summary: string[]; pane: string[] }

// What the engine hands a render hook for its own dialog: a reference the hook must keep.
const ENGINE_DIALOG = { type: 'engine', ref: 1 } as never

// Fakes the engine: answers the dialog with `answers` in turn (a label, typed feedback, or
// null for a dismissal), runs Bash as `ran`, and reads files from `files`. While each
// question is open it draws the dialog and the pane on `surface`, so tests can see them.
function fake(
  $: Engine,
  on: On,
  opts: { answers: (string | null)[]; files?: Record<string, string>; surface?: Surface; narrow?: boolean },
) {
  const asked: Asked[] = []
  const ran: string[] = []
  const panes: string[] = []
  const surface = opts.surface ?? 'terminal'
  on('ui.open', ($, e) => {
    panes.push(`open ${e.id}`)
    return opts.narrow
      ? { value: { isPlaced: false as const, reason: 'opened unasked under 144 columns (100 now)' } }
      : { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('ui.render', () => ENGINE_DIALOG)
  on('fs.read', ($, e) => {
    const hit = Object.entries(opts.files ?? {}).find(([p]) => e.path.endsWith(p))
    return hit ? { value: hit[1] } : { deny: `ENOENT: no such file or directory, open '${e.path}'` }
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') {
      ran.push(String(e.command))
      return { result: 'https://github.com/o/r/pull/1' }
    }
    if (e.tool !== 'AskUserQuestion') throw new Error(`unexpected tool ${e.tool}`)
    const q = e.questions[0] as { question: string; header: string }
    const dialog = await $.ui.mount({
      plugin: 'pr-desc-verifier', surface, component: 'AskUserQuestion', requestId: 'toolu_q',
      props: { tool: 'AskUserQuestion', questions: [{ ...q, options: [], multiSelect: false }] } as never,
    })
    const box = await dialog.find({ key: 'pr-summary' })
    const pane = await $.ui.mount({
      plugin: 'pr-desc-verifier', surface, component: 'Pane', requestId: 'pr-desc-verifier',
      props: { title: 'PR review', isFocused: false } as never,
    })
    const md = await pane.find({ type: 'Markdown' })
    asked.push({ question: q.question, summary: texts(box), pane: md ? [String((md.props as { text: string }).text)] : [] })
    await dialog.unmount()
    await pane.unmount()
    const answer = opts.answers[asked.length - 1]
    if (answer === null || answer === undefined) return { deny: 'The user dismissed the question' }
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  })
  return { asked, ran, panes }
}

type Node = { children?: unknown[] } | string | undefined
function texts(node: Node): string[] {
  if (node === undefined) return []
  if (typeof node === 'string') return [node]
  return (node.children ?? []).flatMap(c => texts(c as Node)).filter(Boolean)
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)

// ---------------------------------------------------------------- the flow

test('approve: the command runs after the user approves', async ($, on) => {
  const f = fake($, on, { answers: ['Approve'] })
  const out = await bash($, CREATE)
  expect(out.deny).toBeUndefined()
  expect(f.ran).toEqual([CREATE])
  expect(f.asked.map(a => a.question)).toEqual(['Open PR "Add retry" with this description?'])
  expect(f.panes).toEqual(['open pr-desc-verifier', 'close pr-desc-verifier'])
})

test('reject: the command is denied and does not run', async ($, on) => {
  const f = fake($, on, { answers: ['Reject'] })
  const out = await bash($, CREATE)
  expect(out.deny).toMatch(/rejected this PR title\/description\. Do not run it again unchanged/)
  expect(f.ran).toEqual([])
})

test('typed feedback reaches Claude in the deny', async ($, on) => {
  const f = fake($, on, { answers: ['Mention the ticket number'] })
  const out = await bash($, CREATE)
  expect(out.deny).toMatch(/with this feedback: "Mention the ticket number"/)
  expect(f.ran).toEqual([])
})

test('a dismissed dialog, or a -p run with nobody to ask, denies', async ($, on) => {
  const f = fake($, on, { answers: [null] })
  const out = await bash($, CREATE)
  expect(out.deny).toMatch(/dismissed or cannot be shown/)
  expect(f.ran).toEqual([])
  expect(f.panes).toEqual(['open pr-desc-verifier', 'close pr-desc-verifier'])
})

test('deny, revise, approve: the revised command runs; approvals are single-use', async ($, on) => {
  const f = fake($, on, { answers: ['Add a test plan', 'Approve', 'Reject'] })
  expect((await bash($, CREATE)).deny).toMatch(/Add a test plan/)
  const revised = CREATE.replace('Retries login.', 'Retries login.\n## Test plan\n- unit')
  expect((await bash($, revised)).deny).toBeUndefined()
  expect(f.asked[1]?.pane[0]).toMatch(/## Test plan/)
  // The identical command again: asked again, not waved through on the old approval.
  expect((await bash($, revised)).deny).toMatch(/rejected/)
  expect(f.asked.length).toBe(3)
  expect(f.ran).toEqual([revised])
})

test('a chain with two PR commands asks for each, and stops at the first rejection', async ($, on) => {
  const f = fake($, on, { answers: ['Approve', 'Reject'] })
  const out = await bash($, 'gh pr create -t One -b a && gh pr edit 7 -t Two')
  expect(out.deny).toMatch(/rejected/)
  expect(f.asked.map(a => a.question)).toEqual([
    'Open PR "One" with this description?',
    'Update PR "Two" with this description?',
  ])
  expect(f.ran).toEqual([])
})

test('other commands pass without a question', async ($, on) => {
  const f = fake($, on, { answers: [] })
  for (const cmd of ['ls', 'gh pr view 3', 'gh pr edit 3 --add-label bug', 'gh pr create -t T -b B --dry-run'])
    expect((await bash($, cmd)).deny).toBeUndefined()
  expect(f.asked).toEqual([])
  expect(f.ran.length).toBe(4)
})

// ------------------------------------------------------------ what is shown

for (const surface of SURFACES) {
  test(`the dialog shows a summary and the pane the full description on ${surface}`, async ($, on) => {
    const f = fake($, on, { answers: ['Approve'], surface })
    await bash($, CREATE + ' -l bug --draft')
    const [a] = f.asked
    expect(a?.summary).toEqual([
      'gh pr create',
      'Add retry',
      'main ← current branch · draft · reviewers: alice · labels: bug',
      '## Summary',
      'Retries login.',
    ])
    expect(a?.pane[0]).toMatch(/^\*\*gh pr create\*\*\n\n# Add retry\n\n.*\n\n---\n\n## Summary\nRetries login\.$/)
  })

  test(`a long body is cut in the dialog and whole in the pane on ${surface}`, async ($, on) => {
    const long = Array.from({ length: 30 }, (_, i) => `- item ${i}`).join('\\n')
    const wide = fake($, on, { answers: ['Approve'], surface })
    await bash($, `gh pr create -t T -b $'${long}'`)
    expect(wide.asked[0]?.summary.at(-1)).toMatch(/^… \d+ more lines in the PR review pane$/)
    expect(wide.asked[0]?.pane[0]).toMatch(/- item 29$/)
  })

  test(`a narrow terminal is told to widen on ${surface}`, async ($, on) => {
    const long = Array.from({ length: 30 }, (_, i) => `- item ${i}`).join('\\n')
    const f = fake($, on, { answers: ['Approve'], surface, narrow: true })
    await bash($, `gh pr create -t T -b $'${long}'`)
    expect(f.asked[0]?.summary.at(-1)).toMatch(/more lines \(widen the terminal to 144\+ columns/)
  })

  test(`--body-file is read and shown on ${surface}`, async ($, on) => {
    const f = fake($, on, { answers: ['Approve'], surface, files: { 'pr.md': '## From the file\nDetails.' } })
    await bash($, BODY_FILE)
    expect(f.asked[0]?.summary).toContain('## From the file')
    expect(f.asked[0]?.summary).toContain('body from --body-file pr.md')
    expect(f.asked[0]?.pane[0]).toMatch(/## From the file\nDetails\./)
  })

  test(`a missing --body-file is flagged, and the user still decides, on ${surface}`, async ($, on) => {
    const f = fake($, on, { answers: ['Reject'], surface })
    expect((await bash($, BODY_FILE)).deny).toMatch(/rejected/)
    expect(f.asked[0]?.summary.join('\n')).toMatch(/Could not read body file pr\.md: .*ENOENT/)
  })

  test(`--fill shows that the body is auto-filled on ${surface}`, async ($, on) => {
    const f = fake($, on, { answers: ['Approve'], surface })
    await bash($, 'gh pr create --fill --base main')
    expect(f.asked[0]?.summary).toContain('(auto-filled from commits)')
    expect(f.asked[0]?.summary).toContain('Body auto-filled from the commits on the branch.')
  })
}

test('the dialog is left alone when no review is pending', async ($, on) => {
  on('ui.render', () => ENGINE_DIALOG)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'pr-desc-verifier', surface, component: 'AskUserQuestion', requestId: 'toolu_x',
      props: { tool: 'AskUserQuestion', questions: [{ question: 'Which library?', header: 'Lib', options: [], multiSelect: false }] } as never,
    })
    expect(await ui.find({ key: 'pr-summary' })).toBeUndefined()
    expect(await ui.find({ type: 'Box' })).toBeUndefined() // nothing of the mod's around it
  }
})

// ---------------------------------------------------------------- settings

test('guardCreate off: gh pr create passes; edits still ask', { options: { guardCreate: false } }, async ($, on) => {
  const f = fake($, on, { answers: ['Reject'] })
  expect((await bash($, CREATE)).deny).toBeUndefined()
  expect((await bash($, 'gh pr edit 3 -b new')).deny).toMatch(/rejected/)
  expect(f.ran).toEqual([CREATE])
})

test('guardEdit off: gh pr edit passes', { options: { guardEdit: false } }, async ($, on) => {
  const f = fake($, on, { answers: [] })
  expect((await bash($, 'gh pr edit 3 -t New -b new')).deny).toBeUndefined()
  expect(f.asked).toEqual([])
})

test('guardFill off: a fully auto-filled PR passes, one with a written title still asks', { options: { guardFill: false } }, async ($, on) => {
  const f = fake($, on, { answers: ['Approve'] })
  await bash($, 'gh pr create --fill')
  expect(f.asked).toEqual([])
  await bash($, 'gh pr create --fill --title Mine')
  expect(f.asked.length).toBe(1)
})

test('--fill asks by default', async ($, on) => {
  const f = fake($, on, { answers: ['Approve'] })
  await bash($, 'gh pr create --fill-first')
  expect(f.asked.length).toBe(1)
})

test('exemptDrafts: drafts pass, ready PRs still ask', { options: { exemptDrafts: true } }, async ($, on) => {
  const f = fake($, on, { answers: ['Approve'] })
  await bash($, 'gh pr create -t T -b B --draft')
  expect(f.asked).toEqual([])
  await bash($, 'gh pr create -t T -b B')
  expect(f.asked.length).toBe(1)
})

// ------------------------------------------------------------ pure helpers

const review = (cmd: string, body = {}) => buildReview(findPrCommands(cmd)[0] as PrCommand, body)

test('the summary fits the engine\'s 10-row budget, however long the body', () => {
  const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(i * 3)}`).join('\n')
  const lines = summaryLines(review('gh pr create -t T', { text: long }), 10)
  expect(lines.reduce((n, l) => n + rowCost(l.text), 0) <= 10).toBe(true)
  expect(lines.at(-1)?.text).toMatch(/more lines in the PR review pane/)
  expect(lines.every(l => l.text.length < 2 * CHARS_PER_ROW)).toBe(true)
})

test('a long body is truncated with a note; long titles are shortened in the question', () => {
  const r = review(`gh pr create -t "${'T'.repeat(80)}"`, { text: 'y'.repeat(9000) })
  expect(r.notes).toContain('Body truncated: showing 8000 of 9000 characters.')
  expect(r.question).toBe(`Open PR "${'T'.repeat(59)}…" with this description?`)
})
