import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findAidlcProject, loadAgents, loadHookConfig, loadSkills, parseFrontmatter, parseHookConfig } from '../src/project.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-aidlc-'))
  const claude = join(root, '.claude')
  mkdirSync(join(claude, 'agents'), { recursive: true })
  mkdirSync(join(claude, 'skills', 'aidlc'), { recursive: true })
  mkdirSync(join(claude, 'skills', 'aidlc-feature'), { recursive: true })
  mkdirSync(join(claude, 'skills', 'Bad_Name'), { recursive: true })
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  writeFileSync(join(claude, 'agents', 'aidlc-architect-agent.md'), [
    '---',
    'name: aidlc-architect-agent',
    'display_name: Architect Agent',
    'description: >',
    '  Solutions architect responsible for domain design.',
    'disallowedTools: Task',
    'model: inherit',
    '---',
    '# Architect Agent',
    '',
    'You are a senior solutions architect.',
  ].join('\n'))
  writeFileSync(join(claude, 'agents', 'broken.md'), 'no frontmatter here')
  writeFileSync(join(claude, 'skills', 'aidlc', 'SKILL.md'), [
    '---',
    'name: aidlc',
    'description: >',
    '  AI-DLC workflow orchestrator.',
    '  Start or resume.',
    '---',
    'Run `aidlc engine next $ARGUMENTS`.',
  ].join('\n'))
  writeFileSync(join(claude, 'skills', 'aidlc-feature', 'SKILL.md'), '---\nname: aidlc-feature\ndescription: Feature scope.\ndisable-model-invocation: true\n---\nbody\n')
  writeFileSync(join(claude, 'skills', 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: x\n---\n')
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: '', hooks: [{ type: 'command', command: 'aidlc engine hook fold-usage' }] },
        { matcher: 'Task|Agent', hooks: [{ type: 'command', command: 'aidlc engine hook deliver-stage-rules', timeout: 30 }] },
        { matcher: 'Write', hooks: [{ type: 'http', url: 'http://x' }] },
      ],
      Stop: [{ hooks: [{ command: 'aidlc engine hook continue-workflow' }] }],
    },
  }))
  return root
}

test('findAidlcProject walks up to the install', () => {
  const root = fixture()
  const project = findAidlcProject(join(root, 'src', 'deep'), '.claude')
  assert.equal(project?.projectDir, root)
  assert.equal(project?.harnessPath, join(root, '.claude'))
  assert.equal(findAidlcProject(tmpdir(), '.claude-none'), undefined)
})

test('parseFrontmatter handles folded scalars and missing frontmatter', () => {
  const { data, body } = parseFrontmatter('---\ndescription: >\n  a\n  b\n---\nbody')
  assert.equal(data.description, 'a b\n')
  assert.equal(body, 'body')
  assert.deepEqual(parseFrontmatter('plain').data, {})
})

test('loadAgents reads name, display name, description, and body', () => {
  const project = findAidlcProject(fixture(), '.claude')!
  const agents = loadAgents(project)
  assert.deepEqual([...agents.keys()], ['aidlc-architect-agent'])
  const agent = agents.get('aidlc-architect-agent')!
  assert.equal(agent.displayName, 'Architect Agent')
  assert.equal(agent.description, 'Solutions architect responsible for domain design.')
  assert.match(agent.body, /^# Architect Agent/)
})

test('loadSkills keeps valid kebab-case skills with invocation policy', () => {
  const project = findAidlcProject(fixture(), '.claude')!
  const skills = loadSkills(project)
  assert.deepEqual(skills.map(s => s.name), ['aidlc', 'aidlc-feature'])
  assert.equal(skills[0]!.description, 'AI-DLC workflow orchestrator. Start or resume.')
  assert.equal(skills[0]!.modelInvocable, true)
  assert.equal(skills[1]!.modelInvocable, false)
  assert.equal(skills[1]!.userInvocable, true)
})

test('hook config keeps command hooks only and drops empty matchers', () => {
  const project = findAidlcProject(fixture(), '.claude')!
  const config = loadHookConfig(project)
  assert.deepEqual(config.PreToolUse, [
    { hooks: [{ command: 'aidlc engine hook fold-usage' }] },
    { matcher: 'Task|Agent', hooks: [{ command: 'aidlc engine hook deliver-stage-rules', timeoutSec: 30 }] },
  ])
  assert.deepEqual(config.Stop, [{ hooks: [{ command: 'aidlc engine hook continue-workflow' }] }])
  assert.deepEqual(parseHookConfig({ PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'x' }] }] }), {
    PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'x' }] }],
  })
  assert.deepEqual(parseHookConfig(null), {})
})
