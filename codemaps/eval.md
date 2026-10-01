> Generated: 2026-10-01 | Token-lean format for LLM context

# L5 self-measurement and tests

## eval/ scripts

| Script | Lines | Does | Production code it calls |
|---|---|---|---|
| run.ts | 1735 | scores a policy against labeled corpora; sweeps threshold grids; `--replay` re-scores from the answer cache | jev `buildJevState`, `jevQuestionsHash`, `deriveJevDecision`; jev-judge `judgeBattery`; index `replayDecision`, `matchModerateRiskTokens`, `evalRiskFlags`; host `CRITICAL_BASH_PATTERNS`, `TypeSafeJudge`, `discoverAuthStorage` |
| headless-brief-probe.ts | 195 | spec step 1 probe: three arms (brief as user words / omitted / operator context) over jev-v3.1 and v2.11; `chooseHeadlessArm` picks a/b/unconfirmed; `--replay` reads the cache only | jev `buildJevState`; jev-judge `judgeBattery`; redact |
| literal-match-probe.ts | 83 | `literalMatchTally`: how many mined intent seeds and judged states reach `literalMatch` (branch 4) and why not | literal-match |
| live-report.ts | 238 | jev-v3 shadow against live v2 disagreements, read from decisions.jsonl; exits 1 when the report is incomplete | index `decisionsLogPath`, `DecisionRecord` |
| recognizer-measure.ts | 486 | measures `recognizeRoutineCommand` clear share against the history corpus (the 30% gate) | recognizer, shell-ast, redact, live-report `readDecisionLog` |
| mine-history.ts | 376 | rebuilds corpus candidates from session logs or `--source decisions` | jev `DEFAULT_JEV_POLICY`, `JEV_HAZARDS` |
| weekly-report.sh | — | launchd job (`launchd/ai.strml.omp-classifier-shadow-report.plist`): runs live-report and posts counts to issue #116 | — |

`run.ts` flags: `--replay --policy <json> --battery <version> --model --corpus --compare <report>
--only <substr> --concurrency --limit --samples --timeout`. Cache: `eval/.cache/`. Reports:
`eval/reports/<hash>-....json` (40 files at generation). Exports used by tests: `parseArgs`,
`parseJsonl`, `validateCase`, `computeIntentMetrics`, `compareAgainstPrior`, `asPriorOutcomes`. v3 scoring: `v3InputsFor`, `computeV3Summary` (V3Inputs/V3ScoredRow). Env: `OMP_EVAL_CACHE_DIR` (default `eval/.cache`), `OMP_EVAL_REPORT_DIR` (default `eval/reports`). A corpus row with `evidence.userMessages` needs `hasUI: true` (`validateCase`).

Error kinds: **false ask** (labeled `allow`, the gate would prompt) and **false allow** (labeled
`ask`, the gate would run silently). A false allow on a `severity: irreversible` case fails the
run, and so does a majority-UNAVAILABLE run. A candidate policy loads strictly: an unknown knob,
an out-of-range value, or `hazardReview > hazardBlock` fails it.

## Corpora (eval/corpus/*.jsonl)

| File | Lines | Source |
|---|---|---|
| adversarial.jsonl | 105 | authored (`label`, `family`, `contested`, `severity`) |
| intent.jsonl | 69 | intent-aware plan Phase 0: seed rows plus twin and injection rows; labels are the target design, `heldOut` rows excluded from tuning |
| gitflow.jsonl | 25 | authored `family: gitflow` cases (worktrees, branches) |
| history.jsonl | 19062 | mined distinct commands with `count` and `cwds` (recognizer measurement; contains real local paths) |

`Case`: `{command, label: allow|ask, family, note?, contested?, cwd?, kind?: "eval-code",
language?, evidence?{userMessages, operatorContext, …}}`.

## tools/

`generate-arity.ts` (620 lines) writes `arity.generated.ts` from each CLI's help and completion
output. Run it with `bun run generate-arity`. Test: `tests/arity-tables.test.ts`.

## tests/: which module each file exercises

Harness: `tests/fixtures.ts` mocks `@oh-my-pi/pi-coding-agent/judgment` (`mock.module`), and
`loadPlugin(settings)` loads index.ts with a fake `pi`. It provides answer builders
(`jevSafeAnswer`, `jevUnsafeAnswer`, `jevHazardousAnswer`, …), captured requests (`modelCalls`,
`shadowCalls`) and v3 knobs (`setShadowAuthorization`, `setShadowFailure`). `git-fixture.ts`
builds temp repos. `config-path-probe.ts` is the child process for config-path.test.ts.

| Area | Test files |
|---|---|
| plugin end-to-end (via fixtures `loadPlugin`) | classifier, cache, config, policy-gates, static-gate, stale-disable, session-off, session-grants, persistent-grants, refusal-memory, late-verdict, fallback, shadow-v3, audit-log, eval-gate, script-body, network, gh-carveout, gh-compound-pipe |
| deterministic tail | replay (`replayDecision`, `annotateJudgement`) |
| L0 evidence and provenance | evidence-tiers, provenance (push), worktree-provenance, ref-provenance, network-provenance, trust-policy, config-path |
| L1 | floor, shell-oracle (floor vs real shell), literal-match, recognizer, shell-ast, shell-ast-load, arity-tables |
| L2 | jev (jev.ts + jev-judge.ts), judge-backend, judge-v3, authorization, decision-order |
| redaction | redact, log-redaction |
| L5 | eval-run, eval-run-compare, live-report, recognizer-measure |

Commands: `bun test`, `bun test tests/<file>.test.ts`.
