export interface Profile {
  name: string;
  description: string;
  model?: string;
  /** The text added to the system prompt (frontmatter removed; `console:` keys are the console's, not Claude's). */
  body: string;
  /** `console: read_only: true`: the session may not change anything (a reviewer); enforced by the guard. */
  readOnly: boolean;
  /** `console: budget_tokens: N`: the token budget of this profile's sessions (SPEC 16); absent means the configured default. */
  budgetTokens?: number;
  source: 'project' | 'user' | 'shipped';
}
