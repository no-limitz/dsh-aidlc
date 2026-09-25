/**
 * Preset-scoped half of the AI-DLC bundle: gives an agent the AI-DLC skills
 * (`/aidlc` and the per-scope/per-stage runners), the `aidlc_agent` dispatch
 * tool that runs the 14 AI-DLC agents as in-harness subagents with their
 * personas and per-tier model routes, and a prompt note that maps the Claude
 * Code vocabulary in AI-DLC prose onto harness tools.
 *
 * The engine hooks run from the host-plane `dsh-aidlc/hooks` row.
 * @module dsh-aidlc
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { findAidlcProject, loadAgents, loadSkills, type AidlcSkill } from './project.ts'
import { childAgents, takePromptRewrite } from './registry.ts'
import { readModelsFile, withModelsFile } from './models.ts'
import { routeFor, type RouteConfig, type RouteOptions } from './route.ts'
import { adaptationNote, blocksToText, DEFAULT_DISPATCH_TOOL, defangTemplate, TIERS, type Tier } from './translate.ts'

export const name = 'aidlc'
export const inject = ['tools', 'subagents', 'systemPrompt', 'skills']

export type { RouteConfig, RouteOptions } from './route.ts'

export interface Config extends RouteConfig {
  /** AI-DLC harness directory inside the project (the Claude projection uses `.claude`). */
  harnessDir: string
  /** `ctx.subagents` provider that runs AI-DLC agents. */
  provider: string
  /** Model-facing dispatch tool name. */
  toolName: string
  /** Absolute delegation-depth cap for AI-DLC children; omitted uses the host setting. */
  maxDepth?: number
  /** Skill-provider rank; lower wins name collisions (project `.dsh/skills` is 100). */
  skillRank: number
  /** Add the Claude-vocabulary translation note to the system prompt. */
  adaptationPrompt: boolean
}

const Route: z<RouteOptions> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  maxTokens: z.natural(),
})

export const Config: z<Config> = z.object({
  harnessDir: z.string().default('.claude'),
  provider: z.string().default('spawn'),
  toolName: z.string().default(DEFAULT_DISPATCH_TOOL),
  tiers: z.object({
    judgment: Route,
    balanced: Route,
    templated: Route,
  }).default({}),
  agentTiers: z.dict(z.union(TIERS as Tier[])).default({}),
  agentRoutes: z.dict(Route).default({}),
  maxDepth: z.natural(),
  skillRank: z.number().default(150),
  adaptationPrompt: z.boolean().default(true),
}) as z<Config>

/** Order just after the built-in subagent tool guidance (TOOL_SUBAGENT = 2800). */
const SECTION_ORDER = 2810

function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'AI-DLC agent was cancelled'
    case 'max-tokens': return 'AI-DLC agent hit its output token limit before finishing'
    case 'refusal': return 'AI-DLC agent declined the task'
    default: return `AI-DLC agent failed (${result.stopReason})`
  }
}

/** Await a foreground run, always disposing it, and return the child's final text. */
async function settle(run: SubagentRun): Promise<string> {
  try {
    const result = await run.result
    const text = blocksToText(result.output as ContentBlock[] as { type: string; text?: string }[])
    const error = stopReasonError(result)
    if (error !== undefined) {
      const detail = [error, result.diagnostic, text && `Partial output:\n${text}`].filter(Boolean).join('\n\n')
      throw new Error(detail)
    }
    return text
  } finally {
    await run.dispose()
  }
}

