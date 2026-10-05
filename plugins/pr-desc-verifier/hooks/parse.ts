// Pure shell-ish parsing of `gh pr create` / `gh pr edit` commands. No `$`, no I/O: what the
// command *says*. Reading a --body-file is the caller's job.

export type Body =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin'; text?: string } // --body-file -; text when a heredoc feeds it
  | { kind: 'fill'; mode: string } // --fill, --fill-first, --fill-verbose
  | { kind: 'none' }

export type PrCommand = {
  subcommand: 'create' | 'edit'
  target?: string // gh pr edit <number | url | branch>
  title?: string
  body: Body
  fill?: string // set when a --fill flag is present, even if --title/--body override it
  repo?: string
  base?: string
  head?: string
  draft: boolean
  dryRun: boolean
  reviewers: string[]
  labels: string[]
  assignees: string[]
  isDynamic: boolean // title or body holds a $VAR or $(...) left as written
}

type Word = { text: string; isDynamic: boolean }
type Segment = { words: Word[]; stdin?: string }

const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'builtin'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Flags of `gh pr create|edit` that take a value; any other flag is boolean.
const VALUE_FLAGS: Record<string, string> = {
  '-t': 'title', '--title': 'title',
  '-b': 'body', '--body': 'body',
  '-F': 'body-file', '--body-file': 'body-file',
  '-R': 'repo', '--repo': 'repo',
  '-B': 'base', '--base': 'base',
  '-H': 'head', '--head': 'head',
  '-r': 'reviewer', '--reviewer': 'reviewer', '--add-reviewer': 'reviewer',
  '-l': 'label', '--label': 'label', '--add-label': 'label',
  '-a': 'assignee', '--assignee': 'assignee', '--add-assignee': 'assignee',
  '--remove-reviewer': 'skip', '--remove-label': 'skip', '--remove-assignee': 'skip',
  '-p': 'skip', '--project': 'skip', '--add-project': 'skip', '--remove-project': 'skip',
  '-m': 'skip', '--milestone': 'skip', '-T': 'skip', '--template': 'skip', '--recover': 'skip',
}
const FILL_FLAGS: Record<string, string> = {
  '-f': 'fill', '--fill': 'fill', '--fill-first': 'fill-first', '--fill-verbose': 'fill-verbose',
}

// ---------------------------------------------------------------- tokenizer

// `$(cat <<'EOF' ... EOF)`: the one command substitution worth evaluating, since it is how
// Claude usually passes a multi-line --body.
const CAT_HEREDOC = /^\s*cat\s*<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2[ \t]*\n([\s\S]*?)\n?[ \t]*\3[ \t]*\n?\s*$/

function evalSubstitution(inner: string): string | undefined {
  const m = CAT_HEREDOC.exec(inner)
  if (!m) return undefined
  const body = m[4] ?? ''
  return m[1] === '-' ? body.replace(/^\t+/gm, '') : body
}

// Index just past the line that ends a heredoc started on the line after `from`.
function skipHeredoc(src: string, from: number, delim: string, stripTabs: boolean): { end: number; body: string } {
  const lines: string[] = []
  let i = from
  while (i < src.length) {
    const nl = src.indexOf('\n', i)
    const line = src.slice(i, nl === -1 ? src.length : nl)
    i = nl === -1 ? src.length : nl + 1
    if ((stripTabs ? line.replace(/^\t+/, '') : line).trim() === delim) break
    lines.push(stripTabs ? line.replace(/^\t+/, '') : line)
  }
  return { end: i, body: lines.join('\n') }
}

// Reads a heredoc operator at src[i] ('<<'); returns the delimiter and where the operator ends.
function readHeredocOp(src: string, i: number): { delim: string; strip: boolean; end: number } | undefined {
  const m = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w-]*))/.exec(src.slice(i))
  if (!m) return undefined
  return { delim: m[2] ?? m[3] ?? m[4] ?? '', strip: m[1] === '-', end: i + m[0].length }
}

