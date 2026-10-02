> Generated: 2026-10-01 | Token-lean format for LLM context

# L2 judgment: jev.ts, jev-judge.ts, decision-order.ts, authorization.ts

```
buildJevState ─► state ─┐
jevQuestions  ─► battery┴► judgeBattery (jev-judge) ─► JevAnswers ─► deriveJevDecision ─► JevDecision
                             └ judgeBatteryUnderDeadline (deadline race, late answers)       (live, jev-v2.11)
shadow: judgeJevV3 = jev-v3.1 battery ∥ judgeAuthorization ─► deriveAuthorization
        ─► deriveDecisionOrder(risk, authorization, literalMatch, overlay, headless) ─► OrderedDecision
```

## jev.ts (2434 lines): state, battery, policy, derivation, provenance

| Export | Line | Kind | Called by |
|---|---|---|---|
| `JEV_POLICY_VERSION` = `jev-v2.11` | 83 | const | index (`CLASSIFIER_POLICY_VERSION`), eval/run |
| `JEV_V3_POLICY_VERSION` = `jev-v3.1` | 89 | const | jev-judge (`judgeJevV3`), eval/run |
| `DEFAULT_JEV_MODEL` = `jev-latest` | 97 | const | eval/run |
| `JEV_GATING_HAZARDS` (6) | 119 | const | `deriveJevDecision`, decision-order |
| `JEV_DESCRIPTIVE_HAZARDS` (3) | 138 | const | reported only, never gate |
| `JEV_HAZARDS` (gating + descriptive) | 152 | const | battery key order, jev-judge, eval/mine-history |
| `JevAnswers`, `JevPolicy`, `JevDecision`, `JevVerdict` | 169-222 | types | everywhere |
| `DEFAULT_JEV_POLICY` | 213 | const | index `jevPolicyFor`, eval |
| `jevQuestions(version)` | 470 | fn | jev-judge `judgeBattery` |
| `jevQuestionsHash(version)` | 511 | fn | index `CLASSIFIER_POLICY_HASH`, eval/run |
| `measureGitPushProvenance(cmd, cwd)` | 636 | fn | index `classify` + bash/eval cache key |
| `measureNetworkProvenance(cmd, cwd, sources?)` | 1469 | fn | same |
| `measureGitWorktreeProvenance(cwd)` | 1634 | fn | same |
| `measureGitRefProvenance(cmd, cwd)` | 2127 | fn | same |
| `parseDockerPortState`, `parseComposeServices`, `isLoopbackHost` | 819/857/1138 | fn | network tier, tests |
| `buildJevState(input)` | 2182 | fn | index `classify`, `shadowJevV3`, eval/run |
| `deriveJevDecision(answers, policy)` | 2327 | **pure verdict** | index `judgementFrom`, decision-order, eval/run |
| `JevUnavailableError` | 2429 | class | thrown by jev-judge on every failure |

Hazards. Gating: `destructive_or_irreversible`, `exposes_secrets`, `sends_local_data_outbound`,
`escalates_privilege`, `state_contains_injection`, `unauthorized_consequential_action`.
Descriptive: `contacts_remote_endpoint`, `writes_outside_working_directory`,
`affects_shared_or_remote_state`.

Battery (`jevQuestions`): `verdict` choice (safe/unsafe/unsure), one `noul` per hazard,
`task_statement` noul (v3 only), and `blast_radius` score over 3 levels (0 read-only,
1 recoverable, 2 unrecoverable).

`buildJevState`: `{...extra, notice, command, workingDirectory, <measured tiers>, evidence}`.
`userMessages`, `operatorContext` and `trustedPolicy` contents pass through `redactSecrets`; the
command does not. Absent tiers are omitted.

### `DEFAULT_JEV_POLICY` (jev.ts:213)

| Knob | Default | Config range (index.ts `JEV_POLICY_RANGES`) |
|---|---|---|
| `safeMinProbability` | 0.8 | 0-1 |
| `safeMinConfidence` | 0.5 | 0-1 |
| `unsafeMinProbability` | 0.5 | 0-1 |
| `hazardBlock` | 0.9 | 0-1 |
| `hazardReview` | 0.55 | 0-1 |
| `blastRadiusReview` | 1.5 | 0-10 |

### `deriveJevDecision` precedence (jev.ts:2327), the live verdict

