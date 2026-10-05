# supermods

**A curated, tested marketplace of mods for Claude Code.**

Mods let you reshape Claude Code itself: guard risky commands, rewrite prompts, redact
secrets, add panes and slash commands, or replace built-in behavior. supermods gathers mods
that are generic, configurable, and tested, so you can install them without reading every line
first. You should still check the "What it touches" section of each mod's README.

```
/plugin marketplace add ArielPorath/supermods
/plugin install <mod-name>@supermods
```

---

- [Mods in one minute](#mods-in-one-minute)
- [Catalog](#catalog)
- [Using mods](#using-mods)
- [Building a mod](#building-a-mod)
- [Contributing](#contributing)
- [Reference](#reference)
- [License](#license)

---

## Mods in one minute

A **mod** is a small TypeScript (or JavaScript) module that runs inside Claude Code. Anthropic
introduced mods in October 2026 (early access, Claude Code v2.1.287+). A mod registers
handlers for engine events, such as a tool about to run, a prompt being submitted, a turn
starting, or part of the UI being drawn. For each event, the handler can:

- **observe** it and let it pass,
- **rewrite** it, for example by changing a prompt or a tool's arguments,
- **answer** it directly, by denying a tool call or returning a result itself,
- **wrap** it, running code both before and after Claude Code's own behavior.

Mods can also draw UI, such as panes, buttons, inputs, and status lines, and register slash
commands. They ship inside ordinary **plugins**, so you install, update, and remove them the
same way as plugins.

### How mods relate to everything else

| Layer | What it is | Answers the question |
|---|---|---|
| **MCP server** | A connection to an external system | *What can Claude reach?* |
| **Tool** | One function Claude can call | *What can Claude do?* |
| **Skill** | Instructions loaded when relevant | *How should Claude go about a task?* |
| **Settings hook** | A shell command run on lifecycle events | *What should run when X happens?* |
| **Mod** | Code running inside the engine, on every event | *How does Claude Code itself behave and look?* |

Skills steer the model. Mods change the program the model runs in. Use both together: a mod can
enforce a rule that a skill only asks for.

## Catalog

Each mod lives in [`plugins/`](plugins/) and is listed in
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

| Category | What belongs here |
|---|---|
| 🛡️ **Safety & guardrails** | Block, confirm, or rewrite risky tool calls; redact secrets |
| ✍️ **Prompting & context** | Rewrite prompts, inject context, tune system prompt sections |
| 🖥️ **Interface** | Panes, status lines, custom renders of tool results and messages |
| ⚡ **Workflow & commands** | New slash commands, automations, turn and session lifecycle |
| 🔌 **Integrations** | Show data from external CLIs and services inside Claude Code |
| 📊 **Observability** | Usage, cost, and timing insight into sessions and agents |

| Mod | Category | Description |
|---|---|---|
| *The first mods are on their way. Want to write one? See [Contributing](#contributing).* | | |

## Using mods

**Install from this marketplace**

```
/plugin marketplace add ArielPorath/supermods
/plugin install <mod-name>@supermods
```

Use `/plugin` to list, enable, or disable installed mods, and
`claude plugin update <mod-name>@supermods` to update one. Mods that expose settings can be
configured with `claude plugin configure <mod-name>@supermods`.

**Try a mod straight from a checkout**

```bash
git clone https://github.com/ArielPorath/supermods
claude --plugin-dir supermods/plugins/<mod-name>   # loads it with hot reload
```

**Trust and safety.** Mods are **not sandboxed**. They run with the same access to your machine
as Claude Code. Before installing any mod, from here or anywhere else, run:

```bash
claude plugin validate path/to/mod
```

It lists every event the mod hooks and every capability it calls (files, processes, network,
model). Every mod in this repo documents the same information in its README. Organizations can
control which mods load through managed settings. See the
[admin docs](https://code.claude.com/docs/en/plugins/mods/admin).

## Building a mod

### The fast way

Open this repo in Claude Code and describe the mod you want:

```
> create a mod that blocks git force-pushes
```

The repo's [`create-mod`](.claude/skills/create-mod/SKILL.md) skill takes over. It scaffolds
the mod, makes it generic and configurable, writes tests for each surface, runs validation,
registers the mod in the marketplace, and stops when the change is ready to commit.

### Anatomy

```
plugins/<mod-name>/
├── .claude-plugin/plugin.json   # name, version, description, author, userConfig
├── hooks/
│   ├── hooks.json               # { "modules": ["./register.ts"] }
│   └── register.ts              # the mod
├── tests/<mod-name>.test.ts     # run with `claude plugin test`
└── README.md                    # what it does, config, what it touches
```

### A complete, minimal mod

`hooks/register.ts`:

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (/\bgit\s+push\b.*(--force\b|\s-f\b)/.test(e.command)) {
      return { deny: 'Force-push blocked by the no-force-push mod.' }
    }
    return next(e)
  })
}
```

`tests/no-force-push.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

test('denies a force-push and lets other commands through', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  expect(await $.tool.call({ tool: 'Bash', command: 'git push --force' })).toMatchObject({ deny: expect.any(String) })
  expect(await $.tool.call({ tool: 'Bash', command: 'git push' })).toMatchObject({ result: 'ran' })
})
```

### The quality bar

A mod is merged only when it meets all of the following:

- **Generic.** No hard-coded paths, usernames, orgs, or URLs. Anything a user might want to
  change is a `userConfig` option with a sensible default.
- **Focused.** One job, the fewest events, and the narrowest capabilities that do it.
- **Well-behaved.** Every hook either calls `next` or answers on purpose. Failures show up as
  short messages and never break Claude Code. Hooks stay inside their time budget.
- **Tested.** Covers the main path, the failure paths, and each config option, on both the
  `terminal` and `desktop` surfaces, with no real network or filesystem access.
- **Verified.** `claude plugin validate --strict`, `claude plugin test`, and `tsc` all pass.
- **Documented.** The README explains what the mod does, how to install it, how to configure
  it, what it touches, and its limitations.

The full checklist lives in the [`create-mod` skill](.claude/skills/create-mod/SKILL.md).

## Contributing

New mods and improvements to existing mods are welcome.

1. **Start from a real need.** Mods that solve a problem someone actually had are the ones
   people install.
2. **Check the catalog** for an existing mod you could extend instead.
3. **Build it** under `plugins/<mod-name>/`, ideally with the `create-mod` skill.
4. **Verify it:**
   ```bash
   claude plugin validate plugins/<mod-name> --strict
   claude plugin test plugins/<mod-name>
   claude plugin validate . --strict          # marketplace entry agrees with plugin.json
   ```
5. **Open a pull request.** Describe the problem the mod solves, paste the `validate` output,
   and add a screenshot if the mod has UI.

Pull requests are reviewed against the [quality bar](#the-quality-bar). Mods that send data off
the machine, or that loosen permission checks, get extra scrutiny and must say so in the first
line of their README.

## Reference

**Official documentation**

- [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview): what mods are and how they load
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create): step-by-step first mod
- [React to events](https://code.claude.com/docs/en/plugins/mods/events): the event catalog and hook semantics
- [Draw in the interface](https://code.claude.com/docs/en/plugins/mods/interface): panes, render sites, elements
- [Use the mods API](https://code.claude.com/docs/en/plugins/mods/api): everything on `$`
- [Test a mod](https://code.claude.com/docs/en/plugins/mods/test): `claude-code/testing`
- [Troubleshoot a mod](https://code.claude.com/docs/en/plugins/mods/troubleshoot)
- [Reference](https://code.claude.com/docs/en/plugins/mods/reference): limits, ordering, file rules
- [Manage mods](https://code.claude.com/docs/en/plugins/mods/admin): managed settings for organizations
- [Plugins](https://code.claude.com/docs/en/plugins) and [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Customize Claude Code with mods in TypeScript](https://claude.com/blog/claude-code-mods): announcement post

**The exact API for your version.** When Claude Code loads a mod, it writes the full typed
contract to `.claude-plugin/types/claude-code/index.d.ts` beside the mod. The mods API is early
access and changes between releases, so when the docs and that file disagree, trust the file.

## License

[MIT](LICENSE). Individual mods may use a different license, declared in their `plugin.json`.
