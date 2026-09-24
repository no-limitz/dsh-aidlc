/**
 * Pure translation between DeepSeek Harness tool vocabulary and the Claude Code
 * vocabulary the AI-DLC engine hooks and prose were written against.
 * @module dsh-aidlc/translate
 */

/** AI-DLC model tiers (see `core/tools/aidlc-tiers.ts` upstream). */
export type Tier = 'judgment' | 'balanced' | 'templated'

export const TIERS: readonly Tier[] = ['judgment', 'balanced', 'templated']

/**
 * The default tier of each shipped AI-DLC agent. The Claude projection rewrites
 * `tier:` into `model: inherit`, so an installed agent file no longer carries
 * it; this table restores it from the upstream `core/agents/*.md` frontmatter.
 */
export const DEFAULT_AGENT_TIERS: Readonly<Record<string, Tier>> = {
  'aidlc-architect-agent': 'judgment',
  'aidlc-architecture-reviewer-agent': 'balanced',
  'aidlc-aws-platform-agent': 'judgment',
  'aidlc-compliance-agent': 'judgment',
  'aidlc-composer-agent': 'judgment',
  'aidlc-delivery-agent': 'templated',
  'aidlc-design-agent': 'judgment',
  'aidlc-developer-agent': 'judgment',
  'aidlc-devsecops-agent': 'judgment',
  'aidlc-operations-agent': 'templated',
  'aidlc-pipeline-deploy-agent': 'templated',
  'aidlc-product-agent': 'judgment',
  'aidlc-product-lead-agent': 'balanced',
  'aidlc-quality-agent': 'judgment',
}

/** Default name of the model-facing AI-DLC dispatch tool. */
export const DEFAULT_DISPATCH_TOOL = 'aidlc_agent'

/**
 * Harness tool name → Claude Code tool name, as the AI-DLC hook matchers and
 * hook bodies expect. Unlisted names pass through unchanged.
 */
export const DEFAULT_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  ask_user_question: 'AskUserQuestion',
  todo_write: 'TodoWrite',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  skill: 'Skill',
  [DEFAULT_DISPATCH_TOOL]: 'Task',
}

/**
 * Map one Harness tool name to its Claude Code name.
 * @param name - the Harness tool name.
 * @param map - the active name map.
 * @returns the Claude name, or `name` unchanged when unmapped.
 */
export function toClaudeToolName(name: string, map: Readonly<Record<string, string>>): string {
  return Object.hasOwn(map, name) ? map[name]! : name
}

/**
 * Replace `{{` so the Harness prompt registry's strict `{{variable}}`
 * interpolation cannot reject or rewrite AI-DLC prose used as a persona.
 * @param text - persona text.
 * @returns text with every `{{` broken up.
 */
export function defangTemplate(text: string): string {
  return text.replaceAll('{{', '{​{')
}

/**
 * Flatten text content blocks into one string (the shape hook payloads carry).
 * @param content - content blocks.
 * @returns the concatenated text of every text block.
 */
export function blocksToText(content: readonly { type: string; text?: string }[]): string {
  return content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
}

/**
 * The system-prompt note that maps the Claude Code vocabulary in AI-DLC
 * skills and agents onto this harness's tools.
 * @param dispatchTool - the configured dispatch tool name.
 * @param harnessDir - the AI-DLC harness directory (e.g. `.claude`).
 * @returns the prompt text.
 */
export function adaptationNote(dispatchTool: string, harnessDir: string): string {
  return [
    '# AI-DLC on DeepSeek Harness',
    `AI-DLC skills and agents (under \`${harnessDir}/\`) were written for Claude Code. Apply them unchanged, translating tool names:`,
    `- \`Task\` / \`Agent\` with \`subagent_type: <agent>\` → call \`${dispatchTool}\` with the same \`subagent_type\`, \`description\`, and \`prompt\`.`,
    '- `AskUserQuestion` → `ask_user_question`. `TaskCreate` / `TaskUpdate` / `TodoWrite` → `todo_write`.',
    '- `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch` → `read`, `write`, `edit`, `bash`, `glob`, `grep`, `web_search`, `web_fetch`.',
    '- `$ARGUMENTS` means the text the user typed after the skill\'s `/name`; pass it through verbatim (empty when none).',
    '- `$CLAUDE_PROJECT_DIR` is the workspace root; it is also exported to every shell command.',
    'Run AI-DLC engine commands (`aidlc engine …` or `bun …/tools/aidlc.ts …`) with `bash` exactly as the instructions give them.',
    'AI-DLC guards treat any shell redirection target (including `2>/dev/null`) as a workspace write; during Code Generation, avoid redirections until the plan is approved, and when a guard denies a call, follow its stated remedy rather than retrying.',
  ].join('\n')
}