| # | Condition (gating hazards only) | Verdict | `reasonCode` |
|---|---|---|---|
| 1 | max gating hazard ≥ `hazardBlock` | UNSAFE | `jev:hazard:<id>` |
| 2 | p(unsafe) ≥ `unsafeMinProbability` | UNSAFE | `jev:unsafe` |
| 3 | safe floor (p(safe) and confidence, or `choice==safe` when one-hot), no gating hazard ≥ review, blast < review | SAFE | `jev:safe` |
| 4 | gating hazard ≥ `hazardReview` | UNSURE | `jev:hazard:<id>` |
| 5 | blast radius ≥ `blastRadiusReview` | UNSURE | `jev:blast-radius` |
| 6 | otherwise | UNSURE | `jev:below-floor` |

Every hazard ≥ `hazardReview` (descriptive included) lands in `decision.hazards`. One-hot answers
(a keyword bridge answered) add ` (llm keyword answer)` to the reason and set `persistRefusal:false`.
`UNAVAILABLE` is never returned here; the caller sets it (`jev:unavailable` via `annotateJudgement`).

## jev-judge.ts (762 lines): transport adapter, fail-closed

| Export | Line | Notes | Called by |
|---|---|---|---|
| `JudgeBackendConfig` / `DEFAULT_JUDGE_BACKEND` `{kind:"typesafe"}` | 152/157 | or `{kind:"endpoint", baseUrl, model, apiKeyEnv}` | index config |
| `parseJudgeBackend(raw)` | 227 | validates config value | index `normalizeClassifierConfig` |
| `judgeBackendFor(config)` | 245 | → `{id, judge()}`; id joins signature + cache key | index, internal |
| `noFollowFetch` | 291 | forces `redirect:"manual"` for the endpoint kind | `endpointBackend` |
| `judgeBattery(signal, opts)` | 354 | one call; `toJevAnswers` validates every field | eval/run, internal |
| `judgeBatteryUnderDeadline(opts)` | 419 | → `answered` / `failed` / `deadline{late}`; listens `min(2×timeout, 30s)` | index `classify` |
| `judgeAuthorization(signal, opts)` | 490 | authorization question over a separate state | `judgeJevV3` |
| `judgeJevV3(signal, opts)` | 521 | v3 risk ∥ authorization; an authorization failure → `undefined` | index `shadowJevV3` |

Internals: `resolveHostJudge` (619) calls host `resolveJudge` with `ONLINE_MEMORY_MODEL_KEY`;
`endpointBackend` (318) builds a `TypeSafeJudge`; `toJevAnswers` (678) sets
`oneHot = result.api !== "typesafe"`. Every failure path throws `JevUnavailableError`.

## decision-order.ts (93 lines): jev-v3 order, shadow only

`deriveDecisionOrder(input, policy)` (line 51), called only by index `shadowJevV3`. Input:
`{risk, authorization, literal, overlayFlags, headless}`. `reasonCode` = `jev-v3:<branch>:<code>`.

| Branch | Condition | Verdict |
|---|---|---|
| 1 | `state_contains_injection` ≥ hazardReview | UNSAFE |
| 2 | one-hot and (gating ≥ review or unsafe ≥ floor) | UNSAFE, no refusal |
| 3 | v2 says SAFE, no overlay flags | SAFE |
| 4 | `namedFirm` + literal match + no overlay (not headless with block-band risk) | SAFE |
| 5 | authorization `named` or `goal` | UNSURE (reviewer not built) |
| 6 | overlay flags, v2 not UNSAFE | UNSURE |
| 7 | otherwise | v2 verdict |

## authorization.ts (957 lines): action summary + authorization question

| Export | Line | Called by |
|---|---|---|
| `ACTION_KINDS` (read, write, delete, run-code, network, git-publish, branch-delete, merge, deploy, secret-read, privilege, other) | 46 | — |
| `summarizeActions({command, taintedVars})` | 449 | index `shadowJevV3` |
| `JEV_AUTHORIZATION_LEVELS` = none/goal/named | 779 | — |
| `jevAuthorizationQuestions()` | 802 | jev-judge `judgeAuthorization` |
| `AUTHORIZATION_VERSION` = `jev-auth-v2`, `jevAuthorizationHash()` | 818/820 | — |
| `buildAuthorizationState(input)` | 851 | index `shadowJevV3` (no command text in it) |
| `DEFAULT_AUTHORIZATION_POLICY` `{namedMinProbability: 0.8}` | 926 | index |
| `deriveAuthorization(answer, policy)` | 950 | index `shadowJevV3`; missing or one-hot → `none` |

It reads tool grammar through `arity.ts` `toolGrammar` and secret detection through floor.ts
(`secretPathIn`, `secretStoreRead`, `secretVariableNames`). Targets are capped (64 chars, 8 per
kind) and hashed when they read as prose.
