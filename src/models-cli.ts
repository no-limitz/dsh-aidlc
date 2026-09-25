#!/usr/bin/env node
/**
 * `dsh-aidlc-models` — show and edit the AI-DLC agent model routes in
 * `$DSH_HOME/aidlc-models.json`. Changes apply to the next `aidlc_agent`
 * dispatch; dsh needs no restart.
 *
 *   dsh-aidlc-models show [--json]
 *   dsh-aidlc-models set (--tier <tier> | --agent <name>) [--model <id>] [--effort <level>] [--provider <name>]
 *   dsh-aidlc-models unset (--tier <tier> | --agent <name>)
 *   dsh-aidlc-models reset
 * @module dsh-aidlc/models-cli
 */

import { describeRoute, modelsFilePath, readModelsFile, summarize, writeModelsFile, type ModelsFile } from './models.ts'
import type { RouteOptions } from './route.ts'
import { TIERS, type Tier } from './translate.ts'

const USAGE = `usage:
  dsh-aidlc-models show [--json]
  dsh-aidlc-models set (--tier <${TIERS.join('|')}> | --agent <name>) [--model <id>] [--effort <level>] [--provider <name>]
  dsh-aidlc-models unset (--tier <tier> | --agent <name>)
  dsh-aidlc-models reset
Routes live in ${modelsFilePath()} (DSH_AIDLC_MODELS_FILE overrides).
An agent route wins over its tier route; unset fields inherit the dsh session.`

function flags(args: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[arg.slice(2)] = next
      i++
    } else {
      out[arg.slice(2)] = true
    }
  }
  return out
}

function str(value: string | true | undefined, name: string): string | undefined {
  if (value === true) throw new Error(`--${name} needs a value`)
  return value
}

function main(argv: string[]): number {
  const [command = 'show', ...rest] = argv
  const path = modelsFilePath()
  const file = readModelsFile(path, (message) => process.stderr.write(`${message}\n`))
  const f = flags(rest)

  switch (command) {
    case 'show': {
      if (f.json) {
        process.stdout.write(`${JSON.stringify({ path, file, agents: summarize(file) }, null, 2)}\n`)
        return 0
      }
      process.stdout.write(`AI-DLC agent models (${path})\n\nTiers:\n`)
      for (const tier of TIERS) process.stdout.write(`  ${tier.padEnd(10)} ${describeRoute(file.tiers?.[tier])}\n`)
      process.stdout.write('\nAgents:\n')
      for (const row of summarize(file)) {
        process.stdout.write(`  ${row.agent.padEnd(36)} ${(row.tier ?? '-').padEnd(10)} ${row.effective}  (${row.from})\n`)
      }
      return 0
    }
    case 'set':
    case 'unset': {
      const tier = str(f.tier, 'tier')
      const agent = str(f.agent, 'agent')
      if ((tier === undefined) === (agent === undefined)) throw new Error('give exactly one of --tier or --agent')
      if (tier !== undefined && !(TIERS as readonly string[]).includes(tier)) throw new Error(`unknown tier ${JSON.stringify(tier)}; tiers: ${TIERS.join(', ')}`)
      const next: ModelsFile = { tiers: { ...file.tiers }, agents: { ...file.agents } }
      if (command === 'unset') {
        if (tier) delete next.tiers![tier as Tier]
        else delete next.agents![agent!]
      } else {
        const route: RouteOptions = {}
        const model = str(f.model, 'model')
        const effort = str(f.effort, 'effort')
        const provider = str(f.provider, 'provider')
        if (model) route.model = model
        if (effort) route.reasoningEffort = effort
        if (provider) route.provider = provider
        if (Object.keys(route).length === 0) throw new Error('set needs at least one of --model, --effort, --provider')
        if (tier) next.tiers![tier as Tier] = route
        else next.agents![agent!] = route
      }
      writeModelsFile(path, next)
      process.stdout.write(`${command === 'set' ? 'set' : 'cleared'} ${tier ? `tier ${tier}` : agent}\n`)
      return 0
    }
    case 'reset':
      writeModelsFile(path, {})
      process.stdout.write('cleared every AI-DLC model route\n')
      return 0
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`)
      return 0
    default:
      throw new Error(`unknown command ${JSON.stringify(command)}\n${USAGE}`)
  }
}

// A reader that closes early (`| head`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`dsh-aidlc-models: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
