// One record of `git worktree list --porcelain`.
export type Worktree = {
  path: string
  head?: string // commit SHA; absent for a bare repo
  branch?: string // short name, absent when detached or bare
  isDetached: boolean
  isBare: boolean
  locked?: string // the reason, '' when locked without one; absent when not locked
  prunable?: string // git's reason; absent when not prunable
}

// A worktree plus what the per-worktree git calls found.
export type WorktreeInfo = Worktree & {
  isCurrent: boolean
  dirty?: number // changed + untracked entries
  hasUpstream?: boolean
  ahead?: number
  behind?: number
  commitAt?: number // epoch seconds of the last commit
  subject?: string
  error?: string // this worktree could not be inspected (e.g. its path is gone)
}

export type Snapshot = {
  worktrees: WorktreeInfo[]
  error?: string // nothing could be listed
  checkedAt?: number
  isLoading?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    worktrees: { snapshot: Snapshot }
  }
}
