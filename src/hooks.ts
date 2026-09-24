/**
 * Host-plane half of the AI-DLC bundle: runs the AI-DLC engine hooks declared
 * in a workspace's `<harnessDir>/settings.json` on the harness interception
 * seams, translating harness tool vocabulary into the Claude Code payloads the
 * engine expects.
 *
 * Unlike the generic `dsh-hooks-claude-code` bridge, it:
 * - discovers the hook config per session workspace (only AI-DLC projects fire);
 * - maps tool names (`write` → `Write`, `aidlc_agent` → `Task`, …) before matching;
 * - reports the real AI-DLC agent as `agent_type` for calls made inside a
 *   delegated agent, so reviewer-scope and state guards see who is acting;
 * - honours the `deliver-stage-rules` prompt rewrite for `aidlc_agent`;
 * - keeps subagent sessions out of SessionStart / UserPromptSubmit / Stop, as
 *   Claude Code does, so a child never records a human turn.
 * @module dsh-aidlc/hooks
 */

import { homedir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  type HookOutput,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
import type {} from '@deepseek-ai/dsh-subagent'
import { findAidlcProject, loadHookConfig, type AidlcProject } from './project.ts'
import { runHookCommand, type AnyShellExecutor } from './shell.ts'
import { childAgents, promptRewrites } from './registry.ts'
import { blocksToText, DEFAULT_DISPATCH_TOOL, DEFAULT_TOOL_NAME_MAP, toClaudeToolName } from './translate.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'aidlc-hooks': { kind: 'aidlc-hooks' } & ContextFormed
  }
}

export const name = 'aidlc-hooks'
export const inject = ['shell', 'sessionProjections']

export interface Config {
  /** AI-DLC harness directory inside the project (the Claude projection uses `.claude`). */
  harnessDir: string
  /** Name of the dispatch tool registered by the `dsh-aidlc` preset row. */
  dispatchToolName: string
  /** Extra harness → Claude tool-name mappings, merged over the defaults. */
  toolNameMap: Record<string, string>
  /**
   * Directories prepended to `PATH` for hook processes so the engine command
   * (`aidlc`, or `bun` for copy installs) resolves even when the harness shell
   * starts with a minimal `PATH`. `~` expands to the home directory; the
   * default is the AI-DLC installer's `~/.local/bin`.
   */
  extraPath: string[]
  /** Per-hook timeout when a hook sets none. */
  defaultTimeoutMs: number
  /** Character cap on the persisted `hook/result` stderr summary. */
  stderrSummaryMaxChars: number
  /** Log every hook run (event, command, exit code, stderr head) as a warning. */
  debug: boolean
}

export const Config: z<Config> = z.object({
  harnessDir: z.string().default('.claude'),
  dispatchToolName: z.string().default(DEFAULT_DISPATCH_TOOL),
  toolNameMap: z.dict(z.string()).default({}),
  extraPath: z.array(z.string()).default(['~/.local/bin']),
  defaultTimeoutMs: z.natural().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.natural().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  debug: z.boolean().default(false),
}) as z<Config>

const SOURCE: MessageSource = { kind: 'aidlc-hooks' }

let handlerCounter = 0

/** Single-quote a string for POSIX sh. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Context Claude Code takes from a successful SessionStart / UserPromptSubmit
 * hook's stdout beyond `hookSpecificOutput.additionalContext`: a top-level
 * `additionalContext` string (AI-DLC's session-start emits this shape), or
 * plain non-JSON text.
 * @param outputs - the hooks' decoded outputs.
 * @returns extra context strings, in hook order.
 */
export function stdoutContext(outputs: readonly Pick<HookOutput, 'exitCode' | 'stdout'>[]): string[] {
  const texts: string[] = []
  for (const output of outputs) {
    const stdout = output.stdout.trim()
    if (output.exitCode !== 0 || stdout === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      texts.push(stdout)
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { additionalContext?: unknown }).additionalContext === 'string') {
      texts.push((parsed as { additionalContext: string }).additionalContext)
    }
  }
  return texts
}

/** Whether a session was created as a delegated child. */
function isSubagent(agent: Agent | undefined): boolean {
  return agent?.session.header.origin === 'subagent'
}