// Index of the `)` closing a `$(` whose body starts at `i`; skips quotes and heredoc bodies.
function closeParen(src: string, i: number): number {
  let depth = 1
  const pending: { delim: string; strip: boolean }[] = []
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === "'") { i = src.indexOf("'", i + 1); if (i === -1) return -1; i++; continue }
    if (c === '"') {
      i++
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '<' && src[i + 1] === '<') {
      const op = readHeredocOp(src, i)
      if (op) { pending.push(op); i = op.end; continue }
    }
    if (c === '\n' && pending.length) {
      let at = i + 1
      for (const h of pending.splice(0)) at = skipHeredoc(src, at, h.delim, h.strip).end
      i = at
      continue
    }
    if (c === '(') depth++
    if (c === ')' && --depth === 0) return i
    i++
  }
  return -1
}

const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }

// Splits a command line into simple commands (on ; && || | & newlines and parentheses),
// each a list of words with quotes removed, plus the heredoc feeding its stdin, if any.
export function tokenize(src: string): Segment[] {
  const segments: Segment[] = []
  let words: Word[] = []
  let cur: Word | undefined
  let stdin: string | undefined
  let pendingHeredoc: { delim: string; strip: boolean; isStdin: boolean }[] = []
  let skipNextWord = false // the target of a redirection

  const word = () => (cur ??= { text: '', isDynamic: false })
  const endWord = () => {
    if (cur) {
      if (skipNextWord) skipNextWord = false
      else words.push(cur)
    }
    cur = undefined
  }
  const endSegment = () => {
    endWord()
    if (words.length) segments.push({ words, stdin })
    words = []
    stdin = undefined
  }
  // A `$...` at src[i]: a command substitution, $VAR, ${VAR} or $'...'. Returns the new index.
  const dollar = (i: number, inDouble: boolean): number => {
    const w = word()
    const next = src[i + 1]
    if (next === '(' && src[i + 2] !== '(') {
      const end = closeParen(src, i + 2)
      if (end === -1) { w.text += src.slice(i); w.isDynamic = true; return src.length }
      const inner = src.slice(i + 2, end)
      const value = evalSubstitution(inner)
      if (value === undefined) { w.text += src.slice(i, end + 1); w.isDynamic = true }
      else w.text += value
      return end + 1
    }
    if (next === "'" && !inDouble) {
      let j = i + 2
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) { w.text += ANSI_C[src[j + 1] ?? ''] ?? src[j + 1]; j += 2 }
        else w.text += src[j++]
      }
      return j + 1
    }
    const m = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9#?$!@*-])/.exec(src.slice(i))
    if (m) { w.text += m[0]; w.isDynamic = true; return i + m[0].length }
    w.text += '$'
    return i + 1
  }

  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (c === '\n') {
      endWord()
      if (pendingHeredoc.length) {
        let at = i + 1
        for (const h of pendingHeredoc) {
          const { end, body } = skipHeredoc(src, at, h.delim, h.strip)
          if (h.isStdin) stdin = body
          at = end
        }
        pendingHeredoc = []
        i = at
      } else i++
      endSegment()
      continue
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue }
    if (c === '#' && !cur) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue }
      word().text += src[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      word().text += src.slice(i + 1, end === -1 ? src.length : end)
      i = end === -1 ? src.length : end + 1
      continue
    }
    if (c === '"') {
      const w = word()
      i++
      while (i < src.length && src[i] !== '"') {
        const d = src[i]
        if (d === '\\' && /["\\$`\n]/.test(src[i + 1] ?? '')) {
          if (src[i + 1] !== '\n') w.text += src[i + 1]
          i += 2
        } else if (d === '$') i = dollar(i, true)
        else { w.text += d; i++ }
      }
      i++
      continue
    }
    if (c === '$') { i = dollar(i, false); continue }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      const w = word()
      w.text += src.slice(i, end === -1 ? src.length : end + 1)
      w.isDynamic = true
      i = end === -1 ? src.length : end + 1
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endSegment()
      i++
      continue
    }
    if (c === '<' || c === '>') {
      if (cur && /^\d+$/.test(cur.text)) cur = undefined // the fd of `2>`
      endWord()
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        const op = readHeredocOp(src, i)
        if (op) {
          pendingHeredoc.push({ delim: op.delim, strip: op.strip, isStdin: true })
          i = op.end
          continue
        }
      }
      let j = i + 1
      while (j < src.length && /[<>&|]/.test(src[j] ?? '')) j++
      // `2>&1` names an fd, not a file: drop it with the operator.
      const fd = /^\d+|^-/.exec(src.slice(j))
      if (src[j - 1] === '&' && fd) j += fd[0].length
      else skipNextWord = true
      i = j
      continue
    }
    word().text += c
    i++
  }
  endSegment()
  return segments
}

