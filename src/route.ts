/**
 * Per-tier child LLM routing for AI-DLC agents.
 * @module dsh-aidlc/route
 */

import { DEFAULT_AGENT_TIERS, type Tier } from './translate.ts'

/** A child LLM route: any subset of provider/model/effort/token cap. */
export interface RouteOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

/** The routing slice of the plugin config. */
export interface RouteConfig {
  /** Per-tier child LLM routes; omitted fields inherit from the calling agent. */
  tiers: Partial<Record<Tier, RouteOptions>>
  /** Agent name → tier, overriding the upstream defaults (for custom agents too). */
  agentTiers: Record<string, Tier>
  /** Agent name → route, applied over its tier route. */
  agentRoutes: Record<string, RouteOptions>
}

/**
 * Resolve the child route for one agent: tier route, then per-agent route.
 * @param config - routing config.
 * @param agent - the AI-DLC agent name.
 * @returns merged options, or undefined to inherit the parent route unchanged.
 */
export function routeFor(config: RouteConfig, agent: string): RouteOptions | undefined {
  const tier = config.agentTiers[agent] ?? DEFAULT_AGENT_TIERS[agent]
  const merged: RouteOptions = {
    ...tier !== undefined ? config.tiers[tier] : {},
    ...config.agentRoutes[agent],
  }
  const defined = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined && v !== ''))
  return Object.keys(defined).length > 0 ? defined as RouteOptions : undefined
}
