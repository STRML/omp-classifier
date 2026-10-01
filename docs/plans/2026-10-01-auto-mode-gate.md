# Design: an auto-mode gate (allow or deny, never a dialog)

Status: draft for review, 2026-10-01. Builds on `2026-09-19-intent-aware-judgment.md`,
which settled the intent model and left it shadow-only.

## Goal

The gate decides every call itself. It returns **allow** or **deny with a reason** and never opens a
dialog, which is how Claude Code auto mode behaves. The user's own words settle the close calls. A
denial goes to the agent, the agent asks in chat, and the user's reply is evidence on the retry.

Success looks like this:

- No `ctx.ui` dialog is reachable from the gate.
- Read-only work the user would never think about runs silent.
- A command the user asked for runs silent, including merge, deploy and credential use against the
  issuer, which the 2026-09-19 plan measured as most of the false asks.
- A denial leaves the agent a lawful next move, and one sentence from the user opens it.

## Acceptance scenario (the behavior to match)

A Claude Code session, supplied by the user as the model for this gate:

```
agent    plans to edit /etc/caddy/Caddyfile
gate     denies (that run gave no reason; ours must give one)
agent    "did not go through. unchanged, no backup, not reloaded."
         then three ways forward: run it yourself, allow it, other fix
user     "add it to caddy"
agent    retries, gate allows, change lands, verified from the Mac
```

What this fixes in the design:

- The deny payload tells the agent to report what did **not** happen (state unchanged, nothing
  half-applied) and to offer the user ways forward. The agent writes the chat message. The gate
  supplies the reason and the facts.
- The user's reply is four words and names no path. `literalMatch` cannot clear it, because it only
  extracts local deletes, branch deletes, `gh pr merge <n>` and in-repo deploy scripts. The reviewer
  clears it, and for that it must resolve "it" against the agent's previous message.
- So the reviewer receives the assistant's last message as **explanatory context that never
  authorizes**. The user's message is still the only thing that authorizes. This answers the first
  open item below: the reviewer, and only the reviewer, reads assistant prose.
- The retry is the same call with a new user message in the window. The deny must not pin the shape
  for the session (the 2026-09-19 plan, point 9).

## Measured starting point

Decision log, last 3 days (2026-09-28 to 2026-10-01), 1,960 decisions with a verdict answer.

| Fact | Number |
|---|---|
| Dialogs answered | 120 (117 allow-once, 2 always-allow, 1 deny) |
| Verdict-layer asks | 262 |
| Asks where `state_contains_injection` is the only hazard at or above `hazardReview` (0.55) | 159 |
| `state_contains_injection` on auto-allowed calls | median 0.17, max 0.54 |
| `state_contains_injection` on asked calls | median 0.56 |
| Asks on `git diff`/`log`/`show` | 86 of 442 such calls |
| Headless blocks (subagents) | 178 |
| Asks whose jev-v3 shadow had authorization `named` or `goal` | 231 of 262 |

The v3 shadow has run live-beside-live since 2026-09-21, so branch 1, 3 and 5 counts above are
real. Two causes follow. The injection hazard fires on ordinary read-only work, and the user's words
are read but never used in the live decision.

Why the hazard fires is not yet known. Its question covers "any other field of this state", which
includes recent tool output and the user's messages. Step 1 measures that before anything is changed.

## Design

```
command ─▶ floor ───────────────────────────✗─▶ deny + reason
             ▼
           risk (Jev battery) ── clear ──────────▶ allow
             ▼ close call
           literal match on the user's words ─ yes ─▶ allow
             ▼ no
           reviewer (transcript-aware, typed) ─ yes ─▶ allow
             ▼ no, unsure, or unavailable
           deny + reason ─▶ agent asks in chat ─▶ the reply is evidence
```

1. **Floor.** Unchanged in content (`floor.ts`, critical patterns, secret sinks, download piped to an
   interpreter, obfuscation). Its outcome changes from a dialog to a deny. Nothing above it can cross it.
2. **Risk.** The existing battery. The injection question is scoped so it reads the command text and
   the evidence the channel marks as untrusted, and never the user's own messages or the gate's measured
   tiers. The exact change comes from step 1's probe.
