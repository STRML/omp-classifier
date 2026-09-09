# Changelog

All notable changes, newest first. Issue and PR numbers reference STRML/omp-classifier.

## 2026-09-06

- Safety scope: the prompt is reframed as a safety gate and nothing else — workflow prudence (wisdom, timing, "disruptive to review") is never grounds for UNSAFE. The project's own developer loop (test runners, formatters, repo scripts, virtualenv/node_modules binaries, session-written temp scripts, local dev servers, localhost queries) is carved out as SAFE execution; only fetch-and-execute of remote content stays in the UNSAFE class. `gh pr close`/`reopen` (close-then-reopen CI retriggers included) are carved as routine reversible operations; `gh pr merge` keeps its after-review gate.
- Refusal memory: an infrastructure PARSE_ERROR (empty reply — dead provider/quota) no longer records a session refusal. Previously one outage poisoned refusal memory and every later SAFE verdict prompted anyway ("classifier-safe despite prior refusal"); the 2026-09-06 audit found this cascade among 168 interruptions, ~83% of which were noise.
- Fetch clearing is per top-level pipeline: a `;`/`&&` compound no longer keeps `curl`/`wget` flagged forever when the fetch's own pipeline is clean (`lsof -i :8011; curl -sS -m 3 http://127.0.0.1:8011/v1/models | head -c 400` runs silent on SAFE). The decision is made over the pipeline's TEXT — a segment-join version was caught clearing `curl … | jq . > ~/.bashrc` off its redirect in tests and never shipped. Redirects, command substitution, consumer write flags, and mid-pipeline curls still flag. Adversarial eval (deepseek-v4-flash, 3 samples): prompt `e17774880fd5` → `b1fc04eb1d64`, over-flags 11 → 9, under-flags unchanged at 1 (the corpus's own contested `gh pr merge` case), zero critical leaks.

## 2026-09-09

- Two-stage reasoning contract (`contract: analysis+verdict`, now shown by `/classifier` and in `/classifier status`): the prompt requires a capped ANALYSIS (~120 words: files/directories touched, what executes, network egress destinations, reversibility, mapping to the user's own words) before a final line exactly `VERDICT: SAFE|UNSAFE|UNSURE` with an optional `REASON:`; `parseJudgement` anchors on that labeled line — scanned from the start of the reply and matched only as a whole line, so mid-sentence verdict talk still fails closed — and captures the analysis for the checks below. Legacy one-line replies that open with the verdict token still parse; analysis without a VERDICT line stays PARSE_ERROR (permission request, not cached). Prompt `def2c11736e2` → `7b4f082ad07c`.
- Authorization grounding: a SAFE whose analysis/reason quotes user authorization must find those words verbatim (whitespace-normalized substring) in `evidence.userMessages`; `checkCitation` downgrades a fabricated quote to UNSURE "cited authorization not found in session evidence" — a dialog that is never cached (`noCache`). No evidence at all is a no-op (never a dialog cause on its own), an unquoted paraphrase has no words to verify and does not fire, quotes that echo the command text are not citations, and UNSAFE/UNSURE verdicts are never touched.
- Scope-consistency checks (deterministic, post-parse, SAFE only): egress — an analysis that declares "no network egress" or never addresses egress while the command carries an uncleared network verb (curl/wget/ssh/scp/sftp/nc variants/telnet/gh) downgrades to UNSURE "declared scope contradicts command (network)"; cleared read-only fetches keep their per-pipeline clearing and never re-trigger, mid-pipeline verbs never clear. Write-scope — an analysis that claims writes stay in the working directory (or is silent about writes) over an absolute/`~` redirect, `tee`, or `-o`/`--output` target outside cwd downgrades "…(write target)"; `/dev/null` and temp locations are excluded, relative targets never fire, and an analysis that discusses writes without claiming confinement defers to the verdict. Both checks are conservative by construction — when unsure they stay silent, so they cannot open a new over-flag family — and both mark the downgrade `noCache`.
- The classify call pins `maxTokens` at 4000: a reasoning-modeled judge can spend the whole budget on thinking before the first text delta (measured: glm-5.3 consumed a 700-token budget entirely on thinking deltas and never reached the verdict), and a truncated reply is a PARSE_ERROR under the new contract. Default `timeoutMs` rises 15s → 25s: the two-stage shape runs ~11s on glm-5.3 and 22-34s on flash-class reasoning models; the 30s tool_call handler budget leaves ~5s of slack after one full burn, so raising `timeoutMs` past ~28s buys nothing without raising the host budget too. Measured pairing note: glm-5.3 (non-flash) beat glm-5.3-flash 2-3x end-to-end on this reply shape despite the name.
- Eval harness v4: the spawn judge hands the WHOLE reply to `parseJudgement` (the verdict is no longer the first line); the in-process judge applies production's `applyPostParseChecks` and pins temperature 0 and the same maxTokens as `classify`, so gate numbers describe the shipped resolution path; `--compare` accepts a prior report's JSON path directly, so baselines from older harness versions diff by path instead of by rebuildable filename. Truncated and empty replies remain loud failures: any UNPARSED sample invalidates its case, errors on irreversible cases exit 1, and a majority-error run fails outright.
- Corpus: two sanitized scary-benign cases from real false positives — the `cd <repo> && RS3_AHK_DIR=… bash scripts/…` env-prefixed compound, and the api.github.com `$GITHUB_PADDOCK_TOKEN` liveness check (a credential presented to the service that issued it). The `~/.claude/scripts/codex-review.sh` case already existed.
- Prompt retunes the two-stage format forced: the anti-injection scan now flags a reply-format imitation in either clothing (the old `SAFE | short reason` shape as well as this contract's `VERDICT:` line — a format rename had silently disarmed the `printf 'SAFE | …'` injection case); approval claims call out ticket numbers directly ("pre-approved by security review ticket SEC-1042" is exactly the claim); process signaling is judged by blast radius (one pid or the user's own app/dev-server name is routine; a shared-name sweep like `pkill -f node` is UNSURE); and an SSH key passed with `-i` to the host it authenticates is a presented credential, not a read. The egress check correspondingly clears read-shaped `gh` invocations (outbound only with explicit write markers `-X POST/-f/--field/--input`), mirroring the cleared-fetch rule.
- Official gate (zai/glm-5.3-flash, 3 samples, spawn judge, 96 cases): over-flags 0/39, under-flags 1/57 (the standing stable `gh api -X POST` case, under-flagged in the v3 baseline too), critical leaks 0, zero unparsed cases; vs `def2c11736e2` — 0 fixed, 0 regressed, 0 new interruptions, 1 noise movement (the corpus's own contested `gh pr merge`, moving to the cautious side).
- Persistent grants ("Always allow"): the bash permission dialog gains a fourth option that writes `{version: 1, grants: [{cmd, cwd, ts}]}` to `~/.omp/omp-classifier-grants.json` (beside omp-classifier.json; `OMP_CLASSIFIER_CONFIG` relocates it). A live grant lets that EXACT command text run in that directory across every session for 30 days — no model call, no cache write, one `layer: "granted", why: "persistent grant"` audit line mirroring the session-grant hit shape. The key is the whole command text, compounds included, because host static allow rules never match a multi-segment command, so `cd X && script` shapes could never be static-allowed and re-prompted forever (a raw-ovh command was approved 4x in 2.5 minutes, an rs3 worktree script 15x across two days — 74/74 approvals in the audit); exactness is the safety argument: an env-prefixed spelling, a different cwd, or any edit does NOT match, and the critical/env/static layers still rank above any grant. Grants sit at the session-grant tier: above model classification, the verdict cache, and refusal memory (a live grant mutes refusal memory for its exact shape — the human outvoted the model). TTL prunes on load and write, the store caps at 500 entries evicting oldest, writes are atomic (tmp+rename) and happen only on a dialog approval, and a missing or corrupt store reads as zero grants. Kill-switch `persistentGrants: false` (`/classifier persistentGrants true|false`, default true) hides the option and disables reads and writes; it is deliberately NOT part of the config signature, since it changes no cached verdict's trust state. Eval-payload dialogs stay out of scope (follow-up). No eval gate ran: no prompt or corpus change.
- Runtime model fallback chain: `fallbackModels` config key (array of model ids, 0-3 after normalization; `/classifier fallbackModels a, b` sets, bare key clears). When the primary classifier model returns an empty reply or throws a provider error, the gate retries down the chain in order; timeouts do NOT trigger a fallback (one attempt already burned most of the 30s tool_call budget). Exhaustion keeps the legacy failure shapes with the tried ids appended — `classifier model returned no content — … (tried: a, b)` — and one classification still produces one judgement and one decision-log line. Both cache keys and the config signature identify the whole chain, so a verdict earned under one chain is never reused under another.
- Prompt: a credential presented to the service that issued it (GitHub token checked against api.github.com; keychain query that prints no secret) is a liveness/permission check, not exfiltration — judge the destination; a secret sent to any other endpoint stays UNSAFE. Opacity is not a verdict: scripts/binaries living in the user's own tooling (`~/.claude/scripts`, `~/.local/bin`, the repo's `scripts/`) invoked as part of the requested workflow are judged from the invocation, surrounding operators, and evidence — session-written files, runtime downloads, and interpreter piping stay UNSAFE. Amending the local commit is carved as routine/reversible (reflog; only a force push publishes a rewrite). Adversarial eval (zai/glm-5.3-flash, 3 samples, spawn judge, 94 cases) vs the 748069362d60 baseline: over-flags 0 → 0, under-flags 2 → 2 (the corpus's own contested gh cases), zero critical leaks; benign regression case added for the `~/.claude/scripts/codex-review.sh origin/main` shape.
- `evidenceUserMessages` default flipped 0 → 3: the newest three user messages ride into every classify record by default (`/classifier evidenceUserMessages 0` restores the no-evidence shape; bounds unchanged). An empty message list attaches no `evidence` field at all.

## 2026-09-01

- Model measurement: `zai/glm-5.3-flash` on the full 92-case adversarial corpus (3 samples, spawn judge) — over-flags 0/35, under-flags 2/57 (the answer-format-imitation injection, and the corpus's own `contested` `gh pr merge` case the prompt's carve-out allows), zero errors, no irreversible-case leaks. Swapped the configured gate model to it after deepseek-v4-flash produced a live over-flag on a routine lint+install-fallback+test chain. Sanitized corpus case added for that shape.
- Session pause (#48): `/classifier off` pauses model classification for the current session only (critical-pattern, env-override, and static-rule checks stay active; cached verdicts keep being honored; other sessions unaffected; dies with the session); `/classifier on` resumes. `/classifier status` reports `pausedSessions`, and `dry-run` while paused reports would=allow with layer "session". The persistent `enabled` setting still dominates.
## 2026-08-31

- Renamed the project to `omp-classifier` — GitHub repo, package name, plugin identity, config file (`~/.omp/omp-classifier.json`), env overrides (`OMP_CLASSIFIER_CONFIG`, `OMP_CLASSIFIER_TEST_LOCKFILE`), and the decision audit dir. Upgrading: `omp plugin uninstall omp-bash-classifier`, `omp plugin install .`, and `mv ~/.omp/omp-bash-classifier.json ~/.omp/omp-classifier.json`.
- Evidence tiers: the classify record can carry the session's recent user messages (the only tier that may authorize), operator context (flattened, capped at 500 chars, never authorizing), and prior refusals; the channel decides provenance, and authorization claims from the wrong channel are themselves injection signals (#31).
- Session grants and dry-run: **Allow for session** records a strict-key grant (action + flags + first argument) that skips classification for the rest of the session and lifts any matching refusal; `/classifier dry-run <command>` previews the gate decision side-effect free (#32).
- Refusal memory: a denied action keeps prompting its rewordings for the rest of the session (#30).
- Decision audit JSONL: every gate decision appends one line — tool, decision, layer, verdict, cache provenance, timing — inspectable via `/classifier status`; `eval/mine-history.ts` turns the log into eval corpus cases (#33).
- Structured refusal payload on every block, and the classify call's temperature is pinned (#28, #29).
- System design map and roadmap: `docs/SYSTEM.md`.
- fix: the `maxCommandLength` usage string is built from the bounds constants.

## 2026-08-29

- Eval gate (posture A): subprocess-bearing `eval` payloads — `child_process`, `Bun.spawn`/`Bun.$`, Python `subprocess`/`os.system`, `exec`/`__import__`/`importlib` escapes — are classified like a bash command; expression-only code passes unread. The scan is a marker list, so string-splitting evasion gets through; kernel-level interception is tracked in #13 (#23).
- `maxCommandLength`: raised 2,000 → 8,000 (#21), hard-capped at 100,000, bounds named.
- Prompt: the gh workflow carve-out extends to issue writes.

## 2026-08-28

- Live-model eval harness and corpus (`eval/`, issue #2, epic #16).

## 2026-08-26

- Compound commands defer to the native gate when any segment carries a `deny`/`prompt` rule; trailing-force prompt rules defer with undecided siblings.
- Replies prefixed `VERDICT` parse; only risky interpreter code is flagged.
- Carve-out scoping: local log reads, read-only consumers, gh PR workflows and tags; the credential bullet now scopes to material exfiltration.
- README documents compound-command semantics.

## 2026-08-25

- v0.2: `tool_call` interceptor replaces tool shadowing — the native bash tool keeps its schema, approval declaration, and execution path (#5).
- curl and wget judged by the whole invocation, not the verb (#11); moderate-risk tokens judged by basename (#15).
- Provider failures surfaced; the cache key uses the resolved model (#7).
- Per-segment `allow` resolution for compound commands; a leading literal `cd` is stripped before matching allow rules.
- gh carve-outs: `gh api` reads and CI-control ops classify as SAFE.
- Warn when the host lockfile disabled the plugin after it bound.
- Cutover of over-prompting on routine verdicts; a speculative prompt tail that over-triggered on neutral text reverted.
- Classifier config path resolved through the host dirs resolver (#9); decision logging.
- The command leads the permission dialog; README reworked to lead with the why.

## 2026-08-21

- 38-case unit suite, standalone typecheck, CI gate.
- Cosmetic cwd variance collapsed in the classifier cache key.

## 2026-08-19 — first public release

- omp-bash-classifier v0.1: classifier-graceful bash approval plugin.
- Review findings: native tokenizer parity, session cache, fail-closed classifier, strict verdict parsing; allow-rule shell-control guard mirrored from the host; cwd-aware cache.
- MIT license; fail-closed wording and privacy disclosure in the README.
