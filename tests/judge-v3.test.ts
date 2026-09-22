/**
 * judgeJevV3: the jev-v3 risk battery and the authorization question, asked in
 * parallel over their two states. Failure-matrix row: "Authorization request
 * fails, risk succeeds → authorization is none". The risk request failing is
 * still no judgment at all.
 */
import { describe, expect, test } from "bun:test";
import type { Answer, Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { JEV_HAZARDS, JEV_V3_POLICY_VERSION, JevUnavailableError, jevQuestions } from "../jev";
import { judgeJevV3 } from "../jev-judge";

const riskAnswers: Record<string, Answer> = {
	verdict: { type: "choice", choice: "safe", probabilities: { safe: 0.95, unsafe: 0.03, unsure: 0.02 }, confidence: 0.92 } as unknown as Answer,
	...Object.fromEntries(JEV_HAZARDS.map(hazard => [hazard, { type: "noul", noul: 0.01 } as unknown as Answer])),
	blast_radius: { type: "score", score: 0.4, probabilities: { "0": 0.6, "1": 0.4 }, confidence: 0.8 } as unknown as Answer,
};

const authorizationAnswers: Record<string, Answer> = {
	user_authorization: { type: "choice", choice: "named", probabilities: { none: 0.05, goal: 0.1, named: 0.85 }, confidence: 0.88 } as unknown as Answer,
};

interface Seen {
	requests: Array<{ state: unknown; questions: Questions }>;
	inFlight: number;
	maxInFlight: number;
}

/** Answers each request by what it asks; `fail` names the request that throws. */
function routingJudge(fail?: "risk" | "authorization"): { judge: Judge; seen: Seen } {
	const seen: Seen = { requests: [], inFlight: 0, maxInFlight: 0 };
	const judge = {
		label: "fake",
		async judge<Q extends Questions>(request: JudgmentRequest<Q>, _options?: JudgeOptions): Promise<JudgmentResult<Q>> {
			seen.requests.push({ state: request.state, questions: request.questions });
			seen.inFlight++;
			seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
			await Bun.sleep(5);
			seen.inFlight--;
			const isAuthorization = "user_authorization" in request.questions;
			if (fail === (isAuthorization ? "authorization" : "risk")) throw new Error("boom");
			return {
				api: "typesafe",
				provider: "typesafe",
				model: "jev-1.13.0",
				answers: isAuthorization ? authorizationAnswers : riskAnswers,
			} as unknown as JudgmentResult<Q>;
		},
	} as Judge;
	return { judge, seen };
}

describe("judgeJevV3", () => {
	test("asks the jev-v3 battery and the authorization question at once, each over its own state", async () => {
		const { judge, seen } = routingJudge();
		const result = await judgeJevV3(undefined, { judge, riskState: "risk-state", authorizationState: "auth-state" });
		expect(seen.maxInFlight).toBe(2);
		const risk = seen.requests.find(request => !("user_authorization" in request.questions));
		const authorization = seen.requests.find(request => "user_authorization" in request.questions);
		expect(JSON.stringify(risk?.questions)).toBe(JSON.stringify(jevQuestions(JEV_V3_POLICY_VERSION)));
		expect(risk?.state).toBe("risk-state");
		expect(authorization?.state).toBe("auth-state");
		expect(result.risk.verdict.choice).toBe("safe");
		expect(result.authorization?.level).toBe("named");
		expect(result.authorizationError).toBeUndefined();
	});

	test("matrix: a failed authorization request leaves the risk answer standing", async () => {
		const { judge } = routingJudge("authorization");
		const result = await judgeJevV3(undefined, { judge, riskState: "risk-state", authorizationState: "auth-state" });
		expect(result.risk.verdict.choice).toBe("safe");
		expect(result.authorization).toBeUndefined();
		expect(result.authorizationError).toMatch(/authorization judgment failed/u);
	});

	test("a failed risk request is no judgment, whatever the authorization said", async () => {
		const { judge } = routingJudge("risk");
		let thrown: unknown;
		try {
			await judgeJevV3(undefined, { judge, riskState: "risk-state", authorizationState: "auth-state" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(JevUnavailableError);
	});
});
