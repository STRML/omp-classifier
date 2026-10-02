> Generated: 2026-10-01 | Token-lean format for LLM context

# omp-classifier architecture

OMP plugin: a permission gate on `bash` and spawn-bearing `eval` tool calls. It asks Jev
(TypeSafe System One) typed questions and derives the verdict in code from the numbers it gets back.
There is no model prose anywhere. TypeScript on Bun ≥1.3.14, no build step (`package.json`
`omp.extensions: ["./index.ts"]`).

| Command | What |
|---|---|
| `bun test` | all tests (`tests/*.test.ts`) |
| `bunx tsc -p tsconfig.json` | typecheck |
| `bun run tools/generate-arity.ts` | regenerate `arity.generated.ts` |
| `bun eval/run.ts` | score policy against corpora (L5) |

Runtime dep: `mvdan-sh` (shell parser, loaded lazily by `shell-ast.ts`). Dev deps are the host
(`@oh-my-pi/pi-coding-agent`, `pi-ai`, `pi-utils` 18.2.4); host source is at
`node_modules/@oh-my-pi/pi-coding-agent/src/`.

## Layer tower → files (docs/SYSTEM.md)

| Layer | Holds | Files |
|---|---|---|
| L6 control plane | `/classifier` command, config bounds, kill switches, status | index.ts (plugin factory, config section) |
| L5 self-measurement | eval harness, corpora, sweep, shadow report | eval/*.ts, eval/corpus/*.jsonl, eval/weekly-report.sh |
| L4 interaction | dialogs, refusal payloads, grants, dry-run | index.ts (`requestPermission`, `refusalPayload`, grants) |
| L3 memory | verdict cache, refusal memory, audit log | index.ts (module state, `logDecision`) |
| L2 judgment | state + battery, transport, derivation | jev.ts, jev-judge.ts, decision-order.ts, authorization.ts |
| L1 recognition | critical/structural/overlay scans, floor, literal match | index.ts (overlay scanners), floor.ts, literal-match.ts, recognizer.ts |
| L0 evidence | command, cwd, user msgs, pinned policy, measured provenance | index.ts (evidence), jev.ts (`measure*`), trust-policy.ts, shell-cwd.ts |
| shared infra | parser, cwd walk, redaction, CLI grammars | shell-ast.ts, shell-cwd.ts, redact.ts, arity.ts (+arity.generated.ts) |

## Module import graph (verified from `import` lines)

```
index.ts ─┬─► decision-order.ts ─► jev.ts
          ├─► jev-judge.ts ──────► jev.ts, authorization.ts, host judgment / pi-ai
          ├─► authorization.ts ──► arity.ts ─► arity.generated.ts
          │                     └► floor.ts, redact.ts, shell-ast.ts
          ├─► literal-match.ts ──► floor.ts, shell-ast.ts
          ├─► floor.ts ──────────► shell-cwd.ts, shell-ast.ts, redact.ts
          ├─► jev.ts ────────────► shell-cwd.ts, shell-ast.ts, redact.ts
          ├─► trust-policy.ts ───► host pi-utils
          └─► shell-cwd.ts ──────► shell-ast.ts ─► mvdan-sh (lazy)
recognizer.ts ─► floor.ts, shell-ast.ts      (not imported by index.ts)
```

| Module | Imports (local) | Imported by |
|---|---|---|
| index.ts | floor, shell-cwd, shell-ast, jev-judge, authorization, decision-order, literal-match, redact, trust-policy, jev | eval/run.ts, eval/live-report.ts, eval/recognizer-measure.ts, tests |
| jev.ts | redact, shell-ast, shell-cwd, trust-policy(type) | index, jev-judge, decision-order, authorization(type), eval/run, eval/mine-history |
| jev-judge.ts | authorization, jev | index, eval/run |
| decision-order.ts | authorization(type), jev | index |
| authorization.ts | arity, floor, redact, shell-ast, trust-policy(type), jev(type) | index, jev-judge, decision-order(type) |
| floor.ts | redact, shell-ast, shell-cwd; host `CRITICAL_BASH_PATTERNS`, `resolveToCwd` | index, authorization, literal-match, recognizer |
| literal-match.ts | floor, shell-ast | index |
| recognizer.ts | floor, shell-ast | eval/recognizer-measure only |
| shell-cwd.ts | shell-ast | index, jev, floor |
| shell-ast.ts | mvdan-sh | index, jev, floor, authorization, literal-match, recognizer, shell-cwd |
| trust-policy.ts | host pi-utils | index (+ types elsewhere) |
| redact.ts | (none) | index, jev, floor, authorization, eval/recognizer-measure |
| arity.ts | arity.generated | authorization |

## Host touchpoints

| Host API | Used in | For |
|---|---|---|
| `pi.on("tool_call")` | index.ts:7105 | `handleToolCall`, the gate |
| `pi.on(session_start/before_switch/switch)` | index.ts:7120-7122 | `dropCurrent`: clears this session's state |
| `pi.on("session_shutdown")` | index.ts:7137 | same, plus stale-disable warned flag |
| `pi.registerCommand("classifier")` | index.ts:4933 | L6 control plane |
| `pi.pi.settings` | index.ts:4926 | host `bash.patterns`, `tools.approval` (static rules) |
| `@oh-my-pi/pi-coding-agent/judgment` `resolveJudge` | jev-judge.ts | the native judge (TypeSafe or the tiny/smol chat chain) |
| `pi-ai` `TypeSafeJudge` | jev-judge.ts (endpoint backend), eval/run.ts | custom endpoint transport |
| `tools/bash` `CRITICAL_BASH_PATTERNS` | index.ts, floor.ts, eval/run.ts | built-in critical patterns |
| `tools/shell-tokenize` | index.ts | `extractLeadingCdTarget`, `tokenizeShellSegments` |

## Live versus shadow

| Path | Decides? | Where |
|---|---|---|
| jev-v2 battery → `deriveJevDecision` | **live** | `classify` (index.ts:5313) |
| code floor `evaluateFloor` | shadow: `floor` field on every audit line | `shadowFloor` (index.ts:5706) |
| jev-v3 battery + authorization → `deriveDecisionOrder` (uses `literalMatch`) | shadow: `v3` field; config `shadowV3` (default true) | `shadowJevV3` (index.ts:5168) |
| `recognizeRoutineCommand` | measurement only | eval/recognizer-measure.ts |

## Identities and versions

| Name | Value | Defined |
|---|---|---|
| `JEV_POLICY_VERSION` (= `CLASSIFIER_POLICY_VERSION`) | `jev-v2.11` | jev.ts:83, index.ts:392 |
| `JEV_V3_POLICY_VERSION` | `jev-v3.1` | jev.ts:89 |
| `AUTHORIZATION_VERSION` | `jev-auth-v2` | authorization.ts:818 |
| `CLASSIFIER_POLICY_HASH` | `jevQuestionsHash()`: sha256 of version + battery + default policy, 16 hex | index.ts:1228 |
| `QUESTIONS_CONTRACT` | `questions+probabilities` | index.ts:1222 |
| `DEFAULT_JEV_MODEL` | `jev-latest` | jev.ts:97 |
| backend id | `typesafe/<model>` or `endpoint/<baseUrl>#<model>` | jev-judge.ts `judgeBackendFor` |

## Files on disk at runtime

`root` = `dirname(getPluginsDir())`. `OMP_JEV_CONFIG` replaces the config path; the data dir
then becomes `dirname(OMP_JEV_CONFIG)` (`classifierDataDir`, index.ts:894).

| Path (default) | Written by |
|---|---|
| `root/omp-classifier.json` | `/classifier <key> <value>` (`classifierConfigPath`) |
| `root/omp-classifier-grants.json` (beside the config) | "Always allow" (30-day persistent grants) |
| `root/omp-classifier/decisions.jsonl` (mode 0600) | `logDecision`, one line per decision |
| `root/omp-classifier/status.json` | `/classifier status` |

See also: pipeline.md (decision order), plugin.md (index.ts internals), judgment.md (L2),
recognition.md (L0/L1 modules), eval.md (L5 + tests).
