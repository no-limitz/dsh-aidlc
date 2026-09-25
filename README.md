# dsh-aidlc

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that loads
[AWS AI-DLC](https://awslabs.github.io/aidlc-workflows/) (AI-Driven Development Life Cycle):
its 14 agents, its `/aidlc` workflow skills, and its engine hooks (approval gates, state
guards, audit log, sensors).

> **Unofficial.** dsh-aidlc is a community project. It is not affiliated with, endorsed by,
> or supported by DeepSeek or Amazon Web Services. "DeepSeek Harness" is a trademark of
> DeepSeek, and "AWS" is a trademark of Amazon.com, Inc. or its affiliates; both are used
> here only to describe compatibility. See `THIRD_PARTY_NOTICES.md` for licenses.

AI-DLC ships one harness-neutral core plus a thin adapter per coding agent. It has no
DeepSeek Harness adapter yet, so this bundle runs AI-DLC's **Claude Code projection**
(`aidlc config --harness claude`) inside Harness and translates at the edges.

| AI-DLC (Claude Code form) | In DeepSeek Harness |
|---|---|
| `.claude/agents/aidlc-*.md` | `aidlc_agent` tool — each agent runs as an in-process subagent with its AI-DLC persona and a per-tier model route |
| `.claude/skills/*/SKILL.md` (42 skills, `/aidlc`, `/aidlc-feature`, …) | Skill provider that reads the workspace's `.claude/skills` |
| `.claude/settings.json` hooks | Host-plane bridge running the same `aidlc engine hook …` commands on Harness's interception points, with tool names translated (`write`→`Write`, `bash`→`Bash`, `aidlc_agent`→`Task`, …) |
| Claude tool names in AI-DLC prose | A system-prompt note mapping them to Harness tools |

## Requirements

- DeepSeek Harness `dsh` 0.1.5 or 0.1.7+ (tested on 0.1.5-rc.1 and 0.1.7-rc.1), with
  pnpm on `PATH`. The two versions compose presets differently; the bundle detects which
  one is running and mounts the matching preset.
- The AI-DLC native binary (`aidlc` ≥ 2.9.0), installed from the
  [AI-DLC Quick Start](https://github.com/awslabs/aidlc-workflows#quick-start).
  Bun is **not** required. You only need it if you install AI-DLC's "copy runtime" instead
  of the native binary; there the hooks run as `bun .claude/tools/aidlc.ts …`, so `bun` must
  be on `PATH` or in `extraPath`.
- An AI-DLC project set up for the Claude harness:

  ```sh
  cd /path/to/your-project
  aidlc config --harness claude
  ```

## Install

```sh
git clone https://github.com/no-limitz/dsh-aidlc.git && cd dsh-aidlc
npm ci && npm run build && npm pack          # → dsh-aidlc-0.1.0.tgz

# Create a Web profile once, then add the bundle to it
dsh --profile aidlc --from-default-profile web --dump-config > /dev/null
dsh plugin --profile aidlc add ./dsh-aidlc-0.1.0.tgz

dsh --profile aidlc --dump-config | grep -A3 '== dsh-aidlc'   # check the layer
```

Install the packed tarball rather than linking the checkout (`add ./`):

- A linked checkout keeps its own `node_modules`. On dsh 0.1.5 the bundle then loads
  dev-dependency copies of Harness packages instead of your installation's.
- `dsh plugin remove` of a linked checkout can move the checkout's `node_modules` into the
  profile.

Start Harness **from the AI-DLC project** (Harness uses the launch directory as the
default workspace):

```sh
cd /path/to/your-project
dsh --profile aidlc
```

In the Web UI, create a session with the **AI-DLC** agent preset, then:

```text
/aidlc Build a REST API for inventory management
```

## What the bundle mounts

`cordis.patch.yml` adds two rows on top of `dsh-base` + `dsh-web-app`:

- **`aidlc-hooks`** (`dsh-aidlc/hooks`, host plane). For every session whose workspace
  contains an AI-DLC install, it runs the hooks declared in `.claude/settings.json`,
  mirroring how Claude Code applies project hooks. Other workspaces are untouched.
  - PreToolUse gates (state-transition guard, reviewer scope, review freeze, plan approval)
    **deny** the Harness tool call and pass the engine's reason back to the model.
  - `deliver-stage-rules` rewrites the brief that `aidlc_agent` sends to the child agent.
  - Calls made inside a delegated agent carry that agent's name as `agent_type`, so the
    reviewer and state guards know who is acting.
  - Subagent sessions never fire SessionStart, UserPromptSubmit or Stop, matching Claude
    Code. A child therefore never records a human turn.
- **The AI-DLC agent preset**: the standard preset plus the `dsh-aidlc` row (skills,
  `aidlc_agent`, prompt note). Its tool-result pruner threshold is raised to 64 KB because
  the orchestrator `SKILL.md` is about 60 KB.
  - **dsh 0.1.7+:** declared by the `preset-aidlc` row.
  - **dsh 0.1.5:** the preset is `presets/aidlc/agent.cordis.yml`, which the
    `aidlc-preset-root` row adds to the `dsh-agent-presets` roster.

  Each row checks which preset registry is mounted and disables itself on the other
  version. Keep the two plugin lists in step.

## Configuration

Override rows in the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/aidlc/`). A patch
replaces a row's whole `config`, so restate every key.

### Per-tier model routing

AI-DLC assigns every agent a tier: 9 are `judgment`, 2 are `balanced` (the reviewer and
the product lead) and 3 are `templated` (delivery, operations, pipeline-deploy). Route each
tier to its own model. Any field you leave out is inherited from the conductor's route.

```yaml
- id: preset-aidlc
  config:
    id: aidlc
    name: AI-DLC
    order: 2
    plugins:
      # … keep the other rows from this bundle's cordis.patch.yml …
      - id: aidlc
        name: 'dsh-aidlc'
        config:
          harnessDir: .claude
          provider: spawn
          toolName: aidlc_agent
          tiers:
            judgment:  { model: deepseek-v4-pro, reasoningEffort: high }
            balanced:  { model: deepseek-v4-pro }
            templated: { model: deepseek-v4-flash }
          agentRoutes:
            aidlc-developer-agent: { reasoningEffort: max }
          agentTiers:
            my-custom-agent: templated     # tier for agents you add yourself
```

### Per-agent models: `dsh-aidlc-models`

A route set in a preset row can't be changed without restating the whole preset. So the
bundle also reads a user-level routes file, **`$DSH_HOME/aidlc-models.json`**, which takes
precedence over the row's `tiers` / `agentRoutes`. The file is re-read on every
`aidlc_agent` dispatch, so edits apply to the next agent with no restart. The bundled CLI
edits it:

```sh
dsh-aidlc-models show                                   # tiers, agents, what each resolves to
dsh-aidlc-models set --tier judgment --model deepseek-v4-pro
dsh-aidlc-models set --agent aidlc-developer-agent --model deepseek-v4-pro --effort high
dsh-aidlc-models unset --agent aidlc-developer-agent
dsh-aidlc-models reset
```

An agent route takes precedence over its tier's route, and any field left unset inherits from
the conductor's session (including the provider). The model must be one that the session's
provider serves. `DSH_AIDLC_MODELS_FILE` points the plugin and the CLI at a different file.

| `dsh-aidlc` field | Default | Meaning |
|---|---|---|
| `harnessDir` | `.claude` | AI-DLC projection directory in the project |
| `provider` | `spawn` | `ctx.subagents` provider that runs the agents. It must support `persona`, plus `agentOptions` when routes are set |
| `toolName` | `aidlc_agent` | Dispatch tool name. If you change it, set the same name as `dispatchToolName` on `aidlc-hooks` |
| `tiers` / `agentTiers` / `agentRoutes` | `{}` | Model routing, as above |
| `maxDepth` | host setting | Delegation-depth cap for AI-DLC children |
| `skillRank` | `150` | Rank used when skill names collide; lower wins. `.dsh/skills` is 100, `.agents/skills` is 200 |
| `adaptationPrompt` | `true` | Include the prompt note that maps Claude tool names to Harness tools |

| `dsh-aidlc/hooks` field | Default | Meaning |
|---|---|---|
| `harnessDir` | `.claude` | As above |
| `dispatchToolName` | `aidlc_agent` | Harness tool treated as Claude `Task` |
| `toolNameMap` | `{}` | Extra `harnessName: ClaudeName` mappings |
| `extraPath` | `['~/.local/bin']` | Directories prepended to `PATH` for hook commands (the AI-DLC installer's default location) |
| `defaultTimeoutMs` | `600000` | Per-hook timeout |
| `debug` | `false` | Log each hook's command, exit code and the start of its stderr |

## Development

```sh
npm run build      # tsc → lib/
npm run typecheck
npm test           # node:test; includes AI-DLC 2.9.0's real hook matchers
```

Source layout:

| File | Contents |
|---|---|
| `src/index.ts` | Preset row: skill provider, `aidlc_agent`, prompt section |
| `src/hooks.ts` | Host row: hook bridge |
| `src/project.ts` | Discovers the AI-DLC install: agents, skills, hook config (cached by mtime) |
| `src/translate.ts` | Tool-name map, agent tier table, prompt note |
| `src/route.ts` | Tier and per-agent model routing |
| `src/models.ts`, `src/models-cli.ts` | The `aidlc-models.json` routes layer and the `dsh-aidlc-models` CLI |
| `src/registry.ts` | State shared between the two rows: child agent identity, parked prompt rewrites |
| `src/shell.ts` | Hook runner that works with both shell-executor APIs (0.1.5 `run`, 0.1.7 `execute`) |
| `src/preset-root.ts` | dsh 0.1.5: adds `presets/` to the preset roster |

## Verified

Tested against `dsh` 0.1.7-rc.1 and 0.1.5-rc.1 with AI-DLC 2.9.0. The checks below made
no LLM calls.

- The profile composes, and a real Web boot loads both rows.
- An agent on the `aidlc` preset gets `aidlc_agent`, all 42 AI-DLC skills (the full 58 KB
  orchestrator loads) and the `aidlc:adaptation` prompt section.
- Through the real tool pipeline: `SessionStart` runs `aidlc engine hook session-start`.
  A `bash` call running `aidlc engine state advance …` is **denied** by AI-DLC's
  `state-transition-guard`, with the engine's reason returned to the model. An ordinary
  `bash` call passes all four PreToolUse gates.

### Live run on DeepSeek (dsh 0.1.5-rc.1, `deepseek-flash`)

The bundle was installed from its tarball into a real `~/.dsh` profile. A scripted user
then drove `/aidlc --scope poc` in a fresh project, asking for a Python temperature
converter with pytest tests, and approved every gate.

- **Completion:** all 7 POC stages completed; AI-DLC logged 7 `STAGE_COMPLETED` events.
  The generated `tempconv.py` works, and its 17 pytest tests pass when run independently.
- **Hooks:** 405 tool calls (274 by the conductor, 131 by delegated agents) passed through
  the hook bridge.
- **Agents:** 4 AI-DLC agent runs (product-lead ×2, architecture-reviewer, developer) went
  through `aidlc_agent`. AI-DLC's audit recorded each `SUBAGENT_COMPLETED` under the right
  agent type.
- **Gates:** the plan-approval guard denied 6 real calls, the model recovered each time, and
  plan approval then unlocked the developer agent.
- **Audit trail:** hook-driven audit events were written (23 `HUMAN_TURN`,
  44 `ARTIFACT_*`, 10 `SENSOR_FIRED`).

Bugs this run exposed, all fixed and covered in `src/`:

- `resolveMaxDepth` doesn't exist on 0.1.5.
- The 0.1.5 shell executor has a different API.
- SessionStart's top-level `additionalContext` was dropped. Without it the conductor lacked
  its runtime session id, which Plan Approval needs.

## Known limitations

- **Only the `poc` scope has been run live.** Larger scopes (`feature`, `enterprise`) and
  the construction swarm haven't been exercised.
- **AI-DLC's plan-approval guard is strict.** Before a Code Generation plan is approved, it
  denies any shell redirection, including `2>/dev/null`, and any engine verb that isn't on
  the path to approval. The adaptation prompt warns the model; expect a few recoverable
  denials anyway.
- **`aidlc_agent` runs in the foreground only.** It has no `run_in_background`. Parallel
  dispatches in one assistant message do run concurrently.
- **Unsupported events.** Harness has no hook points for `SessionEnd` (`SESSION_ENDED` is
  never emitted), `PreCompact` (`validate-state`) or the Claude status line.
- **`transcript_path` is always empty**, so `fold-usage` cannot fold token usage from a
  transcript.
- **`sync-workflow-state` is not wired.** It expects Claude's `TaskUpdate` shape, while
  Harness's `todo_write` uses a different one. Stage state still advances through the
  engine's own `report` path.
- **The preset needs the Web surface** (`dsh-web-app`). Base-only profiles, such as
  headless or SDK, still run the hooks but don't get the preset.
- **Keep the workspace inside the AI-DLC project.** The skill provider, dispatch tool and
  hooks all look for the nearest `.claude/` at or above the session workspace.

## Roadmap: upstream harness port

The longer-term plan is a native `harness/deepseek/` in
[awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows), following its
[porting guide](https://github.com/awslabs/aidlc-workflows/blob/main/docs/harness-engineering/09-porting-to-a-new-harness.md).
Then `aidlc config --harness deepseek` would generate the Harness surfaces directly:

1. `manifest.ts`: `harnessDir: ".dsh"`. Skills go to `.agents/skills/`, which Harness
   discovers without a custom provider. Add root integrations and onboarding into `AGENTS.md`.
2. `emit.ts`: generate the profile `cordis.patch.yml` and the per-agent routes from
   AI-DLC's own tier and model policy (`aidlc config models`).
3. `hooks/aidlc-deepseek-adapter.ts`: the translation this bundle does in `src/hooks.ts`,
   rewritten as the per-harness adapter.
4. Skill prose written in Harness tool names (`aidlc_agent`, `ask_user_question`,
   `todo_write`), which removes the need for the adaptation prompt.
5. Tests for the doctor arm, the hook-adapter contract and a live journey, as the guide
   requires.
