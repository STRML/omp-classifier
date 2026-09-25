/**
 * Refusal memory across rewording (issue #30): a command this session refused
 * — an UNSAFE verdict, a human denial, a critical pattern, a cap — is
 * remembered by normalizeGrantTarget, the identity a session grant uses
 * (issue #64: refusal memory keyed by the first two words made `ssh <host>`
 * one session-length trip wire), injected into the next state as
 * priorRefusal, and a SAFE that lands anyway on a refused target still prompts.
 * A user approval lifts the memory; the store holds 20 targets per session,
 * oldest dropped.
 *
 * The trigger moved with the port: a text judge's refusal-shaped prose no
 * longer exists, so memory keys off the VERDICT. UNSAFE is the only verdict
 * that both judged the content and said no — UNSURE is undecided, and
 * UNAVAILABLE judged nothing at all, so neither is evidence about the command.
 * A human denial of an undecided command is still a refusal, and the dialog
 * path records that itself.
 *
 * Unique sessions per test — the module-level refusal store outlives a test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { normalizeGrantTarget } from "../index";
import type { DecisionRecord } from "../index";
import {
	selectCalls,
	ALLOW_ONCE,
	DENY,
	fire,
	jevSafeAnswer,
	jevUnsureAnswer,
	jevUnsafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	refusalOf,
	setJevAnswer,
	setJevAnsweringApi,
	stateOf,
	removeConfigFile,
} from "./fixtures";

let dir = "";
let seq = 0;

const decisionsPath = (): string => path.join(dir, "decisions.jsonl");

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(decisionsPath(), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);

beforeEach(async () => {
	removeConfigFile();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refusal-"));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Fresh session id per test; the plugin's stores are module-level. */
const nextSession = (): string => `refusal-memory-${(seq += 1)}`;

/** The prior-refusal field of one captured request's state, if it carried one. */
const priorRefusalOf = (callIndex: number): { target: string; why: string; when: string } | undefined =>
	stateOf(callIndex).priorRefusal as { target: string; why: string; when: string } | undefined;

describe("refusal identity (issue #64): the key a session grant uses", () => {
	// The old key kept the first two non-flag words, so every `ssh raw-ovh …`
	// was ONE target — "ssh raw-ovh" — whatever ran behind it, and refusing one
	// remote cleanup turned every later read of that host into a dialog for the
	// rest of the session (152 logged blocks carried `prior refusal`). Refusals
	// now key on normalizeGrantTarget, the identity a grant is stored under, so
	// memory and authorization agree about what "this action" is.
	test("one host's operations are separate targets", () => {
		expect(normalizeGrantTarget("ssh raw-ovh 'mysql --version'")).toBe("ssh --version' raw-ovh");
		expect(normalizeGrantTarget("ssh raw-ovh 'wp db delete --all'")).toBe("ssh --all' raw-ovh");
		expect(normalizeGrantTarget("ssh raw-ovh 'mysql --version'")).not.toBe(
			normalizeGrantTarget("ssh raw-ovh 'wp db delete --all'"),
		);
		// A different host is a different target, and so is a read-only probe
		// of the same one.
		expect(normalizeGrantTarget("ssh raw-ovh 'ls /tmp'")).not.toBe(normalizeGrantTarget("ssh slurper 'ls /tmp'"));
		expect(normalizeGrantTarget("ssh raw-ovh 'ls /tmp'")).not.toBe(
			normalizeGrantTarget("ssh raw-ovh 'grep -o RUSH_INTAKE_KEY /var/www/html/wp-config.php'"),
		);
	});

	test("rewordings of one action still share a target; unlike actions differ", () => {
		expect(normalizeGrantTarget("RM   -RF\t./X")).toBe(normalizeGrantTarget("rm -rf x"));
		expect(normalizeGrantTarget("rm -rf ./x")).toBe(normalizeGrantTarget("rm -rf x"));
		expect(normalizeGrantTarget("cd /tmp && rm -rf x")).toBe(normalizeGrantTarget("rm -rf x"));
		// Dropping a flag is a different action here, as it is for a grant
		// (session-grants.test.ts pins the same distinction).
		expect(normalizeGrantTarget("rm -rf x")).not.toBe(normalizeGrantTarget("rm x"));
		expect(normalizeGrantTarget("rm -rf x")).not.toBe(normalizeGrantTarget("git reset --hard"));
	});

	test("the identity keeps the first argument: a push's remote is in, its branch is not", () => {
		// The one identity the grant path already uses keeps flags and the FIRST
		// non-flag argument, so `origin` scopes a push and the branch behind it
		// does not. That is the grant rule (a grant for `git push origin` is the
		// remote, deliberately), and it is the reason branch-level provenance is
		// issue #63's work, not refusal memory's. Without a remote, the branch
		// IS the first argument and separates two targets.
		expect(normalizeGrantTarget("git push --force origin main")).toBe("git push --force origin");
		expect(normalizeGrantTarget("git push --force origin main")).toBe(normalizeGrantTarget("git push --force origin feature"));
		expect(normalizeGrantTarget("git push --force main")).not.toBe(normalizeGrantTarget("git push --force feature"));
	});
});

