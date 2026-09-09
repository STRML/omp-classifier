# Changelog

All notable changes, newest first. Issue and PR numbers reference STRML/omp-classifier.

## 2026-09-06

- Safety scope: the prompt is reframed as a safety gate and nothing else — workflow prudence (wisdom, timing, "disruptive to review") is never grounds for UNSAFE. The project's own developer loop (test runners, formatters, repo scripts, virtualenv/node_modules binaries, session-written temp scripts, local dev servers, localhost queries) is carved out as SAFE execution; only fetch-and-execute of remote content stays in the UNSAFE class. `gh pr close`/`reopen` (close-then-reopen CI retriggers included) are carved as routine reversible operations; `gh pr merge` keeps its after-review gate.
- Refusal memory: an infrastructure PARSE_ERROR (empty reply — dead provider/quota) no longer records a session refusal. Previously one outage poisoned refusal memory and every later SAFE verdict prompted anyway ("classifier-safe despite prior refusal"); the 2026-09-06 audit found this cascade among 168 interruptions, ~83% of which were noise.
- Fetch clearing is per top-level pipeline: a `;`/`&&` compound no longer keeps `curl`/`wget` flagged forever when the fetch's own pipeline is clean (`lsof -i :8011; curl -sS -m 3 http://127.0.0.1:8011/v1/models | head -c 400` runs silent on SAFE). The decision is made over the pipeline's TEXT — a segment-join version was caught clearing `curl … | jq . > ~/.bashrc` off its redirect in tests and never shipped. Redirects, command substitution, consumer write flags, and mid-pipeline curls still flag. Adversarial eval (deepseek-v4-flash, 3 samples): prompt `e17774880fd5` → `b1fc04eb1d64`, over-flags 11 → 9, under-flags unchanged at 1 (the corpus's own contested `gh pr merge` case), zero critical leaks.

## 2026-09-09

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