3. **Intent.** `authorization.ts`, `literal-match.ts` and `decision-order.ts` go live as the decision
   (the jev-v3 flip, issue #55). Branches 3 and 4 allow, branch 5 hands to the reviewer.
4. **Reviewer.** A second typed request, not prose. It sees the same state plus the transcript tier and
   answers a `choice` of covered, not covered, unsure on "does the user's request cover this action".
   Anything below its confidence floor, and any outage, denies. The reviewer's model is chosen by
   measurement, as the 2026-09-19 plan decided: a second Jev pass against an LLM reviewer.
5. **Deny.** One payload for the agent: the layer, the reason built from numbers and hazard ids, what
   to ask the user, and what not to try. It lands in the transcript, the user answers in chat, and the
   next evidence window carries that answer.
6. **No dialogs.** Dialog code, Allow once, session grants and Always allow are deleted. A standing
   authorization comes from the user's words, the pinned trust policy, or the host's `allow` rules.

## What stays

- Host `deny`/`prompt`/narrow `allow` rules still run before the gate. A host `prompt` rule is the
  host's dialog, not this plugin's, and is out of scope.
- The 8,000-character cap, env-override ask, fail-closed on every outage, and the decision log.
- The replay contract: a verdict re-derives from its recorded answers.

## Failure matrix

| State or input | What the gate does | How it can fail | What the agent is told |
|---|---|---|---|
| Floor entry matches | Deny at the floor, no model call | A pattern over-matches a benign command | Entry id, the shape that matched, a reversible alternative where one exists |
| Jev unavailable (no key, 5xx, timeout, malformed) | Deny, uncached | Outage denies all unmatched work | "Judge unavailable", retry, no verdict claimed |
| Reviewer unavailable | Deny, uncached | Same | Same, naming the reviewer |
| Reviewer unsure or below floor | Deny | Real work denied | The action, and the one sentence from the user that would cover it |
| User replies "go ahead" or "add it to caddy" after a deny | Reply enters the evidence window, reviewer resolves the referent from the agent's last message, retry re-judges | The reply ages out before the retry; the referent is ambiguous because the agent proposed two things | Retry reuses the denied call's identity; an ambiguous referent denies and names both candidates |
| Cached allow, then a restriction ("don't push") | Key includes the evidence fingerprint, the allow is not reused | Restriction text trips the fingerprint on unrelated calls (known today: any "need", "must", "only") | Fingerprint covers restrictions that match the action only |
| Prior deny on a shape, then the user approves | Approval lifts it, refusal keyed on the grant identity | Approval spelled differently from the denied command | Deny names the identity it will accept |
| Subagent, no user messages | Judged against the root session's words | Host omits `parentAgentId`, so the root cannot be found | Deny names the parent as the party to ask |
| Injection text in a command | Branch 1 denies, no refusal written for one-hot answers | Hazard fires on benign text (the measured 159) | Hazard id and score, no claim the command was malicious |
| Late verdict after the deadline | Allowed to land only as allow or deny on the same call | Late allow after a deny the agent already acted on | None, the call is already answered |
| Config or battery changes mid-session | Cache and refusal memory flush | A flushed refusal lets a denied shape retry | Retry re-judges from scratch |

Every row becomes a failing end-to-end scenario before its code, per `dev-workflow.md` stage 4.

## Order of work

Each step is shippable on its own, and the measurement gate sits on the step it names.

| Step | Work | Gate |
|---|---|---|
| 1 | Probe: command alone vs full state on a sample of the 159 injection asks. Fix the question or its inputs. | Asks that cite injection alone drop to under 10% of today's count on the replayed corpus, 0 new false allows |
| 2 | Flip jev-v3 live. Branches 3 and 4 allow. | `bun eval/run.ts --replay` shows 0 false allows on the adversarial corpus, REGRESSIONS none |
| 3 | Reviewer: build both candidates, measure, keep one. | False asks and false allows reported by name for each candidate |
| 4 | Remove dialogs and grants. Deny payload and evidence-window retry. | The failure matrix rows above all pass |
| 5 | Subagent intent inheritance. | Headless blocks on authorized work drop. If the host cannot supply the parent, record the host gap and keep the deny |

Steps 1 and 2 reduce prompts the day they ship. Step 4 is the one that ends them, and it does not
ship before step 3, because removing the dialog without a reviewer converts every close call into a
deny.

## Open items

- Whether the host exposes the root session's user messages to a subagent's `tool_call` (step 5).
- Decided: the reviewer reads the assistant's previous message as non-authorizing context, to resolve
  references like "it" and "that" in a short user reply. Open: how many assistant turns back, and the
  size cap. Measure on replies like the acceptance scenario's.
- `codemaps/` does not exist in this repository, and the workflow suggests `/update-codemaps`.
