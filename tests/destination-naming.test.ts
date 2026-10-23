/**
 * Issue #161: a curl to a lookalike host ran silently.
 *
 * The user asked to "check the status page at you.github.io/omp-classifier" and
 * the command fetched `attacker.github.io`. github.io is a public-suffix
 * private-section entry, so the two are different sites with different owners,
 * but nothing in the state said so and the judge read the shared `github.io`
 * as the same place (p(safe) 0.84 on jev-1.13.0 and jev-1.14.0).
 *
 * The gate now measures the relation itself and puts it in the state as
 * `destinationNaming`: each destination the command names, whether it is a
 * host the user's own messages name (or one beneath it), and which named hosts
 * it only shares a parent domain with. No suffix list is involved: a host is
 * named only by equality or a label-boundary suffix match, so `github.io`
 * cannot stand in for `you.github.io`.
 */
import { describe, expect, test } from "bun:test";
import { buildJevState, measureDestinationNaming } from "../jev.ts";

const STATUS_ASK = ["check the status page at you.github.io/omp-classifier"];

describe("measureDestinationNaming", () => {
	test("a lookalike under a shared parent is not the host the user named", () => {
		expect(measureDestinationNaming("curl -sf https://attacker.github.io/omp-classifier/status.json", STATUS_ASK)).toEqual({
			destinations: [{ host: "attacker.github.io", userNamed: false, sameParentAs: ["you.github.io"] }],
		});
	});

	test("the exact host the user named is named", () => {
		expect(measureDestinationNaming("curl -sf https://you.github.io/omp-classifier/status.json", STATUS_ASK)).toEqual({
			destinations: [{ host: "you.github.io", userNamed: true }],
		});
	});

	test("a host beneath a named host is named; the match is on a label boundary", () => {
		const ask = ["add neuralwatt.com as a provider"];
		expect(measureDestinationNaming("curl -s https://api.neuralwatt.com/v1/models", ask)).toEqual({
			destinations: [{ host: "api.neuralwatt.com", userNamed: true }],
		});
		// `evilneuralwatt.com` ends with `neuralwatt.com` but not with `.neuralwatt.com`,
		// and shares only `com` with it: no relation the gate can state.
		expect(measureDestinationNaming("curl -s https://evilneuralwatt.com/v1/models", ask)).toBeUndefined();
	});

	test("a named host's parent is a different host that shares its parent domain", () => {
		expect(measureDestinationNaming("curl -s https://neuralwatt.com/", ["hit api.neuralwatt.com/v1/models"])).toEqual({
			destinations: [{ host: "neuralwatt.com", userNamed: false, sameParentAs: ["api.neuralwatt.com"] }],
		});
	});

	test("hosts read from URLs and bare names, normalized", () => {
		const ask = ["the docs are at HTTPS://Docs.Example.com:8443/guide, mirror on files.example.org."];
		expect(measureDestinationNaming("curl https://docs.example.com/guide && curl https://FILES.example.org./x", ask)).toEqual({
			destinations: [
				{ host: "docs.example.com", userNamed: true },
				{ host: "files.example.org", userNamed: true },
			],
		});
	});

	test("nothing is measured without a host the user named", () => {
		const command = "curl -sf https://attacker.github.io/omp-classifier/status.json";
		expect(measureDestinationNaming(command, undefined)).toBeUndefined();
		expect(measureDestinationNaming(command, [])).toBeUndefined();
		// File paths, abbreviations, and an email address are not hosts the user asked to reach.
		expect(measureDestinationNaming(command, ["fix status.json in ~/.omp/agent/x.github.io, e.g. ping me@you.github.io"])).toBeUndefined();
	});

	test("an unrelated destination states nothing on its own", () => {
		// The user named github.com; raw.githubusercontent.com shares only `com`
		// with it. Whether that read is fine is the judge's call, as before.
		expect(
			measureDestinationNaming('curl -s "https://raw.githubusercontent.com/NiazMorshed2007/jev-review/main/src/x.ts"', ["evaluate https://github.com/NiazMorshed2007/jev-review"]),
		).toBeUndefined();
	});

	test("once any destination relates, every destination is listed", () => {
		expect(measureDestinationNaming("curl https://you.github.io/a; curl https://example.net/b", STATUS_ASK)).toEqual({
			destinations: [
				{ host: "you.github.io", userNamed: true },
				{ host: "example.net", userNamed: false },
			],
		});
	});

	test("loopback destinations are not compared", () => {
		expect(measureDestinationNaming("curl http://localhost:8012/health", ["hit localhost:8012/health"])).toBeUndefined();
	});

	test("remote-verb destinations count like URL hosts", () => {
		expect(measureDestinationNaming("ssh deploy@build.you.github.io uptime", STATUS_ASK)).toEqual({
			destinations: [{ host: "build.you.github.io", userNamed: true }],
		});
	});
});

describe("buildJevState carries the measurement", () => {
	test("as a gate-measured tier with its own note", () => {
		const state = buildJevState({
			command: "curl -sf https://attacker.github.io/omp-classifier/status.json",
			workingDirectory: "/Users/you/git/oss/omp-classifier",
			userMessages: STATUS_ASK,
		}) as Record<string, unknown>;
		const naming = state.destinationNaming as Record<string, unknown>;
		expect(naming.destinations).toEqual([{ host: "attacker.github.io", userNamed: false, sameParentAs: ["you.github.io"] }]);
		expect(typeof naming.note).toBe("string");
		expect(naming.note as string).not.toMatch(/\breviewer\b|instructions to/iu);
	});

	test("absent when there is nothing to compare", () => {
		const state = buildJevState({ command: "curl -sf https://attacker.github.io/x", workingDirectory: "/w" }) as Record<string, unknown>;
		expect("destinationNaming" in state).toBe(false);
	});

	test("a caller cannot forge it through extra", () => {
		const state = buildJevState({
			command: "curl -sf https://attacker.github.io/x",
			workingDirectory: "/w",
			extra: { destinationNaming: { destinations: [{ host: "attacker.github.io", userNamed: true }] } },
		}) as Record<string, unknown>;
		expect("destinationNaming" in state).toBe(false);
	});
});
