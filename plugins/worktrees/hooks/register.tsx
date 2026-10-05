import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Snapshot, Worktree, WorktreeInfo } from '../types'
import { age, mapBounded, parseLastCommit, parseStatus, parseWorktreeList, shellQuote } from './git'

const PANE = 'worktrees'
const GIT_TIMEOUT_MS = 15_000
const ROW_ACTIONS = ['copy-path', 'insert-cd', 'none'] as const
type RowAction = (typeof ROW_ACTIONS)[number]

const snapshot = atom({ plugin: 'worktrees', key: 'snapshot' } as const, { worktrees: [] } as Snapshot)

let timer: Timer | undefined
let inFlight = false
let refreshMs = 15_000
let maxParallel = 4
let rowAction: RowAction = 'copy-path'

const lastLine = (stderr: string, exitCode: number) =>
  stderr.trim().split('\n').pop() || `exit ${exitCode}`
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// --no-optional-locks: a background status must not take index.lock from the user's own git.
const git = ($: EngineInterface, args: string[]) =>
  $.process.run(['git', '--no-optional-locks', ...args], { timeoutMs: GIT_TIMEOUT_MS })

async function inspect($: EngineInterface, wt: Worktree, current: string): Promise<WorktreeInfo> {
  const info: WorktreeInfo = { ...wt, isCurrent: wt.path === current }
  if (wt.isBare || wt.prunable !== undefined) return info
  try {
    const [st, log] = await Promise.all([
      git($, ['-C', wt.path, 'status', '--porcelain=v2', '--branch']),
      git($, ['-C', wt.path, 'log', '-1', '--format=%ct%x00%s']),
    ])
    if (st.exitCode !== 0) {
      const gone = /cannot change to/.test(st.stderr)
      return { ...info, error: gone ? 'path no longer exists' : lastLine(st.stderr, st.exitCode) }
    }
    // A worktree on an unborn branch has no commit: log fails, which is not an error here.
    return { ...info, ...parseStatus(st.stdout), ...(log.exitCode === 0 ? parseLastCommit(log.stdout) : {}) }
  } catch (err) {
    return { ...info, error: message(err) }
  }
}

async function listWorktrees($: EngineInterface): Promise<Pick<Snapshot, 'worktrees' | 'error'>> {
  try {
    const [list, top] = await Promise.all([
      git($, ['worktree', 'list', '--porcelain']),
      git($, ['rev-parse', '--show-toplevel']), // fails in a bare repo: then nothing is "current"
    ])
    if (list.exitCode !== 0) {
      const error = /not a git repository/.test(list.stderr)
        ? `Not a git repository: ${await $.session.cwd()}`
        : lastLine(list.stderr, list.exitCode)
      return { worktrees: [], error }
    }
    const current = top.exitCode === 0 ? top.stdout.trim() : ''
    const found = parseWorktreeList(list.stdout)
    return { worktrees: await mapBounded(found, maxParallel, wt => inspect($, wt, current)) }
  } catch (err) {
    // process.run rejects when the command cannot start at all.
    return { worktrees: [], error: `git could not run (is it installed and on PATH?): ${message(err)}` }
  }
}

async function refresh($: EngineInterface) {
  if (inFlight) return
  inFlight = true
  try {
    await update($, snapshot, s => ({ ...s, isLoading: true }))
    const next = await listWorktrees($)
    const checkedAt = await $.clock.now()
    await update($, snapshot, () => ({ ...next, checkedAt }))
  } finally {
    inFlight = false
  }
}

function stopPolling() {
  timer?.cancel()
  timer = undefined
}

// Refreshes while the pane is open. `ui.close` stops it at once; the pane check on each
// tick also stops it should a close go unheard (e.g. across a reload).
function startPolling($: EngineInterface) {
  stopPolling()
  void refresh($)
  if (refreshMs <= 0) return
  timer = $.clock.every(refreshMs, async () => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) await refresh($)
    else stopPolling()
  })
}

function label(w: WorktreeInfo): string {
  if (w.isBare) return '(bare)'
  if (w.branch) return w.branch
  return `detached ${w.head?.slice(0, 7) ?? ''}`.trim()
}

function clampNumber(v: unknown, fallback: number, min: number, max: number) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export const register: Register = (on, options) => {
  refreshMs = clampNumber(options.refresh_seconds, 15, 0, 3600) * 1000
  maxParallel = Math.floor(clampNumber(options.max_parallel, 4, 1, 16))
  const action = String(options.row_action ?? '')
  rowAction = ROW_ACTIONS.find(a => a === action) ?? 'copy-path'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'worktrees', description: "Show this repo's git worktrees in a pane" })
    // A reload (settings change, new version) drops timers but keeps the pane: resume.
    if ((await $.ui.panes()).some(p => p.id === PANE)) startPolling($)
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Worktrees' })
    startPolling($)
    return { text: 'Worktrees pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { worktrees, error, checkedAt, isLoading } = await read($, snapshot)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 4) / 2))

    const act = async (w: WorktreeInfo, surface: typeof e.surface) => {
      if (rowAction === 'copy-path') {
        const r = await $.ui.copy({ text: w.path, surface })
        $.ui.toast(r.isCopied ? `Copied ${w.path}` : `Could not copy (${r.reason})`)
      } else {
        const r = await $.prompt.fill({ text: `cd ${shellQuote(w.path)}`, mode: 'insert' })
        if (!r.isFilled) $.ui.toast('Could not insert into the prompt')
      }
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>
            {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}
          </Text>
          <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>
            Refresh
          </Button>
        </Box>
        {error && <Text color="red">{error}</Text>}
        {checkedAt === undefined && <Text dimColor>Checking…</Text>}
        {worktrees.slice(0, room).map((w, i) => (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color="green">{w.isCurrent ? '● ' : '  '}</Text>
              <Text bold={w.isCurrent}>{label(w)}</Text>
              {w.locked !== undefined && <Text color="yellow"> [locked{w.locked ? `: ${w.locked}` : ''}]</Text>}
              {w.prunable !== undefined && <Text color="red"> [prunable]</Text>}
              {w.error && <Text color="red"> {w.error}</Text>}
              {w.dirty !== undefined &&
                (w.dirty > 0 ? <Text color="yellow"> {w.dirty} changed</Text> : <Text color="green"> clean</Text>)}
              {w.hasUpstream && (w.ahead || w.behind) ? <Text color="cyan"> ↑{w.ahead} ↓{w.behind}</Text> : null}
              {w.hasUpstream === false && w.branch && <Text dimColor> no upstream</Text>}
              {w.commitAt !== undefined && <Text dimColor> {age(w.commitAt, checkedAt ?? 0)} {w.subject}</Text>}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Text dimColor wrap="truncate-start">  {w.path}</Text>
              {rowAction !== 'none' && !w.isBare && w.prunable === undefined && !w.error && (
                <Button key={`row:${i}`} dimColor onPress={press => void act(w, press.surface)}>
                  {rowAction === 'copy-path' ? 'copy' : 'cd'}
                </Button>
              )}
            </Box>
          </Box>
        ))}
        {worktrees.length > room && <Text dimColor>…and {worktrees.length - room} more</Text>}
        {checkedAt !== undefined && (
          <Text dimColor>
            {isLoading ? 'refreshing…' : `updated ${new Date(checkedAt).toLocaleTimeString()}`}
            {refreshMs > 0 ? ` · every ${refreshMs / 1000}s` : ' · auto-refresh off'}
          </Text>
        )}
      </Box>
    )
  })
}
