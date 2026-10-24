> Generated: 2026-10-01 | Token-lean format for LLM context

# index.ts internals (7147 lines)

Read this before opening index.ts. Line numbers are where each declaration starts.

## Section map

| Lines | Section | Key symbols |
|---|---|---|
| 1-128 | header + imports | |
| 130-385 | module state, `Judgement` type | `cache`, `refusals`, `floorTaint`, `sessionOff`, `dryRun`, `STALE_CODE_SUFFIX`, `pluginStaleSuffix` |
| 385-650 | host static rules | `BashApprovalPatternRule`, `bashApprovalRuleMatches`, `parseBashApprovalPatternRules`, `isBlanketPattern`, `canonicalEnv` |
| 649-900 | config (L6) | `ClassifierConfig`, `JEV_POLICY_RANGES`, `CLASSIFIER_CONFIG_DEFAULTS`, `jevPolicyFor`, `normalizeClassifierConfig` (790), `readClassifierConfig` (849), `writeClassifierConfig` (866) |
| 894-1060 | paths, audit record, status | `classifierDataDir`, `decisionsLogPath`, `DecisionRecord` (922), `StatusReport`, `buildStatusReport` (1014) |
| 1060-1230 | plugin lockfile diagnostic, config format | `lockfileDisablesPlugin`, `formatClassifierConfig`, `QUESTIONS_CONTRACT`, `CLASSIFIER_POLICY_HASH` |
| 1230-1475 | evidence fingerprinting, outbound network | `evidenceUserSnapshot`, `citableEvidence`, `evidenceFingerprint`, `commandHasOutboundNetwork` |
| 1474-1580 | judgement tail | `annotateJudgement`, `ReplayDecisionInput`, `replayDecision` (1537) |
| 1580-1870 | provenance-tiered evidence (#31) | `collectUserEvidence`, `collectTaskEvidence`, `collectTaskEvidenceV3`, `operatorContextFromInput`, `collectToolEvidence`, `mergeOperatorContext` |
| 1872-2840 | eval payload scanning | `MODERATE_RISK_TOKENS`, `INTERPRETER_FLAG_GRAMMAR`, `INTERPRETER_CODE_RISK`, `evalRiskFlags`, `evalSubprocessMarkers`, `evalCwdSites`, `evalSpawnCwd` |
| 2839-3910 | wrappers, interpreters, script bodies (#67) | `WRAPPER_OPTION_GRAMMAR`, `POLICY_UNSTABLE_VERBS`, `interpreterInvocation`, `withoutWrittenHeredocBodies`, `interpreterProgramRefs`, `readInterpretedScriptBodies` (3775) |
| 3911-4515 | pipe / compound splitting, risk overlay | `splitPipeStages`, `isPlainReadOnlyFetch`, `splitTopLevelCommands`, `rmForcesDialog`, `matchModerateRiskTokens` (4279), `trashFootnote` |
| 4517-4920 | L3 session memory | `remember`, `addRefusal`, `normalizeActionTarget`, `priorRefusalFor`, `priorRefusalLifts`, `userMessagesSince` |
| 4922-7147 | `export default function (pi)`: the plugin factory | see below |

## Inside the factory (closures over `pi`, `settings`)

| Line | Closure | Role |
|---|---|---|
| 4701 | `pi.registerCommand("classifier")` | L6 subcommands (below) |
| 4889 | `readHostPolicy` | host `bash.patterns` + `tools.approval.bash` |
| 4920 | `shadowJevV3` | v3 shadow; never throws; result goes in `Judgement.v3` |
| 5061 | `classify` | the live judgment (see pipeline.md) |
| 5271 | `refusalPayload` | JSON block reason for the agent: `{classifier:"blocked", tool, layer, why, next, notThis, ...axes}` |
| 5306 | `logDecision` | appends to decisions.jsonl; redacts and truncates `cmd` to 120 chars; dry-run captures here |
| 5367 | `shadowFloor` | `evaluateFloor` + session taint |
| 5396 | `logDecisionFor` | adds `sessionId` |
| 5449 | `REFUSAL_GUIDANCE` | per-cause headline, `next`, `notThis` |
| 5505 | `refuse` | the gate's only block for a judged call: terminal audit line + payload |
| 5546 | `dryRunStop` | ends a dry-run probe |
| 5551 | `handleToolCall` | the gate; `pi.on("tool_call")` at 6458 |
| 6463 | `dropCurrent` | per-session state reset on session events |

## Module state (L3, per process, keyed by sessionId)

| Store | Cap | Cleared by |
|---|---|---|
| `cache: Map<session, Map<key, Judgement>>` | `CACHE_CAP` 500 | config-signature change (all sessions), session events |
| `refusals: Map<session, Refusal[]>` | `REFUSAL_CAP` 20 | session events only |
| `floorTaint: Map<session, string[]>` | `FLOOR_TAINT_CAP` 50 | signature change, session events |
| `sessionOff: Set<session>` | — | `/classifier on`, session events |
| `staleDisableWarned: Set<session>` | — | `session_shutdown` |
| `dryRun` capture | — | set and cleared around `/classifier dry-run` |

## Config (`ClassifierConfig`, file `omp-classifier.json`)

| Key | Default | Notes |
|---|---|---|
| `enabled` | true | false stops model classification only; critical, env and static rules still run |
| `typesafeModel` | env `TYPESAFE_DEFAULT_MODEL` or `jev-latest` | derived on each read, not stored |
| `judgeBackend` | `{kind:"typesafe"}` | `parseJudgeBackend` |
| `jevPolicy` | `{}` | merged over `DEFAULT_JEV_POLICY`; an invalid value is dropped |
| `timeoutMs` | 8000 (`DEFAULT_TIMEOUT_MS`) | judge deadline |
| `maxCommandLength` | 8000 | bounds 64-100000 |
| `evidenceUserMessages` | 3 | bounds 0-6 |
| `trustPolicy` | null | set only by `/classifier trust-policy` |
| `shadowV3` | true | runs `shadowJevV3` |
| `logJudgedStates` | false | writes redacted judged states to `judged-states.jsonl` (`recordJudgedState`, 0600, keyed by lead `decisionId`); `BOOLEAN_CONFIG_NOTICES` holds the on/off notices for the three boolean keys |

Config signature (cache-clearing): enabled, typesafeModel, backend id, merged policy, timeoutMs,
maxCommandLength, evidenceUserMessages, trust-policy signature.

## `/classifier` subcommands (index.ts:4933-5136)

(none) prints config · `file` · `dry-run <cmd>` runs `handleToolCall` with capture, nothing
executes · `status` writes status.json · `reset` · `trust-policy` · `enabled true|false` ·
`off` / `on` (session pause) · `policy` (read-only merged policy + battery hash) ·
`timeoutMs` · `maxCommandLength` · `evidenceUserMessages` · `shadowV3` · `logJudgedStates`.

## `DecisionRecord` (one audit line, index.ts:922)

`ts, decisionId, sessionId, policyVersion, policyHash, modelId, reasonCode, jev{model,
probabilities, hazards, confidence, blastRadius, usage, latencyMs}, userMessageIds,
authorization, v3, tool, decision, layer, why, cmd, cwd, spawnCwd, verdict, cached, ms,
staleCode, floor{asks, entries}, followsDecisionId` (blocked lines point at the verdict/cwd/critical/environment line before them; unclassified lines carry none). Older logs also carry `approval`.

No-UI sessions: `userChannelBranch(ctx)` returns an empty branch when `!ctx.hasUI`, so `evidenceUserSnapshot` and `shadowJevV3` see no user words; tool evidence still reads the whole branch.

`layer` values: `cap`, `rule`, `cwd`, `script-body`, `critical`, `environment`,
`verdict`, `cached`, `blocked`, `unclassified`, `internal-error` (older logs also hold `dialog`, `headless`, `granted` and `late-verdict`).

## Exports consumed outside index.ts

| Export | Consumers |
|---|---|
| `replayDecision`, `evalRiskFlags`, `matchModerateRiskTokens` | eval/run.ts, tests |
| `decisionsLogPath`, `DecisionRecord` | eval/live-report.ts, eval/recognizer-measure.ts |
| `classifierConfigPath`, `classifierDataDir`, `readClassifierConfig`, `formatClassifierConfig`, `buildStatusReport`, `normalizeActionTarget`, `collect*Evidence`, `operatorContextFromInput`, `annotateJudgement`, `commandHasOutboundNetwork`, `readInterpretedScriptBodies`, `withoutWrittenHeredocBodies`, `evalSpawnCwd`, `evalSubprocessMarkers`, `pluginStaleSuffix`, `STALE_CODE_SUFFIX` | tests |
| `jevPolicyFor`, `trashFootnote` | exported, but no consumer outside index.ts |
| default export | OMP host (and tests/fixtures.ts `loadPlugin`) |
