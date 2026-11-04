/**
 * Stage 2 asks the live session shell before it reviews
 * (docs/plans/2026-11-04-stage-2-latch-scope.md, plan v4).
 *
 * Each test is one gate-side row of the plan's failure matrix. The host's
 * `inspectShellSession` is stood in for with `setShellInspectorForTest`; the
 * reviewer is the fixtures' mocked model, so a path that must not reach it is
 * checked by its call count, and an allow is checked by the token it carries.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fromHostReport, reportRefusal, setShellInspectorForTest, type ShellInspectReport, type ShellInspector } from "../shell-state";
import {
	fire,
	jevUnsureAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	REVIEWER_TEST_MODEL,
	refusalOf,
	removeConfigFile,
	resetReviewer,
	reviewerCalls,
	reviewerReply,
	scriptReviewer,
	setJevAnswer,
	setJevAnsweringApi,
} from "./fixtures";

type Entry = { type: string; id?: string; message?: Record<string, unknown> };

let dir = "";
let seq = 0;
const nextSession = (): string => `shell-state-${(seq += 1)}`;
const user = (id: string, content: string): Entry => ({ type: "message", id, message: { role: "user", attribution: "user", content } });
const branch = [user("u1", "unpack the archive into extract/")];
const uiCtx = (sessionId: string) => makeCtx({ sessionId, hasUI: true, branch, cwd: dir });

const reviewerAudit = (): Record<string, unknown> | undefined =>
	fs
		.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => (JSON.parse(line) as { reviewer?: Record<string, unknown> }).reviewer)
		.filter(entry => entry !== undefined)
		.at(-1);

/** Where the gate's own PATH finds `name`. */
function onGatePath(name: string): string {
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(entry, name);
		if (entry !== "" && fs.existsSync(candidate)) return candidate;
	}
	throw new Error(`${name} is not on PATH`);
}

/** A report for a shell nobody touched: `tar` resolves where the gate finds it. */
function cleanReport(extra: Partial<ShellInspectReport> = {}): ShellInspectReport {
	return {
		fingerprint: "f".repeat(64),
		resolution: { tar: { kind: "file", path: onGatePath("tar") } },
		hooks: [],
		optionsChanged: [],
		exportsChanged: [],
		snapshotChanged: false,
		home: os.homedir(),
		path: process.env.PATH ?? "",
		...extra,
	};
}

const calls: Array<{ sessionKey: string; names: string[] }> = [];
const inspector =
	(report: ShellInspectReport | undefined | Error): ShellInspector =>
	async (sessionKey, names) => {
		calls.push({ sessionKey, names });
		if (report instanceof Error) throw report;
		return report;
	};

const UNSURE_TAR = "tar -xf archive.tar -C extract";

beforeEach(async () => {
	removeConfigFile();
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-shell-state-")));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	fs.writeFileSync(process.env.OMP_JEV_CONFIG, JSON.stringify({ reviewerModel: REVIEWER_TEST_MODEL }));
	await loadPlugin(makeSettings([]));
	resetReviewer();
	setJevAnsweringApi();
	setJevAnswer(jevUnsureAnswer());
	calls.length = 0;
});

afterEach(() => {
	setShellInspectorForTest(undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a clean live shell reaches the reviewer", () => {
	test("an allow carries the shell's fingerprint back to the host", async () => {
		setShellInspectorForTest(inspector(cleanReport()));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const session = nextSession();
		const result = (await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(session))) as { input?: Record<string, unknown> } | undefined;
		expect(result?.input?.shellState).toEqual({ state: "f".repeat(64), files: [] });
		expect(result?.input?.command).toBe(UNSURE_TAR);
		expect(calls).toEqual([{ sessionKey: session, names: ["tar"] }]);
	});

	test("an earlier call the old latch tripped on no longer turns the reviewer off", async () => {
		setShellInspectorForTest(inspector(cleanReport()));
		const session = nextSession();
		scriptReviewer(reviewerReply("block"));
		await fire("tool_call", makeEvent("NOW=$(date +%s); echo $((NOW-3600))"), uiCtx(session));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = (await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(session))) as { input?: Record<string, unknown> } | undefined;
		expect(reviewerCalls.length).toBe(before + 1);
		expect(result?.input?.shellState).toBeDefined();
	});

	test("a reviewed script's hash rides in the token", async () => {
		const file = path.join(dir, "unpack.sh");
		fs.writeFileSync(file, "#!/bin/bash\ntar -xf archive.tar -C extract\n");
		fs.chmodSync(file, 0o755);
		setShellInspectorForTest(inspector(cleanReport({ resolution: { "./unpack.sh": { kind: "file", path: file } } })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const result = (await fire("tool_call", makeEvent("./unpack.sh"), uiCtx(nextSession()))) as { input?: { shellState?: { files: { path: string; sha256: string }[] } } } | undefined;
		expect(result?.input?.shellState?.files).toEqual([{ path: file, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }]);
	});
});

describe("the live shell rules the review out", () => {
	const skips: Array<[string, () => ShellInspector, string]> = [
		["no core exists yet", () => inspector(undefined), "shell"],
		["the inspector throws", () => inspector(new Error("closed")), "shell"],
		["an export changed", () => inspector(cleanReport({ exportsChanged: ["GIT_SSH_COMMAND"] })), "GIT_SSH_COMMAND"],
		["a DEBUG trap is set", () => inspector(cleanReport({ hooks: ["trap:DEBUG"] })), "trap:DEBUG"],
		["CDPATH is set", () => inspector(cleanReport({ hooks: ["var:CDPATH"] })), "CDPATH"],
		["an option differs", () => inspector(cleanReport({ optionsChanged: ["xtrace"] })), "xtrace"],
		["the snapshot changed", () => inspector(cleanReport({ snapshotChanged: true })), "snapshot"],
		["HOME moved", () => inspector(cleanReport({ home: "/tmp/7" })), "HOME"],
		["PATH moved", () => inspector(cleanReport({ path: "7" })), "PATH"],
		["tar is a function", () => inspector(cleanReport({ resolution: { tar: { kind: "function" } } })), "function"],
		["tar is an alias", () => inspector(cleanReport({ resolution: { tar: { kind: "alias", text: "./x" } } })), "alias"],
		["tar is hashed elsewhere", () => inspector(cleanReport({ resolution: { tar: { kind: "hashed", path: "/tmp/x/tar" } } })), "hashed"],
		["tar is a disabled builtin", () => inspector(cleanReport({ resolution: { tar: { kind: "builtin", usable: false } } })), "disabled"],
	];
	test.each(skips)("skips when %s", async (_name, make, mentions) => {
		setShellInspectorForTest(make());
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()));
		expect(refusalOf(result).layer).toBe("unsure");
		expect(reviewerCalls.length).toBe(before);
		expect(String(reviewerAudit()?.skipped)).toContain(mentions);
	});

	test("a usable builtin matches whatever the gate found on PATH", async () => {
		setShellInspectorForTest(inspector(cleanReport({ resolution: { tar: { kind: "builtin", usable: true } } })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const result = (await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()))) as { input?: Record<string, unknown> } | undefined;
		expect(result?.input?.shellState).toBeDefined();
	});
});

