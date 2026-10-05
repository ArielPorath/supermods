import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { mapBounded, parseLastCommit, parseStatus, parseWorktreeList, shellQuote } from '../hooks/git'

type Run = { exitCode: number; stdout?: string; stderr?: string }
const result = ({ exitCode, stdout = '', stderr = '' }: Run) => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const NOW_MS = 1_800_000_000_000
const SHA = 'c655a2e3187a782f7b9cc2a4a6afe9383c7b63f4'
const LIST = [
  `worktree /repo\nHEAD ${SHA}\nbranch refs/heads/main\n`,
  `worktree /wt/feat\nHEAD ${SHA}\nbranch refs/heads/feat\n`,
  `worktree /wt/det\nHEAD ${SHA}\ndetached\n`,
  `worktree /wt/gone\nHEAD ${SHA}\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n`,
  `worktree /wt/usb\nHEAD ${SHA}\nbranch refs/heads/lk\nlocked on usb\n`,
  `worktree /wt/vanished\nHEAD ${SHA}\nbranch refs/heads/v\n`,
].join('\n')

const STATUS: Record<string, string> = {
  '/repo': '# branch.oid x\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n',
  '/wt/feat': '# branch.head feat\n# branch.upstream origin/feat\n# branch.ab +2 -1\n1 .M N... a\n? b.txt\n? c.txt\n',
  '/wt/det': '# branch.head (detached)\n',
  '/wt/usb': '# branch.head lk\n',
}
const commit = (agoSec: number, subject: string) => `${NOW_MS / 1000 - agoSec}\0${subject}\n`

// A fake git: answers each argv the mod runs; `calls` records them.
function fakeGit(on: On, over: { list?: Run; top?: Run; throws?: string } = {}) {
  const calls: string[][] = []
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (over.throws) return { deny: over.throws }
    const args = argv.slice(2) // drop 'git', '--no-optional-locks'
    if (args[0] === 'worktree') return result(over.list ?? { exitCode: 0, stdout: LIST })
    if (args[0] === 'rev-parse') return result(over.top ?? { exitCode: 0, stdout: '/wt/feat\n' })
    const path = args[1] ?? ''
    if (args[2] === 'status') {
      const out = STATUS[path]
      return result(
        out === undefined
          ? { exitCode: 128, stderr: `fatal: cannot change to '${path}': No such file or directory` }
          : { exitCode: 0, stdout: out },
      )
    }
    if (path === '/wt/usb') return result({ exitCode: 128, stderr: 'fatal: your current branch has no commits' })
    return result({ exitCode: 0, stdout: commit(path === '/wt/feat' ? 7200 : 3 * 86_400, `work on ${path}`) })
  })
  return calls
}

async function openPane($: Engine, on: On, surface: 'terminal' | 'desktop') {
  const clock = mock.clock(on, { now: NOW_MS })
  const pane = { isOpen: true }
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', async () => ({
    value: pane.isOpen
      ? [{ id: 'worktrees', title: 'Worktrees', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }) as never)
  on('session.cwd', async () => ({ value: '/home/me/notes' }))
  await $.command.run({ command: 'worktrees', args: '' } as never)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'worktrees', surface, component: 'Pane',
    props: { title: 'Worktrees', isFocused: false } as never, requestId: 'worktrees',
  })
  return { ui, clock, pane }
}

test('parses porcelain: branch, detached, bare, locked (with and without reason), prunable', async () => {
  const wts = parseWorktreeList(
    LIST + '\nworktree /bare.git\nbare\n\nworktree /wt/l2\nHEAD abc\nbranch refs/heads/x\nlocked\n',
  )
  expect(wts.length).toBe(8)
  expect(wts[0]).toEqual({ path: '/repo', head: SHA, branch: 'main', isDetached: false, isBare: false })
  expect(wts[2]?.isDetached).toBe(true)
  expect(wts[2]?.branch).toBeUndefined()
  expect(wts[3]?.prunable).toBe('gitdir file points to non-existent location')
  expect(wts[4]?.locked).toBe('on usb')
  expect(wts[6]).toEqual({ path: '/bare.git', isDetached: false, isBare: true })
  expect(wts[7]?.locked).toBe('')
  expect(parseWorktreeList('')).toEqual([])
})

test('parses status, last commit, and quotes paths', async () => {
  expect(parseStatus(STATUS['/wt/feat'] ?? '')).toEqual({ dirty: 3, hasUpstream: true, ahead: 2, behind: 1 })
  expect(parseStatus('# branch.head x\n')).toEqual({ dirty: 0, hasUpstream: false })
  expect(parseLastCommit('1700000000\0fix: a\0b\n')).toEqual({ commitAt: 1700000000, subject: 'fix: a' })
  expect(parseLastCommit('')).toEqual({})
  expect(shellQuote('/a/b-c')).toBe('/a/b-c')
  expect(shellQuote("/my dir/it's")).toBe(`'/my dir/it'\\''s'`)
})

