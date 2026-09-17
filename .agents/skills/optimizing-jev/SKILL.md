---
name: optimizing-jev
description: Use when writing or tuning TypeSafe Jev (System One) questions, state, or confidence thresholds; when Jev answers look wrong, noisy, over-blocking, or costly; when decomposing an LLM prompt into typed questions; when a "confidence routing isn't working" question appears; or when designing any state + questions request against api.typesafe.ai.
---

# Optimizing Jev

## Overview

Jev is a judgment primitive, not an LLM: typed state in, probability distributions out, one request evaluating all questions in parallel (~100-300ms, output tokens free). Two ideas optimize everything else:

1. **Ask semantic facts, not facts plus reasoning.** Decompose one broad judgment into atomic snap-judgments ("a second-expert gut check") and compose the answers in code. This is the single most important rule (TypeSafe's own words: "probably the most important concept").
2. **The decision lives in your code, not the model.** Thresholds, composition, precedence, grounding data (dates, counts, line numbers) are yours. Jev supplies calibrated probabilities for questions code cannot compute.

Terminology discipline: schema hallucination is eliminated (output is type-constrained); semantic judgment error is not. "Zero hallucinations" never means "zero errors". Validate on labeled data.

## When to Use / Not Use

Use the six-question test (from the community reference, gist §13): judgement-not-creation? bounded output? atomic? context-contained? snap-judgment-fast? machine-consumed? 5-6 yes = good Jev fit; 0-2 = use code or an LLM.

Never use Jev for: math/counting/arithmetic (not a calculator; counting grows unreliable with size), date/time ordering (reads dates as text), text generation (1.3s/word, $0.01/paragraph measured when forced to "chat" via Choice chains), control-rate loops (measured ~2.5Hz ceiling), or anything a regex/parser can compute exactly.

## Battery Pattern (one request, many atomic questions)

Put independent questions in ONE request. Measured: 13 questions batched = 12.2x cheaper, 10.0x faster than sequential singles, identical answers (official cookbook). "Asking a question you might not need is close to free."

Serial requests only when request 2 genuinely cannot be built without answer 1 (new data needed, next options chosen). Questions do not see each other's answers; do not chain conversationally.

Decomposition examples that worked: `_is_spam` Noul -> 6 atomic Nouls (requests_credentials, offers_unexpected_reward, creates_time_pressure, sender_identity_mismatch, link_domain_mismatch, disguises_link_destination); a bash gate -> 1 verdict Choice + 9 hazard Nouls + 1 blast radius Score.

## Question Craft

Rules, each with its source:

- **IDs never reach the model.** "The key is not sent to the underlying model and is not used in inference." Write the complete meaning in `instructions` even when the ID seems self-explanatory.
- **Phrase for the literal reading.** Jev answers the question you wrote, not what you meant; scoping words and negations land at face value. "When you look at a wrong answer and find yourself explaining what you really meant, that explanation is the missing half of the instruction." Split unavoidable interpretation into two literal questions.
- **Ask the semantic fact without a reasoning chain.** Measured (pi-jev calibration lab): "cannot be recovered from version control" scored a force-push 0.77 (unflaggable) because "it's in git" is a reasoning path the model takes; rephrased plainly as "is destructive", the same pair separated 0.03 vs 0.99.
- **Criteria: concrete situations, never degrees.** "Broken feature, but workaround exists" works; "Moderately severe" does not. Each level is judged independently - the model never sees level numbers or neighbors; "worse than the previous" means nothing.
- **Contrastive options for confusable pairs**: each option gets `what` / `not_for` / `examples` (2-3 representative inputs), same field names across options so the model compares like with like.
- **Choices: send the FULL option list** (few tokens each; works to ~240-255 options); add `other`/`none of the above` rather than forcing a closest-wrong pick.
- **Scores: 2-10 levels**, as many as you can describe distinctly; give a rare extreme its own top level; one dimension per Score; normalize by `len(criteria)-1` when combining Scores of different lengths.
- **Nouls: clean yes/no, high = yes.** A Noul of 0.5 means equal yes/no probability, NOT medium anything (the single most common misuse).
- **Point questions at nested state with backticked paths**: "Does \`ticket.messages[0].text\` request a refund?" - include the backticks.
- **Do not let questions overlap** - if two questions' answer bands overlap on your data, derive one from the other in code instead (pi-jev dropped "safe to rerun" after measuring 0.73-0.96 yes vs 0.37-0.66 no overlap).
- **Location/count data is parsed, never asked for**: diff hunk headers yield line numbers, numbered element tables yield click targets. The model invents positions.

## State Design

- Use a named-field object for anything non-trivial; fields give questions something to point at.
- **Scope state to the fields the questions need.** Measured: "accuracy falls as the state grows with content unrelated to the decision" (context rot). Filter/retrieve in code first; if you cannot, run a relevance Noul first.
- **Ship the policy text in state** - do not rely on model weights for your current rules.
- Separate content from questions: state holds the material and supporting facts; questions define the judgments.
- **Omit empty evidence tiers entirely**; `userMessages: []` cannot be told apart from "caller did not pass this tier", and an empty tier is not evidence of anything.
- **State is not treated as hostile.** Injected instructions, misleading framing, or text arguing for its own classification CAN move the answer (documented jaggedness). Mitigate: put the trusted meaning in question `instructions`/`criteria`, mark untrusted fields with a notice baked into the state, and flag untrusted-origin fields explicitly (`contains_prompt_injection` Noul).
- Budgets: ~64k tokens for all state+questions; ~32k for state + the longest single question. Errors on overflow are about payload bytes, not item count - batch by payload size, not rule count.

## Calibration and Thresholds

- `confidence` derives from the answer's own probability distribution (Choices and Scores; Nouls have none - the value IS the signal). Third-party check: ECE ~1.74pts mean.
- **Read `confidence`, not the winner's own probability** - winner 0.45 with a 0.44 runner-up is different from winner 0.45 with thin spread.
- Three-range routing: high -> act, medium -> review/confirm, low -> human/fallback. Floors move with the cost of a wrong answer: read-only can act at ~0.6; money-movers need >0.85-0.9.
- **Threshold from measured bands, not intuition.** Unit-tested on a real gate: an ordinary requested `sed -i` scored "destructive" 0.73-0.77, so any intuitive 0.7 threshold prompts on routine work; the measured destructive cluster sat at 0.99 and the threshold landed at 0.90 (above the in-scope band, below the real cluster). "git status" style safe examples inoculate the floor (0.03-0.48).
- Empty bands are ideal thresholds: distinguishable clusters with zero overlap (0.92-0.99 vs <=0.02) => set the threshold in the gap; expect +-0.05 run-to-run wobble.
- Hold/unsure rate is an output of question unit x aggregation rule x threshold condition, not a model property (measured: same saved responses produced 13%, 39.6%, ~61% hold rates). Count "model said unsure" and "code-side gate failed" as separate counters.
- Separate risk tiers per decision: hazards may hard-block at one threshold and review at a lower one; presence facts ("does the command talk to the network") must never gate - a Noul answering "does X happen" measures presence, and presence is not a risk. Split gating (risk propositions: destructive, leak, exfil, escalation, injection, unauthorized) from descriptive (facts: contacts remote, writes outside cwd, affects shared state): gating on descriptive facts made a plain `git push` unclassifiable (contacts_remote_endpoint 0.97) while the policy demanded it pass.
- Tune against a specific model version, then pin it (`jev-1.13.0`, not `jev-latest`); aliases move. Log the `model` field from every response.
- Validate thresholds by plotting confidence-vs-accuracy on labeled data, then re-test on held-out rows. Evidence from the field: confidence <0.5 -> 35% correct, 0.5-0.8 -> 67.5%, >=0.8 -> 93.5% on one held-out audit.
- The eval loop beats intuition: sweep thresholds over labeled cases, rank safety-first (zero false-allows, then fewest false-asks), keep the argmax policy in a file with the corpus.

## Cost and Latency Facts

- Input $0.042/M tokens, output free. $0.0001-0.0002 per typical multi-question judgment. Rate limits: 250k tokens/s and 1,200 req/min on jev-1.13 (both can move).
- Latency ~100-300ms per request end-to-end (70-500ms documented; field medians 199-319ms). Latency scales with state size, weakly with question count.
- The state dominates cost: N serial calls pay for it N times; batching 13 questions into one call saved 12.2x on a long document.
- Errors: 401 bad key, 422 question validation (body names the field), 429 rate limit, 529 overloaded. SDKs retry 429/529 with backoff; retry 408/500-599; honor Retry-After. `timeout` is per attempt, not a total budget.
- Cache by request hash for replay and dedupe (no server-side caching exists); pin `cacheSeconds` dedupe in high-QPS loops.
- The fallback path can erase judge savings: one production replay had per-judgment cost down 96% and SYSTEM total up 4.1%, because held cases landed back in an unchanged batch flow. Redesign the fallback alongside the judge.

## Anti-Patterns

| Anti-pattern | Reality | Fix |
|---|---|---|
| One broad question ("rate this pitch", "is this safe?") | Overloads one judgment; confidence drops | N atomic questions, compose in code |
| Noul for degree ("strong in Python?") | 0.5 = coin flip, not medium | Score with concrete levels |
| Numbers-only Score levels ("0","1","2") | Level numbers invisible to model | Describe concrete situations per level |
| Degree words ("moderately severe") | Same failure | Same |
| Multi-dimensional levels ("punctual and smart") | Confidence collapse | One dimension per Score |
| Reasoning-entangled wording | Model happily reasons past the fact | Name the semantic fact |
| Questions from overlapping answer bands | Threshold cannot separate | Derive one from the other in code |
| Filtering state through the model's own judgment alone | State not hostile-by-default; injection moves answers | Notice + injection Noul + code-side policy |
| Gating on descriptive facts | "Does X happen" is presence, not risk | Gating vs descriptive split |
| Forcing generation via Choice chains | 1.3s/word measured | Use an LLM for generation |
| Hand-rolled 429/529 retry | Vendor SDK already has backoff + Retry-After honoring | Use SDK defaults |
| `jev-latest` after threshold tuning | Alias moves; silent behavior change | Pin `jev-1.13.0` in tuned systems |
| One question per call | State paid per call; 12.2x cost hit measured | Batch independent questions |
| Stale agent skill | Model invents request/response fields | Keep the skill current with the API |

## This Repo's Reference Implementation

`jev.ts` implements most of this skill with measured numbers in its header comment: the gating/descriptive hazard split, fail-closed validation (a missing hazard is an error, never a default 0), thresholds as explicit policy (`DEFAULT_JEV_POLICY`), versioned policy hash, and an eval runner (`eval/run.ts`) that sweeps the threshold grid over labeled cases. Read it before hand-rolling any of these again.

## Sources

Official docs: docs.typesafe.ai (primitives, choice, noul, score, advanced, state, confidence, system-one, how-to-build-with-system-one, model-jaggedness/jev-1.13, api, models, patterns/, cookbooks/ - llm_guardrails, classification_using_confidence, classifying_rag_passages, parallel_questions, entity_alignment, hierarchical_classification). Launch post: typesafe.ai/blog/introducing-system-one-models-and-jev. JS SDK: github.com/typesafe-ai/typesafe-sdk-js (issues #2 Node 20/22 cancellation crash on handled cancellation, #4 numeric option labels infer `never`).

Field measurements: y0usaf/pi-jev (calibration lab; thresholds from measured bands); yonatangross/orchestkit docs/audits (held-out 150 sessions; "the accuracy gain came from the rewritten criteria, not from the model"); virtual-context/virtual-context benchmarks/jev (rerank/intent/temporal vs 235B legacy); YTAL entity-resolution replay (hold-rate illusion, fallback cost trap); ytal.io/blog/typesafe-jev-entity-resolution-production-replay; pearpages.com Jev-sorted vendor-eval analysis; patrickdesjardins.com 370-rule linter (payload-batched); dev.to/valyuai Jev practical guide; seangoedecke.com on structured-output prefill.
