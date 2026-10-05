/** One PR command awaiting the user's approval, as the dialog shows it. */
export type Review = {
  question: string // the dialog's question; also the key the render hook looks the review up by
  heading: string // `gh pr create → owner/repo`
  title: string
  meta: string[] // base ← head, draft, reviewers, labels, where the body comes from
  body: string // markdown, or a note in italics when the body is not known
  notes: string[] // warnings: unexpanded shell, truncation
  isPaneHidden?: boolean // the full-text pane could not be placed (a narrow terminal)
}

declare module 'claude-code' {
  interface PluginState {
    'pr-desc-verifier': { pending: Record<string, Review> }
  }
}
