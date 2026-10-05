# worktrees

## What it does

Adds `/worktrees`: a pane listing the current repo's git worktrees: each one's branch (or
detached SHA), how many files are changed, how far it is ahead of or behind its upstream, its
last commit, and markers for locked and prunable worktrees. `●` marks the worktree this session
is in.

```
5 worktrees [ Refresh ]
  main clean 6m first commit
…/wtdemo/repo [ copy ]
  detached c655a2e 1 changed 6m first commit
…/wtdemo/det [ copy ]
● feat 1 changed ↑1 ↓0 2m feat: second commit ahead
…/wtdemo/feat [ copy ]
  gone [prunable]
…/wtdemo/gone
  lk [locked: on usb] clean no upstream 6m first commit
…/wtdemo/locked [ copy ]
updated 10:24:25 PM · every 15s
```

The pane refreshes when you open it, when you press **Refresh** (or `r` while the pane has
focus), and on an interval while it is open. The interval stops when you close the pane. Each
row has a button that copies the worktree's path or puts `cd <path>` in the prompt (see
Configuration).

## Install

```
/plugin install worktrees@supermods
```

Requires `git` on your `PATH`.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `refresh_seconds` | `15` | How often the open pane refreshes, in seconds (0–3600). `0` turns automatic refresh off; Refresh still works. |
| `max_parallel` | `4` | How many worktrees are inspected at once (1–16). |
| `row_action` | `copy-path` | The row button: `copy-path` copies the path to the clipboard, `insert-cd` inserts `cd <path>` at the prompt's cursor, `none` hides the button. |

Each option is a row in `/config`. Changing one applies at once.

## What it touches

From `claude plugin validate --strict`:

- **Events:** `session.start` (registers `/worktrees`; resumes refreshing if the pane is already
  open after a reload), `command.run` for `/worktrees`, `ui.close` for its own pane (stops the
  timer), `ui.render` for its own pane.
- **Processes:** `$.process.run`, only `git`, always with `--no-optional-locks` so a refresh
  never takes `index.lock` away from your own git commands:
  - `git worktree list --porcelain` and `git rev-parse --show-toplevel`, in the session's
    directory;
  - per worktree: `git -C <path> status --porcelain=v2 --branch` and
    `git -C <path> log -1 --format=%ct%x00%s`. Bare and prunable worktrees are skipped.
- **Other calls:** `$.clock.every`/`$.clock.now` (refresh timer), `$.ui.open`/`$.ui.panes`
  (its pane), `$.ui.copy` (copy-path), `$.prompt.fill` (insert-cd), `$.ui.toast` (copy result),
  `$.session.cwd` (named in the "not a git repository" message).
- **State:** its own session state (`snapshot`); no files, no store.
- **Network:** none. Nothing leaves your machine.

## Limitations

- Ahead/behind is shown only for branches with an upstream; a branch without one says
  `no upstream`. It reflects your last fetch: the mod never fetches.
- The repo is the one the session's directory is in. A shell `cd` inside the session does not
  change it.
- The pane shows as many worktrees as fit its height, then `…and N more`.
- `insert-cd` puts `cd <path>` in the prompt as text. Prefix it with `!` to run it as a shell
  command.
- The terminal copies through its clipboard tool or OSC 52; a terminal that drops OSC 52 may
  report a copy that didn't land.

## Development

```sh
claude plugin validate plugins/worktrees --strict
claude plugin test plugins/worktrees
npx -y -p typescript tsc -p plugins/worktrees
```