describe("refusal memory", () => {
	test("reworded command carries priorRefusal into the state", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(1);
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf ./x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		const prior = priorRefusalOf(1);
		expect(prior?.target).toBe("rm -f -r x");
		// The stored why is the refusal's machine reason, not model prose: with
		// no text reply there is nothing else it could be.
		expect(prior?.why).toContain("unsafe 0.96");
		expect(new Date(prior?.when ?? "").getTime()).toBeGreaterThan(0);
		// The first, unrefused classification carries no such field.
		expect(priorRefusalOf(0)).toBeUndefined();
	});

	test("a one-hot UNSAFE asks but is not remembered as a refusal (jev-v2.1)", async () => {
		// The keyword bridge answers 0/1 with no distribution behind it. Its
		// UNSAFE still asks; it must not pin the target for the session.
		const sid = nextSession();
		setJevAnsweringApi("chat");
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid }));
		setJevAnsweringApi();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf ./x"), makeCtx({ sessionId: sid }));
		expect(modelCalls.length).toBe(2);
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("an UNSURE verdict is undecided, so it is not remembered as a refusal", async () => {
		// An undecided judgement is not evidence about the command. If it were
		// remembered, a single ambiguous verdict would pin every rewording of
		// that target to a dialog for the rest of the session.
		const sid = nextSession();
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		// The same target, respelled: had the UNSURE written a refusal, this
		// would meet it.
		await fire("tool_call", makeEvent("cd /workspace && git diff --stat"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("an UNAVAILABLE verdict judged nothing, so it is not remembered either", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsureAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid }));
		setJevAnswer(jevSafeAnswer());
		const ctx = makeCtx({ sessionId: sid });
		expect(await fire("tool_call", makeEvent("cd /workspace && git diff --stat"), ctx)).toBeUndefined();
		expect(priorRefusalOf(1)).toBeUndefined();
	});

	test("a SAFE that lands despite a prior refusal still prompts", async () => {
		const sid = nextSession();
		const ctx = makeCtx({ sessionId: sid, hasUI: true, selectResult: DENY });
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("echo bye"), ctx);
		// echo is not a moderate-risk token, so without the refusal memory a
		// SAFE here would auto-run; the dialog proves the refusal decided.
		setJevAnswer(jevSafeAnswer());
		const result = await fire("tool_call", makeEvent("echo bye again"), ctx);
		expect(selectCalls(ctx).length).toBe(2);
		const payload = JSON.parse((result as { block: true; reason: string }).reason) as { layer: string };
		expect(payload.layer).toBe("dialog");
		expect(readDecisions().some(line => line.why.startsWith("despite prior refusal"))).toBe(true);
	});

	test("machine refusals are scoped to the reviewed directory", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid, cwd: "/workspace" }));

		// The same target, in another directory: a different review.
		setJevAnswer(jevSafeAnswer());
		const elsewhere = makeCtx({ sessionId: sid, cwd: "/elsewhere" });
		const result = await fire("tool_call", makeEvent("cd /elsewhere && git diff --stat"), elsewhere);
		expect(result).toBeUndefined();
		expect(selectCalls(elsewhere)).toHaveLength(0);
		expect(modelCalls.length).toBe(2);
	});

	test("approval in one directory does not erase a refusal in another", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("git diff --stat"), makeCtx({ sessionId: sid, cwd: "/workspace" }));

		const elsewhereDenied = makeCtx({ sessionId: sid, cwd: "/elsewhere", hasUI: true, selectResult: DENY });
		await fire("tool_call", makeEvent("git diff --stat"), elsewhereDenied);
		setJevAnswer(jevSafeAnswer());
		const elsewhere = makeCtx({ sessionId: sid, cwd: "/elsewhere", hasUI: true, selectResult: ALLOW_ONCE });
		expect(await fire("tool_call", makeEvent("cd /elsewhere && git diff --stat"), elsewhere)).toBeUndefined();

		const original = makeCtx({ sessionId: sid, cwd: "/workspace", hasUI: true });
		const result = await fire("tool_call", makeEvent("cd /workspace && git diff --stat"), original);
		expect(refusalOf(result).layer).toBe("dialog");
	});

	test("user approval lifts the refusal for the target", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid, hasUI: true }));
		setJevAnswer(jevSafeAnswer());
		const approved = await fire(
			"tool_call",
			makeEvent("rm -rf ./x"),
			makeCtx({ sessionId: sid, hasUI: true, selectResult: ALLOW_ONCE }),
		);
		expect(approved).toBeUndefined();
		// A same-target rewording, not a different action: under the grant
		// identity `rm -r x` is its own target, so it could not show the lift.
		await fire("tool_call", makeEvent("rm -f -r ./x"), makeCtx({ sessionId: sid, hasUI: true, selectResult: ALLOW_ONCE }));
		expect(modelCalls.length).toBe(3);
		expect(priorRefusalOf(2)).toBeUndefined();
	});

	test("store caps at 20 per session and drops the oldest", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		for (let i = 1; i <= 21; i++) {
			await fire(
				"tool_call",
				makeEvent(`rm -rf f${String(i).padStart(2, "0")}`),
				makeCtx({ sessionId: sid }),
			);
		}
		setJevAnswer(jevUnsafeAnswer());
		// Oldest target (rm -f -r f01) was evicted: its rewording classifies bare.
		await fire("tool_call", makeEvent("rm -r -f f01"), makeCtx({ sessionId: sid }));
		expect(priorRefusalOf(21)).toBeUndefined();
		// Newest target (rm -f -r f21) is still remembered.
		await fire("tool_call", makeEvent("rm -r -f f21"), makeCtx({ sessionId: sid }));
		const prior = priorRefusalOf(22);
		expect(prior?.target).toBe("rm -f -r f21");
	});
});

