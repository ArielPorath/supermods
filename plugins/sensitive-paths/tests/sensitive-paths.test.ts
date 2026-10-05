import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const CWD = '/home/u/proj'

// A fake machine beneath the plugin: HOME, the session's cwd, symlinks by path
// (anything else is missing), and tools that just report they ran.
function machine(on: On, links: Record<string, string> = {}, opts: { brokenCwd?: boolean } = {}) {
  mock.env(on, { HOME })
  on('session.cwd', async () => (opts.brokenCwd ? { deny: 'no cwd' } : { value: CWD }))
  on('fs.stat', async (_$, e) => {
    const realPath = links[e.path]
    return realPath === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: true, realPath } }
  })
  on('tool.call', async () => ({ result: 'ran' as never }))
  on('tool.check', async () => ({ decision: 'allow' as const }))
}

const ran = (r: { deny?: string }) => r.deny === undefined

test('denies Read of a protected file and names the glob and the way out', async ($, on) => {
  machine(on)
  const r = await $.tool.call({ tool: 'Read', file_path: '~/.ssh/id_rsa' })
  expect(r.deny).toMatch(/~\/\.ssh\/id_rsa matches the protected pattern "~\/\.ssh\/\*\*"/)
  expect(r.deny).toMatch(/"allowed" option/)
})

test('lets ordinary files through untouched', async ($, on) => {
  machine(on)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: `${CWD}/src/index.ts` }))).toBe(true)
  expect(ran(await $.tool.call({ tool: 'Write', file_path: `${CWD}/README.md`, content: 'x' }))).toBe(true)
})

test('resolves relative paths and .. against the session cwd', async ($, on) => {
  machine(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '.env' })).deny).toMatch(/proj\/\.env matches .*"\*\*\/\.env"/)
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/../../.aws/credentials' })).deny)
    .toMatch(/~\/\.aws\/credentials/)
})

test('denies Edit, Write and NotebookEdit of protected files', async ($, on) => {
  machine(on)
  expect((await $.tool.call({ tool: 'Edit', file_path: `${CWD}/.env.local`, old_string: 'a', new_string: 'b' })).deny)
    .toMatch(/"\*\*\/\.env\.\*"/)
  expect((await $.tool.call({ tool: 'Write', file_path: '/srv/server.key', content: 'x' })).deny).toMatch(/\*\.key/)
  expect((await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${HOME}/.ssh/x.ipynb`, new_source: '' })).deny)
    .toMatch(/NotebookEdit/)
})

test('allow-exceptions win: .env.example and public keys pass', async ($, on) => {
  machine(on)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: '.env.example' }))).toBe(true)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: '~/.ssh/id_ed25519.pub' }))).toBe(true)
})

test('follows a symlink to a protected file', async ($, on) => {
  machine(on, { [`${CWD}/notes.txt`]: `${HOME}/.ssh/id_rsa` })
  expect((await $.tool.call({ tool: 'Read', file_path: 'notes.txt' })).deny).toMatch(/~\/\.ssh\/id_rsa/)
})

test('follows a symlinked folder for a file not there yet', async ($, on) => {
  machine(on, { [`${CWD}/keys`]: `${HOME}/.ssh` })
  expect((await $.tool.call({ tool: 'Write', file_path: 'keys/new', content: 'x' })).deny).toMatch(/~\/\.ssh\/new/)
})

test('Bash: blocks commands naming protected paths', async ($, on) => {
  machine(on)
  for (const command of [
    'cat ~/.ssh/id_rsa', 'cp .env /tmp/x', 'source .env', '. ./.env', 'base64 < ~/.netrc',
    'cat $HOME/.aws/credentials', 'cd ~/.ssh && ls', 'echo "$(cat .env)"', 'grep TOKEN ~/.npmrc',
  ]) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toMatch(/Bash call.*check_bash/)
  }
})

test('Bash: leaves ordinary commands alone', async ($, on) => {
  machine(on)
  for (const command of [
    'ls -la', 'git status', 'echo .env >> .gitignore', 'cat .env.example', 'npm test',
    'curl https://example.com/.env', 'git commit -m "ignore .env files"', 'cat ~/.ssh/id_rsa.pub',
  ]) {
    expect(ran(await $.tool.call({ tool: 'Bash', command }))).toBe(true)
  }
})

test('check_bash: false lets Bash through', { options: { check_bash: false } }, async ($, on) => {
  machine(on)
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'cat .env' }))).toBe(true)
  expect((await $.tool.call({ tool: 'Read', file_path: '.env' })).deny).toBeDefined()
})

test('protected adds globs', { options: { protected: ['**/secrets/**'] } }, async ($, on) => {
  machine(on)
  expect((await $.tool.call({ tool: 'Read', file_path: 'config/secrets/db.yml' })).deny).toMatch(/"\*\*\/secrets\/\*\*"/)
})

test('allowed exempts paths', { options: { allowed: ['**/fixtures/**'] } }, async ($, on) => {
  machine(on)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: 'fixtures/test.pem' }))).toBe(true)
  expect((await $.tool.call({ tool: 'Read', file_path: 'test.pem' })).deny).toBeDefined()
})

test('ask mode passes tool.call on and asks in tool.check', { options: { read_mode: 'ask' } }, async ($, on) => {
  machine(on)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: '.env' }))).toBe(true)
  const check = await $.tool.check({ tool: 'Read', input: { file_path: '.env' } })
  expect(check.decision).toBe('ask')
  expect(check.reason).toMatch(/\.env/)
  // writes stay denied
  expect((await $.tool.call({ tool: 'Write', file_path: '.env', content: '' })).deny).toBeDefined()
  expect((await $.tool.check({ tool: 'Write', input: { file_path: '.env' } })).decision).toBe('deny')
})

test('off mode allows; Bash takes the stricter mode', { options: { read_mode: 'off', write_mode: 'ask' } }, async ($, on) => {
  machine(on)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: '.env' }))).toBe(true)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '.env' } })).decision).toBe('allow')
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'cat .env' }))).toBe(true)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'cat .env' } })).decision).toBe('ask')
})

test('tool.check covers Glob and Grep by folder and pattern', async ($, on) => {
  machine(on)
  expect((await $.tool.check({ tool: 'Glob', input: { pattern: '*', path: '~/.ssh' } })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'Glob', input: { pattern: '**/.env' } })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'Grep', input: { pattern: 'KEY', glob: '*.pem' } })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'Glob', input: { pattern: 'src/**/*.ts' } })).decision).toBe('allow')
})

test('a failing check refuses the call instead of leaking the file', async ($, on) => {
  machine(on, {}, { brokenCwd: true })
  expect((await $.tool.call({ tool: 'Read', file_path: '.env' })).deny).toMatch(/could not check this Read call/)
  // tools the mod doesn't guard never reach the failing lookup
  expect(ran(await $.tool.call({ tool: 'WebFetch', url: 'https://x', prompt: 'p' } as never))).toBe(true)
})
