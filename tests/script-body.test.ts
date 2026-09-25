/**
 * Issue #67: a command that runs an interpreter on a session-written script is
 * judged by the script's BODY, not by its path.
 *
 * Before the fix the gate judged the command TEXT, so a file's content decided
 * nothing: the byte-identical script ran from the worktree and, under the older
 * provenance rule, was refused from /tmp, and renaming a refused script flipped
 * the verdict. These tests hold the fix to both directions — a body carrying a
 * refused operation is refused from the session's directory and from outside it
 * alike, under either name, and a benign body still runs from both.
 *
 * Everything runs through the interceptor (fire("tool_call")) against real
 * files in real temporary directories: the point of the issue is what the gate
 * reads off DISK, which no pure-function test can show.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readInterpretedScriptBodies } from "../index";
import {
	ALLOW_ONCE,
	dialogText,
	fire,
	jevSafeAnswer,
	loadPlugin,
	makeCtx,
	makeEvent,
	makeSettings,
	modelCalls,
	refusalOf,
	removeConfigFile,
	resultText,
	setJevAnswer,
	stateOf,
} from "./fixtures";

/** A shell body carrying a destructive operation. `rm` with recursion is one of
 *  the forced-dialog shapes, so the body alone decides the call: the command
 *  text `bash probe.sh` carries no risk verb at all. */
const HARMFUL_SHELL = "#!/bin/bash\nrm -rf ./out\n";

/** A body that hands its work to another program: `subprocess` is one of the
 *  interpreter-code markers the gate already applies to a `-c` payload, so a
 *  SAFE cannot release it. */
const HARMFUL_CODE = 'import subprocess\nsubprocess.run(["ls"])\n';

/** A body that reaches a raw device: the built-in critical patterns match the
 *  BODY text, so this is refused before any model call. */
const DEVICE_SHELL = "dd if=/dev/zero of=/dev/rdisk2\n";

/** Nothing a SAFE cannot vouch for. */
const BENIGN = 'print("scratch probe ok")\n';

/** The session's working directory: the analogue of the assigned worktree. */
let root: string;
/** A directory the session is NOT in — the issue's `/tmp` leg. Both live under
 *  the OS temp dir on purpose: what differed before the fix was not the path on
 *  disk but whether the file sat inside the session's working directory, which
 *  is the provenance the old refusal keyed on and the new rule ignores. */
let outside: string;
let seq = 0;

const writeScript = (dir: string, name: string, body: string): string => {
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return file;
};

const fresh = () => {
	seq += 1;
	return makeCtx({ sessionId: `script-body-${seq}`, cwd: root });
};

const gate = async (command: string, ctx = fresh()) => resultText(await fire("tool_call", makeEvent(command), ctx));

beforeEach(async () => {
	removeConfigFile();
	await loadPlugin(makeSettings([]));
	setJevAnswer(jevSafeAnswer());
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-script-body-root-"));
	outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-script-body-outside-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(outside, { recursive: true, force: true });
});

