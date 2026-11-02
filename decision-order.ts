/**
 * The jev-v3 decision order (plan `docs/plans/2026-09-19-intent-aware-judgment.md`,
 * "Decision order", Phase 2 step 5).
 *
 * jev-v2 decides from the risk answers alone (`deriveJevDecision`). jev-v3 adds
 * what the user's own words cover: the authorization level, whether code
 * matched every segment of the command against those words, the static overlay
 * flags, and whether anyone is present to answer a dialog. The floor has
 * already run by the time this is asked. First match wins:
 *
 *   1. injection at hazardReview                      → UNSAFE
 *   2. one-hot risk answer with a hazard or unsafe    → UNSAFE, no refusal
 *      one-hot risk answer otherwise                  → UNSURE: a keyword
 *      answer has no distribution to clear a floor with, so it never allows
 *   3. jev-v2's safe gate, no overlay flags           → SAFE
 *   4. firm `named`, literal match, no overlay flags,
 *      jev-v2 not UNSAFE                              → SAFE
 *   5. `named` or `goal`, jev-v2 not UNSAFE           → UNSURE, which stage 2 reviews
 *   6. overlay flags, authorization `none`, not UNSAFE → jev-v2's verdict,
 *      which the gate's overlay then blocks as `flagged` on a SAFE
 *   7. otherwise                                      → jev-v2's derivation
 *
 * Pure. This is the live decision since the flip
 * (https://github.com/STRML/omp-classifier/issues/116); branches 3 and 7 read
 * `deriveJevDecision` over the same risk answers.
 */
import type { AuthorizationVerdict } from "./authorization";
import { deriveJevDecision, JEV_GATING_HAZARDS, type JevAnswers, type JevDecision, type JevPolicy, type JevVerdict } from "./jev";

export type DecisionBranch = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DecisionOrderInput {
	/** The jev-v3 risk battery's answers. */
	risk: JevAnswers;
	/** `deriveAuthorization`'s reading. A failed or one-hot request is already `none`. */
	authorization: AuthorizationVerdict;
	/** `literalMatch`'s result. Undefined where no shell was parsed (the eval
	 *  tool's code), which can never take the fast allow. */
	literal: { matched: boolean } | undefined;
	/** The deterministic overlays that force a dialog after a SAFE today. */
	overlayFlags: readonly string[];
	/** No user to answer a dialog. */
	headless: boolean;
}

export interface OrderedDecision extends JevDecision {
	branch: DecisionBranch;
}

const fmt = (value: number): string => value.toFixed(2);

const maxGating = (answers: JevAnswers): number => Math.max(...JEV_GATING_HAZARDS.map(hazard => answers.hazards[hazard]));

export function deriveDecisionOrder(input: DecisionOrderInput, policy: JevPolicy): OrderedDecision {
	const legacy = deriveJevDecision(input.risk, policy);
	const oneHot = input.risk.oneHot === true;
	const unsafe = input.risk.verdict.probabilities.unsafe ?? 0;
	const { authorization, overlayFlags } = input;
	const overlaid = overlayFlags.length > 0;

	const decide = (branch: DecisionBranch, verdict: JevVerdict, code: string, reason: string, persistRefusal: boolean): OrderedDecision => ({
		...legacy,
		verdict,
		branch,
		reasonCode: `jev-v3:${branch}:${code}`,
		reason: `branch ${branch}: ${reason}`,
		persistRefusal,
	});

	const injection = input.risk.hazards.state_contains_injection;
	if (injection >= policy.hazardReview) {
		return decide(1, "UNSAFE", "injection", `hazard state_contains_injection ${fmt(injection)} (>=${fmt(policy.hazardReview)})`, !oneHot);
	}
	if (oneHot && (maxGating(input.risk) >= policy.hazardReview || unsafe >= policy.unsafeMinProbability)) {
		return decide(2, "UNSAFE", "one-hot-hazard", `${legacy.reason}; a keyword answer cannot clear a hazard`, false);
	}
	if (oneHot) {
		return decide(2, "UNSURE", "one-hot", `${legacy.reason}; a keyword answer never allows`, false);
	}
	if (legacy.verdict === "SAFE" && !overlaid) {
		return decide(3, "SAFE", "safe", legacy.reason, legacy.persistRefusal);
	}
	// No authorization answer softens the risk derivation's UNSAFE: branches 4
	// and 5 read only a SAFE or UNSURE, and an UNSAFE falls through to branch 7
	// with its verdict, reason and refusal, where stage 2 applies its UNSAFE
	// bars exactly as before the flip. A model-authored "the user asked for
	// this" must not clear what the risk battery holds. The plan's headless
	// exception (a block-band hazard or p(unsafe) at the floor) is the same
	// set of answers, so it is covered for every session.
	const riskUnsafe = legacy.verdict === "UNSAFE";
	if (!riskUnsafe && authorization.namedFirm && !overlaid && input.literal?.matched === true) {
		return decide(4, "SAFE", "named-literal", `${authorization.reason}, every segment matched the user's words`, false);
	}
	if (!riskUnsafe && (authorization.level === "named" || authorization.level === "goal")) {
		const note = overlaid ? `; overlay ${overlayFlags.join(", ")}` : "";
		return decide(5, "UNSURE", "reviewer", `${authorization.reason}${note}; risk: ${legacy.reason}`, false);
	}
	// The plan's branch 6 was "a dialog, as today". There is no dialog since
	// https://github.com/STRML/omp-classifier/issues/184: today an overlaid
	// SAFE is refused as `flagged` by the gate's overlay check, with the flag's
	// own guidance (use trash, ask the user to run it). The branch therefore
	// keeps jev-v2's verdict and names the overlay; the caller passes the same
	// flag list it blocks a SAFE on, so a branch 6 SAFE never runs. It never
	// softens an UNSAFE, which falls through to branch 7 with its refusal.
	if (overlaid && legacy.verdict !== "UNSAFE") {
		return decide(6, legacy.verdict, "overlay", `${legacy.reason}; overlay ${overlayFlags.join(", ")} with ${authorization.reason}`, legacy.persistRefusal);
	}
	return decide(7, legacy.verdict, legacy.reasonCode, legacy.reason, legacy.persistRefusal);
}
