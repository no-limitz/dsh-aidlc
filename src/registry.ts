/**
 * Process-wide state shared between the preset-scoped dispatch tool and the
 * host-plane hook bridge (both are rows of this one package, so they share
 * this module instance).
 * @module dsh-aidlc/registry
 */

/** Child session id → the AI-DLC agent name it runs as. */
export const childAgents = new Map<string, string>()

/**
 * Tool call id → the delegated prompt rewritten by the AI-DLC
 * `deliver-stage-rules` PreToolUse hook. The harness pre-execute seam cannot
 * rewrite arguments, so the bridge parks the rewrite here and the dispatch
 * tool consumes it when it runs.
 */
export const promptRewrites = new Map<string, string>()

/**
 * Take (and forget) the parked prompt rewrite for one tool call.
 * @param callId - the tool call id.
 * @returns the rewritten prompt, or undefined when no hook rewrote it.
 */
export function takePromptRewrite(callId: string): string | undefined {
  const prompt = promptRewrites.get(callId)
  promptRewrites.delete(callId)
  return prompt
}
