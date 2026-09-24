/**
 * Run one hook command through the harness shell executor, tolerating the
 * executor API change between dsh 0.1.5 (`run(spec)` → result) and 0.1.7+
 * (`execute(spec)` → handle with `result()`).
 * @module dsh-aidlc/shell
 */

import { parseHookOutput, type HookOutput } from '@deepseek-ai/dsh-hook-protocol'

interface ShellResult {
  exitCode: number | null
  stdout: { text: string }
  stderr: { text: string }
}

/** The subset of either executor generation this runner uses. */
export interface AnyShellExecutor {
  resolve(request: object): unknown
  run?(spec: unknown): Promise<ShellResult>
  execute?(spec: unknown): Promise<{ result(): Promise<ShellResult> }>
}

export interface HookRunRequest {
  command: string
  timeoutMs: number
  stdin: string
  cwd: string
  env: Record<string, string>
  signal: AbortSignal
  expectedEventName: string
}

/**
 * Run a hook command and decode its output with the shared hook codec.
 * A command that cannot start yields a non-blocking error output.
 * @param shell - the harness `shell` service.
 * @param request - command, stdin payload, environment, and limits.
 * @returns the decoded hook output and duration.
 */
export async function runHookCommand(shell: AnyShellExecutor, request: HookRunRequest): Promise<{ output: HookOutput; durationMs: number }> {
  const started = performance.now()
  try {
    const spec = shell.resolve({
      command: request.command,
      timeoutMs: request.timeoutMs,
      stdin: request.stdin,
      signal: request.signal,
      workdir: request.cwd,
      env: request.env,
    })
    let result: ShellResult
    if (typeof shell.execute === 'function') result = await (await shell.execute(spec)).result()
    else if (typeof shell.run === 'function') result = await shell.run(spec)
    else throw new Error('shell executor exposes neither execute() nor run()')
    return {
      output: parseHookOutput(result.exitCode ?? undefined, result.stdout.text, result.stderr.text, request.expectedEventName),
      durationMs: performance.now() - started,
    }
  } catch (error: unknown) {
    return {
      output: parseHookOutput(undefined, '', error instanceof Error ? error.message : String(error)),
      durationMs: performance.now() - started,
    }
  }
}
