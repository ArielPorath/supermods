import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { editsText, findPrCommands } from './parse'
import type { PrCommand } from './parse'
import { APPROVE, REJECT, buildReview, denyText, inlineBody, reviewMarkdown, summaryLines } from './preview'
import type { BodyText, Review, SummaryLine } from './preview'

const HEADER = 'PR review' // the dialog's chip: 12 characters at most
const SUMMARY_ROWS = 12 // the most the engine draws around its dialog
const BORDER_ROWS = 2
const PANE = 'pr-desc-verifier'
const PANE_TITLE = 'PR review'
const COLORS: Record<SummaryLine['kind'], string | undefined> = {
  heading: undefined, title: undefined, meta: 'cyan', note: 'yellow', body: undefined, dim: undefined,
}
// Reviews waiting on the dialog, by question: the render hooks draw the one its dialog asks.
const pending = atom({ plugin: 'pr-desc-verifier', key: 'pending' } as const, {} as Record<string, Review>)

type Config = { create: boolean; edit: boolean; fill: boolean; exemptDrafts: boolean }

function readConfig(options: PluginOptions): Config {
  return {
    create: options.guardCreate !== false,
    edit: options.guardEdit !== false,
    fill: options.guardFill !== false,
    exemptDrafts: options.exemptDrafts === true,
  }
}

/** Whether this command needs the user's approval under `cfg`. */
function needsReview(cmd: PrCommand, cfg: Config): boolean {
  if (cmd.dryRun) return false
  if (cmd.subcommand === 'edit') return cfg.edit && editsText(cmd)
  if (!cfg.create) return false
  if (cfg.exemptDrafts && cmd.draft) return false
  const allFilled = cmd.fill !== undefined && cmd.title === undefined && cmd.body.kind === 'fill'
  return !(allFilled && !cfg.fill)
}

async function resolveBody($: EngineInterface, cmd: PrCommand): Promise<BodyText> {
  if (cmd.body.kind !== 'file') return inlineBody(cmd)
  try {
    return { text: await $.fs.read(cmd.body.path) }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { note: `Could not read body file ${cmd.body.path}: ${why}` }
  }
}

// Resolves to the user's answer: a label, their typed feedback, or undefined when the
// dialog was dismissed or nobody can answer (a `-p` run).
async function askUser($: EngineInterface, review: Review): Promise<string | undefined> {
  await update($, pending, all => ({ ...all, [review.question]: review }))
  try {
    // A narrow terminal does not place a pane nobody asked for; the summary then says so.
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
    if (opened?.isPlaced === false)
      await update($, pending, all => ({ ...all, [review.question]: { ...review, isPaneHidden: true } }))
    return await $.ui.ask(review.question, { options: [APPROVE, REJECT], header: HEADER })
  } catch {
    return undefined
  } finally {
    const others = await update($, pending, ({ [review.question]: _, ...rest }) => rest)
    if (!Object.keys(others).length) await $.ui.close({ id: PANE }).catch(() => undefined)
  }
}

function questionOf(q: unknown): string {
  return typeof q === 'object' && q !== null && 'question' in q && typeof q.question === 'string'
    ? q.question
    : ''
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const commands = findPrCommands(e.command).filter(c => needsReview(c, cfg))
    // A chain such as `gh pr create ... && gh pr edit ...` is reviewed one PR command at a time.
    for (const cmd of commands) {
      const review = buildReview(cmd, await resolveBody($, cmd))
      const answer = await askUser($, review)
      if (answer !== APPROVE) return { deny: denyText(answer) }
    }
    return next(e)
  })

  // A compact summary above the engine's own question dialog.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const review = (await read($, pending))[questionOf(e.props.questions[0])]
    if (!review) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const dialog = await next(e)
    return (
      <Box flexDirection="column">
        <Box key="pr-summary" flexDirection="column" borderStyle="round" paddingX={1}>
          {summaryLines(review, SUMMARY_ROWS - BORDER_ROWS).map(l => (
            <Text wrap="truncate" bold={l.kind === 'title'} dimColor={l.kind === 'dim' || l.kind === 'heading'} color={COLORS[l.kind]}>
              {l.text}
            </Text>
          ))}
        </Box>
        {dialog}
      </Box>
    )
  })

  // The whole description, rendered, while a review is pending.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Markdown, Text } = $.ui.resolve(e)
    const reviews = Object.values(await read($, pending))
    if (!reviews.length) return <Text dimColor>No pull request is waiting for review.</Text>
    return (
      <Box flexDirection="column" gap={1}>
        {reviews.map((r, i) => <Markdown key={`review-${i}`} text={reviewMarkdown(r)} />)}
      </Box>
    )
  })
}
