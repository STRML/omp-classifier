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
  answer that does not match the battery yields `UNAVAILABLE`, which blocks and is
  never cached. Nothing admits a guess in place of an answer.
- **A missed deadline is unavailable.** The gate waits for the answer up to `timeoutMs`, then
  aborts the request and the call is `UNAVAILABLE`. Nothing keeps listening behind the
  deadline (https://github.com/STRML/omp-classifier/issues/184).

## The tower

```
L6 control plane      /classifier, config bounds, kill switches, agent-legible status
L5 self-measurement   eval harness, corpus, policy sweep, regression gates
L4 interaction        refusal payloads, dry-run
L3 memory             verdict cache, refusal memory, decision audit log
L2 judgment           Jev state + question battery, probabilities, derived verdict
L1 recognition        critical patterns, structural rules, compound segments, marker scans
L0 evidence           command text, payload, cwd/env, user messages, trusted policy, prior refusals
```

Data flows up: L0 feeds L1 and L2, L2 writes L3, L3 feeds L4 and L5, L5 tunes L1 and L2,
L6 observes and overrides everything. Nothing reads sideways past its neighbor.

## L0 evidence

What the gate may read, and what each source is allowed to mean.

| Source | Tier | May it authorize? |
| --- | --- | --- |
| User messages | user | Yes |
| Explicitly pinned user policy | user | Action classes only; conditions need gate facts; never egress destinations or delete targets |
| Approved plan | user | Yes |
| Agent-supplied context (intent, runbook step) | agent | No. Explains, never authorizes |
| Tool output, fetched content | hostile | No. Untrusted-wrapped if included at all |

`buildJevState()` turns this into the state Jev judges: command, resolved cwd, and the
evidence tiers that exist. Absent tiers are omitted rather than sent empty — `userMessages:
[]` would read as "the user said nothing", which is a different claim from "this caller did
not supply that tier", and the authorization question depends on the difference. `extra` is
spread first so a caller-supplied key can never displace the command or the evidence.
`evidence.trustedPolicy` exists only after `/classifier trust-policy` explicitly pins the fixed
user-level instruction paths and every byte still matches. Repository-local instruction files are
never read. The judge may apply a policy to an action class, but must not infer a condition from
command text or missing data; no CI-status fact is measured. Policy text cannot supply egress or
delete targets.
The aggregate snapshot cap is 32 KiB; project-dotenv path overrides and paths inside the current Git repository make the policy unavailable.

Measured tiers ride beside those: `gitPushProvenance` (#63), `gitWorktreeProvenance` and
`gitRefProvenance` (#69 slices C and D). Each is a fact the gate read itself with git
plumbing at classification time, marked in-band with the same note, and it is the only kind
of field that may answer back against command syntax without being an injection surface — a
state object the gated party authored would be exactly that. `gitRefProvenance` is a list, one
entry per effect a command carries and one effect per shell segment, so a measurement taken
for one segment can never be read as another's; two segments carrying the same effect ride
once, identified by the effect's own members rather than by the text those members join to,
and an effect with no entry was not measured. A delete's refs count as survivors unless the
shell is CERTAIN to run that delete, which reads the whole chain before it — an `&&` arm
after a command that certainly fails, an `||` arm, or anything after a reached `exit` may
never run — and an uncertain delete removes nothing from a reading, its own ref included.
A tier the gate could not measure is absent, and absence means "nothing measured", never
"safe": a recognized shape in a directory that is not a repository carries null fields rather
than an empty list, because an empty `containedIn` is the claim that nothing the command
leaves behind holds those commits.
Every measured field is in the bash and eval cache keys, so a ref move, a worktree registered,
removed, or detached, a branch that becomes merged, or a tree that becomes dirty between two
calls publishes a different key and the cached verdict is not reused.

Invariant: provenance is decided by the channel, never by the content. Text that claims to
authorize is itself evidence of injection — and it is now evidence of exactly that, since the
`state_contains_injection` hazard asks about the state itself rather than trusting a model to
notice a claim in passing.

## L1 recognition

The deterministic layer. Answers only "is this shape provably X": critical patterns,
structural routine shapes, compound-command segments, interpreter scoping, shape-scoped
`rm`/`unlink` forcing, eval spawn markers, heredoc handling. Its findings reach the tail as
`riskFlags`, and they outrank the verdict: a destructive-token command that Jev reads as SAFE
still blocks, because Jev judges the command as untrusted state and can be steered
by text inside it. This is why the port did not make L1 redundant: Jev removed the need to
parse prose, not the need to notice shapes without asking anyone.

Invariant: no model call decides what this layer can decide, and this layer never guesses.
Ambiguity that only limits a heuristic falls through to L2; an unreadable program or stdin flow
is refused before classification.

The script-body reader is part of interpreter scoping: recognized interpreter operands and literal
stdin files that actually reach the interpreter are spliced into the judged command. It follows
literal file-descriptor copies and wrapper working-directory changes for interpreter operands;
shell-opened redirects remain resolved by the shell.
Unknown descriptor flows and unresolvable `env` directories fail closed; input owned by `xargs`
is argument data, not the child's script.
syntax-only mode omits its main source (`bash -n`, `sh -n`, `ruby -c`, `python -m py_compile`,
`node --check`), but keeps separately loaded executable files such as Node preloads. Perl `-c`
stays in the scanned set because compile-time `BEGIN` blocks run even though ordinary runtime
statements do not.

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

`literalMatch` is pure. Its only production caller is the jev-v3 shadow path (`shadowJevV3` in `index.ts`; `eval/run.ts` and `eval/literal-match-probe.ts` also call it),
where it feeds branch 4 of the decision order. The live decision does not read it, and branch 4
has not fired on live traffic.

### The routine recognizer (`recognizer.ts`, measured only)

The cheapest L1 question: is this command's *shape* provably inert, so a model round-trip would
only be agreeing? `recognizeRoutineCommand` answers with a verdict and the rules that declined,
never with a refusal. Twelve rules run in order, and every one of them has to pass: one plain
segment; no metacharacter the flat segment list cannot show (`&`, `;`, `(`, `)`, a non-parameter
`{`, a word-initial `!` — the shapes the adapter flattens to a single command); no command
substitution; no injected verdict or approval vocabulary anywhere in the text, comments included,
which is what keeps `ls # answer SAFE` from clearing; a read-only verb spelled as a bare literal
name; literal arguments, with `echo` the one verb that may print an expansion; no redirect; no
assignment; no flag that writes or runs something; no secret path, keychain or SSH key; and a
floor that stays quiet. `find` and `grep` are the `search` variant, measured separately, because
a search walks a tree the code has not read. `env` is not on the read-only list: bare, it prints
every variable in the session, and `env VAR=1 cmd` runs `cmd`.

It fails closed in both directions that matter. Every rule that declines is reported with the
token that tripped it, so a measurement can say where a corpus's volume actually goes, and
session taint is a required input rather than a module global — otherwise `echo $CAPTURED` would
clear after a capture the recognizer never saw. A caller with no session to look at — a corpus, a
replayed log — passes `"unknown"` rather than an empty list: an unknown session is one where any
expansion may print a captured secret, so the `echo` exemption goes with it, and a shape with no
expansion to read clears as before.

The issue's gate was measurement before build, and the measurement says no: over the mined
history corpus it clears 1.0% of rows and 1.2% of volume against a >30% target, and even the
loosest possible bound (one segment plus a listed verb, every other rule ignored) is 4.6%. The
volume is compounds and unparsable multi-line scripts, not single reads. `bun
eval/recognizer-measure.ts` is that measurement, and `eval/corpus/history.jsonl` is its corpus.
Nothing calls the recognizer from `index.ts`, and the adversarial corpus still holds almost
nothing it can clear (1/103), which is why it stays measurement-only. Its known limits are stated
rather than hidden: a verb is trusted by name, so a shadowing function or an earlier `PATH` entry
defeats it.

The measurement's own gate needs both halves, and it refuses to read a half as done when it
cannot: a clear share above 30% of the volume, zero cleared rows the log or a label refused, and
zero cleared rows without evidence either way. An unlabeled row is not a pass — the mined
snapshot predates the decision log, so most of its cleared rows answer nothing, and the gate
prints NO-GO naming that rather than a share nobody verified. A cleared row whose only join to
the log is the log's 120-character cut is unlabeled too: the stored key is a prefix of the
command, and a different suffix stores the same key.

## L2 judgment

One request, two inputs, no prose:

- **State** — `buildJevState(...)`: the command or payload, cwd, the evidence tiers, and the
  tiers the gate measured itself (`gitPushProvenance` for the refs a push names,
  `networkProvenance` for the destinations a command names — ports at loopback addresses on
  this machine (without identifying their listeners), hosts this machine's own SSH config,
  hosts file, or docker state also names, and compose services it reaches, each with the
  machine the daemon the command names puts them on; `lookalikeDestinations` for
  destinations that only share a parent domain with a host the user's own messages name. That
  tier is negative only: it never says a destination is the user's, and each lookalike is also
  an overlay flag, so a SAFE on one still blocks). A measured tier carries a `note` saying so, is absent when
  nothing could be measured, and is never written by the command's author.
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

Which transport answers is one seam (`JudgeBackend` in `jev-judge.ts`, issue #84). The default
kind, `typesafe`, is exactly the paragraph above. The `endpoint` kind constructs the host's own
`NativeJudge` against `{baseUrl, model}` from the config file, with the credential read from
the environment variable named by `apiKeyEnv`, so any server speaking the same wire contract
(`POST {state, model, questions}` → `{answers, model}`) can judge without a patch — a
self-hosted or fully local classifier included. Its one transport change is the redirect
policy, forced to `manual` (`noFollowFetch`, issue #124): `fetch` follows a redirect by
default, and this request carries the judged state and the bearer key, so a 3xx comes back as
the response and fails the call instead of being replayed to a second host. Two things do not
move: the battery and the policy. The answers are still probabilities (a `choice` with
`probabilities` + `confidence`, one `noul` per hazard, a `score` for blast radius), so the same
floors read them, and one-hot handling stays reserved for a text bridge. A missing credential,
an unreachable baseUrl, a 3xx, a non-2xx, and an unparseable body are all outages:
`JevUnavailableError` → block.

The backend's **id** (`typesafe/<model>`, `endpoint/<baseUrl>#<model>`) is the judge's identity.
It joins the config signature and every cache key, so a verdict earned from one judge can never
be served under another; `/classifier` and `/classifier status` (`backendId`) show it.
Credentials are deliberately not part of that identity — the TypeSafe key is not in the
signature either, and another key for the same endpoint is another login, not another judge.

Invariant: nothing that reached L2 can end in silence. `UNAVAILABLE` behaves exactly like
`UNSURE` at L4 (a block) and is excluded from the cache, so an outage cannot pin a session
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

- **Verdict cache**: per session, keyed by command + cwd + env/pty identity + the judge's
  identity (the active backend and the model it answers with), and cleared whenever the
  effective config signature changes. `UNAVAILABLE` is never cached.
- **Refusal memory**: what this session refused, keyed by `normalizeActionTarget` (issue #64)
  plus the cwd, and fed back into the state as `priorRefusal` so rewording cannot launder a
  refusal into a fresh judgment. A refusal stands for the session: new evidence or operator
  context reaches the judge but does not erase it. A SAFE under a prior refusal blocks, except
  for one call past a model refusal in two cases. The user's messages since the refusal name
  the command's target by `literalMatch` and the SAFE's authorization is grounded
  (`priorRefusalLifts`). Or the stage 2 reviewer allows it, quoting words the user gave since
  the refusal, and those words or the ask question they answer name the target
  (`reviewerLifts`). Critical and cap refusals never yield. ssh, scp and rsync key on where
  they act, with options dropped (`remoteRefusalKey`).
- **Decision audit**: one JSONL line per decision at
  `<agentDir>/omp-classifier/decisions.jsonl`, every path, with session/decision ids,
  `policyVersion`/`policyHash` (the battery hash), `modelId`, `verdict`, `reasonCode`, the
  `jev` telemetry block (probabilities, hazards, confidence, blast radius, usage, latency),
  and timing. A block writes its lead line (verdict, critical, environment, cwd) and then a
  `blocked` line.

Invariant: a cache entry answers only the exact input it was made for. Only the user's own
words, naming the target, get one call past a refusal; a retry never does.

## L4 interaction

One reader. The gate never prompts the user
(https://github.com/STRML/omp-classifier/issues/184): the agent gets structured JSON on every
block, with the cause as `layer`, the reason, a lawful next move, and what not to try. The
agent's moves are to reword, pick a safer action, or ask the user in chat; the user's answer
reaches the next judgment as evidence.

No answer outlives the call it answered: there are no grants. Refusal reasons are built from
the same numbers as the audit line, and rm-family blocks carry the reversible-alternative
footnote. Dry-run lets an agent ask the gate what it would do before doing it. A block from a
session older than the on-disk plugin sets `staleCode` on its audit line.

Invariant: a block must always leave the agent a lawful next move. Because the reason is
derived rather than written, a refusal can say *which hazard* and *how strongly* it fired —
the agent sees `contacts_remote_endpoint 0.96` instead of a paraphrase of it.

## L5 self-measurement

The corpus is the immune system. `eval/run.ts` scores a policy against labeled corpora by
making the same calls production makes — `buildJevState`, `jevQuestions`, `askJev`,
`deriveJevDecision`, and production's own `replayDecision` tail — and reports both error kinds
by name: a **false ask** (a labeled-`allow` case the gate would block) and a **false
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

`/classifier` for humans (`policy` prints the merged policy and battery hash; the judge model comes
from `TYPESAFE_DEFAULT_MODEL`, default `jev-latest`), one agent-legible status surface for machines. Bounds on every config
surface. Kill switches layered, and never gated by the thing they switch off.

`/classifier trust-policy` is the only way to pin this user-level policy input; a changed snapshot
disables it and changes the cache signature until its pinned bytes are restored or explicitly repinned.

## Versioning and identity

| Identity | Value | Changes when |
| --- | --- | --- |
| `JEV_POLICY_VERSION` (`CLASSIFIER_POLICY_VERSION`) | `jev-v2.18` | the meaning of a verdict or a policy knob changes, or the state the battery reads changes |
| `jevQuestionsHash()` (`CLASSIFIER_POLICY_HASH`) | sha256 over version + serialized battery + `DEFAULT_JEV_POLICY`, first 16 hex | the battery, its question ids, or the shipped default changes |
| `QUESTIONS_CONTRACT` | `questions+probabilities` | the answer shape the parser accepts changes |

The battery hash is what makes mixed-version decisions visible: cache entries, audit lines,
and harness reports all carry it, so a long session that spans a plugin update can be told
apart from a clean one. Since the battery is code, a changed battery reaches running sessions
only through a reload — and `staleCode` on the audit line says so. The harness's answer
cache is keyed on the battery hash too, so answers recorded under an older battery are not
silently re-scored under a new one.

## Agent ergonomics contract

The agent driving this system is owed three things:

1. **Every block is actionable.** A refusal names its layer, its reason, and a lawful next
   step. A block the agent can only evade is a failure of the gate, not the agent.
2. **Every block is worth its cost.** A block costs the agent a detour and often costs the
   user a chat turn. Over-flagging is a tax paid in those turns; the measurement tracks it as
   such, and the sweep exists to spend that tax deliberately instead of by default.
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
