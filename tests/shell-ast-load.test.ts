/**
 * The lazy parser load (issue #99).
 *
 * `shell-ast.ts` resolves `mvdan-sh` on first use, not at import, so a parser
 * missing at runtime fails the parse — `{ ok: false }` from `parseShell` —
 * rather than the plugin's module load. These tests stub the load through
 * `setShellParserLoader`, the module's only seam for it, and put the real
 * loader back afterward, so the rest of the suite sees the genuine parser.
 *
 * The final test re-reads a real command after the restore, so a lazy load
 * that swapped in and never parsed again would fail here rather than in
 * every other suite.
 */
import { describe, expect, test } from "bun:test";
import { parseShell, setShellParserLoader } from "../shell-ast";

describe("when the parser module cannot be resolved", () => {
	// Swapped before any parse: the module must have loaded without touching
	// the loader, and only the first parse pays for the failed load. The
	// real loader comes back below, in the same swap that returns it.
	const realLoader = setShellParserLoader(() => {
		throw new Error("stub: parser module missing");
	});

	test("the module itself loaded", () => {
		// Reaching this line at all is the assertion: before #99 the import of
		// a missing parser threw while the module loaded.
		expect(typeof parseShell).toBe("function");
	});

	test("parseShell reports the failure instead of throwing", () => {
		const parsed = parseShell("rm -rf build");
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.reason).toContain("stub: parser module missing");
	});

	test("every call reports the failure, not just the first", () => {
		for (const text of ["echo hi", "a && b", "true"]) {
			const parsed = parseShell(text);
			expect(parsed.ok).toBe(false);
		}
	});

	// Back to the real loader; `setShellParserLoader` drops the failed
	// runtime, so the next parse re-derives it from the live module.
	test("restoring the loader resumes parsing", () => {
		setShellParserLoader(realLoader);
		const parsed = parseShell("echo hello");
		expect(parsed.ok).toBe(true);
	});
});
