// Pure helpers: parsing git's porcelain output and formatting. No `$` here.
import type { Worktree } from '../types'

// Records of `git worktree list --porcelain`, separated by blank lines.
export function parseWorktreeList(stdout: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of stdout.split(/\n\s*\n/)) {
    let wt: Worktree | undefined
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ')
      const word = sp < 0 ? line : line.slice(0, sp)
      const rest = sp < 0 ? '' : line.slice(sp + 1)
      if (word === 'worktree') wt = { path: rest, isDetached: false, isBare: false }
      else if (!wt) continue
      else if (word === 'HEAD') wt.head = rest
      else if (word === 'branch') wt.branch = rest.replace(/^refs\/heads\//, '')
      else if (word === 'detached') wt.isDetached = true
      else if (word === 'bare') wt.isBare = true
      else if (word === 'locked') wt.locked = rest
      else if (word === 'prunable') wt.prunable = rest
    }
    if (wt) out.push(wt)
  }
  return out
}

// `git status --porcelain=v2 --branch`: `#` lines are headers, every other line one entry.
export function parseStatus(stdout: string) {
  let dirty = 0
  let ab: RegExpMatchArray | null = null
  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.ab ')) ab = line.match(/\+(\d+) -(\d+)/)
    else if (!line.startsWith('#')) dirty++
  }
  return ab
    ? { dirty, hasUpstream: true, ahead: Number(ab[1]), behind: Number(ab[2]) }
    : { dirty, hasUpstream: false }
}

// `git log -1 --format=%ct%x00%s`.
export function parseLastCommit(stdout: string) {
  const [ct = '', subject = ''] = stdout.replace(/\n$/, '').split('\0')
  const commitAt = Number(ct)
  return Number.isFinite(commitAt) && ct ? { commitAt, subject } : {}
}

export function age(epochSeconds: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - epochSeconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

// Runs `fn` over `items`, at most `limit` at a time, keeping order.
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}
