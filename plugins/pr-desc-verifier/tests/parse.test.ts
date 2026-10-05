import { expect, test } from 'claude-code/testing'

import { editsText, findPrCommands } from '../hooks/parse'
import type { PrCommand } from '../hooks/parse'

const one = (command: string): PrCommand => {
  const found = findPrCommands(command)
  expect(found.length).toBe(1)
  return found[0] as PrCommand
}

test('double-quoted title and body', () => {
  const c = one('gh pr create --title "Fix: login" --body "Line one\\nwith \\"quotes\\""')
  expect(c.subcommand).toBe('create')
  expect(c.title).toBe('Fix: login')
  expect(c.body).toEqual({ kind: 'text', text: 'Line one\\nwith "quotes"' })
  expect(c.isDynamic).toBe(false)
})

test('single quotes, --flag=value, attached short flags and ANSI-C quoting', () => {
  expect(one("gh pr create -t 'it''s' -b 'a \"b\"'").title).toBe('its')
  const c = one("gh pr create --title='Add x' -bBody --base=develop")
  expect(c.title).toBe('Add x')
  expect(c.body).toEqual({ kind: 'text', text: 'Body' })
  expect(c.base).toBe('develop')
  expect(one("gh pr create -t T -b $'one\\ntwo'").body).toEqual({ kind: 'text', text: 'one\ntwo' })
})

test('the $(cat <<EOF ...) heredoc body, with ) and quotes inside', () => {
  const cmd = [
    'gh pr create --title "Add retry" --body "$(cat <<\'EOF\'',
    '## Summary',
    '- handles (nested) parens and "quotes"',
    '',
    '🤖 Generated',
    'EOF',
    ')" --base main',
  ].join('\n')
  const c = one(cmd)
  expect(c.body).toEqual({
    kind: 'text',
    text: '## Summary\n- handles (nested) parens and "quotes"\n\n🤖 Generated',
  })
  expect(c.base).toBe('main')
  expect(c.isDynamic).toBe(false)
})

test('unquoted and tab-stripping heredoc delimiters', () => {
  expect(one('gh pr create -t T -b "$(cat <<EOF\nhello\nEOF\n)"').body).toEqual({ kind: 'text', text: 'hello' })
  expect(one('gh pr create -t T -b "$(cat <<-"END"\n\thi\n\tEND\n)"').body).toEqual({ kind: 'text', text: 'hi' })
})

test('--body-file: a path, a heredoc on stdin, and an unknown stdin', () => {
  expect(one('gh pr create -t T --body-file docs/pr.md').body).toEqual({ kind: 'file', path: 'docs/pr.md' })
  expect(one('gh pr create -t T -F ./pr.md').body).toEqual({ kind: 'file', path: './pr.md' })
  expect(one("gh pr create -t T -F - <<'EOF'\nfrom stdin\nEOF").body).toEqual({ kind: 'stdin', text: 'from stdin' })
  expect(one('cat pr.md | gh pr create -t T --body-file -').body).toEqual({ kind: 'stdin', text: undefined })
})

test('found inside chains, behind env prefixes, wrappers, full paths and -R', () => {
  const chain = 'git push -u origin HEAD && GH_TOKEN=x gh pr create -R acme/app -t T -b B 2>&1 | tee out.log'
  const c = one(chain)
  expect(c.repo).toBe('acme/app')
  expect(c.body).toEqual({ kind: 'text', text: 'B' })
  expect(one('cd repo; env FOO=1 /opt/homebrew/bin/gh --repo o/r pr new -t T').repo).toBe('o/r')
  expect(one('(cd sub && command gh pr create -t T -b B)').title).toBe('T')
  expect(findPrCommands('gh pr create -t A -b a; gh pr edit 3 -t B').map(x => x.title)).toEqual(['A', 'B'])
})

test('base, head, draft, reviewers, labels and assignees', () => {
  const c = one('gh pr create -t T -b B -B main -H feat -d -r alice,bob --reviewer carol -l bug -l "needs review" -a @me')
  expect(c).toMatchObject({
    base: 'main', head: 'feat', draft: true,
    reviewers: ['alice', 'bob', 'carol'], labels: ['bug', 'needs review'], assignees: ['@me'],
  })
})

test('--fill flavours', () => {
  expect(one('gh pr create --fill').body).toEqual({ kind: 'fill', mode: 'fill' })
  expect(one('gh pr create -f').fill).toBe('fill')
  expect(one('gh pr create --fill-first --draft').body).toEqual({ kind: 'fill', mode: 'fill-first' })
  const both = one('gh pr create --fill-verbose --title Mine')
  expect(both.title).toBe('Mine')
  expect(both.fill).toBe('fill-verbose')
})

test('gh pr edit: target, and whether title/body change', () => {
  const labels = one('gh pr edit 12 --add-label bug --add-reviewer alice')
  expect(labels.target).toBe('12')
  expect(labels.labels).toEqual(['bug'])
  expect(editsText(labels)).toBe(false)
  expect(editsText(one('gh pr edit https://github.com/o/r/pull/9 -b "new body"'))).toBe(true)
  expect(editsText(one('gh pr edit --body-file pr.md'))).toBe(true)
})

test('shell expansions are kept as written and flagged', () => {
  const c = one('gh pr create -t "$TITLE" --body "$(git log -1 --format=%B)"')
  expect(c.title).toBe('$TITLE')
  expect(c.body).toEqual({ kind: 'text', text: '$(git log -1 --format=%B)' })
  expect(c.isDynamic).toBe(true)
})

test('--dry-run is recorded', () => {
  expect(one('gh pr create -t T -b B --dry-run').dryRun).toBe(true)
})

test('other commands are not PR commands', () => {
  for (const cmd of [
    'echo "gh pr create --title x"',
    "git commit -m 'gh pr create'",
    'gh pr view 12',
    'gh pr list --state open',
    'gh issue create -t T -b B',
    'ghq get x',
    '# gh pr create -t T',
    'gh api repos/o/r/pulls -f title=x',
  ])
    expect(findPrCommands(cmd)).toEqual([])
})
