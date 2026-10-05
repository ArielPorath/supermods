import type { EngineInterface, Register } from 'claude-code'

import { findViolations, parseConfig, reason } from './guard'
import type { Config } from './guard'

const GIT_TIMEOUT_MS = 5_000
// Cheap pre-filter so non-git commands never reach the parser.
const MENTIONS_GIT = /\bgit\b/

async function check($: EngineInterface, command: string, cfg: Config) {
  if (!MENTIONS_GIT.test(command)) return undefined
  const found = await findViolations(command, cfg, async (cwd, repoArgs) => {
    const { exitCode, stdout } = await $.process.run(
      ['git', ...repoArgs, 'branch', '--show-current'],
      { cwd, timeoutMs: GIT_TIMEOUT_MS },
    )
    return exitCode === 0 ? stdout.trim() : ''
  })
  return found[0] && reason(found[0], cfg)
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)

  if (cfg.action === 'deny') {
    // Refuse before the permission flow, so no rule, mode or prompt can let it through.
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      if (e.tool !== 'Bash') return next(e)
      const deny = await check($, e.command, cfg)
      return deny ? { deny } : next(e)
    })
  } else {
    // Turn the engine's verdict into an ask, so the user's permission prompt decides.
    on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
      const decided = await next(e)
      if (decided.decision === 'deny') return decided
      const input = e.input
      const command = typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined
      if (typeof command !== 'string') return decided
      const why = await check($, command, cfg)
      return why ? { decision: 'ask', reason: why } : decided
    })
  }
}
