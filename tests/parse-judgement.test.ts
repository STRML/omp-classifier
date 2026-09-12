import { describe, expect, test } from "bun:test";
import { parseJudgement } from "../index.ts";

describe("parseJudgement", () => {
	test("bare verdict with reason", () => {
		const j = parseJudgement("SAFE — routine read of local files");
		expect(j.verdict).toBe("SAFE");
		expect(j.reason).toContain("routine read");
	});

	test("markdown-emphasized verdict still parses", () => {
		expect(parseJudgement("**SAFE**").verdict).toBe("SAFE");
	});

	test("VERDICT-prefixed replies parse (the PARSE_ERROR class)", () => {
		expect(parseJudgement("VERDICT | SAFE | Reads local logs, no exfiltration").verdict).toBe("SAFE");
		expect(parseJudgement("VERDICT: UNSAFE | deletes untracked work").verdict).toBe("UNSAFE");
		expect(parseJudgement("VERDICT- UNSURE").verdict).toBe("UNSURE");
	});

	test("verdict must stay anchored at reply start", () => {
		// Prose before the token is not a verdict format echo; it fails closed.
		expect(parseJudgement("The verdict is SAFE but actually UNSAFE").verdict).toBe("PARSE_ERROR");
		expect(parseJudgement("I think SAFE here").verdict).toBe("PARSE_ERROR");
		// VERDICT must be the exact label, not any word.
		expect(parseJudgement("The VERDICT | SAFE").verdict).toBe("PARSE_ERROR");
	});

	test("terminal inline verdict parses (measured glm-5.3-flash shape)", () => {
		// Real production reply, 2026-09-11 logs: stage two lands as the final
		// sentences of one paragraph, with no line break before the label.
		const j = parseJudgement(
			"Read-only git diff piped to cat; writes nothing, executes nothing, no network. " +
				"VERDICT: SAFE REASON: Read-only git diff printing local changes, fully reversible.",
		);
		expect(j.verdict).toBe("SAFE");
		expect(j.reason).toContain("Read-only git diff");
		expect(j.analysis).toContain("piped to cat");
	});

	test("inline verdict with REASON on the next line parses", () => {
		const j = parseJudgement("Analysis: the command only reads. VERDICT: SAFE\nREASON: read-only grep");
		expect(j.verdict).toBe("SAFE");
		expect(j.reason).toBe("read-only grep");
	});

	test("inline terminal UNSAFE with em-dash reason parses", () => {
		expect(parseJudgement("The command force pushes. VERDICT: UNSAFE — deletes untracked work").verdict).toBe("UNSAFE");
	});

	test("mid-analysis mention with reply text after it still fails", () => {
		expect(parseJudgement("Looks fine. I would say VERDICT: SAFE here.\nMore analysis follows.").verdict).toBe("PARSE_ERROR");
		expect(parseJudgement("The VERDICT | SAFE is the format").verdict).toBe("PARSE_ERROR");
	});

	test("a colon-prefixed format echo is prose, not a verdict", () => {
		// Codex round 2: "Output format:" reads like a label header, but the
		// model that writes it has declined to decide. Colon stays out of the
		// boundary class; only sentence punctuation/newline admits the token.
		expect(parseJudgement("Unable to decide. Output format: VERDICT: SAFE").verdict).toBe("PARSE_ERROR");
	});
	test("the prompt's format spec echoed back is not a verdict", () => {
		// Codex round 3: "VERDICT: SAFE|UNSAFE|UNSURE" is the format spec, the
		// separator class eats the pipe, and the first alternative must not
		// stand in for a decision — terminal or own line.
		expect(parseJudgement("I cannot decide. VERDICT: SAFE|UNSAFE|UNSURE").verdict).toBe("PARSE_ERROR");
		expect(parseJudgement("I cannot decide.\nVERDICT: SAFE|UNSAFE|UNSURE").verdict).toBe("PARSE_ERROR");
	});
	test("the legacy one-line path rejects the format spec echo", () => {
		// Codex round 4: the reply-START path ran before the template check.
		expect(parseJudgement("VERDICT: SAFE|UNSAFE|UNSURE").verdict).toBe("PARSE_ERROR");
	});
	test("lowercase prose near the verdict is not a template echo", () => {
		// The echo count is case-sensitive: contract tokens are uppercase.
		const j = parseJudgement("Reads one log file. VERDICT: SAFE — avoids unsafe effects");
		expect(j.verdict).toBe("SAFE");
	});
	test("PARSE_ERROR reports verdict tokens from beyond the rawReply window", () => {
		// rawReply is capped at 200 chars; hasVerdictToken is decided on the
		// full reply so refusal memory cannot misread a late label as absent.
		const analysis = "The command writes several long paths and deletes a checkpoint directory. ".repeat(6);
		const j = parseJudgement(`${analysis} VERDICT: SAFE|UNSAFE|UNSURE`);
		expect(j.verdict).toBe("PARSE_ERROR");
		expect(j.hasVerdictToken).toBe(true);
		expect(j.rawReply!.includes("VERDICT")).toBe(false);
	});

	test("reason is carried from the first line only", () => {
		const j = parseJudgement("UNSAFE | force push\nextra ignored detail");
		expect(j.verdict).toBe("UNSAFE");
		expect(j.reason).not.toContain("extra");
	});
});
