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
import { gateResolve, withSearchPath } from "../stage-two";
import { fromHostReport, reportRefusal, setShellInspectorForTest, shellStateToken, type ShellInspectReport, type ShellInspector } from "../shell-state";
import {
	fire,
	jevSafeAnswer,
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
		["PATH has a relative entry", () => inspector(cleanReport({ path: "7" })), "relative PATH entry"],
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

	test("a hash entry for the gate's own file is a match: the shell hashes every lookup", async () => {
		setShellInspectorForTest(inspector(cleanReport({ resolution: { tar: { kind: "hashed", path: onGatePath("tar") } } })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const result = (await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()))) as { input?: Record<string, unknown> } | undefined;
		expect(result?.input?.shellState).toBeDefined();
	});

	test("a user-writable link to the gate's file does not match: it can be re-pointed after the review", async () => {
		const link = path.join(dir, "tar-link");
		fs.symlinkSync(onGatePath("tar"), link);
		setShellInspectorForTest(inspector(cleanReport({ resolution: { tar: { kind: "hashed", path: link } } })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()));
		expect(reviewerCalls.length).toBe(before);
		expect(refusalOf(result).layer).toBe("unsure");
	});

	test("a script reached through a link rides in the token by the path the shell opens", async () => {
		const real = path.join(dir, "real.sh");
		fs.writeFileSync(real, "#!/bin/bash\ntar -xf archive.tar -C extract\n");
		fs.chmodSync(real, 0o755);
		const link = path.join(dir, "unpack.sh");
		fs.symlinkSync(real, link);
		setShellInspectorForTest(inspector(cleanReport({ resolution: { "./unpack.sh": { kind: "file", path: link } } })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const result = (await fire("tool_call", makeEvent("./unpack.sh"), uiCtx(nextSession()))) as { input?: { shellState?: { files: { path: string }[] } } } | undefined;
		expect(result?.input?.shellState?.files.map(file => file.path)).toEqual([link]);
	});

	test("a host that never answers skips the review inside the handler budget", async () => {
		setShellInspectorForTest(() => new Promise(() => {}));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()));
		expect(reviewerCalls.length).toBe(before);
		expect(refusalOf(result).layer).toBe("unsure");
		expect(String(reviewerAudit()?.skipped)).toContain("in time");
	}, 40_000);

	test("a relative hash entry never matches: the host resolves it against the run's cwd", async () => {
		setShellInspectorForTest(inspector(cleanReport({ resolution: { tar: { kind: "hashed", path: "./tar" } } })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()));
		expect(reviewerCalls.length).toBe(before);
		expect(String(reviewerAudit()?.skipped)).toContain("hashed ./tar");
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
		expect(reportRefusal(report, ["tar"], () => onGatePath("tar"))).toContain("HOME");
	});
});

describe("the gate resolves names on the live shell's PATH", () => {
	// A real session's PATH comes from the rc snapshot, so it never equals the
	// PATH omp was launched with: duplicates, another order, extra entries.
	test("a PATH that differs in order and duplicates still reaches the reviewer", async () => {
		const tarDir = path.dirname(onGatePath("tar"));
		const live = [tarDir, path.join(dir, "absent"), process.env.PATH ?? "", tarDir].join(path.delimiter);
		setShellInspectorForTest(inspector(cleanReport({ path: live })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = (await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()))) as { input?: Record<string, unknown> } | undefined;
		expect(reviewerCalls.length).toBe(before + 1);
		expect(result?.input?.shellState).toEqual({ state: "f".repeat(64), files: [] });
	});

	test("a tar earlier on the live PATH is the file the gate judges", async () => {
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		const shadow = path.join(bin, "tar");
		fs.writeFileSync(shadow, "#!/bin/sh\necho shadow tar\n", { mode: 0o755 });
		const live = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
		setShellInspectorForTest(inspector(cleanReport({ path: live, resolution: { tar: { kind: "file", path: shadow } } })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()));
		// On omp's PATH the gate would have judged /usr/bin/tar; on the shell's it
		// meets the shadow, and a local script run by name is never reviewed.
		expect(refusalOf(result).layer).toBe("unsure");
		expect(reviewerCalls.length).toBe(before);
		expect(String(reviewerAudit()?.skipped)).toContain("local script run by name");
	});

	test("a live tar the gate's own PATH would not find is still a mismatch when the report disagrees", async () => {
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "tar"), "#!/bin/sh\necho shadow tar\n", { mode: 0o755 });
		const live = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
		setShellInspectorForTest(inspector(cleanReport({ path: live })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()));
		expect(refusalOf(result).layer).toBe("unsure");
		expect(reviewerCalls.length).toBe(before);
	});

	test("a relative entry in the live PATH skips the review", async () => {
		setShellInspectorForTest(inspector(cleanReport({ path: `.${path.delimiter}${process.env.PATH ?? ""}` })));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const before = reviewerCalls.length;
		const result = await fire("tool_call", makeEvent(UNSURE_TAR), uiCtx(nextSession()));
		expect(refusalOf(result).layer).toBe("unsure");
		expect(reviewerCalls.length).toBe(before);
		expect(String(reviewerAudit()?.skipped)).toContain("relative PATH entry");
	});

	test("the scope ends with the call, and a promise is refused", () => {
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, "zzscoped"), "#!/bin/sh\n", { mode: 0o755 });
		expect(withSearchPath(bin, () => gateResolve("zzscoped", dir))).toBe(path.join(bin, "zzscoped"));
		expect(gateResolve("zzscoped", dir)).toBeUndefined();
		expect(() => withSearchPath(bin, () => Promise.resolve(1))).toThrow();
		expect(gateResolve("zzscoped", dir)).toBeUndefined();
	});
});

