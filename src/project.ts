/**
 * Discovery of an installed AI-DLC projection (`aidlc config --harness claude`)
 * in a workspace: its agents, skills, and hook config. Reads are cached by
 * file mtime so edits and `aidlc config` refreshes are picked up live.
 * @module dsh-aidlc/project
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** An installed AI-DLC projection located from a workspace directory. */
export interface AidlcProject {
  /** The project root (the directory that holds the harness directory). */
  readonly projectDir: string
  /** Absolute path of the harness directory, e.g. `<projectDir>/.claude`. */
  readonly harnessPath: string
}

/** One AI-DLC agent definition. */
export interface AidlcAgent {
  readonly name: string
  readonly displayName?: string
  readonly description: string
  /** Markdown body after frontmatter — the agent's system persona. */
  readonly body: string
  readonly path: string
}

/** One AI-DLC skill (`<harnessDir>/skills/<name>/SKILL.md`). */
export interface AidlcSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly metadata: Readonly<Record<string, unknown>>
  readonly body: string
  readonly path: string
  readonly dir: string
}

/** One command hook in a Claude Code settings `hooks` block. */
export interface CommandHookSpec {
  readonly command: string
  readonly timeoutSec?: number
}

/** One matcher group in a Claude Code settings `hooks` block. */
export interface HookGroupSpec {
  readonly matcher?: string
  readonly hooks: readonly CommandHookSpec[]
}

/** Parsed hook config: Claude Code event name → matcher groups. */
export type HookConfig = Readonly<Record<string, readonly HookGroupSpec[]>>

/**
 * Walk up from `cwd` to the nearest directory whose `<harnessDir>` holds an
 * AI-DLC install (an `agents/` dir or the `skills/aidlc` orchestrator).
 * @param cwd - the session workspace.
 * @param harnessDir - harness directory name, e.g. `.claude`.
 * @returns the located project, or undefined when AI-DLC is not installed.
 */
export function findAidlcProject(cwd: string, harnessDir: string): AidlcProject | undefined {
  let dir = resolve(cwd)
  for (;;) {
    const harnessPath = join(dir, harnessDir)
    if (existsSync(join(harnessPath, 'skills', 'aidlc', 'SKILL.md')) || existsSync(join(harnessPath, 'agents', 'aidlc-architect-agent.md'))) {
      return { projectDir: dir, harnessPath }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Split YAML frontmatter from a Markdown document.
 * @param text - the document.
 * @returns parsed frontmatter data (empty when absent) and the body.
 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const parsed: unknown = parseYaml(match[1]!)
  const data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  return { data, body: text.slice(match[0].length) }
}

const fileCache = new Map<string, { mtimeMs: number; value: unknown }>()

/** Read and transform a file, memoized on its mtime. */
function cachedRead<T>(path: string, transform: (text: string) => T): T {
  const mtimeMs = statSync(path).mtimeMs
  const hit = fileCache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.value as T
  const value = transform(readFileSync(path, 'utf8'))
  fileCache.set(path, { mtimeMs, value })
  return value
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(v)) return true
    if (['false', 'no', 'off', '0'].includes(v)) return false
  }
  return fallback
}

/**
 * Load every agent under `<harnessPath>/agents/*.md`.
 * @param project - the located project.
 * @returns agents keyed by name; malformed files are skipped.
 */
export function loadAgents(project: AidlcProject): Map<string, AidlcAgent> {
  const dir = join(project.harnessPath, 'agents')
  const agents = new Map<string, AidlcAgent>()
  if (!existsSync(dir)) return agents
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const path = join(dir, entry)
    const agent = cachedRead(path, (text): AidlcAgent | undefined => {
      const { data, body } = parseFrontmatter(text)
      const name = asString(data.name) ?? basename(entry, '.md')
      const description = asString(data.description)
      if (!description) return undefined
      const displayName = asString(data.display_name)
      return { name, description, body: body.trim(), path, ...displayName ? { displayName } : {} }
    })
    if (agent) agents.set(agent.name, agent)
  }
  return agents
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Load every skill bundle under `<harnessPath>/skills/<name>/SKILL.md`.
 * @param project - the located project.
 * @returns skills sorted by name; malformed skills are skipped.
 */
export function loadSkills(project: AidlcProject): AidlcSkill[] {
  const root = join(project.harnessPath, 'skills')
  if (!existsSync(root)) return []
  const skills: AidlcSkill[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    const path = join(dir, 'SKILL.md')
    if (!existsSync(path)) continue
    const skill = cachedRead(path, (text): AidlcSkill | undefined => {
      const { data, body } = parseFrontmatter(text)
      const name = asString(data.name) ?? entry.name
      const description = asString(data.description)
      if (!description || !SKILL_NAME.test(name)) return undefined
      const whenToUse = asString(data.whenToUse ?? data.when_to_use)
      return {
        name,
        description: description.replace(/\s+/g, ' '),
        modelInvocable: !asBool(data['disable-model-invocation'], false),
        userInvocable: asBool(data['user-invocable'], true),
        metadata: data,
        body,
        path,
        dir,
        ...whenToUse ? { whenToUse } : {},
      }
    })
    if (skill) skills.push(skill)
  }
  return skills.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * Parse a Claude Code settings object's `hooks` block (command hooks only).
 * @param raw - the parsed settings JSON (or a bare hooks map).
 * @returns event → matcher groups.
 */
export function parseHookConfig(raw: unknown): HookConfig {
  const root = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const hooksMap = typeof root.hooks === 'object' && root.hooks !== null ? root.hooks as Record<string, unknown> : root
  const config: Record<string, HookGroupSpec[]> = {}
  for (const [event, rawGroups] of Object.entries(hooksMap)) {
    if (!Array.isArray(rawGroups)) continue
    const groups: HookGroupSpec[] = []
    for (const rawGroup of rawGroups) {
      if (typeof rawGroup !== 'object' || rawGroup === null) continue
      const group = rawGroup as Record<string, unknown>
      if (!Array.isArray(group.hooks)) continue
      const hooks: CommandHookSpec[] = []
      for (const rawHook of group.hooks) {
        if (typeof rawHook !== 'object' || rawHook === null) continue
        const hook = rawHook as Record<string, unknown>
        if ((hook.type ?? 'command') !== 'command' || typeof hook.command !== 'string') continue
        hooks.push({ command: hook.command, ...typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {} })
      }
      if (hooks.length === 0) continue
      groups.push({ hooks, ...typeof group.matcher === 'string' && group.matcher !== '' ? { matcher: group.matcher } : {} })
    }
    if (groups.length > 0) config[event] = groups
  }
  return config
}

/**
 * Load the project's AI-DLC hook config from `<harnessPath>/settings.json`.
 * @param project - the located project.
 * @returns the parsed config, or an empty config when absent/unreadable.
 */
export function loadHookConfig(project: AidlcProject): HookConfig {
  const path = join(project.harnessPath, 'settings.json')
  if (!existsSync(path)) return {}
  try {
    return cachedRead(path, text => parseHookConfig(JSON.parse(text)))
  } catch {
    return {}
  }
}
