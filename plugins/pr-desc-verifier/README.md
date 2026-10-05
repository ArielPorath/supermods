# pr-desc-verifier

## What it does

Before Claude runs `gh pr create` or `gh pr edit` (when the edit changes the title or body),
the mod holds the command and shows you the PR's title and description. Nothing runs until
you approve it. If you reject it, Claude is told why and revises.

The question comes up in Claude Code's own question dialog, with a summary above it. The
full description, rendered as markdown, opens in a **PR review** pane beside the transcript:

```
╭─────────────────────────────────────────────────────────────────────────────────╮
│ gh pr create                                                                    │
│ Add login retry                                                                 │
│ main ← current branch · reviewers: alice, bob · labels: bug · body from --body… │
│ ## Summary                                                                      │
│ - Adds **login retry** with backoff                                             │
│ - Fixes `timeout` bug in session refresh                                        │
│ - Logs retries at debug level                                                   │
│ … 6 more lines in the PR review pane                                            │
╰─────────────────────────────────────────────────────────────────────────────────╯
 ☐ PR review
Open PR "Add login retry" with this description?
❯ 1. Approve
  2. Reject
  3. Type something.
  4. Chat about this
```

- **Approve** runs the command. Your usual permission rules still apply after that.
- **Reject** blocks the command. Claude is told to ask you what to change.
- **Type something** blocks the command and passes your text to Claude as feedback, for
  example `mention the ticket number`. Claude revises the PR and runs the command again, and
  you review the new version.
- **Esc** or **Chat about this** blocks the command, and Claude asks you how to proceed.

Each approval covers one run of one command. If Claude runs the same command again, you're
asked again.

The mod reads:

- `--title/-t`, `--body/-b` (including the `--body "$(cat <<'EOF' … EOF)"` heredoc form
  Claude usually writes), and `--body-file/-F <file>` (it reads the file).
- `--body-file -` fed by a heredoc. When the body comes from a pipe, the dialog says the
  body can't be shown.
- `--fill`, `--fill-first`, `--fill-verbose`. The dialog says the title and body are
  auto-filled from commits.
- The base and head branches, draft status, reviewers, labels, assignees and `-R/--repo`.
- PR commands in chains (`git push && gh pr create …`), behind `VAR=value` or `env`
  prefixes, and called by a full path to `gh`. A chain with several PR commands asks
  about each one.

## Install

```
/plugin install pr-desc-verifier@supermods
```

Needs nothing else: the mod reads the command Claude is about to run. `gh` is only needed
for the command itself.

## Configuration

Each option is a row in `/config`.

| Option | Default | Effect |
|---|---|---|
| `guardCreate` | `true` | Asks before `gh pr create` (and its alias `gh pr new`). |
| `guardEdit` | `true` | Asks before a `gh pr edit` that changes the title or body. Edits that only change labels, reviewers, assignees or the base never ask. |
| `guardFill` | `true` | Also asks when `--fill`, `--fill-first` or `--fill-verbose` fills both the title and the body. Set it to `false` to let those through. A `--fill` with a title or body Claude wrote still asks. |
| `exemptDrafts` | `false` | Lets `gh pr create --draft` through without asking. |

`gh pr create --dry-run` never asks, because it creates nothing.

## What it touches

From `claude plugin validate --strict`:

- **Events:** `tool.call` for `Bash`, which parses each command and holds PR commands for
  your answer. `ui.render` for `AskUserQuestion`, which draws the summary above its own
  question and leaves every other question alone. `ui.render` for its own `pr-desc-verifier`
  pane.
- **Calls:** `$.ui.ask` (the question), `$.ui.open` / `$.ui.close` (the pane, open only
  while a question is waiting), `$.ui.resolve`, `$.state` (the review waiting for an answer,
  this session only).
- **Files:** `$.fs.read`, only for the file named by `--body-file`, to show you its content.
  Nothing is written.
- **Processes, network, model:** none. The PR text doesn't leave Claude Code.

## Limitations

- **The full description needs a wide terminal.** Claude Code places a pane nobody asked
  for only at 144 columns or wider. In a narrower terminal, the dialog shows a summary of
  about ten lines and says to widen the window. The summary is short because Claude Code
  limits what a mod can draw around its dialog to about 12 rows.
- **`claude -p` and other sessions with nobody to ask:** guarded PR commands are always
  blocked there, and Claude is told that approval isn't possible. Turn the matching option
  off when you run Claude headless and still want it to open PRs.
- **You may be asked twice.** After you approve, Claude Code's own permission check still
  runs. If `gh pr create` isn't allowed in your permission rules, that prompt follows. To be
  asked only by this mod, add `Bash(gh pr create:*)` and `Bash(gh pr edit:*)` to your
  allowed rules.
- **Shell expansions aren't run.** `--body "$BODY"` or `--title "$(git log -1 --format=%s)"`
  is shown as written, with a warning. Only `$(cat <<EOF … EOF)` is expanded.
- **Paths are relative to the session's directory.** A `--body-file` after `cd elsewhere &&`
  is read from the session's working directory. If that file doesn't exist, the dialog
  says it couldn't read the file, and you still decide.
- **`--fill` text isn't shown.** The mod doesn't run `git log` to show what `--fill` will
  write.
- **Only `gh` commands Claude runs are checked.** A PR opened through an MCP tool, the
  GitHub API (`gh api`), or a script that calls `gh` isn't checked.

## Development

```sh
claude plugin validate plugins/pr-desc-verifier --strict
claude plugin test plugins/pr-desc-verifier
npx -y -p typescript tsc -p plugins/pr-desc-verifier
```
