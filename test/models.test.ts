import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { modelsFilePath, parseModelsFile, readModelsFile, summarize, withModelsFile } from '../src/models.ts'
import { routeFor } from '../src/route.ts'

test('modelsFilePath prefers the override, then DSH_HOME', () => {
  assert.equal(modelsFilePath({ DSH_AIDLC_MODELS_FILE: '/x/m.json', DSH_HOME: '/h' }), '/x/m.json')
  assert.equal(modelsFilePath({ DSH_HOME: '/h' }), '/h/aidlc-models.json')
})

test('parseModelsFile drops unknown tiers, keys, and empty values', () => {
  assert.deepEqual(parseModelsFile({
    tiers: { judgment: { model: ' pro ', bogus: 1 }, galaxy: { model: 'x' }, balanced: { model: '' } },
    agents: { 'aidlc-developer-agent': { reasoningEffort: 'high', maxTokens: 0 }, empty: {} },
  }), {
    tiers: { judgment: { model: 'pro' } },
    agents: { 'aidlc-developer-agent': { reasoningEffort: 'high' } },
  })
  assert.deepEqual(parseModelsFile(null), {})
})

test('the file layers over the row config and agent routes win over tiers', () => {
  const row = { tiers: { judgment: { model: 'row-pro' }, templated: { model: 'row-flash' } }, agentTiers: {}, agentRoutes: {} }
  const merged = withModelsFile(row, { tiers: { judgment: { model: 'file-pro' } }, agents: { 'aidlc-developer-agent': { model: 'dev' } } })
  assert.deepEqual(routeFor(merged, 'aidlc-architect-agent'), { model: 'file-pro' })
  assert.deepEqual(routeFor(merged, 'aidlc-delivery-agent'), { model: 'row-flash' })
  assert.deepEqual(routeFor(merged, 'aidlc-developer-agent'), { model: 'dev' })
})

test('readModelsFile tolerates absent and invalid files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-aidlc-models-'))
  assert.deepEqual(readModelsFile(join(dir, 'missing.json')), {})
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{not json')
  const errors: string[] = []
  assert.deepEqual(readModelsFile(bad, e => errors.push(e)), {})
  assert.equal(errors.length, 1)
})

test('summarize reports each agent with its source', () => {
  const rows = summarize({ tiers: { templated: { model: 'flash' } }, agents: { 'aidlc-developer-agent': { model: 'dev', reasoningEffort: 'high' } } })
  const byName = Object.fromEntries(rows.map(r => [r.agent, r]))
  assert.equal(rows.length, 14)
  assert.deepEqual([byName['aidlc-delivery-agent']!.effective, byName['aidlc-delivery-agent']!.from], ['flash', 'tier templated'])
  assert.deepEqual([byName['aidlc-developer-agent']!.effective, byName['aidlc-developer-agent']!.from], ['dev, effort high', 'agent'])
  assert.equal(byName['aidlc-architect-agent']!.from, 'session')
})

test('the CLI sets, shows, and clears routes', { skip: !existsBuilt() && 'run npm run build first' }, () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-aidlc-cli-')), 'aidlc-models.json')
  const run = (...args: string[]) => spawnSync(process.execPath, ['lib/models-cli.js', ...args], { env: { ...process.env, DSH_AIDLC_MODELS_FILE: file }, encoding: 'utf8' })
  assert.equal(run('set', '--tier', 'judgment', '--model', 'nolimitz/agent').status, 0)
  assert.equal(run('set', '--agent', 'aidlc-developer-agent', '--model', 'nolimitz/coder', '--effort', 'high').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    tiers: { judgment: { model: 'nolimitz/agent' } },
    agents: { 'aidlc-developer-agent': { model: 'nolimitz/coder', reasoningEffort: 'high' } },
  })
  const shown = JSON.parse(run('show', '--json').stdout)
  assert.equal(shown.agents.find((r: { agent: string }) => r.agent === 'aidlc-architect-agent').effective, 'nolimitz/agent')
  assert.equal(run('unset', '--tier', 'judgment').status, 0)
  assert.equal(run('set', '--tier', 'galaxy', '--model', 'x').status, 2)
  assert.equal(run('reset').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
})

function existsBuilt(): boolean {
  try {
    readFileSync('lib/models-cli.js')
    return true
  } catch {
    return false
  }
}
