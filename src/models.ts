/**
 * User-level model routes for AI-DLC agents: `$DSH_HOME/aidlc-models.json`.
 *
 * The plugin row's `tiers` / `agentRoutes` config lives inside an agent preset,
 * which a user cannot override without restating the whole preset. This file is
 * the user-editable layer on top: per-tier and per-agent routes that win over
 * the row config. It is re-read (mtime-cached) on every dispatch, so an edit
 * applies to the next `aidlc_agent` call with no restart. Pure Node — the
 * `dsh-aidlc-models` CLI shares it outside dsh.
 * @module dsh-aidlc/models
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RouteConfig, RouteOptions } from './route.ts'
import { DEFAULT_AGENT_TIERS, TIERS, type Tier } from './translate.ts'

/** The on-disk shape. Every section and field is optional. */
export interface ModelsFile {
  tiers?: Partial<Record<Tier, RouteOptions>>
  agents?: Record<string, RouteOptions>
}

const ROUTE_KEYS = ['provider', 'model', 'reasoningEffort', 'maxTokens'] as const

/**
 * Resolve the routes file path: `DSH_AIDLC_MODELS_FILE`, else
 * `$DSH_HOME/aidlc-models.json` (`~/.dsh` when DSH_HOME is unset).
 */
export function modelsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_AIDLC_MODELS_FILE) return env.DSH_AIDLC_MODELS_FILE
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'aidlc-models.json')
}

/** Keep only known route keys with usable values; undefined when nothing remains. */
function cleanRoute(value: unknown): RouteOptions | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const route: RouteOptions = {}
  for (const key of ROUTE_KEYS) {
    const v = input[key]
    if (key === 'maxTokens') {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) route.maxTokens = v
    } else if (typeof v === 'string' && v.trim() !== '') {
      route[key] = v.trim()
    }
  }
  return Object.keys(route).length > 0 ? route : undefined
}

/**
 * Validate a parsed routes document into its clean form.
 * @param raw - parsed JSON.
 * @returns the routes with unknown tiers, keys, and empty values dropped.
 */
export function parseModelsFile(raw: unknown): ModelsFile {
  const doc = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const out: ModelsFile = {}
  const tiers = doc.tiers as Record<string, unknown> | undefined
  if (tiers && typeof tiers === 'object') {
    for (const tier of TIERS) {
      const route = cleanRoute(tiers[tier])
      if (route) (out.tiers ??= {})[tier] = route
    }
  }
  const agents = doc.agents as Record<string, unknown> | undefined
  if (agents && typeof agents === 'object') {
    for (const [name, value] of Object.entries(agents)) {
      const route = cleanRoute(value)
      if (route) (out.agents ??= {})[name] = route
    }
  }
  return out
}

let cache: { path: string; mtimeMs: number; value: ModelsFile } | undefined

/**
 * Read the routes file, memoized on mtime.
 * @param path - the file path.
 * @param onError - called once per changed-but-unparsable file.
 * @returns the routes, or an empty document when the file is absent or invalid.
 */
export function readModelsFile(path: string = modelsFilePath(), onError?: (message: string) => void): ModelsFile {
  if (!existsSync(path)) return {}
  const mtimeMs = statSync(path).mtimeMs
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.value
  let value: ModelsFile = {}
  try {
    value = parseModelsFile(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    onError?.(`dsh-aidlc: ignoring ${path}: ${String(error)}`)
  }
  cache = { path, mtimeMs, value }
  return value
}

/**
 * Layer the routes file over the row config: a file tier route replaces the
 * row's route for that tier, and a file agent route replaces the row's route
 * for that agent.
 */
export function withModelsFile(config: RouteConfig, file: ModelsFile): RouteConfig {
  return {
    tiers: { ...config.tiers, ...file.tiers },
    agentTiers: config.agentTiers,
    agentRoutes: { ...config.agentRoutes, ...file.agents },
  }
}

/** Write the routes file atomically, removing empty sections. */
export function writeModelsFile(path: string, file: ModelsFile): void {
  const doc: ModelsFile = {}
  if (file.tiers && Object.keys(file.tiers).length > 0) doc.tiers = file.tiers
  if (file.agents && Object.keys(file.agents).length > 0) doc.agents = file.agents
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
  renameSync(tmp, path)
}

/** One-line description of a route. */
export function describeRoute(route: RouteOptions | undefined): string {
  if (!route) return 'inherit'
  return [route.model ?? 'session model', route.reasoningEffort && `effort ${route.reasoningEffort}`, route.provider && `via ${route.provider}`]
    .filter(Boolean).join(', ')
}

/** One row per known agent: its tier, its own route, and the route it resolves to. */
export function summarize(file: ModelsFile): Array<{ agent: string; tier: Tier | undefined; own?: RouteOptions; effective: string; from: string }> {
  const names = [...new Set([...Object.keys(DEFAULT_AGENT_TIERS), ...Object.keys(file.agents ?? {})])].sort()
  return names.map((agent) => {
    const tier = DEFAULT_AGENT_TIERS[agent]
    const own = file.agents?.[agent]
    const tierRoute = tier ? file.tiers?.[tier] : undefined
    const effective = own ? { ...tierRoute, ...own } : tierRoute
    return {
      agent,
      tier,
      ...own ? { own } : {},
      effective: describeRoute(effective),
      from: own ? 'agent' : tierRoute ? `tier ${tier}` : 'session',
    }
  })
}