describe("the body decides, wherever the file lives", () => {
	test("a shell body carrying rm -rf is refused from the session's directory", async () => {
		writeScript(root, "probe.sh", HARMFUL_SHELL);
		const result = await gate("bash probe.sh");
		const payload = refusalOf(result);
		// The flag can only come from the body: the command text has no rm in it.
		expect(payload.why).toContain("flags: rm");
		expect(payload.layer).toBe("headless");
	});

	test("the same body is refused from outside the session's directory", async () => {
		const file = writeScript(outside, "probe.sh", HARMFUL_SHELL);
		const result = await gate(`bash ${file}`);
		const payload = refusalOf(result);
		expect(payload.why).toContain("flags: rm");
		expect(payload.layer).toBe("headless");
	});

	test("a rename does not change the verdict", async () => {
		// The issue's own evidence: a refused cleanup_row.py was renamed to
		// rs3_remove_import.py to get it through.
		writeScript(root, "cleanup_row.py", HARMFUL_CODE);
		writeScript(root, "rs3_remove_import.py", HARMFUL_CODE);
		const first = await gate("python3 cleanup_row.py");
		const second = await gate("python3 rs3_remove_import.py");
		expect(refusalOf(first).layer).toBe("headless");
		expect(refusalOf(second).layer).toBe("headless");
		expect(refusalOf(first).why).toContain("flags: python3 runs cleanup_row.py");
		expect(refusalOf(second).why).toContain("flags: python3 runs rs3_remove_import.py");
	});

	test("an extensionless operand is read", async () => {
		writeScript(root, "probe", "rm -rf ./out\n");
		const result = await gate("bash probe");
		expect(refusalOf(result).why).toContain("flags: rm");
	});

	test("a runner subcommand's file is read", async () => {
		writeScript(root, "x.ts", "rm -rf ./out\n");
		const result = await gate("bun run x.ts");
		expect(refusalOf(result).why).toContain("flags: rm");
	});

	test("a runner subcommand naming a package script is not refused", async () => {
		// `bun run dev` reads package.json, not ./dev: a same-named directory
		// must not turn a runner invocation into an unreadable program.
		fs.mkdirSync(path.join(root, "dev"));
		expect(await gate("bun run dev")).toBe("ALLOWED");
	});

	test("the judge is handed the body, not the path", async () => {
		writeScript(root, "probe.py", HARMFUL_CODE);
		await gate("python3 probe.py");
		const state = stateOf(0);
		expect(String(state.command)).toContain("subprocess.run(");
		expect(String(state.command)).toContain("probe.py");
	});

	test("a body reaching a device hits the built-in critical patterns", async () => {
		writeScript(root, "probe.sh", DEVICE_SHELL);
		const result = await gate("bash probe.sh");
		expect(refusalOf(result).why).toContain("critical pattern");
		// The body's own line is what matched: nothing was sent to the judge.
		expect(modelCalls.length).toBe(0);
	});

	test("the cache does not carry a verdict across a body rewrite", async () => {
		// Same session, same command text, different file. The text that was
		// judged includes the body, so the rewrite is a new question.
		const ctx = makeCtx({ sessionId: "script-body-cache", cwd: root });
		writeScript(root, "probe.py", HARMFUL_CODE);
		expect(refusalOf(await gate("python3 probe.py", ctx)).layer).toBe("headless");

		setJevAnswer(jevSafeAnswer());
		writeScript(root, "probe.py", 'print("rewritten")\n');
		await gate("python3 probe.py", ctx);
		// A second judgement, on the second body: the stale verdict could not
		// answer for a file it never read.
		expect(modelCalls.length).toBe(2);
		expect(String(stateOf(1).command)).toContain("rewritten");
		expect(String(stateOf(1).command)).not.toContain("subprocess");
	});
});

describe("a benign body still runs", () => {
	test("from the session's directory", async () => {
		writeScript(root, "probe.py", BENIGN);
		const result = await gate("python3 probe.py");
		expect(result).toBe("ALLOWED");
		expect(String(stateOf(0).command)).toContain("scratch probe ok");
	});

	test("from outside the session's directory", async () => {
		const file = writeScript(outside, "probe.py", BENIGN);
		const result = await gate(`python3 ${file}`);
		expect(result).toBe("ALLOWED");
		expect(String(stateOf(0).command)).toContain("scratch probe ok");
	});
});

describe("fail closed when the body cannot be read", () => {
	test("a body past the review limit is refused with the reason named", async () => {
		// Default maxCommandLength is 8000; the body alone is well past it.
		writeScript(root, "big.py", `${"# padding line\n".repeat(700)}print("ok")\n`);
		const result = await gate("python3 big.py");
		const payload = refusalOf(result);
		expect(payload.layer).toBe("script-body");
		expect(payload.why).toContain("review limit");
		expect(payload.why).toContain("big.py");
		// Nothing was judged: the file is refused before the model is asked.
		expect(modelCalls.length).toBe(0);
	});

	test("an unreadable script is refused, not waved through", async () => {
		const file = writeScript(root, "locked.py", BENIGN);
		fs.chmodSync(file, 0o000);
		const result = await gate("python3 locked.py");
		const payload = refusalOf(result);
		expect(payload.layer).toBe("script-body");
		expect(payload.why).toContain("locked.py");
		expect(modelCalls.length).toBe(0);
	});

	test("a directory named as the program is refused", async () => {
		fs.mkdirSync(path.join(root, "package"));
		const result = await gate("python3 package");
		const payload = refusalOf(result);
		expect(payload.layer).toBe("script-body");
		expect(payload.why).toContain("package");
		expect(modelCalls.length).toBe(0);
	});

	test("a glob as the program is refused", async () => {
		writeScript(root, "probe.py", BENIGN);
		const result = await gate("python3 *.py");
		const payload = refusalOf(result);
		expect(payload.layer).toBe("script-body");
		expect(payload.why).toContain("*.py");
		expect(modelCalls.length).toBe(0);
	});
});

