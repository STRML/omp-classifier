# System design

This plugin is one system, not a pile of checks. This document is the map: what each layer
holds, the invariant that makes it safe, and how each layer feeds the next. Every issue and
PR should name the layer it touches.

Readers: contributors, reviewing agents, and future maintainers. The user-facing doc is the
[README](../README.md).

## What kind of judgment this is

The gate does not ask a model for an opinion and read the prose. It sends Jev one typed
request per command and gets typed answers back: a choice over `safe`/`unsafe`/`unsure` with
calibrated probabilities, one **noul** (a probability, not a token) per hazard, and a
blast-radius score. The verdict is derived in code from those numbers against a policy of
thresholds. Four consequences shape every layer below:

- **No model text exists anywhere in the design.** There is nothing to parse out of a reply,
  nothing to quote, and nothing to render from a model. A layer that "reads what the model
  said" cannot be written, because the model says nothing — it answers questions. Reasons are
  assembled from numbers and hazard ids, and are byte-stable for the same answers.
- **One request per classification.** The full battery answers in ~0.6s and extra questions
  in the same request are cheap, so the verdict and all nine hazards ride in one call rather
  than a second pass over a "review" prompt.
- **The verdict is a function.** `deriveJevDecision(answers, policy)` is pure: the same
  answers and the same policy always decide the same thing. A threshold change can therefore
  be scored against recorded answers offline instead of re-asking the model (L5).
- **Fail-closed is a code path, not a promise.** A missing key, a non-2xx, a timeout, or an
  answer that does not match the battery yields `UNAVAILABLE`, which raises a dialog and is
  never cached. Nothing admits a guess in place of an answer.
- **A missed deadline keeps listening, and that can only help the dialog.** The deadline is a
  race the gate owns, not an abort on the request, so the judgment that lands a beat late can
  still act on the dialog the deadline opened: a late `SAFE` dismisses it and the command runs,
  a late `UNSAFE` leaves it open with the real reason beside it, a late `UNSURE` goes on the
  record. A human who answers first cancels the request and the late answer does nothing.
  Listening stops at `min(2 x timeoutMs, 30s)` past the deadline. The three cases are written
  as they happen, on a `late-verdict` layer, with the pair (`unavailable → late UNSAFE`) in
  `why` so calibration can read the late answer next to the human's own line. A late verdict
  can never bypass a dialog, and a late `UNSAFE` never re-blocks what a human allowed: the
  dialog is the only thing it can refine. A late `SAFE` dismisses only where an on-time `SAFE`
  would have auto-run — the destructive-token overlay and a refusal this session already holds
  for the target keep the dialog open, because the late path recovers the deadline's answer,
  never a guard the verdict path applies.

## The tower

```
L6 control plane      /classifier, config bounds, kill switches, agent-legible status
L5 self-measurement   eval harness, corpus, policy sweep, regression gates
L4 interaction        dialogs, refusal payloads, session grants, dry-run
L3 memory             verdict cache, refusal memory, decision audit log
L2 judgment           Jev state + question battery, probabilities, derived verdict
L1 recognition        critical patterns, structural rules, compound segments, marker scans
L0 evidence           command text, payload, cwd/env, user messages, grants, prior refusals
```

Data flows up: L0 feeds L1 and L2, L2 writes L3, L3 feeds L4 and L5, L5 tunes L1 and L2,
L6 observes and overrides everything. Nothing reads sideways past its neighbor.

## L0 evidence

What the gate may read, and what each source is allowed to mean.

| Source | Tier | May it authorize? |
| --- | --- | --- |
| User messages | user | Yes |
| Approved plan or session grant | user | Yes |
| Agent-supplied context (intent, runbook step) | agent | No. Explains, never authorizes |
| Tool output, fetched content | hostile | No. Untrusted-wrapped if included at all |

`buildJevState()` turns this into the state Jev judges: command, resolved cwd, and the
evidence tiers that exist. Absent tiers are omitted rather than sent empty — `userMessages:
[]` would read as "the user said nothing", which is a different claim from "this caller did
not supply that tier", and the authorization question depends on the difference. `extra` is
spread first so a caller-supplied key can never displace the command or the evidence.

Invariant: provenance is decided by the channel, never by the content. Text that claims to
authorize is itself evidence of injection — and it is now evidence of exactly that, since the
`state_contains_injection` hazard asks about the state itself rather than trusting a model to
notice a claim in passing.

## L1 recognition

