import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adaptationNote, blocksToText, DEFAULT_AGENT_TIERS, DEFAULT_TOOL_NAME_MAP, defangTemplate, toClaudeToolName } from '../src/translate.ts'
import { routeFor } from '../src/route.ts'

test('tool names map to the Claude vocabulary the AI-DLC hooks match on', () => {
  assert.equal(toClaudeToolName('write', DEFAULT_TOOL_NAME_MAP), 'Write')
  assert.equal(toClaudeToolName('bash', DEFAULT_TOOL_NAME_MAP), 'Bash')
  assert.equal(toClaudeToolName('aidlc_agent', DEFAULT_TOOL_NAME_MAP), 'Task')
  assert.equal(toClaudeToolName('ask_user_question', DEFAULT_TOOL_NAME_MAP), 'AskUserQuestion')
  assert.equal(toClaudeToolName('lsp', DEFAULT_TOOL_NAME_MAP), 'lsp')
  assert.equal(toClaudeToolName('toString', DEFAULT_TOOL_NAME_MAP), 'toString')
})

test('every shipped AI-DLC agent has a tier', () => {
  assert.equal(Object.keys(DEFAULT_AGENT_TIERS).length, 14)
  assert.equal(DEFAULT_AGENT_TIERS['aidlc-delivery-agent'], 'templated')
})

test('defangTemplate breaks template braces only', () => {
  assert.equal(defangTemplate('a {{x}} b { c }'), 'a {​{x}} b { c }')
})

test('blocksToText keeps text blocks', () => {
  assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
})

test('adaptationNote names the dispatch tool and harness dir', () => {
  const note = adaptationNote('aidlc_agent', '.claude')
  assert.match(note, /`Task`.*`aidlc_agent`/)
  assert.match(note, /\.claude\//)
})

test('routeFor merges tier and per-agent routes', () => {
  const config = {
    tiers: { judgment: { model: 'pro', reasoningEffort: 'high' }, templated: { model: 'flash' } },
    agentTiers: { 'my-custom-agent': 'templated' as const },
    agentRoutes: { 'aidlc-developer-agent': { reasoningEffort: 'max' } },
  }
  assert.deepEqual(routeFor(config, 'aidlc-architect-agent'), { model: 'pro', reasoningEffort: 'high' })
  assert.deepEqual(routeFor(config, 'aidlc-developer-agent'), { model: 'pro', reasoningEffort: 'max' })
  assert.deepEqual(routeFor(config, 'aidlc-delivery-agent'), { model: 'flash' })
  assert.deepEqual(routeFor(config, 'my-custom-agent'), { model: 'flash' })
  assert.equal(routeFor(config, 'aidlc-product-lead-agent'), undefined)
  assert.equal(routeFor({ tiers: {}, agentTiers: {}, agentRoutes: {} }, 'aidlc-architect-agent'), undefined)
})

test('stdoutContext recovers top-level and plain SessionStart context', async () => {
  const { stdoutContext } = await import('../src/hooks.ts')
  assert.deepEqual(stdoutContext([
    { exitCode: 0, stdout: '{"additionalContext":"AIDLC Runtime Session: s1"}' },
    { exitCode: 0, stdout: 'plain context' },
    { exitCode: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"x"}}' },
    { exitCode: 2, stdout: 'ignored' },
    { exitCode: 0, stdout: '' },
  ]), ['AIDLC Runtime Session: s1', 'plain context'])
})