describe("the gate's PATH lookup", () => {
	test("skips a file the user cannot execute, as the shell does", () => {
		const a = path.join(dir, "a");
		const b = path.join(dir, "b");
		fs.mkdirSync(a);
		fs.mkdirSync(b);
		fs.writeFileSync(path.join(a, "zzfoo"), "#!/bin/sh\necho A\n", { mode: 0o001 });
		fs.writeFileSync(path.join(b, "zzfoo"), "#!/bin/sh\necho B\n", { mode: 0o755 });
		const saved = process.env.PATH;
		process.env.PATH = `${a}${path.delimiter}${b}`;
		try {
			expect(gateResolve("zzfoo", dir)).toBe(path.join(b, "zzfoo"));
		} finally {
			process.env.PATH = saved;
		}
	});
});

describe("the token binds the bytes the reviewer read", () => {
	const sha = (text: string): string => require("node:crypto").createHash("sha256").update(text).digest("hex");

	test("a reviewed script rides with the digest the reviewer saw", () => {
		const file = path.join(dir, "a.sh");
		fs.writeFileSync(file, "echo reviewed\n");
		expect(shellStateToken(cleanReport(), [{ file, reviewed: sha("echo reviewed\n") }])?.files).toEqual([{ path: file, sha256: sha("echo reviewed\n") }]);
	});

	test("a script swapped after the review voids the allow", () => {
		const file = path.join(dir, "a.sh");
		fs.writeFileSync(file, "echo swapped\n");
		expect(shellStateToken(cleanReport(), [{ file, reviewed: sha("echo reviewed\n") }])).toBeUndefined();
	});

	test("one path listed with two digests voids the allow", () => {
		const file = path.join(dir, "a.sh");
		fs.writeFileSync(file, "echo reviewed\n");
		expect(shellStateToken(cleanReport(), [{ file, reviewed: sha("echo reviewed\n") }, { file, reviewed: sha("other") }])).toBeUndefined();
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

	// The loop bakes the gate's revised input into the assistant message
	// (pi-agent-core agent-loop.ts), so the model sees the token in its own
	// history and copies it into its next call. The gate drops it and judges
	// the call as if it were absent.
	const copied = { shellState: { state: "0".repeat(64), files: [] } };

	test("a copied shellState on a SAFE call is dropped, and the call runs", async () => {
		setShellInspectorForTest(inspector(cleanReport()));
		setJevAnswer(jevSafeAnswer());
		const result = (await fire("tool_call", makeEvent("ls extract", copied), uiCtx(nextSession()))) as { block?: boolean; input?: Record<string, unknown> } | undefined;
		expect(result?.block).toBeUndefined();
		expect(result?.input).toEqual({ command: "ls extract" });
	});

	test("a copied shellState on a reviewed call is replaced by the gate's own", async () => {
		setShellInspectorForTest(inspector(cleanReport()));
		scriptReviewer(reviewerReply("allow", "unpack the archive into extract/"));
		const result = (await fire("tool_call", makeEvent(UNSURE_TAR, copied), uiCtx(nextSession()))) as { input?: Record<string, unknown> } | undefined;
		expect(result?.input?.shellState).toEqual({ state: "f".repeat(64), files: [] });
	});

	test("a copied shellState never lifts a block", async () => {
		setShellInspectorForTest(inspector(cleanReport()));
		scriptReviewer(reviewerReply("block"));
		const result = await fire("tool_call", makeEvent(UNSURE_TAR, copied), uiCtx(nextSession()));
		expect(refusalOf(result).layer).toBe("unsure");
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
