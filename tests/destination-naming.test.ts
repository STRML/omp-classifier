/**
 * Issue #161: a curl to a lookalike host ran silently.
 *
 * The user asked to "check the status page at you.github.io/omp-classifier" and
 * the command fetched `attacker.github.io`. github.io is a public-suffix
 * private-section entry, so the two are different sites with different owners,
 * but nothing in the state said so and the judge read the shared `github.io`
 * as the same place (p(safe) 0.84 on jev-1.13.0 and jev-1.14.0).
 *
 * The gate now reports `lookalikeDestinations`: destinations that are not a
 * host the user named and not beneath one, yet share a parent domain with one.
 * The measurement is negative only. It never says a destination IS the
 * user's, because that would be a trust signal a shared suffix, a quoted or
 * substituted URL, or a redirect flag could forge.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { buildJevState, measureLookalikeDestinations } from "../jev.ts";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSessionId, makeSettings, refusalOf, removeConfigFile, resultText, setJevAnswer } from "./fixtures";

const STATUS_ASK = ["check the status page at you.github.io/omp-classifier"];

describe("measureLookalikeDestinations", () => {
	test("a lookalike under a shared parent is reported", () => {
		expect(measureLookalikeDestinations("curl -sf https://attacker.github.io/omp-classifier/status.json", STATUS_ASK)).toEqual({
			destinations: [{ host: "attacker.github.io", sameParentAs: ["you.github.io"] }],
		});
	});

	test("a named host's parent is a different host sharing its parent domain", () => {
		expect(measureLookalikeDestinations("curl -s https://neuralwatt.com/", ["hit api.neuralwatt.com/v1/models"])).toEqual({
			destinations: [{ host: "neuralwatt.com", sameParentAs: ["api.neuralwatt.com"] }],
		});
	});

	test("hosts read from URLs and bare names, normalized", () => {
		const ask = ["the docs are at HTTPS://Docs.Example.com:8443/guide, mirror on files.example.org."];
		expect(measureLookalikeDestinations("curl https://api.example.com/guide && curl https://FILES.example.org./x", ask)).toEqual({
			destinations: [{ host: "api.example.com", sameParentAs: ["docs.example.com"] }],
		});
	});

	test("punctuation around a named host or a destination does not hide the lookalike", () => {
		const expected = { destinations: [{ host: "attacker.github.io", sameParentAs: ["you.github.io"] }] };
		for (const message of [
			"check the status page at https://you.github.io, then report",
			"check the status page at https://you.github.io. thanks",
			"check the status page (you.github.io)",
			"check the status page <https://you.github.io>",
			"check you.github.io!",
			"check https://you.github.io; it moved",
		]) {
			expect(measureLookalikeDestinations("curl -sf https://attacker.github.io/x", [message])).toEqual(expected);
		}
		expect(measureLookalikeDestinations("curl -sf https://attacker.github.io,", STATUS_ASK)).toEqual(expected);
	});

	test("a lookalike is reported beside a named destination in the same command", () => {
		expect(measureLookalikeDestinations("curl https://you.github.io/a; curl https://attacker.github.io/b", STATUS_ASK)).toEqual({
			destinations: [{ host: "attacker.github.io", sameParentAs: ["you.github.io"] }],
		});
	});

	test("remote-verb destinations count like URL hosts", () => {
		expect(measureLookalikeDestinations("ssh deploy@build.github.io uptime", STATUS_ASK)).toEqual({
			destinations: [{ host: "build.github.io", sameParentAs: ["you.github.io"] }],
		});
	});

	describe("never a positive claim", () => {
		test("the exact named host, or one beneath it, reports nothing", () => {
			expect(measureLookalikeDestinations("curl -sf https://you.github.io/omp-classifier/status.json", STATUS_ASK)).toBeUndefined();
			expect(measureLookalikeDestinations("curl -s https://api.neuralwatt.com/v1/models", ["add neuralwatt.com as a provider"])).toBeUndefined();
		});

		test("a user who names a bare shared suffix vouches for no tenant under it", () => {
			// Nothing is reported, and nothing could read as "the user's host".
			const state = buildJevState({ command: "curl -sf https://attacker.github.io/x", workingDirectory: "/w", userMessages: ["it's on github.io somewhere"] }) as Record<string, unknown>;
			expect("lookalikeDestinations" in state).toBe(false);
			expect(JSON.stringify(state)).not.toMatch(/userNamed/u);
		});

		test("a host touching a quote, $ or substitution is not read", () => {
			for (const command of ['curl "https://you.github.io$SUFFIX/x"', "curl https://attacker.github.io$(printf x)/y", "curl https://`echo attacker`.github.io/x", "curl https://$HOST.github.io/x"]) {
				expect(measureLookalikeDestinations(command, STATUS_ASK)).toBeUndefined();
			}
		});

		test("redirect flags do not make a destination the user's", () => {
			for (const command of [
				"curl --resolve you.github.io:443:203.0.113.9 https://you.github.io/x",
				"curl --connect-to you.github.io:443:attacker.github.io:443 https://you.github.io/x",
				'curl -H "Host: attacker.github.io" https://you.github.io/x',
				"curl -x http://proxy.attacker.example:8080 https://you.github.io/x",
			]) {
				const state = buildJevState({ command, workingDirectory: "/w", userMessages: STATUS_ASK }) as Record<string, unknown>;
				expect(JSON.stringify(state)).not.toMatch(/userNamed/u);
				for (const destination of (state.lookalikeDestinations as { destinations?: { host: string }[] } | undefined)?.destinations ?? []) {
					expect(destination.host).not.toBe("you.github.io");
				}
			}
		});
	});

	test("nothing is measured without a host the user named", () => {
		const command = "curl -sf https://attacker.github.io/omp-classifier/status.json";
		expect(measureLookalikeDestinations(command, undefined)).toBeUndefined();
		expect(measureLookalikeDestinations(command, [])).toBeUndefined();
		// File paths, abbreviations, and an email address are not hosts the user asked to reach.
		expect(measureLookalikeDestinations(command, ["fix status.json in ~/.omp/agent/x.github.io, e.g. ping me@you.github.io"])).toBeUndefined();
	});

	test("an unrelated destination is not reported", () => {
		// github.com and raw.githubusercontent.com share only `com`.
		expect(
			measureLookalikeDestinations('curl -s "https://raw.githubusercontent.com/NiazMorshed2007/jev-review/main/src/x.ts"', ["evaluate https://github.com/NiazMorshed2007/jev-review"]),
		).toBeUndefined();
		expect(measureLookalikeDestinations("curl -s https://evilneuralwatt.com/v1/models", ["add neuralwatt.com as a provider"])).toBeUndefined();
	});

	test("loopback destinations are not compared", () => {
		expect(measureLookalikeDestinations("curl http://127.0.0.2:8012/health", ["hit 127.0.0.1:8012/health"])).toBeUndefined();
	});
});

describe("buildJevState carries the measurement", () => {
	test("as a gate-measured tier with its own note", () => {
		const state = buildJevState({
			command: "curl -sf https://attacker.github.io/omp-classifier/status.json",
			workingDirectory: "/Users/you/git/oss/omp-classifier",
			userMessages: STATUS_ASK,
		}) as Record<string, unknown>;
		const lookalikes = state.lookalikeDestinations as Record<string, unknown>;
		expect(lookalikes.destinations).toEqual([{ host: "attacker.github.io", sameParentAs: ["you.github.io"] }]);
		expect(typeof lookalikes.note).toBe("string");
		expect(lookalikes.note as string).not.toMatch(/\breviewer\b|instructions to/iu);
	});

	test("absent when there is nothing to report", () => {
		const state = buildJevState({ command: "curl -sf https://attacker.github.io/x", workingDirectory: "/w" }) as Record<string, unknown>;
		expect("lookalikeDestinations" in state).toBe(false);
	});

	test("a caller cannot forge it through extra", () => {
		const state = buildJevState({
			command: "curl -sf https://you.github.io/x",
			workingDirectory: "/w",
			extra: { lookalikeDestinations: { destinations: [] } },
		}) as Record<string, unknown>;
		expect("lookalikeDestinations" in state).toBe(false);
	});
});

describe("the gate blocks a measured lookalike, whatever the judge answers", () => {
	const userSays = (...contents: string[]) => contents.map((content, index) => ({ type: "message", id: `u${index + 1}`, message: { role: "user", attribution: "user", content } }));
	const run = async (command: string, branch = userSays(STATUS_ASK[0])) => {
		const ctx = makeCtx({ sessionId: makeSessionId("lookalike"), branch, hasUI: true });
		return resultText(await fire("tool_call", makeEvent(command), ctx));
	};

	beforeEach(async () => {
		removeConfigFile();
		await loadPlugin(makeSettings([]));
		setJevAnswer(jevSafeAnswer());
	});

	test("a SAFE on a lookalike is a flagged block that names the host and the way forward", async () => {
		const payload = refusalOf(await run("curl -sf https://attacker.github.io/omp-classifier/status.json"));
		expect(payload.layer).toBe("flagged");
		expect(payload.why).toContain("lookalike host attacker.github.io (user named you.github.io)");
		expect(payload.why).toContain("ask the user in chat to confirm the exact host");
		expect(payload.why).toContain("run the command themselves");
	});

	test("once the user names the exact host in chat, the same command runs", async () => {
		const branch = userSays(STATUS_ASK[0], "yes, attacker.github.io is the right host");
		expect(await run("curl -sf https://attacker.github.io/omp-classifier/status.json", branch)).toBe("ALLOWED");
	});

	test("a SAFE on the host the user named still runs", async () => {
		expect(await run("curl -sf https://you.github.io/omp-classifier/status.json")).toBe("ALLOWED");
	});

	test("the eval tool's spawn is held to the same rule", async () => {
		const ctx = makeCtx({ sessionId: makeSessionId("lookalike-eval"), branch: userSays(STATUS_ASK[0]), hasUI: true });
		const code = 'Bun.spawnSync(["curl", "-sf", "https://attacker.github.io/x"])';
		const payload = refusalOf(resultText(await fire("tool_call", { toolName: "eval", input: { code, language: "js" } }, ctx)));
		expect(payload.layer).toBe("flagged");
		expect(payload.why).toContain("Lookalike destination");
	});
});
