/**
 * judgeJevV3UnderDeadline: the jev-v3 risk battery and the authorization
 * question, asked in parallel over their two states under one deadline. Failure-matrix row: "Authorization request
 * fails, risk succeeds → authorization is none". The risk request failing is
 * still no judgment at all.
 */
import { describe, expect, test } from "bun:test";
import type { Answer, Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { JEV_HAZARDS, JEV_V3_POLICY_VERSION, JevUnavailableError, jevQuestions } from "../jev";
import { judgeJevV3UnderDeadline, type JevV3Outcome } from "../jev-judge";

const riskAnswers: Record<string, Answer> = {
	verdict: { type: "choice", choice: "safe", probabilities: { safe: 0.95, unsafe: 0.03, unsure: 0.02 }, confidence: 0.92 } as unknown as Answer,
	...Object.fromEntries(JEV_HAZARDS.map(hazard => [hazard, { type: "noul", noul: 0.01 } as unknown as Answer])),
	blast_radius: { type: "score", score: 0.4, probabilities: { "0": 0.6, "1": 0.4 }, confidence: 0.8 } as unknown as Answer,
	task_statement: { type: "noul", noul: 0.8 } as unknown as Answer,
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
function routingJudge(fail?: "risk" | "authorization", slow?: { request: "risk" | "authorization"; ms: number }): { judge: Judge; seen: Seen } {
	const seen: Seen = { requests: [], inFlight: 0, maxInFlight: 0 };
	const judge = {
		label: "fake",
		async judge<Q extends Questions>(request: JudgmentRequest<Q>, _options?: JudgeOptions): Promise<JudgmentResult<Q>> {
			seen.requests.push({ state: request.state, questions: request.questions });
			seen.inFlight++;
			seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
			const isAuthorization = "user_authorization" in request.questions;
			const wait = slow !== undefined && slow.request === (isAuthorization ? "authorization" : "risk") ? slow.ms : 5;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, wait);
				_options?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				});
			});
			seen.inFlight--;
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

const ask = (judge: Judge, timeoutMs = 1_000): Promise<JevV3Outcome> =>
	judgeJevV3UnderDeadline({ judge, timeoutMs, riskState: "risk-state", authorizationState: "auth-state" });

describe("judgeJevV3UnderDeadline", () => {
	test("asks the jev-v3 battery and the authorization question at once, each over its own state", async () => {
		const { judge, seen } = routingJudge();
		const outcome = await ask(judge);
		expect(seen.maxInFlight).toBe(2);
		const risk = seen.requests.find(request => !("user_authorization" in request.questions));
		const authorization = seen.requests.find(request => "user_authorization" in request.questions);
		expect(JSON.stringify(risk?.questions)).toBe(JSON.stringify(jevQuestions(JEV_V3_POLICY_VERSION)));
		expect(risk?.state).toBe("risk-state");
		expect(authorization?.state).toBe("auth-state");
		if (outcome.kind !== "answered") throw new Error(`expected an answer, got ${outcome.kind}`);
		expect(outcome.judgment.risk.verdict.choice).toBe("safe");
		expect(outcome.judgment.risk.taskStatement).toBe(0.8);
		expect(outcome.judgment.authorization?.level).toBe("named");
		expect(outcome.judgment.authorizationError).toBeUndefined();
	});

	test("matrix: a failed authorization request leaves the risk answer standing", async () => {
		const outcome = await ask(routingJudge("authorization").judge);
		if (outcome.kind !== "answered") throw new Error(`expected an answer, got ${outcome.kind}`);
		expect(outcome.judgment.risk.verdict.choice).toBe("safe");
		expect(outcome.judgment.authorization).toBeUndefined();
		expect(outcome.judgment.authorizationError).toMatch(/authorization judgment failed/u);
	});

	test("a failed risk request is no judgment, whatever the authorization said", async () => {
		const outcome = await ask(routingJudge("risk").judge);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") expect(outcome.error).toBeInstanceOf(JevUnavailableError);
	});

	test("a risk request past the deadline is the deadline, not an answer", async () => {
		const outcome = await ask(routingJudge(undefined, { request: "risk", ms: 2_000 }).judge, 50);
		expect(outcome.kind).toBe("deadline");
	});

	test("an authorization request past the deadline reads as none and the risk answer stands", async () => {
		const outcome = await ask(routingJudge(undefined, { request: "authorization", ms: 2_000 }).judge, 50);
		if (outcome.kind !== "answered") throw new Error(`expected an answer, got ${outcome.kind}`);
		expect(outcome.judgment.authorization).toBeUndefined();
		expect(outcome.judgment.authorizationError).toMatch(/timed out after 50ms/u);
	});
});