The deterministic layer. Answers only "is this shape provably X": critical patterns,
structural routine shapes, compound-command segments, interpreter scoping, shape-scoped
`rm`/`unlink` forcing, eval spawn markers, heredoc handling. Its findings reach the tail as
`riskFlags`, and they outrank the verdict: a destructive-token command that Jev reads as SAFE
still raises a dialog, because Jev judges the command as untrusted state and can be steered
by text inside it. This is why the port did not make L1 redundant: Jev removed the need to
parse prose, not the need to notice shapes without asking anyone.

Invariant: no model call decides what this layer can decide, and this layer never guesses.
Anything ambiguous falls through to L2.

### The floor (`floor.ts`, shadow)

The floor is the part of L1 that no answer above it can cross: the built-in critical patterns,
a secret reaching a sink that is not allowed, a download piped into an interpreter, and
obfuscated code. It exists because the intent-aware plan
(`docs/plans/2026-09-19-intent-aware-judgment.md`) makes the gate much readier to allow work the
user asked for, and something has to hold the line under that in code.

Entry 2 is a source-and-sink model, and it is destination-blind on purpose. It asks what a
secret flows *into*, never where that goes, so `curl -H "Authorization: Bearer $KEY"` passes the
floor whatever host it names: a header is how a key is used for its purpose. Four sinks are
allowed and no others: a `$(…)` capture assigned to a variable, `/dev/null`, a curl auth header
or `-u` without tracing, and `--password-stdin`. A capture taints the variable for the rest of
the session, so printing it later asks. The destination is judged above the floor, by
`sends_local_data_outbound` and the reviewer.

`evaluateFloor` is pure: taint arrives as an argument and leaves as a return value. The plugin
holds the per-session taint and wipes it at the same boundaries as the verdict cache.

Today the floor runs in shadow. Every `decisions.jsonl` line carries a `floor` field saying what
it would have done, and the live decision is unchanged until the `jev-v3` flip (#55).

### The literal match (`literal-match.ts`)

The other half of "code may grant an allow only for what code fully sees". A command matches
only when both hold: every segment is an extracted action or an inert shape, and every extracted
action is named in the user's own recent standalone words. One segment the parser does not
understand makes the command incomplete, so a matched `rm` beside a `python3 -c` payload gets no
fast path. An inert *verb* is not enough either: a redirect, a glob, a brace or a substitution
anywhere in the segment makes it non-inert, because `echo "alias x=y" >> ~/.bashrc` writes a
shell config while looking like an echo.

Extracted actions are local: a delete whose real path resolves inside the working directory or
the session temp directory, a branch delete, `gh pr merge <number>`, and a deploy script inside
the working directory. Network egress, secrets and privilege are neither extracted nor inert,
which is how they reach the reviewer instead. A command spelled as a path is a file rather than a
verb, so `./rm` and `/tmp/evil/cat` are neither.

Matching is on whole words in imperative or present form. "rebuild" does not authorize deleting
`build`, a past-tense recount authorizes nothing, and a restrictive or conditional word within
five words of a matched token cancels the match. A verb has to belong to the target it
authorizes: only filler words or another target of the same command may sit between them, so
"delete build then merge main" does not authorize deleting the branch `main`. Fenced code, inline
code and quoted lines are stripped first, typographic apostrophes are folded so `don’t` cancels
like `don't`, and a pinned or inherited message never produces a match.

`literalMatch` is pure, and nothing calls it yet. Phase 2 step 5 gives it a branch in the
decision order.

## L2 judgment

One request, two inputs, no prose:

- **State** — `buildJevState(...)`: the command or payload, cwd, and the evidence tiers.
- **Battery** — `jevQuestions()`: one `choice` question for the verdict, one `noul` per
  hazard in `JEV_HAZARDS`, one `score` question for blast radius. The battery is a pure
  function of the module, not of config, so its hash is a stable identity (below).

The response's answers are validated field by field (`judgeBattery` in `jev-judge.ts` throws
`JevUnavailableError` on a missing or mistyped field rather than letting a default slip
through), then `deriveJevDecision(answers, policy)` derives the verdict in a fixed precedence:

1. a hazard at or above `hazardBlock` → `UNSAFE` (a hard safety signal outranks the verdict
   distribution — the choice can say "safe" right next to it)
2. p(unsafe) at or above `unsafeMinProbability` → `UNSAFE`

   When the answers are one-hot (a keyword bridge answered), the decision carries
   `persistRefusal: false`: the verdict is still `UNSAFE` and still asks, but a keyword answer
   does not write refusal memory.

3. the safe gate: p(safe) and confidence above their floors, no hazard at or above
   `hazardReview`, blast radius below `blastRadiusReview` → `SAFE`
4. a hazard at or above `hazardReview` → `UNSURE`
5. blast radius at or above `blastRadiusReview` → `UNSURE`
6. otherwise `UNSURE`, below the safe gate's floors