test('mapBounded keeps order and never exceeds the limit', async () => {
  let active = 0
  let peak = 0
  const out = await mapBounded([1, 2, 3, 4, 5], 2, async n => {
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    return n * 10
  })
  expect(out).toEqual([10, 20, 30, 40, 50])
  expect(peak).toBe(2)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`lists every worktree with its state on ${surface}`, async ($, on) => {
    fakeGit(on)
    const { ui } = await openPane($, on, surface)
    expect(await ui.find({ text: /6 worktrees/ })).toBeDefined()
    expect(await ui.find({ text: /main.*clean/ })).toBeDefined()
    expect(await ui.find({ text: /● .*feat.*3 changed.*↑2 ↓1.*2h work on \/wt\/feat/ })).toBeDefined()
    expect(await ui.find({ text: /detached c655a2e.*clean.*3d/ })).toBeDefined()
    expect(await ui.find({ text: /gone.*\[prunable\]/ })).toBeDefined()
    expect(await ui.find({ text: /lk.*\[locked: on usb\].*no upstream/ })).toBeDefined()
    expect(await ui.find({ text: /v.*path no longer exists/ })).toBeDefined()
    expect(await ui.find({ text: /every 15s/ })).toBeDefined()
    // no row button where the path is gone (prunable, vanished)
    expect(await ui.find({ key: 'row:3' })).toBeUndefined()
    expect(await ui.find({ key: 'row:5' })).toBeUndefined()
    expect(await ui.find({ key: 'row:4' })).toBeDefined()
  })

  test(`shows a message outside a git repo on ${surface}`, async ($, on) => {
    fakeGit(on, { list: { exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' } })
    const { ui } = await openPane($, on, surface)
    expect(await ui.find({ text: /Not a git repository: \/home\/me\/notes/ })).toBeDefined()
    expect(await ui.find({ text: /0 worktrees/ })).toBeDefined()
  })

  test(`a bare main repo is listed without git calls or a row button on ${surface}`, async ($, on) => {
    const calls = fakeGit(on, {
      list: { exitCode: 0, stdout: `worktree /bare.git\nbare\n\nworktree /wt/feat\nHEAD ${SHA}\nbranch refs/heads/feat\n` },
      top: { exitCode: 128, stderr: 'fatal: this operation must be run in a work tree' },
    })
    const { ui } = await openPane($, on, surface)
    expect(await ui.find({ text: /\(bare\)/ })).toBeDefined()
    expect(await ui.find({ text: /●/ })).toBeUndefined()
    expect(await ui.find({ key: 'row:0' })).toBeUndefined()
    expect(await ui.find({ key: 'row:1' })).toBeDefined()
    expect(calls.some(c => c[3] === '/bare.git')).toBe(false)
  })

  test(`shows a message when git is missing on ${surface}`, async ($, on) => {
    fakeGit(on, { throws: 'spawn git ENOENT' })
    const { ui } = await openPane($, on, surface)
    expect(await ui.find({ text: /git could not run.*ENOENT/ })).toBeDefined()
  })

  test(`Refresh re-runs git, the interval polls, and it stops once the pane is closed on ${surface}`, async ($, on) => {
    const calls = fakeGit(on)
    const { ui, clock, pane } = await openPane($, on, surface)
    const lists = () => calls.filter(c => c[2] === 'worktree').length
    expect(lists()).toBe(1)
    await ui.press({ key: 'refresh' })
    expect(lists()).toBe(2)
    await clock.advance(15_000)
    expect(lists()).toBe(3)
    pane.isOpen = false // the person closed it
    await clock.advance(15_000)
    await clock.advance(60_000)
    expect(lists()).toBe(3)
  })

  test(`the copy button copies the worktree path on ${surface}`, async ($, on) => {
    fakeGit(on)
    const copied: string[] = []
    on('ui.copy', async ($, e) => {
      copied.push(e.text)
      return { value: { isCopied: true as const } }
    })
    const { ui } = await openPane($, on, surface)
    expect((await ui.find({ key: 'row:1' }))?.text).toBe('copy')
    await ui.press({ key: 'row:1' })
    expect(copied).toEqual(['/wt/feat'])
  })
}

test('row_action insert-cd fills `cd <path>` into the prompt', { options: { row_action: 'insert-cd' } }, async ($, on) => {
  fakeGit(on)
  const filled: string[] = []
  on('prompt.fill', async ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  const { ui } = await openPane($, on, 'terminal')
  await ui.press({ key: 'row:0' })
  expect(filled).toEqual(['cd /repo'])
})

test('row_action none draws no row buttons', { options: { row_action: 'none' } }, async ($, on) => {
  fakeGit(on)
  const { ui } = await openPane($, on, 'desktop')
  expect(await ui.find({ key: 'row:0' })).toBeUndefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
})

test('refresh_seconds 0 turns the interval off', { options: { refresh_seconds: 0 } }, async ($, on) => {
  const calls = fakeGit(on)
  const { ui, clock } = await openPane($, on, 'terminal')
  await clock.advance(120_000)
  expect(calls.filter(c => c[2] === 'worktree').length).toBe(1)
  expect(await ui.find({ text: /auto-refresh off/ })).toBeDefined()
})

test('refresh_seconds sets the interval', { options: { refresh_seconds: 5 } }, async ($, on) => {
  const calls = fakeGit(on)
  const { ui, clock } = await openPane($, on, 'terminal')
  await clock.advance(5_000)
  expect(calls.filter(c => c[2] === 'worktree').length).toBe(2)
  expect(await ui.find({ text: /every 5s/ })).toBeDefined()
})

test('max_parallel bounds concurrent worktree checks', { options: { max_parallel: 1 } }, async ($, on) => {
  let active = 0
  let peak = 0
  const clock = mock.clock(on, { now: NOW_MS })
  on('process.run', async ($, e) => {
    const args = e.argv.slice(2)
    if (args[0] === 'worktree') return result({ exitCode: 0, stdout: LIST })
    if (args[0] === 'rev-parse') return result({ exitCode: 0, stdout: '/repo\n' })
    if (args[2] !== 'status') return result({ exitCode: 0, stdout: commit(60, 's') })
    peak = Math.max(peak, ++active)
    await clock.sleep(10)
    active--
    return result({ exitCode: 0, stdout: '# branch.head x\n' })
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'worktrees', args: '' } as never)
  for (let i = 0; i < 10; i++) await clock.advance(10)
  expect(peak).toBe(1)
})
