/**
 * dsh 0.1.5 compatibility: add this package's `presets/` directory to the
 * `@deepseek-ai/dsh-agent-presets` roster, so the `aidlc` preset appears
 * beside the shipped ones. On dsh 0.1.7+ the `agentPresets` service is the
 * declarative registry (no `roots`), and this row does nothing.
 * @module dsh-aidlc/preset-root
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'aidlc-preset-root'
export const inject = ['agentPresets']

interface PresetRoot {
  path: string
  trust: 'system' | 'user'
}

export const PRESET_ROOT = fileURLToPath(new URL('../presets', import.meta.url))

export function apply(ctx: Context): void {
  const roots = (ctx.get('agentPresets') as { roots?: unknown } | undefined)?.roots
  if (!Array.isArray(roots)) return
  const root: PresetRoot = { path: PRESET_ROOT, trust: 'system' }
  // The roster re-reads its roots on every call, so appending takes effect live.
  ctx.effect(() => {
    roots.push(root)
    return () => {
      const index = roots.indexOf(root)
      if (index !== -1) roots.splice(index, 1)
    }
  }, 'aidlc-preset-root: roster root')
}
