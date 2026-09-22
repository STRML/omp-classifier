/**
 * The jev-v3 decision order (plan `docs/plans/2026-09-19-intent-aware-judgment.md`,
 * "Decision order", Phase 2 step 5). Seven branches, first match wins, and
 * every branch writes a reason code naming its number. Until Phase 3 lands a
 * reviewer, branch 5 means UNSURE.
 *
 * Tests named for a failure-matrix row pin that row.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_AUTHORIZATION_POLICY, deriveAuthorization, type AuthorizationVerdict } from "../authorization";
import { deriveDecisionOrder, type DecisionOrderInput } from "../decision-order";
import { DEFAULT_JEV_POLICY, deriveJevDecision, JEV_HAZARDS, type JevAnswers, type JevHazard } from "../jev";

function risk(over: { safe?: number; unsafe?: number; confidence?: number; hazards?: Partial<Record<JevHazard, number>>; blast?: number; oneHot?: boolean } = {}): JevAnswers {
	const safe = over.safe ?? 0.95;
	const unsafe = over.unsafe ?? 1 - safe;
	const hazards = Object.fromEntries(JEV_HAZARDS.map(hazard => [hazard, over.hazards?.[hazard] ?? 0])) as Record<JevHazard, number>;
	return {
		model: "jev-test",
		verdict: { choice: safe >= unsafe ? "safe" : "unsafe", probabilities: { safe, unsafe, unsure: 0 }, confidence: over.confidence ?? 0.9 },
		hazards,
		blastRadius: { score: over.blast ?? 0.2, confidence: 0.9, levels: ["a", "b", "c"] },
		latencyMs: 1,
		...(over.oneHot ? { oneHot: true } : {}),
	};
}

const none: AuthorizationVerdict = { level: "none", namedFirm: false, reason: "authorization none 0.00" };
const goal: AuthorizationVerdict = { level: "goal", namedFirm: false, reason: "authorization goal 0.10" };
const namedFirm: AuthorizationVerdict = { level: "named", namedFirm: true, reason: "authorization named 0.95 (>=0.80)" };
const namedSoft: AuthorizationVerdict = { level: "named", namedFirm: false, reason: "authorization named 0.60 (<0.80)" };

function input(over: Partial<DecisionOrderInput> = {}): DecisionOrderInput {
	return { risk: risk(), authorization: none, literal: { matched: false }, overlayFlags: [], headless: false, ...over };
}

const decide = (over: Partial<DecisionOrderInput> = {}) => deriveDecisionOrder(input(over), DEFAULT_JEV_POLICY);

describe("branch 1: injection", () => {
	test("injection at hazardReview is UNSAFE whatever the authorization says", () => {
		const decision = decide({ risk: risk({ hazards: { state_contains_injection: 0.6 } }), authorization: namedFirm, literal: { matched: true } });
		expect(decision.verdict).toBe("UNSAFE");
		expect(decision.branch).toBe(1);
		expect(decision.reasonCode).toBe("jev-v3:1:injection");
		expect(decision.persistRefusal).toBe(true);
	});

	test("a one-hot injection answer stays UNSAFE and records no refusal", () => {
		const decision = decide({ risk: risk({ hazards: { state_contains_injection: 1 }, oneHot: true }) });
		expect(decision.verdict).toBe("UNSAFE");
		expect(decision.branch).toBe(1);
		expect(decision.persistRefusal).toBe(false);
	});
});

describe("branch 2: a one-hot risk answer never allows a hazard", () => {
	test("a one-hot gating hazard is UNSAFE without a refusal, even when named", () => {
		const decision = decide({ risk: risk({ hazards: { exposes_secrets: 1 }, oneHot: true }), authorization: namedFirm, literal: { matched: true } });
		expect(decision.verdict).toBe("UNSAFE");
		expect(decision.branch).toBe(2);
		expect(decision.reasonCode).toBe("jev-v3:2:one-hot-hazard");
		expect(decision.persistRefusal).toBe(false);
	});

	test("a one-hot unsafe choice is UNSAFE without a refusal", () => {
		const decision = decide({ risk: risk({ safe: 0, unsafe: 1, oneHot: true }), authorization: goal });
		expect(decision.verdict).toBe("UNSAFE");
		expect(decision.branch).toBe(2);
		expect(decision.persistRefusal).toBe(false);
	});

	test("a one-hot safe answer with no hazard falls through to the safe gate", () => {
		const decision = decide({ risk: risk({ safe: 1, unsafe: 0, confidence: 1, oneHot: true }) });
		expect(decision.verdict).toBe("SAFE");
		expect(decision.branch).toBe(3);
	});
});

describe("branch 3: the safe gate", () => {
	test("a clean safe answer with no overlay is SAFE at any authorization", () => {
		for (const authorization of [none, goal, namedFirm]) {
			const decision = decide({ authorization });
			expect(decision.verdict).toBe("SAFE");
			expect(decision.branch).toBe(3);
			expect(decision.reasonCode).toBe("jev-v3:3:safe");
		}
	});

	test("an overlay flag keeps a clean safe answer out of branch 3", () => {
		const decision = decide({ overlayFlags: ["recursive-delete"] });
		expect(decision.branch).not.toBe(3);
		expect(decision.verdict).toBe("UNSURE");
	});
});

describe("branch 4: the literal fast allow", () => {
	const deleteAnswer = risk({ safe: 0.3, unsafe: 0.4, hazards: { destructive_or_irreversible: 0.8 } });

	test("a firm named authorization over a fully matched command is SAFE", () => {
		const decision = decide({ risk: deleteAnswer, authorization: namedFirm, literal: { matched: true } });
		expect(decision.verdict).toBe("SAFE");
		expect(decision.branch).toBe(4);
		expect(decision.reasonCode).toBe("jev-v3:4:named-literal");
		expect(decision.reason).toContain("authorization named 0.95");
	});

	test("matrix: named with nothing extracted never takes branch 4", () => {
		// literalMatch reports matched only with at least one extracted action
		// and every segment matched or inert; an empty extraction is unmatched.
		const decision = decide({ risk: deleteAnswer, authorization: namedFirm, literal: { matched: false } });
		expect(decision.branch).toBe(5);
		expect(decision.verdict).toBe("UNSURE");
	});

	test("matrix: one matched delete plus an unextracted python3 -c segment goes to the reviewer", () => {
		const decision = decide({ risk: deleteAnswer, authorization: namedFirm, literal: { matched: false } });
		expect(decision.branch).toBe(5);
	});

	test("the eval path has no literal match, so it never takes branch 4", () => {
		const decision = decide({ risk: deleteAnswer, authorization: namedFirm, literal: undefined });
		expect(decision.branch).toBe(5);
	});

	test("an overlay flag sends a matched named command to the reviewer", () => {
		const decision = decide({ risk: deleteAnswer, authorization: namedFirm, literal: { matched: true }, overlayFlags: ["recursive-delete"] });
		expect(decision.branch).toBe(5);
		expect(decision.verdict).toBe("UNSURE");
	});

	test("matrix: named below namedMinProbability stays named and reaches the reviewer", () => {
		const decision = decide({ risk: deleteAnswer, authorization: namedSoft, literal: { matched: true } });
		expect(decision.branch).toBe(5);
		expect(decision.reasonCode).toBe("jev-v3:5:reviewer");
	});

	test("headless: a block-band hazard goes to the reviewer instead", () => {
		const blockBand = risk({ safe: 0.1, unsafe: 0.3, hazards: { destructive_or_irreversible: 0.95 } });
		const decision = decide({ risk: blockBand, authorization: namedFirm, literal: { matched: true }, headless: true });
		expect(decision.branch).toBe(5);
		expect(decision.verdict).toBe("UNSURE");
		// With a user present, the same answer takes the fast allow.
		expect(decide({ risk: blockBand, authorization: namedFirm, literal: { matched: true } }).branch).toBe(4);
	});

	test("headless: p(unsafe) at unsafeMinProbability goes to the reviewer instead", () => {
		const leaning = risk({ safe: 0.2, unsafe: 0.6, hazards: { destructive_or_irreversible: 0.7 } });
		expect(decide({ risk: leaning, authorization: namedFirm, literal: { matched: true }, headless: true }).branch).toBe(5);
	});

	test("headless: a review-band hazard alone still takes the fast allow", () => {
		expect(decide({ risk: deleteAnswer, authorization: namedFirm, literal: { matched: true }, headless: true }).branch).toBe(4);
	});
});

describe("branch 5: the reviewer, UNSURE until Phase 3", () => {
	test("goal authorization over a hazard goes to the reviewer", () => {
		const decision = decide({ risk: risk({ hazards: { exposes_secrets: 0.92 } }), authorization: goal });
		expect(decision.verdict).toBe("UNSURE");
		expect(decision.branch).toBe(5);
		expect(decision.persistRefusal).toBe(false);
	});

	test("the reviewer branch never records a refusal", () => {
		const decision = decide({ risk: risk({ safe: 0, unsafe: 1, hazards: { destructive_or_irreversible: 0.99 } }), authorization: goal });
		expect(decision.verdict).toBe("UNSURE");
		expect(decision.persistRefusal).toBe(false);
	});
});

describe("branch 6: overlay flags without authorization", () => {
	test("an overlay flag with authorization none is a dialog", () => {
		const decision = decide({ overlayFlags: ["recursive-delete"] });
		expect(decision.verdict).toBe("UNSURE");
		expect(decision.branch).toBe(6);
		expect(decision.reasonCode).toBe("jev-v3:6:overlay");
		expect(decision.reason).toContain("recursive-delete");
	});

	test("an overlay never softens a jev-v2 UNSAFE or drops its refusal (Codex, #101 gate round 3)", () => {
		const unsafe = risk({ safe: 0.02, unsafe: 0.98, hazards: { destructive_or_irreversible: 0.95 } });
		for (const headless of [true, false]) {
			const decision = decide({ risk: unsafe, overlayFlags: ["rm"], headless });
			const legacy = deriveJevDecision(unsafe, DEFAULT_JEV_POLICY);
			expect(legacy.verdict).toBe("UNSAFE");
			expect(decision.branch).toBe(7);
			expect(decision.verdict).toBe("UNSAFE");
			expect(decision.persistRefusal).toBe(true);
		}
	});
});

describe("branch 7: today's derivation", () => {
	test("matrix: an unrequested deploy with a safe-leaning verdict still asks", () => {
		const answer = risk({ safe: 0.85, hazards: { unauthorized_consequential_action: 0.7 } });
		const decision = decide({ risk: answer });
		expect(decision.branch).toBe(7);
		expect(decision.verdict).toBe("UNSURE");
		expect(decision.reasonCode).toBe("jev-v3:7:jev:hazard:unauthorized_consequential_action");
	});

	test("with no authorization, the verdict is jev-v2's", () => {
		const shapes = [
			risk({ hazards: { exposes_secrets: 0.95 } }),
			risk({ safe: 0.2, unsafe: 0.7 }),
			risk({ safe: 0.6 }),
			risk({ blast: 1.8 }),
		];
		for (const answer of shapes) {
			const legacy = deriveJevDecision(answer, DEFAULT_JEV_POLICY);
			const decision = decide({ risk: answer });
			expect(decision.branch).toBe(7);
			expect(decision.verdict).toBe(legacy.verdict);
			expect(decision.reasonCode).toBe(`jev-v3:7:${legacy.reasonCode}`);
			expect(decision.persistRefusal).toBe(legacy.persistRefusal);
		}
	});
});

describe("authorization failures", () => {
	test("matrix: a failed authorization request counts as none", () => {
		const authorization = deriveAuthorization(undefined, DEFAULT_AUTHORIZATION_POLICY);
		const decision = decide({ risk: risk({ hazards: { exposes_secrets: 0.95 } }), authorization, literal: { matched: true } });
		expect(decision.branch).toBe(7);
		expect(decision.verdict).toBe("UNSAFE");
	});

	test("matrix: a one-hot authorization answer counts as none, whatever the risk answer", () => {
		const authorization = deriveAuthorization(
			{ model: "bridge", level: "named", probabilities: { none: 0, goal: 0, named: 1 }, confidence: 1, latencyMs: 1, oneHot: true },
			DEFAULT_AUTHORIZATION_POLICY,
		);
		const decision = decide({ risk: risk({ hazards: { destructive_or_irreversible: 0.8 } }), authorization, literal: { matched: true } });
		expect(decision.branch).toBe(7);
	});
});

test("every decision names its branch in the reason code and the reason", () => {
	const cases: Array<Partial<DecisionOrderInput>> = [
		{ risk: risk({ hazards: { state_contains_injection: 0.7 } }) },
		{ risk: risk({ hazards: { exposes_secrets: 1 }, oneHot: true }) },
		{},
		{ risk: risk({ safe: 0.3, hazards: { destructive_or_irreversible: 0.8 } }), authorization: namedFirm, literal: { matched: true } },
		{ risk: risk({ safe: 0.3 }), authorization: goal },
		{ overlayFlags: ["x"] },
		{ risk: risk({ safe: 0.3 }) },
	];
	expect(cases.map(over => decide(over).branch)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	for (const over of cases) {
		const decision = decide(over);
		expect(decision.reasonCode.startsWith(`jev-v3:${decision.branch}:`)).toBe(true);
		expect(decision.reason.startsWith(`branch ${decision.branch}: `)).toBe(true);
	}
});
