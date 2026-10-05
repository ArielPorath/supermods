# sensitive-paths

## What it does

Keeps Claude away from files that hold secrets. When Read, Edit, Write or NotebookEdit (and
Glob or Grep, in builds that have them) target a path matching a protected glob, the call is
refused, or put to your permission prompt if you prefer. Bash commands that name a protected
path are checked too, best effort. Claude gets a reason it can relay to you:

```
sensitive-paths blocked this Read call: ~/project/.env matches the protected pattern "**/.env".
Do not try to reach this file another way; tell the user. To allow it, the user adds a glob
covering it to the sensitive-paths plugin's "allowed" option.
```

Before matching, paths are resolved: `~` becomes your home, relative paths resolve against the
session's working directory, `.` and `..` are folded, and for the file tools a symlink is
followed to where it really lands. Matching ignores case.

**Protected by default:** `~/.ssh/**`, `~/.aws/credentials`, `~/.config/gcloud/**`,
`~/.netrc`, `~/.docker/config.json`, `~/.kube/config`, `~/.config/gh/hosts.yml`,
`**/.git-credentials`, `**/.env`, `**/.env.*`, `**/*.pem`,
`**/*.key`, `**/id_rsa*`, `**/id_ed25519*`, `**/*.p12`, `**/*.pfx`, `**/credentials.json`,
`**/.npmrc`, `**/.pypirc`.

**Always allowed:** `**/.env.example`, `**/.env.sample`, `**/.env.template`, `**/*.pub`.

`~/.aws/config` is deliberately not protected: it holds profiles and regions, not keys. Add it
to `protected` if yours holds more.

## Install

```
/plugin install sensitive-paths@supermods
```

## Configuration

| Option | Default | Effect |
|---|---|---|
| `protected` (list) | empty | Globs protected on top of the defaults. |
| `allowed` (list) | empty | Globs never blocked, even when a protected glob matches. Added to the built-in exceptions. |
| `check_bash` | `true` | Also check Bash commands. |
| `read_mode` | `deny` | Read, Glob, Grep on a protected path: `deny` refuses it, `ask` puts it to your permission prompt, `off` allows it. |
| `write_mode` | `deny` | Edit, Write, NotebookEdit on a protected path: same choices. Bash uses the stricter of the two modes. |

`check_bash`, `read_mode` and `write_mode` are rows in `/config`. The two lists are set when you
enable the plugin, or in `settings.json`:

```json
{ "pluginConfigs": { "sensitive-paths@supermods": { "options": {
  "protected": ["~/.vault-token", "**/secrets/**"],
  "allowed": ["**/fixtures/**/*.pem"]
} } } }
```

**Glob syntax:** `**` any number of folders (`dir/**` covers `dir` itself too), `*` and `?`
within one path segment, `{a,b}` alternatives. `~/` is your home, a glob starting with `/` is
absolute, and any other glob matches at any depth (`secrets.yml` means `**/secrets.yml`).

**About `ask`:** the call goes to your permission mode's decider. In the default mode that is
the permission dialog (a `-p` run refuses it). In auto mode the classifier decides, and it may
approve the call without asking you; bypass-permissions mode may approve it too. Use `deny`
when it must never happen.

## What it touches

From `claude plugin validate --strict`:

- **Events:** `tool.call` (refuses in `deny` mode, before the permission prompt, in every
  permission mode) and `tool.check` (answers `ask` or `deny` to the permission decision). Both
  hooks see every tool call; for tools it doesn't guard, the mod passes the call straight on.
- **Calls:** `$.session.cwd` (to resolve relative paths), `$.env.get` (reads `HOME` only),
  `$.fs.stat` (follows symlinks of the file tools' paths; it never reads file contents).
- **Environment writes, processes, network, model, store:** none. Nothing leaves your machine.

## Limitations

- **Bash is best effort.** It reads the command's words (arguments, redirect targets,
  `$(...)`, `--flag=value`, `$HOME`), not what the shell will do: variables other than
  `HOME`, wildcards (`cat .en*`), scripts that open files themselves, and paths built at run
  time get through. Arguments of `echo` and `printf` are treated as text, so
  `echo .env >> .gitignore` passes. A word that only looks like a protected path (`grep .env
  .gitignore`) is blocked; add an `allowed` glob or turn off `check_bash` if that bites.
- **Symlinks** are followed only for the file tools' own path, not inside Bash commands or
  Glob/Grep patterns. Hard links are not detected.
- **Glob and Grep:** a search rooted above a protected folder (Grep over your whole home) is
  not blocked; only a search whose folder or pattern names a protected path is. In builds where
  Glob and Grep run through Bash, the Bash check covers them.
- **macOS and Linux paths.** Windows paths (`C:\...`) are not normalized.
- Other tools that read files (MCP servers, LSP) are not checked.

## Development

```sh
claude plugin validate plugins/sensitive-paths --strict
claude plugin test plugins/sensitive-paths
npx -y -p typescript tsc -p plugins/sensitive-paths
```
