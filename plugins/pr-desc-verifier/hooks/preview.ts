// Pure formatting of what the user reviews. No `$`.
import type { Review } from '../types'
import type { PrCommand } from './parse'

export type { Review }

export const MAX_BODY_CHARS = 8_000 // a Text/Markdown string holds 10,000 at most
const MAX_TITLE_IN_QUESTION = 60

/** What the body resolved to once a --body-file was read (or could not be). */
export type BodyText = { text?: string; note?: string }

export function bodyLabel(cmd: PrCommand): string {
  switch (cmd.body.kind) {
    case 'text': return 'inline --body'
    case 'file': return `--body-file ${cmd.body.path}`
    case 'stdin': return cmd.body.text === undefined ? 'stdin' : 'heredoc on stdin'
    case 'fill': return `--${cmd.body.mode}`
    case 'none': return 'none'
  }
}

/** The body as known from the command alone, before any file is read. */
export function inlineBody(cmd: PrCommand): BodyText {
  switch (cmd.body.kind) {
    case 'text': return { text: cmd.body.text }
    case 'stdin':
      return cmd.body.text === undefined
        ? { note: 'Body is read from stdin and cannot be shown.' }
        : { text: cmd.body.text }
    case 'fill': return { note: 'Body auto-filled from the commits on the branch.' }
    case 'none':
      return { note: cmd.subcommand === 'edit' ? 'Body unchanged.' : 'No body given.' }
    case 'file': return {} // the caller reads it
  }
}

export function buildReview(cmd: PrCommand, body: BodyText): Review {
  const verb = cmd.subcommand === 'edit' ? `edit${cmd.target ? ` #${cmd.target.replace(/^#/, '')}` : ''}` : 'create'
  const title =
    cmd.title ??
    (cmd.fill ? '(auto-filled from commits)' : cmd.subcommand === 'edit' ? '(title unchanged)' : '(no title)')
  const meta: string[] = []
  if (cmd.base || cmd.head) meta.push(`${cmd.base ?? 'default branch'} ← ${cmd.head ?? 'current branch'}`)
  if (cmd.draft) meta.push('draft')
  if (cmd.reviewers.length) meta.push(`reviewers: ${cmd.reviewers.join(', ')}`)
  if (cmd.labels.length) meta.push(`labels: ${cmd.labels.join(', ')}`)
  if (cmd.assignees.length) meta.push(`assignees: ${cmd.assignees.join(', ')}`)
  if (cmd.body.kind !== 'text' && cmd.body.kind !== 'none') meta.push(`body from ${bodyLabel(cmd)}`)

  const notes: string[] = []
  if (cmd.isDynamic) notes.push('Contains shell expansions ($VAR, $(...)), shown as written.')
  let text = body.text ?? `_${body.note ?? 'Body unknown.'}_`
  if (text.length > MAX_BODY_CHARS) {
    notes.push(`Body truncated: showing ${MAX_BODY_CHARS} of ${text.length} characters.`)
    text = text.slice(0, MAX_BODY_CHARS) + '\n…'
  }
  if (!text.trim()) text = '_(empty body)_'

  const short = title.length > MAX_TITLE_IN_QUESTION ? title.slice(0, MAX_TITLE_IN_QUESTION - 1) + '…' : title
  return {
    question: `${cmd.subcommand === 'edit' ? 'Update' : 'Open'} PR "${short}" with this description?`,
    heading: `gh pr ${verb}${cmd.repo ? ` → ${cmd.repo}` : ''}`,
    title,
    meta,
    body: text,
    notes,
  }
}

export type SummaryLine = { kind: 'heading' | 'title' | 'meta' | 'note' | 'body' | 'dim'; text: string }

// The engine budgets the rows drawn around its dialog by estimate: each Text costs one row
// plus one per CHARS_PER_ROW characters, whatever the window's width.
export const CHARS_PER_ROW = 40
const LINE_CHARS = 2 * CHARS_PER_ROW - 1 // a long line costs two rows at most
const WIDEN_HINT = '(widen the terminal to 144+ columns for the full text)'

export const rowCost = (text: string) => 1 + Math.floor(text.length / CHARS_PER_ROW)

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

/** The review as one-line rows whose estimated cost fits `budget`: what goes above the dialog. */
export function summaryLines(r: Review, budget: number): SummaryLine[] {
  const raw: SummaryLine[] = [
    { kind: 'heading', text: r.heading },
    { kind: 'title', text: r.title },
    ...(r.meta.length ? [{ kind: 'meta' as const, text: r.meta.join(' · ') }] : []),
    ...r.notes.map(text => ({ kind: 'note' as const, text: `⚠ ${text}` })),
    ...r.body
      .split('\n')
      .filter(l => l.trim())
      .map(l => ({ kind: 'body' as const, text: l.replace(/^_(.*)_$/, '$1') })), // a note's italics
  ]
  const lines = raw.map(l => ({ ...l, text: clip(l.text, LINE_CHARS) }))
  const out: SummaryLine[] = []
  let used = 0
  for (const [i, line] of lines.entries()) {
    const n = lines.length - i
    const more = `… ${n} more line${n === 1 ? '' : 's'} ${r.isPaneHidden ? WIDEN_HINT : 'in the PR review pane'}`
    const isLast = i === lines.length - 1
    if (used + rowCost(line.text) + (isLast ? 0 : rowCost(more)) > budget) {
      out.push({ kind: 'dim', text: more })
      break
    }
    out.push(line)
    used += rowCost(line.text)
  }
  return out
}

/** The whole review as one markdown document. */
export function reviewMarkdown(r: Review): string {
  return [
    `**${r.heading}**`,
    `# ${r.title}`,
    ...(r.meta.length ? [r.meta.join(' · ')] : []),
    ...r.notes.map(n => `> ⚠ ${n}`),
    '---',
    r.body,
  ].join('\n\n')
}

export const APPROVE = 'Approve'
export const REJECT = 'Reject'

/** What Claude reads when the user does not approve. */
export function denyText(answer: string | undefined): string {
  const who = 'pr-desc-verifier: '
  if (answer === undefined)
    return (
      who +
      'this PR title/description needs the user\'s approval, and the approval dialog was dismissed or cannot be shown in this session. ' +
      'Do not retry it unchanged; ask the user how they want to proceed.'
    )
  if (answer === REJECT)
    return (
      who +
      'the user rejected this PR title/description. Do not run it again unchanged: ask the user what to change, revise, then run the command again.'
    )
  return (
    who +
    `the user rejected this PR title/description with this feedback: "${answer}". ` +
    'Revise the title/description to address it, then run the command again for a new review.'
  )
}