describe("refusal identity at the gate (issue #64)", () => {
	/** A branch entry collectUserEvidence reads (issue #31): the user's own words. */
	const userEntry = (content: string) => ({ type: "message", message: { role: "user", attribution: "user", content } });

	test("a refusal of one operation does not refuse the host's other operations", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh raw-ovh 'wp db delete --all'"), makeCtx({ sessionId: sid }));

		// Same host, a read: judged on its own, with no refusal in the state the
		// judge saw, and nothing left to prompt about.
		setJevAnswer(jevSafeAnswer());
		const readOnly = makeCtx({ sessionId: sid });
		const result = await fire("tool_call", makeEvent("ssh raw-ovh 'ls /tmp'"), readOnly);
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(result).toBeUndefined();
		expect(selectCalls(readOnly)).toHaveLength(0);
	});

	test("a refused container write does not refuse a read-only probe of it", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire(
			"tool_call",
			makeEvent("docker exec raw_wordpress sh -c 'mysql -e \"DELETE FROM wp_options\"'"),
			makeCtx({ sessionId: sid }),
		);

		setJevAnswer(jevSafeAnswer());
		const probe = makeCtx({ sessionId: sid });
		const result = await fire("tool_call", makeEvent("docker exec raw_wordpress php -r 'var_dump(get_option(\"siteurl\"));'"), probe);
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(result).toBeUndefined();
		expect(selectCalls(probe)).toHaveLength(0);
	});

	test("two hosts are two targets", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh raw-ovh 'ls /tmp'"), makeCtx({ sessionId: sid }));

		setJevAnswer(jevSafeAnswer());
		const other = makeCtx({ sessionId: sid });
		const result = await fire("tool_call", makeEvent("ssh slurper 'ls /tmp'"), other);
		expect(priorRefusalOf(1)).toBeUndefined();
		expect(result).toBeUndefined();
	});

	test("a refusal still matches the command re-run, shell whitespace aside", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("ssh raw-ovh 'wp db delete --all'"), makeCtx({ sessionId: sid }));

		setJevAnswer(jevSafeAnswer());
		// The same command again; the run of spaces collapses in a shell.
		const again = makeCtx({ sessionId: sid, hasUI: true });
		await fire("tool_call", makeEvent("ssh raw-ovh  'wp db delete --all'"), again);
		expect(priorRefusalOf(1)?.target).toBe("ssh --all' raw-ovh");
		// The refusal rode in the state, and a SAFE verdict is not a clean bill.
		expect(selectCalls(again)).toHaveLength(1);
		expect(readDecisions().some(line => line.why.includes("prior refusal"))).toBe(true);
	});

	test("a model refusal still expires when the evidence fingerprint moves", async () => {
		const sid = nextSession();
		setJevAnswer(jevUnsafeAnswer());
		await fire("tool_call", makeEvent("rm -rf x"), makeCtx({ sessionId: sid, branch: [userEntry("wipe the scratch build")] }));

		setJevAnswer(jevSafeAnswer());
		const moved = makeCtx({ sessionId: sid, branch: [userEntry("actually stop, keep the build")] });
		await fire("tool_call", makeEvent("rm -rf x"), moved);
		expect(priorRefusalOf(1)).toBeUndefined();
	});
});
