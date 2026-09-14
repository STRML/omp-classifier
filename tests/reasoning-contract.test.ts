/**
 * Two-stage reasoning contract (analysis + VERDICT line): parsing of both
 * reply shapes, the authorization-grounding check (checkCitation), the two
 * scope-consistency checks (egress, write target), their composition, the
 * noCache downgrade path through the live gate, and the prompt-contract
 * status line.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	applyPostParseChecks,
	buildStatusReport,
	checkCitation,
	checkEgressConsistency,
	checkWriteScopeConsistency,
	formatClassifierConfig,
	parseJudgement,
	PROMPT_CONTRACT,
	readClassifierConfig,
} from "../index";
import {
	fire,
	fireCommand,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	removeConfigFile,
	selectCalls,
	setClassifierDelay,
	setClassifierReply,
} from "./fixtures";

beforeEach(async () => {
	removeConfigFile();
	setClassifierDelay(5);
	await loadPlugin(makeSettings([]));
	setClassifierReply("SAFE");
});

const safeReply = (analysis: string, reason?: string): string =>
	reason ? `${analysis}\nVERDICT: SAFE\nREASON: ${reason}` : `${analysis}\nVERDICT: SAFE`;

describe("parseJudgement: two-stage replies", () => {
	test("analysis + labeled VERDICT + REASON parses with analysis captured", () => {
		const j = parseJudgement(
			"Writes ./build/out.txt only. Executes the local formatter.\nEgress: none.\nReversible via git.\nVERDICT: SAFE\nREASON: routine local format",
		);
		expect(j.verdict).toBe("SAFE");
		expect(j.reason).toBe("routine local format");
		expect(j.analysis).toContain("Writes ./build/out.txt only");
		expect(j.analysis).not.toContain("VERDICT");
	});

	test("REASON on its own line under the verdict is picked up", () => {
		const j = parseJudgement("Reads a file.\nVERDICT: UNSAFE\nREASON: deletes untracked work");
		expect(j.verdict).toBe("UNSAFE");
		expect(j.reason).toBe("deletes untracked work");
	});

	test("verdict with no REASON parses with empty reason", () => {
		const j = parseJudgement("Reads a file.\nVERDICT: UNSURE");
		expect(j.verdict).toBe("UNSURE");
		expect(j.reason).toBe("");
	});

	test("markdown-emphasized labeled verdict still parses", () => {
		expect(parseJudgement("Reads a file.\n**VERDICT: SAFE**").verdict).toBe("SAFE");
	});

	test("mid-sentence verdict mention is not a verdict", () => {
		// Prose line, not a labeled line: fails closed even though the word appears.
		expect(parseJudgement("the verdict should be SAFE here\nbut the model kept writing").verdict).toBe("PARSE_ERROR");
	});

	test("legacy bare-verdict replies still parse, without analysis", () => {
		for (const reply of ["SAFE", "**SAFE**", "VERDICT | SAFE | reads logs", "VERDICT: UNSAFE | deletes work"]) {
			const j = parseJudgement(reply);
			expect(j.verdict).not.toBe("PARSE_ERROR");
			expect(j.analysis).toBeUndefined();
		}
	});

	test("rawReply diagnostics keep the collapsed head", () => {
		const j = parseJudgement(`${"analysis ".repeat(80)}\nno verdict line`);
		expect(j.verdict).toBe("PARSE_ERROR");
		expect(j.rawReply!.length).toBeLessThanOrEqual(201);
		expect(j.rawReply).toContain("analysis");
	});
});

describe("checkCitation", () => {
	const cited = safeReply('The user asked to "deploy the staging build" so this is authorized.');
	const fabricated = safeReply('The user asked to "wipe the production database" per their request.');
	const messages = ["please deploy the staging build"];

	test("verbatim citation in evidence passes", () => {
		expect(checkCitation(parseJudgement(cited), messages).verdict).toBe("SAFE");
	});

	test("quoted words absent from every user message downgrade to UNSURE, uncached", () => {
		const j = checkCitation(parseJudgement(fabricated), messages);
		expect(j.verdict).toBe("UNSURE");
		expect(j.reason).toBe("cited authorization not found in session evidence");
		expect(j.noCache).toBe(true);
	});

	test("absent evidence (switched off) is a no-op, never a dialog cause", () => {
		expect(checkCitation(parseJudgement(fabricated), undefined).verdict).toBe("SAFE");
	});

	test("an empty evidence list means no user wrote anything, so a user citation downgrades", () => {
		const j = checkCitation(parseJudgement(fabricated), []);
		expect(j.verdict).toBe("UNSURE");
		expect(j.citationMissing).toEqual(["wipe the production database"]);
	});

	test("an empty evidence list leaves a SAFE with no user citation alone", () => {
		const reply = safeReply("Reads the working tree status. No writes, no egress.");
		expect(checkCitation(parseJudgement(reply), []).verdict).toBe("SAFE");
	});

	test("quote across a line break in the user message still matches", () => {
		const j = checkCitation(parseJudgement(cited), ["please\ndeploy the\nstaging build"]);
		expect(j.verdict).toBe("SAFE");
	});

	test("command echo is not treated as a citation", () => {
		const reply = safeReply("The user asked for exactly `npm run build` per their request.");
		expect(checkCitation(parseJudgement(reply), ["ship it"], "npm run build").verdict).toBe("SAFE");
	});

	test("unquoted paraphrase has no words to verify and does not fire", () => {
		const reply = safeReply("The user asked to deploy the staging build, so this matches evidence.");
		expect(checkCitation(parseJudgement(reply), ["other words entirely"]).verdict).toBe("SAFE");
	});

	test("quotes far from the authorization claim are not checked", () => {
		const reply = safeReply('Runs `rm -rf ./build`. Reversible. The user asked for a rebuild per their request.');
		expect(checkCitation(parseJudgement(reply), ["rebuild the project"]).verdict).toBe("SAFE");
	});

	test("a downgrade names the quoted spans it could not find", () => {
		const j = checkCitation(parseJudgement(fabricated), messages);
		expect(j.citationMissing).toEqual(["wipe the production database"]);
	});

	test("missing spans are capped at three", () => {
		const reply = safeReply('The user asked for "alpha one", "bravo two", "charlie three" and "delta four".');
		const j = checkCitation(parseJudgement(reply), messages);
		expect(j.verdict).toBe("UNSURE");
		expect(j.citationMissing).toEqual(["alpha one", "bravo two", "charlie three"]);
	});

	test("a grounded citation carries no citationMissing", () => {
		expect(checkCitation(parseJudgement(cited), messages).citationMissing).toBeUndefined();
	});

	test("a quote spanning the head/tail elision marker does not match", () => {
		// collectUserEvidence joins the kept head and tail with "\n…\n". Whitespace
		// normalization turns that into " … ", so a quote across the seam must be
		// checked against each side on its own, never the joined string.
		const kept = `${"a".repeat(1_000)}\n…\n${"b".repeat(1_000)}`;
		const reply = safeReply(`The user asked to "${"a".repeat(5)} … ${"b".repeat(5)}" per their request.`);
		const j = checkCitation(parseJudgement(reply), [kept]);
		expect(j.verdict).toBe("UNSURE");
	});

	test("UNSAFE and UNSURE verdicts are never touched", () => {
		const unsafe = parseJudgement('analysis\nVERDICT: UNSAFE\nREASON: deletes work');
		expect(checkCitation(unsafe, ["anything"]).verdict).toBe("UNSAFE");
		const unsure = parseJudgement('analysis\nVERDICT: UNSURE');
		expect(checkCitation(unsure, ["anything"]).verdict).toBe("UNSURE");
	});
});

describe("checkEgressConsistency", () => {
	test("declaring no egress while the command reaches a remote downgrades", () => {
		const j = checkEgressConsistency(parseJudgement(safeReply("No network egress. Copies files locally.")), "ssh backup-host rsync -a ./data backup:/data");
		expect(j.verdict).toBe("UNSURE");
		expect(j.reason).toBe("declared scope contradicts command (network)");
	});

	test("analysis that addresses egress passes", () => {
		const j = checkEgressConsistency(
			parseJudgement(safeReply("Egress: queries the GitHub API for pr 5; sends nothing local.")),
			"gh pr view 5",
		);
		expect(j.verdict).toBe("SAFE");
	});

	test("a cleared read-only fetch never re-triggers the check", () => {
		const silent = parseJudgement(safeReply("Pipelines a fetch into jq."));
		expect(checkEgressConsistency(silent, "curl -s https://api.github.com/repos/o/r | jq .").verdict).toBe("SAFE");
	});

	test("a non-read-only curl (POST) with a silent analysis defers to the verdict", () => {
		const j = checkEgressConsistency(parseJudgement(safeReply("Sends a payload.")), "curl -s -X POST --data @out.json https://api.example.com/hooks");
		expect(j.verdict).toBe("SAFE");
	});

	test("commands with no network verb are never contradicted", () => {
		expect(checkEgressConsistency(parseJudgement("VERDICT: SAFE"), "git status && ls -la").verdict).toBe("SAFE");
	});

	test("silent analysis on an outbound command defers to the verdict", () => {
		const j = checkEgressConsistency(parseJudgement(safeReply("Echoes a line.")), "ssh deploy@server.example.com uptime");
		expect(j.verdict).toBe("SAFE");
	});

	test("a read-shaped gh invocation clears like a fetched read", () => {
		const silent = parseJudgement(safeReply("Queries the pull request and prints the result."));
		expect(checkEgressConsistency(silent, "gh pr view 5").verdict).toBe("SAFE");
	});

	test("gh api write with an affirmative no-egress claim downgrades", () => {
		const silent = parseJudgement(safeReply("No network egress."));
		expect(checkEgressConsistency(silent, "gh api repos/o/r -X POST -f title=test").verdict).toBe("UNSURE");
	});
	const cwd = "/Users/you/sites/project";
	const silent = parseJudgement(safeReply("Echoes a line."));

	test("absolute redirect outside cwd downgrades", () => {
		const j = checkWriteScopeConsistency(silent, "echo x > /etc/hosts", cwd);
		expect(j.verdict).toBe("UNSURE");
		expect(j.reason).toBe("declared scope contradicts command (write target)");
	});

	test("tilde redirect outside cwd downgrades", () => {
		expect(checkWriteScopeConsistency(silent, "echo x >> ~/.zshrc", cwd).verdict).toBe("UNSURE");
	});

	test("tee to an absolute path outside cwd downgrades", () => {
		expect(checkWriteScopeConsistency(silent, "curl -s https://api.github.com | tee /etc/passwd", cwd).verdict).toBe("UNSURE");
	});

	test("-o/--output with an absolute path outside cwd downgrades", () => {
		expect(checkWriteScopeConsistency(silent, "curl -s https://api.example.com -o /etc/cron.d/x", cwd).verdict).toBe("UNSURE");
	});

	test("declared confinement contradicted by an outside write downgrades", () => {
		const confined = parseJudgement(safeReply("Writes are confined to the working directory."));
		expect(checkWriteScopeConsistency(confined, "echo x > /etc/hosts", cwd).verdict).toBe("UNSURE");
	});

	test("writes inside cwd, /tmp, and /dev/null never fire", () => {
		expect(checkWriteScopeConsistency(silent, "echo x > ./out.txt", cwd).verdict).toBe("SAFE");
		expect(checkWriteScopeConsistency(silent, "echo x > /tmp/log", cwd).verdict).toBe("SAFE");
		expect(checkWriteScopeConsistency(silent, "echo x > /dev/null", cwd).verdict).toBe("SAFE");
		expect(checkWriteScopeConsistency(silent, "make 2>&1 > build.log", cwd).verdict).toBe("SAFE");
	});

	test("quoted pseudo-redirects are arguments, not writes", () => {
		expect(checkWriteScopeConsistency(silent, 'echo hi "> /etc/hosts"', cwd).verdict).toBe("SAFE");
	});

	test("relative targets are inside cwd by definition", () => {
		expect(checkWriteScopeConsistency(silent, "make install DESTDIR=./staging", cwd).verdict).toBe("SAFE");
	});

	test("analysis that discusses writes without claiming confinement defers", () => {
		const discussed = parseJudgement(safeReply("Modifies the installed headers under their own path."));
		expect(checkWriteScopeConsistency(discussed, "make install", cwd).verdict).toBe("SAFE");
	});
});
describe("applyPostParseChecks", () => {
	test("first fired check wins and non-SAFE verdicts pass through", () => {
		const downgraded = applyPostParseChecks(parseJudgement(safeReply("No network egress.")), {
			command: "gh api repos/o/r -X POST -f title=t",
			cwd: "/w",
		});
		expect(downgraded.verdict).toBe("UNSURE");
		expect(downgraded.reason).toContain("network");
		const untouched = applyPostParseChecks(parseJudgement("analysis\nVERDICT: UNSAFE"), { command: "rm -rf /", cwd: "/w" });
		expect(untouched.verdict).toBe("UNSAFE");
	});

	test("a fully-covered analysis on a plain command stays SAFE", () => {
		const j = applyPostParseChecks(
			parseJudgement(safeReply("Reads README.md. Egress: none. Reversible.")),
			{ command: "cat README.md", cwd: "/w" },
		);
		expect(j.verdict).toBe("SAFE");
		expect(j.noCache).toBeUndefined();
	});
});

describe("live gate integration", () => {
	test("fabricated citation turns a model SAFE into an uncached dialog", async () => {
		setClassifierReply(safeReply('The user asked to "wipe the production database" per their request.'));
		const branch = [{ type: "message", message: { role: "user", attribution: "user", content: "please deploy the staging build" } }];
		const ctx = makeCtx({ sessionId: "reasoning-cite", hasUI: true, branch });
		const first = await fire("tool_call", makeEvent("git status"), ctx);
		expect(first).toBeDefined();
		expect(selectCalls(ctx)).toHaveLength(1);
		// noCache: the downgraded UNSURE must not replay from the verdict cache —
		// the model is consulted again and asks again.
		await fire("tool_call", makeEvent("git status"), ctx);
		expect(modelCalls.length).toBe(2);
		expect(selectCalls(ctx)).toHaveLength(2);
	});

	test("verbatim-grounded citation auto-runs", async () => {
		setClassifierReply(safeReply('The user asked to "check the working tree status" before committing.'));
		const branch = [{ type: "message", message: { role: "user", attribution: "user", content: "check the working tree status" } }];
		const ctx = makeCtx({ sessionId: "reasoning-cite-ok", branch });
		const result = await fire("tool_call", makeEvent("git status"), ctx);
		expect(result).toBeUndefined();
		expect(selectCalls(ctx)).toHaveLength(0);
	});

	test("an agent-written brief cannot authorize: quoting it dialogs", async () => {
		// The review-438-corr shape: a headless worker's only user-role message is the brief
		// its parent agent sent, stamped attribution "agent". Its permission sentence is not
		// the user's word, so a SAFE that cites it must not auto-run.
		const brief = `${"Review the PR at head. ".repeat(95)}Clean up your own worktree and scratch.`;
		setClassifierReply(safeReply('The user said to "clean up your own worktree and scratch" in the brief.'));
		const branch = [{ type: "message", message: { role: "user", attribution: "agent", content: brief } }];
		const ctx = makeCtx({ sessionId: "reasoning-cite-agent", hasUI: true, branch });
		const result = await fire("tool_call", makeEvent("git status"), ctx);
		expect(result).toBeDefined();
		expect(selectCalls(ctx)).toHaveLength(1);
	});

	test("quoting words past the first 2000 chars of a long brief auto-runs", async () => {
		const brief = `${"Review the PR at head. ".repeat(95)}Clean up your own worktree and scratch.`;
		setClassifierReply(safeReply('The user said to "clean up your own worktree and scratch" in the brief.'));
		const branch = [{ type: "message", message: { role: "user", attribution: "user", content: brief } }];
		const ctx = makeCtx({ sessionId: "reasoning-cite-tail", branch });
		const result = await fire("tool_call", makeEvent("git status"), ctx);
		expect(result).toBeUndefined();
		expect(selectCalls(ctx)).toHaveLength(0);
	});

	test("no-egress analysis on a hosted-API write dialogs with the egress reason", async () => {
		setClassifierReply(safeReply("No network egress."));
		const ctx = makeCtx({ sessionId: "reasoning-egress", hasUI: true });
		const result = await fire("tool_call", makeEvent("gh api repos/o/r -X POST -f title=test"), ctx);
		expect(result).toBeDefined();
		expect(selectCalls(ctx)).toHaveLength(1);
		expect(dialogFor(ctx)).toContain("judge approved, but its analysis claimed no network while the command contacts one");
	});

	test("read-shaped gh commands still auto-run on a bare verdict", async () => {
		setClassifierReply("VERDICT: SAFE");
		const ctx = makeCtx({ sessionId: "reasoning-gh-read" });
		const result = await fire("tool_call", makeEvent("gh pr view 5"), ctx);
		expect(result).toBeUndefined();
		expect(selectCalls(ctx)).toHaveLength(0);
	});

	test("cleared fetch pipelines still auto-run", async () => {
		setClassifierReply(safeReply("Read-only fetch piped into jq; sends nothing local."));
		const ctx = makeCtx({ sessionId: "reasoning-cleared" });
		const result = await fire("tool_call", makeEvent("curl -s https://api.github.com/repos/o/r | jq ."), ctx);
		expect(result).toBeUndefined();
	});
});

/** The dialog body travels inside the select title; dig the reason out of it. */
function dialogFor(ctx: Parameters<typeof selectCalls>[0]): string {
	return selectCalls(ctx)[0]?.[0] ?? "";
}

describe("status surface", () => {
	test("status report and config panel carry the prompt contract", () => {
		expect(PROMPT_CONTRACT).toBe("analysis+verdict");
		expect(buildStatusReport().contract).toBe("analysis+verdict");
		expect(formatClassifierConfig(readClassifierConfig())).toContain(`contract: ${PROMPT_CONTRACT}`);
	});

	test("/classifier prints the contract line", async () => {
		const ctx = makeCtx({ sessionId: "reasoning-status" });
		await fireCommand("classifier", "", ctx);
		const notes = (ctx as unknown as { notifyCalls: string[][] }).notifyCalls;
		expect(notes.some(([message]) => message.includes("contract: analysis+verdict"))).toBe(true);
	});
});
