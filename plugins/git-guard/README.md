# git-guard

## What it does

Stops the risky git commands Claude runs through Bash before they run: force pushes, pushes to
`main`/`master`, `reset --hard`, `clean -f`, `branch -D`, discarding all uncommitted changes,
dropping stashes, and rebasing a protected branch. By default it refuses them and tells Claude
which rule fired and how to turn it off. Set it to `ask` and they go to your permission prompt
instead.

```
git-guard blocked `git push --force origin feat`: rule "force push". Do not work around it;
ask the user to run it themselves or to allow it. To turn this rule off, set forcePush to false
for git-guard in /config.
```

It reads the command the way a shell would: chained commands (`&&`, `||`, `;`, `|`, `&`,
newlines, `( )`, `$( )`), `git -C dir` and other global options, `VAR=x git ...`, `env`/`sudo`
wrappers, `bash -c '...'`, and a `cd dir &&` earlier in the chain. Quoted text such as a commit
message, a comment, or a heredoc body is never treated as a command.

| Rule (option) | Flags | Lets through |
|---|---|---|
| `forcePush` | `push --force`, `-f` (also clustered, `-uf`), `--mirror`, `+refspec` | `--force-with-lease` (see `allowForceWithLease`), `--dry-run` |
| `protectedPush` | `push origin main`, `HEAD:main`, `feat:refs/heads/main`, `:main`, `--all`; `push` / `push origin` / `push origin HEAD` while on a protected branch | pushes to other branches, `--tags` |
| `resetHard` | `reset --hard` | `reset`, `--soft`, `--mixed` |
| `clean` | `clean -f`, `-fd`, `-fdx`, `--force` | `-n` / `--dry-run` |
| `branchForceDelete` | `branch -D`, `--delete --force`, `-df` | `branch -d` |
| `discardChanges` | `checkout -- .`, `checkout .`, `restore .`, the `:/` pathspec | single paths, `restore --staged .` |
| `stashDrop` | `stash drop`, `stash clear` | `stash`, `pop`, `list` |
| `rebaseProtected` | `rebase` while on a protected branch, or `rebase <upstream> main` | `--continue`, `--abort`, `--skip`, `--quit` |

## Install

```
/plugin install git-guard@supermods
```

## Configuration

Every option is a row in `/config`. A change applies at once.

| Option | Default | Effect |
|---|---|---|
| `action` | `deny` | `deny` refuses a match before the permission flow, so no allow rule or mode lets it through. `ask` turns the permission decision for a match into an ask, so your permission prompt decides. |
| `protectedBranches` | `main,master` | Comma-separated branch names the push and rebase rules guard. |
| `forcePush` | `true` | The force-push rule. |
| `allowForceWithLease` | `true` | Let `--force-with-lease` past the force-push rule. It is still a push, so pushing it to a protected branch is still caught. |
| `protectedPush` | `true` | The protected-branch push rule. |
| `resetHard` | `true` | The `reset --hard` rule. |
| `clean` | `true` | The `clean -f` rule. |
| `branchForceDelete` | `true` | The `branch -D` rule. |
| `discardChanges` | `true` | The `checkout -- .` / `restore .` rule. |
| `stashDrop` | `true` | The `stash drop` / `clear` rule. |
| `rebaseProtected` | `true` | The protected-branch rebase rule. |

## What it touches

From `claude plugin validate --strict`:

- **Events:** `tool.call` for `Bash` when `action` is `deny`; `tool.check` for `Bash` when it is
  `ask`. Only one is registered at a time. Other tools are never looked at.
- **Processes:** `$.process.run` for exactly `git [-C dir | --git-dir … | --work-tree …] branch
  --show-current`, in the session's directory or the one a preceding `cd` names. It runs only
  when a rule needs the checked-out branch: a push with no refspec or to `HEAD`, or a rebase.
  Commands that don't mention `git` are never parsed.
- **Files, network, model, state:** none. Nothing leaves your machine.

## Limitations

- **A text guard, not a security boundary.** It reads the command text. Git aliases, scripts
  (`./deploy.sh`), variables (`git $CMD`), `xargs`, `eval`, `$( )` inside double quotes, or a
  `sudo -u user git` form get past it. Protect branches on your git host as well.
- **The branch is the session's.** A push with no refspec is judged against the branch checked
  out in the session's directory, or the directory a `cd` / `-C` in the same command names. A
  `cd` from an earlier Bash call isn't tracked. It assumes the push goes to the branch of the
  same name (git's default `push.default=simple`). If git can't name the branch (detached HEAD,
  not a repository), the push and rebase rules don't fire.
- **`ask` follows your permission mode.** It hands the call to whatever decides asks: the
  dialog normally, the classifier in `auto` mode. In `claude -p` it is refused with the reason.
  Use `deny` if a guard must hold in every mode.
- **`discardChanges` covers the whole tree only** (`.`, `:/`, `*`). `git checkout -- file`
  isn't flagged.

## Development

```sh
claude plugin validate plugins/git-guard --strict
claude plugin test plugins/git-guard
npx -y -p typescript tsc -p plugins/git-guard
```
