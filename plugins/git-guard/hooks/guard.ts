// Pure logic: split a shell command into simple commands, find the git ones, and match them
// against the rules. No `$` here, so it unit-tests without an engine.

export const RULES = {
  forcePush: 'force push',
  protectedPush: 'push to a protected branch',
  resetHard: 'reset --hard',
  clean: 'clean -f',
  branchForceDelete: 'branch -D',
  discardChanges: 'discarding uncommitted changes',
  stashDrop: 'stash drop/clear',
  rebaseProtected: 'rebase of a protected branch',
} as const
export type RuleId = keyof typeof RULES

export type Config = {
  action: 'deny' | 'ask'
  rules: Record<RuleId, boolean>
  allowForceWithLease: boolean
  protectedBranches: string[]
}

export type Violation = { rule: RuleId; command: string; detail?: string }

// Looks up the checked-out branch for a git invocation: `cwd` from a preceding `cd`, `repoArgs`
// the invocation's own -C / --git-dir / --work-tree. Resolves '' when it can't tell.
export type BranchOf = (cwd: string | undefined, repoArgs: string[]) => Promise<string>

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'nice', 'env'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT = /^\d*(>>?|<<?<?|>&|<&|&>>?)/
const WHOLE_TREE = new Set(['.', './', ':/', ':/.', '*'])

export function parseConfig(options: Readonly<Record<string, unknown>>): Config {
  const rules = {} as Record<RuleId, boolean>
  for (const id of Object.keys(RULES) as RuleId[]) rules[id] = options[id] !== false
  return {
    action: options.action === 'ask' ? 'ask' : 'deny',
    rules,
    allowForceWithLease: options.allowForceWithLease !== false,
    protectedBranches: String(options.protectedBranches ?? 'main,master')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  }
}

// Splits a command line into simple commands (word lists). Quotes are honored, so text inside
// a commit message is one word, never a command; $( ) and backticks outside quotes are split
// out as their own commands since the shell runs them; heredoc bodies are skipped.
export function splitCommands(src: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const heredocs: string[] = []
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\n') {
      endCommand()
      // Skip each pending heredoc's body, up to its delimiter line.
      for (const delim of heredocs.splice(0)) {
        while (i < src.length) {
          const end = src.indexOf('\n', i + 1)
          const line = src.slice(i + 1, end === -1 ? src.length : end)
          i = end === -1 ? src.length : end
          if (line.replace(/^\t+/, '') === delim) break
        }
      }
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '\\') {
      if (src[i + 1] === '\n') i++
      else {
        word += src[i + 1] ?? ''
        inWord = true
        i++
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      word += src.slice(i + 1, end === -1 ? src.length : end)
      inWord = true
      i = end === -1 ? src.length : end
    } else if (c === '"') {
      inWord = true
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) i++
        word += src[i]
      }
    } else if (c === '#' && !inWord) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      // A heredoc: remember its delimiter; the body starts on the next line.
      endWord()
      let j = i + 2
      if (src[j] === '-') j++
      while (src[j] === ' ' || src[j] === '\t') j++
      const m = /^(['"]?)([^\s;&|<>()'"]+)\1/.exec(src.slice(j))
      if (m) {
        heredocs.push(m[2] ?? '')
        i = j + m[0].length - 1
      } else i++
    } else if (c === '&' && (word.endsWith('>') || word.endsWith('<') || src[i + 1] === '>')) {
      word += c // a redirection such as 2>&1 or &>file, not a separator
      inWord = true
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      endCommand()
    } else if (c === '$' && src[i + 1] === '(') {
      endCommand()
      i++
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return out.map(stripRedirects).filter(w => w.length > 0)
}

function stripRedirects(words: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    const m = REDIRECT.exec(w)
    if (!m) kept.push(w)
    else if (m[0] === w) i++ // `> file`: the target is the next word
  }
  return kept
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

// Drops leading VAR=value assignments and wrappers like `env`, `sudo`, `command`.
function unwrap(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i] ?? ''
    if (ASSIGNMENT.test(w)) i++
    else if (WRAPPERS.has(basename(w))) {
      i++
      while (words[i]?.startsWith('-')) i++
    } else break
  }
  return words.slice(i)
}

type GitCall = { cwd?: string; repoArgs: string[]; sub: string; args: string[]; text: string }