export function apply(ctx: Context, config: Config): void {
  const harnessDir = config.harnessDir
  const toolName = config.toolName

  // --- Skills: `<project>/<harnessDir>/skills/*/SKILL.md`, per lookup cwd. ---
  ctx.skills.registerProvider(() => {
    const provider: SkillProvider = {
      name: 'aidlc',
      async list({ cwd }) {
        const project = cwd === undefined ? undefined : findAidlcProject(cwd, harnessDir)
        if (!project) return []
        return loadSkills(project).map((skill): SkillCandidate => ({
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse ? { whenToUse: skill.whenToUse } : {},
          path: skill.path,
          invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
          source: 'aidlc',
          provider: 'aidlc',
          resourceBase: { kind: 'directory', path: skill.dir },
          rank: config.skillRank,
          locator: skill.path,
          metadata: skill.metadata,
        }))
      },
      async get(candidate, { cwd }) {
        const project = cwd === undefined ? undefined : findAidlcProject(cwd, harnessDir)
        const skill: AidlcSkill | undefined = project && loadSkills(project).find(s => s.path === candidate.locator)
        if (!skill) return undefined
        return {
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse ? { whenToUse: skill.whenToUse } : {},
          path: skill.path,
          invocation: candidate.invocation,
          source: 'aidlc',
          provider: 'aidlc',
          resourceBase: { kind: 'directory', path: skill.dir },
          metadata: skill.metadata,
          content: skill.body,
        }
      },
    }
    return provider
  })

  // --- Prompt note mapping Claude Code vocabulary to harness tools. ---
  if (config.adaptationPrompt) {
    ctx.systemPrompt.section({
      name: 'aidlc:adaptation',
      order: SECTION_ORDER,
      text: adaptationNote(toolName, harnessDir),
    })
  }

  // --- The dispatch tool: AI-DLC's `Task(subagent_type=…)`. ---
  ctx.tools.register(defineTool({
    name: toolName,
    description: [
      'Delegate one task to an AI-DLC agent (the Claude Code `Task` tool in AI-DLC instructions).',
      'The agent runs as a fresh subagent with its AI-DLC persona; it does not see this conversation, so the prompt must carry everything it needs.',
      'Use the agent name the AI-DLC engine directive gives you, e.g. aidlc-architect-agent, aidlc-developer-agent, aidlc-quality-agent.',
      'Returns the agent\'s final message.',
    ].join(' '),
    parameters: {
      subagent_type: { type: 'string', required: true, description: 'AI-DLC agent name, e.g. "aidlc-architect-agent".' },
      description: { type: 'string', required: true, description: 'Short (3-5 word) label for the delegated task.' },
      prompt: { type: 'string', required: true, description: 'The complete task brief for the agent.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value.length > 0 ? value : '(the agent returned no text)' }],
    },
    presentCall: args => ({ card: 'generic', title: `${args.subagent_type}: ${args.description}` }),
    // Independent children: AI-DLC's construction swarm dispatches several at once.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${toolName} requires a calling agent`)
      const cwd = parent.session.header.cwd
      const project = cwd === undefined ? undefined : findAidlcProject(cwd, harnessDir)
      if (!project) {
        throw new Error(`AI-DLC is not installed in this workspace (no ${harnessDir}/ projection found). Run \`aidlc config --harness claude\` in the project root.`)
      }
      const agents = loadAgents(project)
      const agent = agents.get(args.subagent_type)
      if (!agent) {
        throw new Error(`unknown AI-DLC agent "${args.subagent_type}". Available: ${[...agents.keys()].sort().join(', ')}`)
      }
      // The AI-DLC deliver-stage-rules PreToolUse hook may have rewritten the brief.
      const prompt = takePromptRewrite(exec.callId) ?? args.prompt
      // $DSH_HOME/aidlc-models.json (dsh-aidlc-models) layers over the row config per dispatch.
      const route = routeFor(withModelsFile(config, readModelsFile(undefined, message => ctx.logger.warn(message))), agent.name)
      // resolveMaxDepth() arrived after dsh 0.1.5; older hosts take the configured cap as-is.
      const maxDepth = typeof ctx.subagents.resolveMaxDepth === 'function'
        ? ctx.subagents.resolveMaxDepth(config.maxDepth)
        : config.maxDepth
      const persona = defangTemplate([
        agent.body,
        '',
        adaptationNote(toolName, harnessDir),
        '',
        `You are running as the AI-DLC ${agent.displayName ?? agent.name} (\`${agent.name}\`), delegated by the AI-DLC conductor. Do not delegate further. End with a concise report of what you produced and where.`,
      ].join('\n'))
      const run = await ctx.subagents.start(config.provider, {
        label: `${agent.name}: ${args.description}`,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        persona,
        signal: exec.signal,
        ...route !== undefined ? { agentOptions: route as AgentOptions } : {},
        ...maxDepth !== undefined ? { maxDepth } : {},
      })
      childAgents.set(run.id, agent.name)
      return settle(run)
    },
  }))
}
