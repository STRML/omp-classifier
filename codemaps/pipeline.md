> Generated: 2026-10-01 | Token-lean format for LLM context

# Decision pipeline: where a verdict comes from

Entry point: `handleToolCall(event, ctx)` at index.ts:6100, registered on `tool_call`. A return of
`undefined` hands the call back to the host's own approval flow. `{block:true, reason}` blocks it,
and the reason is JSON from `refusalPayload`. Every decision writes one audit line through
`logDecisionFor` → `logDecision`, and that line's `layer` names the step that decided.

## Preamble (both tools)

1. Return unless the tool is `bash` or `eval` with non-empty input.
2. Evidence snapshot, taken once per call: `operatorContextFromInput` + `collectToolEvidence`
   → `mergeOperatorContext`; `evidenceUserSnapshot(ctx)` → `citableEvidence` → `scopeFingerprint`.
3. `shadowFloor(...)` runs `evaluateFloor` and records the `floor` audit field. Shadow only, and it
   accumulates session taint.
4. `resolvePolicyContext(dir, policyDirectoryStable(text))` attaches the pinned trust policy, or
   withholds it when the command can move its own cwd. It builds the config signature, and a
   changed signature clears `cache`, `grants` and `floorTaint`.
5. Lockfile diagnostic (`lockfileDisablesPlugin`): a toast only, never decides.

## Bash path (index.ts:6560-7103), first match wins

| # | Check | Outcome | audit `layer` |
|---|---|---|---|
| 1 | `command.length > maxCommandLength` | block (refusal payload), `addRefusal(cap)` | `cap` |
| 2 | host static rule deny, or `tools.approval.bash: deny` (`readHostPolicy`, per-segment for compounds) | return undefined (host denies) | — |
| 3 | cwd input is an internal URL (`://`, `local:/`) | block | `cwd` |
| 4 | `readInterpretedScriptBodies` refusal (an unreadable or oversized script operand) | block, `addRefusal(cap)` | `script-body` |
|   | `judgedCommand = script.text` (bodies spliced in); measure the 4 provenance tiers; build `cacheKey`; `priorRefusalFor` | | |
| 5 | `CRITICAL_BASH_PATTERNS` match | `addRefusal(critical)` → `requestPermission` (no grant offered) | `critical` |
| 6 | caller-supplied `env` (`canonicalEnv`) | `requestPermission` (no grant offered) | `environment` |
| 7 | static `prompt` rule | return undefined (host prompts) | — |
| 8 | static `allow` rule, not blanket, no script bodies | allow | `rule` |
| 9 | no rule and `tools.approval.bash: prompt` | return undefined | — |
| 10 | `config.enabled === false` | return undefined | (dry-run: `config`) |
| 11 | `/classifier off` for this session (`sessionOff`) | return undefined | (dry-run: `session`) |
| 12 | `matchingGrant` (session grant, scoped by fingerprint) | allow | `granted` |
| 13 | `matchingPersistentGrant` (exact text + cwd, 30 days) | allow | `granted` |
| 14 | dry-run with no cached verdict | `dryRunStop(would: classify)` | `classifier` |
| 15 | **`classify(...)`** or a cache hit (`withoutShadow(cached)`) | Judgement (see below) | |
| 15a | classify threw | `requestPermission("unclassified")` | `unclassified` |
| 16 | verdict SAFE, no `matchModerateRiskTokens` flags, no script `INTERPRETER_CODE_RISK`, no prior refusal | allow | `verdict` / `cached` |
| 17 | verdict SAFE but flags or a prior refusal | `requestPermission("flagged for approval")` | `verdict` |
| 18 | UNSAFE / UNSURE / UNAVAILABLE | UNSAFE with `persistRefusal` → `addRefusal(model)`; then `requestPermission` with the `late` handle | `verdict` |
| — | any throw in the try block | block, fail closed | `internal-error` |

The cache write happens after 15 only when the verdict is not UNAVAILABLE, `!noCache`, and the
network tier is cacheable (no `directoryUnresolved`/`ambientConfigUnreadable`).

## Eval path (index.ts:6312-6558)

`evalSubprocessMarkers(code, language)` empty → return (the host's own eval approval applies) →
`!enabled` or `sessionOff` → return → `evalSpawnCwd` → `resolvePolicyContext` → length cap (`cap`)
→ spawn cwd `opaque` → `requestPermission("unreadable spawn cwd")` (`cwd`) → session grant
(`normalizeEvalGrantTarget`, both directories) → cache / dry-run → `priorRefusalFor` →
`classify(..., language "code")` → SAFE + no `evalRiskFlags` + no prior → allow; otherwise
`requestPermission`. The eval path has no critical-pattern or env step, and no persistent grants.

## `classify` (index.ts:5313), the only live judgment

```
measureGitPushProvenance(cmd, startCwd)    ┐ each in try/catch;
measureGitWorktreeProvenance(cwd)          │ undefined = "not measured"
measureGitRefProvenance(cmd, cwd)          │
measureNetworkProvenance(cmd, startCwd)    ┘
shadowJevV3(...) started in parallel when config.shadowV3
judgeBatteryUnderDeadline({timeoutMs, state: buildJevState(...), backend})   jev-judge.ts
  ├ answered → judgementFrom(answers)
  │     deriveJevDecision(answers, jevPolicyFor(config))   jev.ts  ◄── THE VERDICT
  │     risk tier: routine | review | irreversible (destructive hazard ≥ hazardBlock)
  │     authorization label: missing | grounded | not-required
  │     annotateJudgement(...)  fills reasonCode/risk defaults
  ├ failed   → UNAVAILABLE, noCache, reason "Jev unavailable: <err>"
  └ deadline → UNAVAILABLE, noCache, plus `late: {answer, cancel}` (late answers go through the same judgementFrom)
```

## `requestPermission` (index.ts:5770), L4

| Condition | Result | `layer` |
|---|---|---|
| dry-run | records "would prompt", block | — |
| `!ctx.hasUI` | cancels the late handle, block | `headless`, or `unclassified` when the headline is unclassified |
| UI | `ctx.ui.select`: Allow once / Allow for session / Always allow (bash + `persistentGrants`) / Deny | `dialog` |
| Allow* | `liftRefusals`; session → `addGrant`; always → `addPersistentGrant` | `dialog` + `approval` field |
| Deny or cancel | `addRefusal(human)`, block | `dialog` |
| late SAFE that passes the `replayDecision` guards | dismisses the dialog → allow | `late-verdict` |
| late UNSAFE / UNSURE | dialog stays open, notify + audit only | `late-verdict` |

Grants are not offered on `critical pattern`, `environment override` or `unreadable spawn cwd`.

## `replayDecision` (index.ts:1537): the shared deterministic tail

Production calls it at each step to get the `layer`/`decision`; eval/run.ts calls it to score.
Precedence: cap → static deny → `riskFlags` includes `critical` → envKeys → static prompt →
static allow → grant → no judgement (approval or `unclassified`) → SAFE with no prior refusal and
no flags (allow, `verdict`) → simulated user approval (allow, `approval`) → otherwise block `verdict`.
Output `hostHandoff`: `run` | `permission` | `headless-block`.

## Refusal memory sources (`addRefusal` source field)

`cap` (length or script-body), `critical`, `model` (UNSAFE with persistRefusal), `human` (deny or
cancel). Lifted only by `liftRefusals` when a user approves. Fed back to the judge as
`recordExtras.priorRefusal`.
