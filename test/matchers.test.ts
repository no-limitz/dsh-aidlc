// Which AI-DLC engine hooks fire for each harness tool once names are
// translated — checked against the real AI-DLC 2.9.0 Claude hook config and
// the harness's own Claude-dialect matcher.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { matchesMatcher } from '@deepseek-ai/dsh-hook-protocol'
import { parseHookConfig } from '../src/project.ts'
import { DEFAULT_TOOL_NAME_MAP, toClaudeToolName } from '../src/translate.ts'

const config = parseHookConfig(JSON.parse(readFileSync(new URL('./fixtures/aidlc-claude-settings.json', import.meta.url), 'utf8')))

function firing(event: string, harnessTool: string): string[] {
  const subject = toClaudeToolName(harnessTool, DEFAULT_TOOL_NAME_MAP)
  return (config[event] ?? [])
    .filter(group => matchesMatcher(group.matcher, subject, 'claude-code'))
    .flatMap(group => group.hooks.map(hook => hook.command.replace(/^aidlc engine hook /, '')))
}

test('write is gated and audited like Claude Write', () => {
  assert.deepEqual(firing('PreToolUse', 'write'), ['fold-usage', 'state-transition-guard', 'reviewer-scope', 'review-freeze', 'plan-approval-guard'])
  assert.deepEqual(firing('PostToolUse', 'write'), ['write-audit-log', 'run-sensors', 'fold-usage'])
})

test('bash reaches the state guard and graph rebuild', () => {
  assert.ok(firing('PreToolUse', 'bash').includes('state-transition-guard'))
  assert.ok(firing('PostToolUse', 'bash').includes('rebuild-stage-graph'))
})

test('aidlc_agent receives stage-rule delivery and plan approval like Task', () => {
  assert.deepEqual(firing('PreToolUse', 'aidlc_agent'), ['fold-usage', 'deliver-stage-rules', 'plan-approval-guard'])
})

test('ask_user_question records the human turn', () => {
  assert.ok(firing('PostToolUse', 'ask_user_question').includes('record-human-turn'))
})

test('untranslated names would silently skip the gates', () => {
  const raw = (config.PreToolUse ?? []).filter(group => matchesMatcher(group.matcher, 'write', 'claude-code'))
  assert.deepEqual(raw.flatMap(group => group.hooks.map(hook => hook.command)), ['aidlc engine hook fold-usage'])
})