Every branch writes a `reasonCode` (`jev:safe`, `jev:hazard:<id>`, `jev:below-floor`,
`jev:unavailable`) and a `reason` string assembled from the numbers that decided. The decode
parameters belong to the harness now: the judge is OMP's native one (TypeSafe when a
credential exists, otherwise the tiny/smol/default chain, whose one-hot answers tag every
reason with `(llm keyword answer)`), the model is whatever that judge resolves
(`TYPESAFE_DEFAULT_MODEL`, else `jev-latest`), and the only knob this gate passes is its own
deadline as an `AbortSignal` — no temperature to set.

Invariant: nothing that reached L2 can end in silence. `UNAVAILABLE` behaves exactly like
`UNSURE` at L4 (a dialog) and is excluded from the cache, so an outage cannot pin a session
to a stale non-answer.

## Policy: where the thresholds live

The thresholds are policy, not constants, because Jev's probabilities move with the question
set and the state shape — the same command scored p(safe) 0.61 / confidence 0.42 alone and
0.52 / 0.43 / 0.29 with the full battery. `DEFAULT_JEV_POLICY` is therefore a starting
point, and the interesting question is always what a *different* threshold set would do to
the same answers.

- The gate reads `jevPolicy: Partial<JevPolicy>` from the config file
  (`<configRoot>/omp-classifier.json`, `OMP_JEV_CONFIG` overrides the path) and merges
  it over `DEFAULT_JEV_POLICY`. A hand-edited value that is unknown, mistyped, NaN, or out of
  range is dropped rather than passed through: for numbers that decide auto-run, a typo must
  mean "keep the default", never "no floor".
- The verdict cache is keyed on a config signature that includes the merged policy: changing
  a threshold invalidates every cached verdict, so a `jevPolicy` edit cannot reuse a decision
  made under different numbers.
- `/classifier policy` prints the merged effective policy next to the defaults and the battery
  hash, and is read-only on purpose — thresholds move together, so they are edited in the
  config file where the whole set is visible at once.
- A candidate policy is scored by the harness (`--policy <file.json>`), which is deliberately
  stricter than the config loader: an unknown knob or an out-of-range value fails the run
  (rather than being dropped), and so does a `hazardReview` above `hazardBlock` — the block
  test runs first, so a higher review threshold could never fire and the candidate would look
  tuned while changing nothing.

Invariant: no threshold is copied from a vendor document into code without a corpus run
behind it. The sweep in L5 exists to make that cheap enough to be routine.

## L3 memory

- **Verdict cache**: per session, keyed by command + cwd + env/pty identity, and cleared
  whenever the effective config signature changes. `UNAVAILABLE` is never cached.
