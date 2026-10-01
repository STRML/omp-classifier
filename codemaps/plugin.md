> Generated: 2026-10-01 | Token-lean format for LLM context

# index.ts internals (7147 lines)

Read this before opening index.ts. Line numbers are where each declaration starts.

## Section map

| Lines | Section | Key symbols |
|---|---|---|
| 1-128 | header + imports | |
| 130-385 | module state, `Judgement` type | `cache`, `refusals`, `grants`, `floorTaint`, `sessionOff`, `dryRun`, `STALE_CODE_SUFFIX`, `pluginStaleSuffix` |
| 385-650 | host static rules | `BashApprovalPatternRule`, `bashApprovalRuleMatches`, `parseBashApprovalPatternRules`, `isBlanketPattern`, `canonicalEnv` |
| 649-900 | config (L6) | `ClassifierConfig`, `JEV_POLICY_RANGES`, `CLASSIFIER_CONFIG_DEFAULTS`, `jevPolicyFor`, `normalizeClassifierConfig` (790), `readClassifierConfig` (849), `writeClassifierConfig` (866) |
| 894-1060 | paths, audit record, status | `classifierDataDir`, `decisionsLogPath`, `DecisionRecord` (922), `StatusReport`, `buildStatusReport` (1014) |
| 1060-1230 | plugin lockfile diagnostic, config format | `lockfileDisablesPlugin`, `formatClassifierConfig`, `QUESTIONS_CONTRACT`, `CLASSIFIER_POLICY_HASH` |
| 1230-1475 | evidence fingerprinting, outbound network | `evidenceUserSnapshot`, `citableEvidence`, `evidenceFingerprint`, `commandHasOutboundNetwork` |
| 1474-1580 | judgement tail | `annotateJudgement`, `ReplayDecisionInput`, `replayDecision` (1537) |
| 1580-1870 | provenance-tiered evidence (#31) | `collectUserEvidence`, `collectTaskEvidence`, `collectTaskEvidenceV3`, `scopeFingerprint`, `operatorContextFromInput`, `collectToolEvidence`, `mergeOperatorContext` |
| 1872-2840 | eval payload scanning | `MODERATE_RISK_TOKENS`, `INTERPRETER_FLAG_GRAMMAR`, `INTERPRETER_CODE_RISK`, `evalRiskFlags`, `evalSubprocessMarkers`, `evalCwdSites`, `evalSpawnCwd` |
| 2839-3910 | wrappers, interpreters, script bodies (#67) | `WRAPPER_OPTION_GRAMMAR`, `POLICY_UNSTABLE_VERBS`, `interpreterInvocation`, `withoutWrittenHeredocBodies`, `interpreterProgramRefs`, `readInterpretedScriptBodies` (3775) |
| 3911-4515 | pipe / compound splitting, risk overlay | `splitPipeStages`, `isPlainReadOnlyFetch`, `splitTopLevelCommands`, `rmForcesDialog`, `matchModerateRiskTokens` (4279), `trashFootnote` |
| 4517-4920 | L3 session memory | `remember`, `addRefusal`, `liftRefusals`, `normalizeGrantTarget`, `grantKeyForCommand`, `addGrant`, `matchingGrant`, persistent grants (`loadPersistentGrants`, `matchingPersistentGrant`, `addPersistentGrant`), `priorRefusalFor` (4901) |
| 4922-7147 | `export default function (pi)`: the plugin factory | see below |

## Inside the factory (closures over `pi`, `settings`)

| Line | Closure | Role |
|---|---|---|
| 4933 | `pi.registerCommand("classifier")` | L6 subcommands (below) |
| 5137 | `readHostPolicy` | host `bash.patterns` + `tools.approval.bash` |
| 5168 | `shadowJevV3` | v3 shadow; never throws; result goes in `Judgement.v3` |
| 5313 | `classify` | the live judgment (see pipeline.md) |
| 5543 | `buildPermissionBody` | dialog body; non-authored text indented as a code block |
| 5614 | `refusalPayload` | JSON block reason for the agent: `{classifier:"blocked", tool, layer, why, next, notThis, ...axes}` |
| 5649 | `logDecision` | appends to decisions.jsonl; redacts and truncates `cmd` to 120 chars; dry-run captures here |
| 5706 | `shadowFloor` | `evaluateFloor` + session taint |
| 5735 | `logDecisionFor` | adds `sessionId` |
| 5770 | `requestPermission` | dialog / headless block / grants / late race |
| 6095 | `dryRunStop` | ends a dry-run probe |
| 6100 | `handleToolCall` | the gate; `pi.on("tool_call")` at 7105 |
| 7110 | `dropCurrent` | per-session state reset on session events |

## Module state (L3, per process, keyed by sessionId)

| Store | Cap | Cleared by |
|---|---|---|
| `cache: Map<session, Map<key, Judgement>>` | `CACHE_CAP` 500 | config-signature change (all sessions), session events |
| `refusals: Map<session, Refusal[]>` | `REFUSAL_CAP` 20 | session events; `liftRefusals` on approval |
| `grants: Map<session, Grant[]>` | `GRANT_CAP` 50 | signature change, session events |
| `floorTaint: Map<session, string[]>` | `FLOOR_TAINT_CAP` 50 | signature change, session events |
| `sessionOff: Set<session>` | — | `/classifier on`, session events |
| `staleDisableWarned: Set<session>` | — | `session_shutdown` |
| persistent grants file | `PERSISTENT_GRANT_CAP` 500, TTL 30 days | expiry |
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
| `persistentGrants` | true | kill switch; not part of the signature |
| `shadowV3` | true | runs `shadowJevV3` |
| `logJudgedStates` | false | writes redacted judged states to `judged-states.jsonl` (`recordJudgedState`, 0600, keyed by lead `decisionId`); `BOOLEAN_CONFIG_NOTICES` holds the on/off notices for the three boolean keys |

Config signature (cache-clearing): enabled, typesafeModel, backend id, merged policy, timeoutMs,
maxCommandLength, evidenceUserMessages, trust-policy signature.

## `/classifier` subcommands (index.ts:4933-5136)

(none) prints config · `file` · `dry-run <cmd>` runs `handleToolCall` with capture, nothing
executes · `status` writes status.json · `reset` · `trust-policy` · `enabled true|false` ·
`off` / `on` (session pause) · `policy` (read-only merged policy + battery hash) ·
`timeoutMs` · `maxCommandLength` · `evidenceUserMessages` · `persistentGrants` · `shadowV3` · `logJudgedStates`.

## `DecisionRecord` (one audit line, index.ts:922)

`ts, decisionId, sessionId, policyVersion, policyHash, modelId, reasonCode, jev{model,
probabilities, hazards, confidence, blastRadius, usage, latencyMs}, userMessageIds,
authorization, v3, approval, tool, decision, layer, why, cmd, cwd, spawnCwd, verdict, cached, ms,
staleCode, floor{asks, entries}, followsDecisionId` (dialog/headless/late-verdict lines point at the verdict/cwd/critical/environment line before them; unclassified lines carry none).

No-UI sessions: `userChannelBranch(ctx)` returns an empty branch when `!ctx.hasUI`, so `evidenceUserSnapshot` and `shadowJevV3` see no user words; tool evidence still reads the whole branch.

`layer` values: `cap`, `rule`, `cwd`, `script-body`, `critical`, `environment`, `granted`,
`verdict`, `cached`, `dialog`, `headless`, `unclassified`, `late-verdict`, `internal-error`.

## Exports consumed outside index.ts

| Export | Consumers |
|---|---|
| `replayDecision`, `evalRiskFlags`, `matchModerateRiskTokens` | eval/run.ts, tests |
| `decisionsLogPath`, `DecisionRecord` | eval/live-report.ts, eval/recognizer-measure.ts |
| `classifierConfigPath`, `classifierDataDir`, `readClassifierConfig`, `formatClassifierConfig`, `buildStatusReport`, `normalizeGrantTarget`, `collect*Evidence`, `operatorContextFromInput`, `annotateJudgement`, `commandHasOutboundNetwork`, `readInterpretedScriptBodies`, `withoutWrittenHeredocBodies`, `evalSpawnCwd`, `evalSubprocessMarkers`, `pluginStaleSuffix`, `STALE_CODE_SUFFIX` | tests |
| `jevPolicyFor`, `trashFootnote` | exported, but no consumer outside index.ts |
| default export | OMP host (and tests/fixtures.ts `loadPlugin`) |
