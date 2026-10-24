> Generated: 2026-10-01 | Token-lean format for LLM context

# Decision pipeline: where a verdict comes from

Entry point: `handleToolCall(event, ctx)` at index.ts:5551, registered on `tool_call`. A return of
`undefined` hands the call back to the host's own approval flow. `{block:true, reason}` blocks it,
and the reason is JSON from `refusalPayload`. Every decision writes one audit line through
`logDecisionFor` → `logDecision`, and that line's `layer` names the step that decided.

## Preamble (both tools)

1. Return unless the tool is `bash` or `eval` with non-empty input.
2. Evidence snapshot, taken once per call: `operatorContextFromInput` + `collectToolEvidence`
   → `mergeOperatorContext`; `evidenceUserSnapshot(ctx)` → `citableEvidence`.
3. `shadowFloor(...)` runs `evaluateFloor` and records the `floor` audit field. Shadow only, and it
   accumulates session taint.
4. `resolvePolicyContext(dir, policyDirectoryStable(text))` attaches the pinned trust policy, or
   withholds it when the command can move its own cwd. It builds the config signature, and a
   changed signature clears `cache` and `floorTaint`.
5. Lockfile diagnostic (`lockfileDisablesPlugin`): a toast only, never decides.

## Bash path (index.ts:6560-7103), first match wins

| # | Check | Outcome | audit `layer` |
|---|---|---|---|
| 1 | `command.length > maxCommandLength` | block (refusal payload), `addRefusal(cap)` | `cap` |
| 2 | host static rule deny, or `tools.approval.bash: deny` (`readHostPolicy`, per-segment for compounds) | return undefined (host denies) | — |
| 3 | cwd input is an internal URL (`://`, `local:/`) | block | `cwd` |
| 4 | `readInterpretedScriptBodies` refusal (an unreadable or oversized script operand) | block, `addRefusal(cap)` | `script-body` |
|   | `judgedCommand = script.text` (bodies spliced in); measure the 4 provenance tiers; build `cacheKey`; `priorRefusalFor` | | |
| 5 | `CRITICAL_BASH_PATTERNS` match | `addRefusal(critical)` → `refuse(critical)` | `critical` |
| 6 | caller-supplied `env` (`canonicalEnv`) | `refuse(environment)` | `environment` |
| 7 | static `prompt` rule | return undefined (host prompts) | — |
| 8 | static `allow` rule, not blanket, no script bodies | allow | `rule` |
| 9 | no rule and `tools.approval.bash: prompt` | return undefined | — |
| 10 | `config.enabled === false` | return undefined | (dry-run: `config`) |
| 11 | `/classifier off` for this session (`sessionOff`) | return undefined | (dry-run: `session`) |
| 14 | dry-run with no cached verdict | `dryRunStop(would: classify)` | `classifier` |
| 15 | **`classify(...)`** or a cache hit (`withoutShadow(cached)`) | Judgement (see below) | |
| 15a | classify threw | `refuse(unclassified)` | `unclassified` |
| 16 | verdict SAFE, no `matchModerateRiskTokens` flags, no script `INTERPRETER_CODE_RISK`, and no prior refusal or one `priorRefusalLifts` lifts (then `liftRefusals`) | allow | `verdict` / `cached` |
| 17 | verdict SAFE but flags, or a prior refusal that did not lift | `refuse(flagged)` / `refuse(prior-refusal)` | `verdict` |
| 18 | UNSAFE / UNSURE / UNAVAILABLE | UNSAFE with `persistRefusal` → `addRefusal(model)`; then `refuse(unsafe/unsure/unavailable)` | `verdict` |
| — | any throw in the try block | block, fail closed | `internal-error` |

The cache write happens after 15 only when the verdict is not UNAVAILABLE, `!noCache`, and the
network tier is cacheable (no `directoryUnresolved`/`ambientConfigUnreadable`).

## Eval path (index.ts:6312-6558)

`evalSubprocessMarkers(code, language)` empty → return (the host's own eval approval applies) →
`!enabled` or `sessionOff` → return → `evalSpawnCwd` → `resolvePolicyContext` → length cap (`cap`)
→ spawn cwd `opaque` → `refuse(cwd)` (`cwd`) → cache / dry-run → `priorRefusalFor` →
`classify(..., language "code")` → SAFE + no `evalRiskFlags` + no unlifted prior → allow; otherwise
`refuse`, with the same causes as bash. The eval path has no critical-pattern or env step.

## `classify` (index.ts:5313), the only live judgment

```
measureGitPushProvenance(cmd, startCwd)    ┐ each in try/catch;
measureGitWorktreeProvenance(cwd)          │ undefined = "not measured"
measureGitRefProvenance(cmd, cwd)          │
measureNetworkProvenance(cmd, startCwd)    │
measureDeleteTargets(cmd, startCwd)        ┘ (shell only)
shadowJevV3(...) started in parallel when config.shadowV3
judgeBatteryUnderDeadline({timeoutMs, state: buildJevState(...), backend})   jev-judge.ts
  ├ answered → judgementFrom(answers)
  │     deriveJevDecision(answers, jevPolicyFor(config))   jev.ts  ◄── THE VERDICT
  │     risk tier: routine | review | irreversible (destructive hazard ≥ hazardBlock)
  │     authorization label: missing | grounded | not-required
  │     annotateJudgement(...)  fills reasonCode/risk defaults
  ├ failed   → UNAVAILABLE, noCache, reason "Jev unavailable: <err>"
  └ deadline → request aborted; UNAVAILABLE, noCache
```

## `refuse` (index.ts:5505), L4

The gate never prompts (https://github.com/STRML/omp-classifier/issues/184). Every block a
judged call ends in goes through `refuse(ctx, target, cause, reason, tool, logWhyPrefix,
auditExtras)`: it writes the terminal audit line and returns `refusalPayload(tool, cause, …)`.

| `cause` (payload `layer`) | From | Terminal audit `layer` |
|---|---|---|
| `critical`, `environment` | steps 5, 6 | `blocked` |
| `cwd` | eval unreadable spawn cwd | `blocked` |
| `unsafe`, `unsure`, `unavailable` | step 18 (`VERDICT_CAUSE`) | `blocked` (carries `verdict`) |
| `flagged`, `prior-refusal` | step 17 | `blocked` |
| `unclassified` | step 15a | `unclassified` (no lead line) |

`REFUSAL_GUIDANCE` holds each cause's headline, `next` and `notThis`. Dry-run records the
first decision through `logDecision`, so a probe reports `would: block`.


## `replayDecision` (index.ts:1537): the shared deterministic tail

Production calls it at each step to get the `layer`/`decision`; eval/run.ts calls it to score.
Precedence: cap → static deny → `riskFlags` includes `critical` → envKeys → static prompt →
static allow → no judgement (`unclassified`) → SAFE with no unlifted prior refusal and no flags
(allow, `verdict`) → otherwise block `verdict`.
Output `hostHandoff`: `run` | `block` | `host-prompt` (a static prompt rule: the host's own dialog).

## Refusal memory sources (`addRefusal` source field)

`cap` (length or script-body), `critical`, `model` (UNSAFE with persistRefusal). Each records
the newest user message id (`newestUserMessageId`). Fed back to the judge as
`recordExtras.priorRefusal`. Lifted by `liftRefusals` only when `priorRefusalLifts` holds: SAFE,
authorization `grounded`, and a user message newer than the one the refusal recorded.
