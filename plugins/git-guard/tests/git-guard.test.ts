import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { findViolations, parseConfig, splitCommands } from '../hooks/guard'
import type { BranchOf, Config, RuleId } from '../hooks/guard'

const DEFAULTS = parseConfig({})
const onBranch = (name: string): BranchOf => async () => name

async function rulesHit(command: string, cfg: Config = DEFAULTS, branch = 'feature'): Promise<RuleId[]> {
  return (await findViolations(command, cfg, onBranch(branch))).map(v => v.rule)
}

// Positive and negative cases per rule, with the default config, on branch `feature`.
const CASES: [RuleId, string[], string[]][] = [
  [
    'forcePush',
    ['git push --force origin feat', 'git push -f', 'git push -uf origin feat', 'git push origin +feat', 'git push --mirror backup'],
    ['git push origin feat', 'git push --force-with-lease origin feat', 'git push -u origin feat', 'git push -n -f origin feat'],
  ],
  [
    'protectedPush',
    ['git push origin main', 'git push origin HEAD:main', 'git push origin feat:refs/heads/master', 'git push origin :main', 'git push --all origin'],
    ['git push origin feat', 'git push origin main:feat', 'git push --tags', 'git push', 'git push --dry-run origin main'],
  ],
  ['resetHard', ['git reset --hard', 'git reset --hard origin/main'], ['git reset', 'git reset --soft HEAD~1']],
  ['clean', ['git clean -f', 'git clean -fd', 'git clean -fdx', 'git clean -xdf', 'git clean --force'], ['git clean -n', 'git clean -fdn', 'git clean -d']],
  ['branchForceDelete', ['git branch -D old', 'git branch --delete --force old', 'git branch -df old'], ['git branch -d old', 'git branch -f feat HEAD~1', 'git branch new']],
  [
    'discardChanges',
    ['git checkout -- .', 'git checkout .', 'git restore .', 'git restore --worktree --staged .', 'git checkout HEAD -- :/'],
    ['git checkout main', 'git checkout -- src/file.ts', 'git restore --staged .', 'git checkout -b new'],
  ],
  ['stashDrop', ['git stash drop', 'git stash drop stash@{1}', 'git stash clear'], ['git stash', 'git stash pop', 'git stash list']],
  ['rebaseProtected', ['git rebase origin/feature main'], ['git rebase main', 'git rebase -i HEAD~3', 'git rebase --abort']],
]

describe('rules', () => {
  for (const [rule, hits, misses] of CASES) {
    for (const cmd of hits) {
      test(`${rule} flags: ${cmd}`, async () => {
        expect(await rulesHit(cmd)).toContain(rule)
      })
    }
    for (const cmd of misses) {
      test(`${rule} allows: ${cmd}`, async () => {
        expect(await rulesHit(cmd)).not.toContain(rule)
      })
    }
  }

  test('a push with no refspec, or HEAD, goes to the checked-out branch', async () => {
    expect(await rulesHit('git push', DEFAULTS, 'main')).toEqual(['protectedPush'])
    expect(await rulesHit('git push -u origin', DEFAULTS, 'master')).toEqual(['protectedPush'])
    expect(await rulesHit('git push origin HEAD', DEFAULTS, 'main')).toEqual(['protectedPush'])
    expect(await rulesHit('git push origin HEAD', DEFAULTS, 'feature')).toEqual([])
  })

  test('rebasing while on a protected branch is flagged', async () => {
    expect(await rulesHit('git rebase -i HEAD~3', DEFAULTS, 'main')).toEqual(['rebaseProtected'])
    expect(await rulesHit('git rebase --continue', DEFAULTS, 'main')).toEqual([])
  })

  test('an unknown branch (detached HEAD, not a repo, git failed) is not protected', async () => {
    const failing: BranchOf = async () => {
      throw new Error('git missing')
    }
    expect(await findViolations('git push', DEFAULTS, failing)).toEqual([])
    expect(await rulesHit('git push', DEFAULTS, '')).toEqual([])
  })
})

