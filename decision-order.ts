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
 *   3. jev-v2's safe gate, no overlay flags           → SAFE
 *   4. firm `named`, literal match, no overlay flags  → SAFE
 *      (headless with a block-band hazard or unsafe   → branch 5)
 *   5. `named` or `goal`                              → reviewer (UNSURE until Phase 3)
 *   6. overlay flags, authorization `none`, not UNSAFE → UNSURE
 *   7. otherwise                                      → jev-v2's derivation
 *
 * Pure, like deriveJevDecision, and separate from it on purpose: jev-v2 stays
 * the live decision until the flip, so the shadow week compares against code
 * that did not move.
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
	if (legacy.verdict === "SAFE" && !overlaid) {
		return decide(3, "SAFE", "safe", legacy.reason, legacy.persistRefusal);
	}
	if (authorization.namedFirm && !overlaid && input.literal?.matched === true) {
		const blockBand = maxGating(input.risk) >= policy.hazardBlock || unsafe >= policy.unsafeMinProbability;
		if (!(input.headless && blockBand)) {
			return decide(4, "SAFE", "named-literal", `${authorization.reason}, every segment matched the user's words`, false);
		}
	}
	if (authorization.level === "named" || authorization.level === "goal") {
		const note = overlaid ? `; overlay ${overlayFlags.join(", ")}` : "";
		return decide(5, "UNSURE", "reviewer", `${authorization.reason}; reviewer not built yet${note}; risk: ${legacy.reason}`, false);
	}
	// A dialog, as today: the overlay escalates a SAFE or UNSURE. It never
	// softens an UNSAFE, which falls through to branch 7 with its refusal.
	if (overlaid && legacy.verdict !== "UNSAFE") {
		return decide(6, "UNSURE", "overlay", `overlay ${overlayFlags.join(", ")} with ${authorization.reason}`, false);
	}
	return decide(7, legacy.verdict, legacy.reasonCode, legacy.reason, legacy.persistRefusal);
}