export function apply(ctx: Context, config: Config): void {
  const nameMap: Record<string, string> = {
    ...DEFAULT_TOOL_NAME_MAP,
    [config.dispatchToolName]: 'Task',
    ...config.toolNameMap,
  }
  const hookPath = [
    ...config.extraPath.map(dir => dir === '~' || dir.startsWith('~/') ? resolve(homedir(), dir.slice(2)) : dir),
    ...(process.env.PATH ?? '').split(delimiter),
  ].filter((dir, i, all) => dir !== '' && all.indexOf(dir) === i).join(delimiter)
  const pathPrefix = `export PATH=${shellQuote(hookPath)}; `
  const detached = createDetachedRuns()
  const subagentCwd = new Map<string, string>()
  ctx.effect(() => () => detached.drain(), 'aidlc-hooks: drain detached hook runs')

  function projectOf(cwd: string | undefined): AidlcProject | undefined {
    return cwd === undefined ? undefined : findAidlcProject(cwd, config.harnessDir)
  }

  function lastTurn(agent: Agent | undefined): number | undefined {
    if (!agent) return undefined
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary') as TurnBoundaryProjection
    return boundary.lastTurn
  }

  /** Common Claude Code payload fields. */
  function base(agent: Agent | undefined, event: string, project: AidlcProject): Record<string, unknown> {
    const sessionId = agent?.session.header.id ?? ''
    const agentType = childAgents.get(sessionId)
    return {
      session_id: sessionId,
      transcript_path: '',
      cwd: project.projectDir,
      hook_event_name: event,
      ...agentType !== undefined ? { agent_type: agentType, agent_id: sessionId } : {},
    }
  }

  /**
   * Run every hook for `event` in `project` whose matcher selects `subject`.
   * @returns the merged outcome plus the raw outputs (for `updatedInput`).
   */
  async function runEvent(
    project: AidlcProject,
    event: string,
    subject: string,
    payload: Record<string, unknown>,
    opts: { agent?: Agent; turn?: number; signal: AbortSignal },
  ): Promise<{ merged: MergedHookOutcome; outputs: HookOutput[] }> {
    const groups = loadHookConfig(project)[event] ?? []
    const outputs: HookOutput[] = []
    const env = { CLAUDE_PROJECT_DIR: project.projectDir, AIDLC_PROJECT_DIR: project.projectDir }
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, subject, 'claude-code')) continue
      for (const hook of group.hooks) {
        const handlerId = `aidlc:${event}:${++handlerCounter}`
        const session = opts.agent?.session
        const logged = session !== undefined && opts.turn !== undefined
        if (logged) {
          // Session hook records are best-effort: their schema varies across dsh versions.
          try {
            appendHookInvoked(session, {
              turn: opts.turn!, point: event, dialect: 'claude-code', handlerId,
              ...group.matcher !== undefined ? { matcher: group.matcher } : {},
            })
          } catch { /* not recorded */ }
        }
        // The shell executor does not take PATH from `env`, so set it in-command.
        const { output, durationMs } = await runHookCommand(ctx.shell as unknown as AnyShellExecutor, {
          command: `${pathPrefix}${hook.command}`,
          timeoutMs: hook.timeoutSec !== undefined ? hook.timeoutSec * 1000 : config.defaultTimeoutMs,
          stdin: `${JSON.stringify(payload)}\n`,
          cwd: project.projectDir,
          env,
          signal: opts.signal,
          expectedEventName: event,
        })
        outputs.push(output)
        if (config.debug) {
          ctx.logger.warn(`aidlc-hooks[debug]: ${event}[${subject}] ${hook.command} → exit ${output.exitCode ?? 'n/a'} (${Math.round(durationMs)}ms)${output.stderr ? ` stderr: ${output.stderr.slice(0, 300)}` : ''}`)
        }
        if (logged) {
          try {
            appendHookResult(session, { turn: opts.turn!, point: event, handlerId, output, stderrSummaryMaxChars: config.stderrSummaryMaxChars, durationMs })
          } catch { /* not recorded */ }
        }
      }
    }
    return { merged: mergeHookOutputs(outputs), outputs }
  }

  function contextFrom(merged: MergedHookOutcome, stdoutContexts: readonly string[] = []): UserMessage | undefined {
    const texts = [...merged.additionalContext, ...stdoutContexts.filter(text => !merged.additionalContext.includes(text))]
    if (texts.length === 0) return undefined
    const content: ContentBlock[] = texts.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: SOURCE })
  }

  function toolPayload(exec: ToolExecution, event: string, project: AidlcProject): Record<string, unknown> {
    return {
      ...base(exec.agent, event, project),
      tool_name: toClaudeToolName(exec.name, nameMap),
      tool_input: exec.arguments,
      tool_use_id: exec.callId,
    }
  }

  // --- SessionStart (top-level sessions only). ---
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    if (isSubagent(agent)) return
    const project = projectOf(agent.session.header.cwd)
    if (!project) return
    const owner = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
    const trigger = source ?? 'startup'
    const run = runEvent(project, 'SessionStart', trigger, { ...base(agent, 'SessionStart', project), source: trigger }, { agent, signal: owner })
      .then(({ merged, outputs }) => {
        const context = contextFrom(merged, stdoutContext(outputs))
        if (context) agent.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`aidlc-hooks: SessionStart failed: ${String(error)}`) })
    detached.track(run)
    await run
  })

  // --- UserPromptSubmit (top-level sessions only: a child never mints a human turn). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0 || isSubagent(agent)) return next()
    const project = projectOf(agent.session.header.cwd)
    if (!project) return next()
    const prompt = blocksToText(messages.flatMap(message => message.content) as { type: string; text?: string }[])
    const { merged, outputs } = await runEvent(project, 'UserPromptSubmit', '', { ...base(agent, 'UserPromptSubmit', project), prompt }, { agent, turn, signal })
    if (merged.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const ours = contextFrom(merged, stdoutContext(outputs))
    if (!ours || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages, ours] }
  })

  // --- PreToolUse: gates, plus the deliver-stage-rules prompt rewrite. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const project = projectOf(exec.agent?.session.header.cwd)
    if (!project) return next()
    const claudeName = toClaudeToolName(exec.name, nameMap)
    const { merged, outputs } = await runEvent(project, 'PreToolUse', claudeName, toolPayload(exec, 'PreToolUse', project), {
      ...exec.agent ? { agent: exec.agent } : {}, turn: lastTurn(exec.agent), signal: exec.signal,
    })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by AI-DLC PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    if (exec.name === config.dispatchToolName) {
      for (const output of outputs) {
        const updated = output.updatedInput as Record<string, unknown> | undefined
        if (updated && typeof updated.prompt === 'string') promptRewrites.set(exec.callId, updated.prompt)
      }
    }
    return next()
  })

  // --- PostToolUse: audit log, sensors, human-turn capture, graph rebuild. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    promptRewrites.delete(exec.callId)
    const project = projectOf(exec.agent?.session.header.cwd)
    if (!project) return next()
    const claudeName = toClaudeToolName(exec.name, nameMap)
    const payload = { ...toolPayload(exec, 'PostToolUse', project), tool_response: blocksToText(result.content as { type: string; text?: string }[]) }
    const { merged } = await runEvent(project, 'PostToolUse', claudeName, payload, {
      ...exec.agent ? { agent: exec.agent } : {}, turn: lastTurn(exec.agent), signal: exec.signal,
    })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by AI-DLC PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    const downstream = await next()
    if (!context) return downstream
    return { ...downstream, additionalContexts: [context, ...downstream.additionalContexts ?? []] }
  })

  // --- Stop: continue-workflow keeps the conductor moving between stages. ---
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    if (isSubagent(agent)) return
    const project = projectOf(agent.session.header.cwd)
    if (!project) return
    const { merged } = await runEvent(project, 'Stop', '', { ...base(agent, 'Stop', project), stop_hook_active: false }, { agent, turn, signal })
    if (merged.decision === 'deny') {
      agent.steer(createUserMessage({ content: [{ type: 'text', text: merged.reason ?? 'continue: blocked by AI-DLC Stop hook' }], source: SOURCE }))
    }
  })

  // --- SubagentStart/Stop: log delegated-agent lifecycle with its real agent_type. ---
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    const cwd = child?.session.header.cwd
    if (cwd !== undefined) subagentCwd.set(info.runId, cwd)
  })
  ctx.on('subagent/end', (info) => {
    const agentType = childAgents.get(info.id)
    const cwd = subagentCwd.get(info.runId) ?? ctx.get('agents')?.get(info.id)?.session.header.cwd
    subagentCwd.delete(info.runId)
    childAgents.delete(info.id)
    const project = projectOf(cwd)
    if (!project || agentType === undefined) return
    const payload = {
      session_id: info.id,
      transcript_path: '',
      cwd: project.projectDir,
      hook_event_name: 'SubagentStop',
      agent_id: info.id,
      agent_type: agentType,
      stop_hook_active: false,
      ...info.lastAssistantMessage ? { last_assistant_message: blocksToText(info.lastAssistantMessage as { type: string; text?: string }[]) } : {},
    }
    detached.track(runEvent(project, 'SubagentStop', agentType, payload, { signal: detached.signal })
      .catch((error: unknown) => { ctx.logger.warn(`aidlc-hooks: SubagentStop failed: ${String(error)}`) }))
  })
}