describe('parsing', () => {
  test('chained commands are each checked', async () => {
    expect(await rulesHit('npm test && git push --force')).toEqual(['forcePush'])
    expect(await rulesHit('git status; git reset --hard')).toEqual(['resetHard'])
    expect(await rulesHit('git log | head || git clean -fd')).toEqual(['clean'])
    expect(await rulesHit('(git stash clear) & echo done')).toEqual(['stashDrop'])
    expect(await rulesHit('echo $(git branch -D x)')).toEqual(['branchForceDelete'])
    expect(await rulesHit('git add .\ngit push origin main')).toEqual(['protectedPush'])
  })

  test('git -C, global options, env prefixes and wrappers are seen through', async () => {
    expect(await rulesHit('git -C ../repo push -f')).toEqual(['forcePush'])
    expect(await rulesHit('git -c core.pager=cat --no-pager reset --hard')).toEqual(['resetHard'])
    expect(await rulesHit('GIT_SSH_COMMAND="ssh -i k" git push origin main')).toEqual(['protectedPush'])
    expect(await rulesHit('env FOO=1 /usr/bin/git clean -f')).toEqual(['clean'])
    expect(await rulesHit('sudo git reset --hard')).toEqual(['resetHard'])
    expect(await rulesHit("bash -c 'git push --force'")).toEqual(['forcePush'])
    expect(await rulesHit('git push --force origin feat 2>&1 > /tmp/log')).toEqual(['forcePush'])
  })

  test('git -C and cd are passed to the branch lookup', async () => {
    const seen: [string | undefined, string[]][] = []
    const spy: BranchOf = async (cwd, repoArgs) => {
      seen.push([cwd, repoArgs])
      return 'main'
    }
    await findViolations('cd /work && git -C sub push', DEFAULTS, spy)
    expect(seen).toEqual([['/work', ['-C', 'sub']]])
  })

  test('quoted text is not a command', async () => {
    expect(await rulesHit('git commit -m "never git push --force to main; git reset --hard"')).toEqual([])
    expect(await rulesHit("echo 'git clean -fdx && git stash clear'")).toEqual([])
    expect(await rulesHit('grep -r "git branch -D" .')).toEqual([])
    expect(await rulesHit('git log --grep="reset --hard" # git push -f')).toEqual([])
    expect(await rulesHit("cat <<'EOF' > notes.md\ngit push --force\nEOF\ngit status")).toEqual([])
  })

  test('splitCommands honors quotes, escapes and separators', () => {
    expect(splitCommands(`a "b c" 'd;e' f\\ g && h|i`)).toEqual([['a', 'b c', 'd;e', 'f g'], ['h'], ['i']])
  })
})

describe('config', () => {
  test('each rule can be turned off', async () => {
    for (const [rule, hits] of CASES) {
      const cfg = parseConfig({ [rule]: false })
      for (const cmd of hits) expect(await rulesHit(cmd, cfg)).not.toContain(rule)
    }
  })

  test('allowForceWithLease false guards --force-with-lease', async () => {
    const cfg = parseConfig({ allowForceWithLease: false })
    expect(await rulesHit('git push --force-with-lease origin feat', cfg)).toEqual(['forcePush'])
  })

  test('protectedBranches replaces the default list', async () => {
    const cfg = parseConfig({ protectedBranches: ' release , prod ' })
    expect(cfg.protectedBranches).toEqual(['release', 'prod'])
    expect(await rulesHit('git push origin prod', cfg)).toEqual(['protectedPush'])
    expect(await rulesHit('git push origin main', cfg)).toEqual([])
  })

  test('action defaults to deny and accepts ask', () => {
    expect(DEFAULTS.action).toBe('deny')
    expect(parseConfig({ action: 'ask' }).action).toBe('ask')
  })
})

// End to end through the hooks, with git and the tool stubbed.
function stubGit(on: On, branch: string) {
  const runs: string[][] = []
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    return {
      value: { exitCode: 0, stdout: `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('tool.call', () => ({ result: 'ran' }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  return runs
}

describe('hooks', () => {
  test('deny (default): a risky command is refused with the rule and how to turn it off', async ($, on) => {
    stubGit(on, 'feature')
    const out = await $.tool.call({ tool: 'Bash', command: 'git push --force origin feature' })
    expect(out.deny).toContain('rule "force push"')
    expect(out.deny).toContain('set forcePush to false for git-guard in /config')
  })

  test('deny: a safe command runs, and non-git commands never start git', async ($, on) => {
    const runs = stubGit(on, 'main')
    expect((await $.tool.call({ tool: 'Bash', command: 'ls -la' })).result).toBe('ran')
    expect((await $.tool.call({ tool: 'Bash', command: 'git status' })).result).toBe('ran')
    expect(runs).toEqual([])
  })

  test('deny: the branch comes from git, with -C passed along', async ($, on) => {
    const runs = stubGit(on, 'main')
    const out = await $.tool.call({ tool: 'Bash', command: 'git -C app push' })
    expect(out.deny).toContain('it pushes to main')
    expect(runs).toEqual([['git', '-C', 'app', 'branch', '--show-current']])
  })

  test('deny: other tools pass through', async ($, on) => {
    stubGit(on, 'main')
    expect((await $.tool.call({ tool: 'Read', file_path: 'git push -f' })).result).toBe('ran')
  })

  test('ask: a risky command goes to the permission prompt instead', { options: { action: 'ask' } }, async ($, on) => {
    stubGit(on, 'feature')
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('rule "reset --hard"')
    // tool.call is left alone in ask mode
    expect((await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })).result).toBe('ran')
  })

  test('ask: safe commands keep the engine verdict, and a deny stays a deny', { options: { action: 'ask' } }, async ($, on) => {
    on('process.run', async () => ({
      value: { exitCode: 0, stdout: 'feature\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('tool.check', ($, e) => {
      const input = e.input
      const cmd = typeof input === 'object' && input !== null && 'command' in input ? input.command : ''
      return { decision: cmd === 'git clean -f' ? ('deny' as const) : ('allow' as const), reason: 'rule' }
    })
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git status' } })).decision).toBe('allow')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git clean -f' } })).decision).toBe('deny')
  })

  test('a rule turned off in options lets the command run', { options: { resetHard: false } }, async ($, on) => {
    stubGit(on, 'feature')
    expect((await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })).result).toBe('ran')
  })

  test('a failing git lookup leaves the push allowed', async ($, on) => {
    on('process.run', async () => ({
      value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('tool.call', () => ({ result: 'ran' }))
    expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).result).toBe('ran')
  })
})