// ------------------------------------------------------------------- parser

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// The gh words of a segment, or undefined when it does not run gh.
function ghArgs(words: Word[]): Word[] | undefined {
  let i = 0
  while (i < words.length) {
    const t = words[i]?.text ?? ''
    if (ASSIGNMENT.test(t) || WRAPPERS.has(t) || (i > 0 && t.startsWith('-'))) i++
    else break
  }
  const cmd = words[i]
  return cmd && basename(cmd.text) === 'gh' ? words.slice(i + 1) : undefined
}

function parseSegment(seg: Segment): PrCommand | undefined {
  const args = ghArgs(seg.words)
  if (!args) return undefined
  let repo: string | undefined
  // gh [-R repo] pr [-R repo] <create|new|edit> ...
  const positional: Word[] = []
  let i = 0
  for (; i < args.length && positional.length < 2; i++) {
    const t = args[i]?.text ?? ''
    if (t === '-R' || t === '--repo') repo = args[++i]?.text
    else if (t.startsWith('--repo=')) repo = t.slice(7)
    else if (!t.startsWith('-')) positional.push(args[i] as Word)
  }
  if (positional[0]?.text !== 'pr') return undefined
  const sub = positional[1]?.text
  if (sub !== 'create' && sub !== 'new' && sub !== 'edit') return undefined

  const cmd: PrCommand = {
    subcommand: sub === 'edit' ? 'edit' : 'create',
    body: { kind: 'none' },
    repo,
    draft: false,
    dryRun: false,
    reviewers: [],
    labels: [],
    assignees: [],
    isDynamic: false,
  }
  let body: Body | undefined
  const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean)

  for (; i < args.length; i++) {
    const w = args[i] as Word
    let flag = w.text
    let value: Word | undefined
    if (flag.startsWith('--') && flag.includes('=')) {
      value = { text: flag.slice(flag.indexOf('=') + 1), isDynamic: w.isDynamic }
      flag = flag.slice(0, flag.indexOf('='))
    } else if (/^-[A-Za-z]./.test(flag) && VALUE_FLAGS[flag.slice(0, 2)]) {
      value = { text: flag.slice(2).replace(/^=/, ''), isDynamic: w.isDynamic }
      flag = flag.slice(0, 2)
    }
    const kind = VALUE_FLAGS[flag]
    if (kind) {
      value ??= args[++i]
      if (!value) continue
      const v = value.text
      if (kind === 'title') { cmd.title = v; cmd.isDynamic ||= value.isDynamic }
      else if (kind === 'body') { body = { kind: 'text', text: v }; cmd.isDynamic ||= value.isDynamic }
      else if (kind === 'body-file') body = v === '-' ? { kind: 'stdin', text: seg.stdin } : { kind: 'file', path: v }
      else if (kind === 'repo') cmd.repo = v
      else if (kind === 'base') cmd.base = v
      else if (kind === 'head') cmd.head = v
      else if (kind === 'reviewer') cmd.reviewers.push(...list(v))
      else if (kind === 'label') cmd.labels.push(...list(v))
      else if (kind === 'assignee') cmd.assignees.push(...list(v))
      continue
    }
    if (FILL_FLAGS[flag]) cmd.fill = FILL_FLAGS[flag]
    else if (flag === '-d' || flag === '--draft') cmd.draft = true
    else if (flag === '--dry-run') cmd.dryRun = true
    else if (!flag.startsWith('-') && cmd.target === undefined) cmd.target = flag
  }
  cmd.body = body ?? (cmd.fill ? { kind: 'fill', mode: cmd.fill } : { kind: 'none' })
  return cmd
}

/** Every `gh pr create|new|edit` in a Bash command line, in order. */
export function findPrCommands(command: string): PrCommand[] {
  return tokenize(command).flatMap(seg => parseSegment(seg) ?? [])
}

/** Whether `gh pr edit` changes the title or body (the only edits this mod reviews). */
export function editsText(cmd: PrCommand): boolean {
  return cmd.title !== undefined || cmd.body.kind !== 'none'
}