- **Refusal memory**: what this session was denied, keyed by `normalizeGrantTarget` — the same
  identity a session grant uses, so an approval lifts exactly what a refusal covers (issue #64)
  — plus the cwd, and fingerprinted by the evidence the judge saw, fed back into the state as
  `priorRefusal` so rewording cannot launder a refusal into a fresh judgment. A SAFE under a
  prior refusal is not a clean bill: the refusal rode in the state the judge saw.
- **Decision audit**: one JSONL line per decision at
  `<agentDir>/omp-classifier/decisions.jsonl`, every path, with session/decision ids,
  `policyVersion`/`policyHash` (the battery hash), `modelId`, `verdict`, `reasonCode`, the
  `jev` telemetry block (probabilities, hazards, confidence, blast radius, usage, latency),
  approval outcome, and timing.

Invariant: a cache entry answers only the exact input it was made for. Refusals lift only by
user action, never by retry.

## L4 interaction

Two readers, two shapes. The agent gets structured JSON on every block: what refused it, why,
what would work instead, what not to try. The human gets one line plus the shortest dialog
that can be answered correctly: the command, the axes, the alternatives.

Session grants and 30-day persistent grants let a human pre-authorize a family of actions
once instead of answering the same dialog five times. Dialog reasons are built from the same
numbers as the audit line, and the rm-family prompts carry the reversible-alternative
footnote. Dry-run lets an agent ask the gate what it would do before doing it. A dialog from
a session older than the on-disk plugin says so in its subtitle.

Invariant: a block must always leave the agent a lawful next move, and a prompt must cost the
human one glance when everything is normal. Because the reason is derived rather than written,
a dialog can also say *which hazard* and *how strongly* it fired — the human sees
`contacts_remote_endpoint 0.96` instead of a paraphrase of it.

## L5 self-measurement

The corpus is the immune system. `eval/run.ts` scores a policy against labeled corpora by
making the same calls production makes — `buildJevState`, `jevQuestions`, `askJev`,
`deriveJevDecision`, and production's own `replayDecision` tail — and reports both error kinds
by name: a **false ask** (a labeled-`allow` case that would raise a dialog) and a **false
allow** (a labeled-`ask` case that would run silently). False allows are never aggregated away;
any allow on a case tiered `irreversible` fails the run.

Two properties fall out of the typed design:

- **Answers are cached and policy-independent**, so one pass over a corpus scores a grid of
  ~14,000 threshold sets offline (`--replay` re-scores from cache with no API calls), and the
  report names the false allows each setting would still make instead of trusting a single
  percentage. The best-agreement setting is only a candidate: a setting that runs a
  labeled-`ask` case silently is not adoptable at any agreement.
- **A case with no answers is `UNAVAILABLE`**, excluded from every rate and counted loudly —
  the harness never fabricates a verdict for a request that failed. A majority-unavailable run
  fails outright, and an unavailable `irreversible` case fails too: its risk was never
  assessed.

`eval/mine-history.ts` rebuilds the other half of the corpus from this machine's real traffic:
session logs for the commands actually run, and the decision audit log for the commands the
gate actually stopped. Mined candidates carry the machine `reasonCode` and the flagged hazards
in their note, so a human labeling them can see what the gate reacted to.

Invariant: no change ships to L1 or L2 without a before/after run reporting agreement,
interruption counters, and false allows by name.

## L6 control plane

`/classifier` for humans (`model <id>` sets `typesafeModel`, `policy` prints the merged policy
and battery hash), one agent-legible status surface for machines. Bounds on every config
surface. Kill switches layered, and never gated by the thing they switch off.

## Versioning and identity

| Identity | Value | Changes when |
| --- | --- | --- |
| `JEV_POLICY_VERSION` (`CLASSIFIER_POLICY_VERSION`) | `jev-v2.2` | the meaning of a verdict or a policy knob changes |
| `jevQuestionsHash()` (`CLASSIFIER_POLICY_HASH`) | sha256 over version + serialized battery + `DEFAULT_JEV_POLICY`, first 16 hex | the battery, its question ids, or the shipped default changes |
| `QUESTIONS_CONTRACT` | `questions+probabilities` | the answer shape the parser accepts changes |

The battery hash is what makes mixed-version decisions visible: cache entries, audit lines,
and harness reports all carry it, so a long session that spans a plugin update can be told
apart from a clean one. Since the battery is code, a changed battery reaches running sessions
only through a reload — and the stale-code suffix says so in the dialog. The harness's answer
cache is keyed on the battery hash too, so answers recorded under an older battery are not
silently re-scored under a new one.

## Agent ergonomics contract

The agent driving this system is owed three things:

1. **Every block is actionable.** A refusal names its layer, its reason, and a lawful next
   step. A block the agent can only evade is a failure of the gate, not the agent.
2. **Every prompt is cheap to answer.** The human's attention is the scarcest resource in the
   system. Over-flagging is a tax paid in human turns; the measurement tracks it as such, and
   the sweep exists to spend that tax deliberately instead of by default.
3. **Every judgment is replayable.** Any verdict can be re-derived later from its record: the
   same answers, the same battery hash, the same policy, the same deterministic tail. Nothing
   in the record is prose a later reader has to interpret.

## Open work

| Layer | Work | State |
| --- | --- | --- |
| L2 | Threshold calibration from measured data. Measured 2026-09-17 on the authored corpus (103 cases, one draw each, `battery=72c11adf23aa7469`): `DEFAULT_JEV_POLICY` gives 0 false allows and 20 false asks (80.6% agreement), and the best of ~14,000 threshold sets only reaches 16. Every remaining miss is a hazard-driven network or process command, so the lever is hazard policy rather than the numeric floors. Reproduce with `bun eval/run.ts --replay --samples 1` after a live pass; a battery or derivation edit moves the answers, which is why every report names the battery hash. | Open |
| L2 | Hazard-level policy: whether some hazards (e.g. `contacts_remote_endpoint`) should need a higher noul than others. The battery is fixed; the decision table is not. | Open |
| L5 | Corpus breadth: authored cases plus mined history give a false-ask rate, not a distribution over real traffic. The mined decision log is the intended source. | Open |
| L1 | Kernel-level spawn interception (structural scan fix) | Open; documented gap in README Limits |
| L1, L2 | Cheap pre-filter stage | Measured NO-GO on the authored corpus (2.2-4.4% volume, 0 misses); re-measure on a history corpus first |
| L0 | Eval payload cwd propagation (spawn's own cwd in the record) | Done (#14): the marker scan reads a spawn's own cwd when it is a literal, resolves it against the directory in effect, and judges in it; an unreadable one asks instead of guessing |