describe("the reviewed command's own text", () => {
	test.each([
		["$[w] arithmetic", "echo $[w]; tar -xf archive.tar -C extract"],
		["${*:w} offset", 'echo "${*:w}"; tar -xf archive.tar -C extract'],
		["an indirect expansion", 'echo "${!n}"; tar -xf archive.tar -C extract'],
		["a prompt expansion", 'echo "${y@P}"; tar -xf archive.tar -C extract'],
		["a -v test", '[ -v "a[w]" ] && tar -xf archive.tar -C extract'],
		["~- tilde", "tar -xf ~-/archive.tar -C extract"],
		["pushd", "pushd extract && tar -xf ../archive.tar"],
	])("refuses review for %s", async (_name, command) => {
		setShellInspectorForTest(inspector(cleanReport()));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(command), uiCtx(nextSession()));
		expect(reviewerCalls.length).toBe(before);
		expect(result).toBeDefined();
	});
});

describe("the host's report as pi-natives ships it", () => {
	const base = { fingerprint: "a".repeat(64), hooks: [], optionsChanged: [], exportsChanged: [], snapshotChanged: false };

	test("resolution arrives as a list and is read per name", () => {
		const report = fromHostReport({
			...base,
			home: os.homedir(),
			path: "/usr/bin",
			resolution: [
				{ name: "tar", kind: "file", path: "/usr/bin/tar" },
				{ name: "git", kind: "builtin", usable: true },
				{ name: "ls", kind: "alias", text: "ls -G" },
			],
		});
		expect(report.resolution).toEqual({ tar: { kind: "file", path: "/usr/bin/tar" }, git: { kind: "builtin", usable: true }, ls: { kind: "alias", text: "ls -G" } });
	});

	test("a file entry without a path, or a builtin without usable, cannot pass", () => {
		const report = fromHostReport({ ...base, resolution: [{ name: "tar", kind: "file" }, { name: "git", kind: "builtin" }] });
		expect(report.resolution.tar).toEqual({ kind: "missing" });
		expect(report.resolution.git).toEqual({ kind: "builtin", usable: false });
	});

	test("an unset HOME or PATH never matches the gate's", () => {
		const report = fromHostReport({ ...base, resolution: [{ name: "tar", kind: "file", path: onGatePath("tar") }] });
		expect(reportRefusal(report, ["tar"], () => onGatePath("tar"), process.env.PATH)).toContain("HOME");
	});
});

describe("routes and the token field", () => {
	test.each([["pty", { pty: true }], ["async", { async: true }], ["a service name", { name: "svc" }]])("skips review on %s", async (_name, extra) => {
		setShellInspectorForTest(inspector(cleanReport()));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(UNSURE_TAR, extra), uiCtx(nextSession()));
		expect(reviewerCalls.length).toBe(before);
		expect(result).toBeDefined();
	});

	test("a shellState the model wrote itself is refused before judgment", async () => {
		setShellInspectorForTest(inspector(cleanReport()));
		const result = await fire("tool_call", makeEvent("ls", { shellState: { state: "0".repeat(64), files: [] } }), uiCtx(nextSession()));
		expect(refusalOf(result).layer).toBeDefined();
		expect(calls).toHaveLength(0);
	});

	test("a host without the API keeps the old latch", async () => {
		setShellInspectorForTest(null);
		const session = nextSession();
		scriptReviewer(reviewerReply("block"));
		await fire("tool_call", makeEvent("export PATH=/tmp/evil:$PATH"), uiCtx(session));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(session));
		expect(reviewerCalls.length).toBe(before);
		expect(String(reviewerAudit()?.skipped)).toContain("resolve names differently");
	});
});
