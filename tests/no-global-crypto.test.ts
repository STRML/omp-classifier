/**
 * The global `crypto.randomUUID()` is not safe to call per tool call. On Linux
 * (a bun 1.3.14 container, and GitHub's runners) one extra call per tool call
 * to it made every judgment in a long `bun test` run wait for seconds: a
 * 5 ms fixture timer fired after 6 s, and `refusal memory > store caps at 20`
 * went from 0.2 s to past its 5 s limit, taking the tests after it down with
 * it. The same call through `node:crypto` costs nothing. A timing bug like that
 * cannot be asserted from a test body, so this pins the cause instead: no
 * module of the plugin calls the global.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCES = ["index.ts", "jev.ts", "jev-judge.ts", "authorization.ts", "floor.ts", "trust-policy.ts"];

describe("the plugin's ids come from node:crypto", () => {
	for (const file of SOURCES) {
		test(`${file} never calls the global crypto.randomUUID`, () => {
			const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
			const hits = text
				.split("\n")
				.map((line, index) => ({ line, number: index + 1 }))
				.filter(({ line }) => /(?<![\w.])crypto\.randomUUID\s*\(/u.test(line));
			expect(hits.map(({ number, line }) => `${file}:${number}: ${line.trim()}`)).toEqual([]);
		});
	}
});