describe("the reader itself", () => {
	test("a body is spliced in under a labelled fence", () => {
		writeScript(root, "probe.py", BENIGN);
		const read = readInterpretedScriptBodies("python3 probe.py", root, 8000);
		expect(read.refusal).toBeNull();
		expect(read.text).toContain("# --- python3 runs probe.py; body read from disk ---");
		expect(read.text).toContain('print("scratch probe ok")');
		expect(read.text).toContain("# --- end of probe.py ---");
		expect(read.bodies.map(b => `${b.verb} ${b.operand}`)).toEqual(["python3 probe.py"]);
	});

	test("a command with no script operand is left exactly as it was", () => {
		const read = readInterpretedScriptBodies("git status --short", root, 8000);
		expect(read.text).toBe("git status --short");
		expect(read.bodies).toEqual([]);
		expect(read.refusal).toBeNull();
	});

	test("nothing is half-appended when the limit refuses the body", () => {
		writeScript(root, "probe.py", BENIGN);
		const read = readInterpretedScriptBodies("python3 probe.py", root, 30);
		expect(read.refusal?.why).toContain("review limit");
		expect(read.text).toBe("python3 probe.py");
		expect(read.bodies).toEqual([]);
	});
});

describe("sibling commands of this fix stay as they were", () => {
	test("a script the same command writes with a heredoc still runs", async () => {
		// The path does not exist at gate time; the body it will hold is in the
		// command text already, so this is not the opaque case the rule targets.
		const result = await gate(`cat > probe.py <<'EOF'\nprint("written inline")\nEOF\npython3 probe.py`);
		expect(result).toBe("ALLOWED");
	});

	test("an interpreter line inside a heredoc DOCUMENT is not a program", async () => {
		// The line is data to the shell. A document that mentions `python3 pkg`
		// — a directory here — must not refuse the write carrying it.
		fs.mkdirSync(path.join(root, "pkg"));
		const result = await gate(`cat > notes.md <<'EOF'\npython3 pkg\nEOF`);
		expect(result).toBe("ALLOWED");
	});

	test("a missing script is judged on the command text alone", async () => {
		const result = await gate("python3 not_written_yet.py");
		expect(result).toBe("ALLOWED");
		// Nothing was spliced in: the judged text is the command, byte for byte.
		expect(String(stateOf(0).command)).toBe("python3 not_written_yet.py");
	});

	test("inline code is unchanged", async () => {
		const result = await gate("python3 -c 'print(1)'");
		expect(result).toBe("ALLOWED");
	});

	test("an interpreter fed from stdin is unchanged", async () => {
		const result = await gate(`python3 - <<'EOF'\nprint("piped")\nEOF`);
		expect(result).toBe("ALLOWED");
	});

	test("a non-interpreter command that names a file is unchanged", async () => {
		writeScript(root, "notes.txt", "rm -rf ./out\n");
		const result = await gate("cat notes.txt");
		expect(result).toBe("ALLOWED");
	});

	test("an approved script still runs, and the dialog showed its body", async () => {
		writeScript(root, "probe.sh", HARMFUL_SHELL);
		const ctx = makeCtx({ sessionId: "script-body-allow", cwd: root, hasUI: true, selectResult: ALLOW_ONCE });
		expect(await gate("bash probe.sh", ctx)).toBe("ALLOWED");
		// The human approved the text the gate judged, body included: the dialog
		// renders target.command, and that is the spliced text.
		expect(dialogText(ctx)).toContain("rm -rf ./out");
	});
});