// Every git invocation in the command, with the directory a preceding `cd` moved to.
export function gitCalls(src: string, depth = 0): GitCall[] {
  const calls: GitCall[] = []
  let cwd: string | undefined
  for (const raw of splitCommands(src)) {
    const words = unwrap(raw)
    if (!words.length) continue
    const cmd = basename(words[0] ?? '')
    if (cmd === 'cd') {
      const to = words[1]
      cwd = to === undefined || to === '-' ? undefined : to.startsWith('/') || !cwd ? to : `${cwd}/${to}`
      continue
    }
    if (SHELLS.has(cmd) && depth < 3) {
      const c = words.findIndex((w, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(w))
      const script = c > 0 ? words[c + 1] : undefined
      if (script !== undefined) calls.push(...gitCalls(script, depth + 1))
      continue
    }
    if (cmd !== 'git') continue
    const repoArgs: string[] = []
    let i = 1
    for (; words[i]?.startsWith('-'); i++) {
      const w = words[i] ?? ''
      if (w === '-C' || w === '--git-dir' || w === '--work-tree') repoArgs.push(w, words[++i] ?? '')
      else if (/^--(git-dir|work-tree)=/.test(w)) repoArgs.push(w)
      else if (w === '-c' || w === '--namespace' || w === '--exec-path' || w === '--config-env') i++
    }
    const sub = words[i]
    if (sub === undefined) continue
    calls.push({ cwd, repoArgs, sub, args: words.slice(i + 1), text: words.join(' ') })
  }
  return calls
}

// Short flags may be clustered (-fdx): true when any listed letter is in a cluster.
const hasShort = (args: string[], letters: string) =>
  args.some(a => /^-[A-Za-z]+$/.test(a) && [...letters].some(l => a.includes(l)))
const has = (args: string[], ...long: string[]) => args.some(a => long.includes(a))

// Positional words, skipping options and the values of options that take one.
function positionals(args: string[], valued: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') return out.concat(args.slice(i + 1))
    if (a.startsWith('-') && a !== '-') {
      if (valued.includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

const shortName = (ref: string) => ref.replace(/^refs\/heads\//, '')

export async function findViolations(
  command: string,
  cfg: Config,
  branchOf: BranchOf,
): Promise<Violation[]> {
  const found: Violation[] = []
  const on = cfg.rules
  const isProtected = (b: string) => b !== '' && cfg.protectedBranches.includes(shortName(b))
  for (const call of gitCalls(command)) {
    const { sub, args, text } = call
    const add = (rule: RuleId, detail?: string) => found.push({ rule, command: text, detail })
    let current: Promise<string> | undefined
    const branch = () => (current ??= branchOf(call.cwd, call.repoArgs).catch(() => ''))

    if (sub === 'push') {
      if (hasShort(args, 'n') || has(args, '--dry-run')) continue
      const pos = positionals(args, ['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
      const refspecs = pos.slice(1)
      const lease = args.some(a => a.startsWith('--force-with-lease'))
      const force =
        has(args, '--force', '--mirror') || hasShort(args, 'f') || refspecs.some(r => r.startsWith('+'))
      if (on.forcePush && (force || (lease && !cfg.allowForceWithLease))) {
        add('forcePush', force ? undefined : '--force-with-lease is not allowed by your settings')
      }
      if (!on.protectedPush) continue
      if (has(args, '--all', '--branches', '--mirror')) {
        add('protectedPush', 'it pushes every branch')
        continue
      }
      if (has(args, '--tags') && refspecs.length === 0) continue
      const dests = refspecs.length
        ? refspecs.map(r => {
            // src:dst pushes to dst; `:dst` deletes dst; a bare name pushes to itself
            const [src = '', dst = src] = r.replace(/^\+/, '').split(':')
            return dst || src
          })
        : ['HEAD']
      for (const d of dests) {
        const target = d === 'HEAD' || d === '@' ? await branch() : d
        if (isProtected(target)) {
          add('protectedPush', `it pushes to ${shortName(target)}`)
          break
        }
      }
    } else if (sub === 'reset') {
      if (on.resetHard && has(args, '--hard')) add('resetHard')
    } else if (sub === 'clean') {
      const force = has(args, '--force') || hasShort(args, 'f')
      const dry = has(args, '--dry-run') || hasShort(args, 'n')
      if (on.clean && force && !dry) add('clean')
    } else if (sub === 'branch') {
      const del = has(args, '--delete') || hasShort(args, 'd')
      const force = has(args, '--force') || hasShort(args, 'f')
      if (on.branchForceDelete && (hasShort(args, 'D') || (del && force))) add('branchForceDelete')
    } else if (sub === 'checkout' || sub === 'restore') {
      if (!on.discardChanges) continue
      const staged = has(args, '--staged') || hasShort(args, 'S')
      const worktree = has(args, '--worktree') || hasShort(args, 'W')
      if (sub === 'restore' && staged && !worktree) continue
      const pos = positionals(args, ['-s', '--source', '-b', '-B', '--orphan', '--conflict'])
      if (pos.some(p => WHOLE_TREE.has(p))) add('discardChanges')
    } else if (sub === 'stash') {
      if (on.stashDrop && (args[0] === 'drop' || args[0] === 'clear')) add('stashDrop')
    } else if (sub === 'rebase') {
      if (!on.rebaseProtected) continue
      if (has(args, '--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch')) continue
      const pos = positionals(args, ['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec'])
      const target = pos[1] ?? (await branch())
      if (isProtected(target)) add('rebaseProtected', `it rewrites ${shortName(target)}`)
    }
  }
  return found
}

export function reason(v: Violation, cfg: Config): string {
  const why = v.detail ? ` (${v.detail})` : ''
  const lead =
    cfg.action === 'deny'
      ? `git-guard blocked \`${v.command}\`: rule "${RULES[v.rule]}"${why}. Do not work around it; ask the user to run it themselves or to allow it.`
      : `\`${v.command}\` matches rule "${RULES[v.rule]}"${why}.`
  return `${lead} To turn this rule off, set ${v.rule} to false for git-guard in /config.`
}
