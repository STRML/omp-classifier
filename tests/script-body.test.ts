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

	test("redirected stdin carries the same body risk as an on-disk script", async () => {
		writeScript(root, "installer", HARMFUL_SHELL);
		const onDisk = await gate("bash installer");
		expect(refusalOf(onDisk).why).toContain("flags: rm");

		for (const command of ["bash < installer", "bash -s < installer"]) {
			const redirected = await gate(command);
			expect(refusalOf(redirected).why).toContain("flags: rm");
		}
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

describe("redirected stdin", () => {
	test("a redirected file is read as the interpreter body", () => {
		writeScript(root, "installer", HARMFUL_SHELL);
		for (const command of ["bash < installer", "bash -s < installer"]) {
			const read = readInterpretedScriptBodies(command, root, 8000);
			expect(read.refusal).toBeNull();
			expect(read.bodies.map(body => body.operand)).toEqual(["installer"]);
			expect(read.text).toContain("rm -rf ./out");
		}
	});

	test("an expanded target is refused rather than guessed", () => {
		const read = readInterpretedScriptBodies("bash < $INSTALLER", root, 8000);
		expect(read.refusal?.why).toContain("expands $INSTALLER");
		expect(read.bodies).toEqual([]);
	});

	test("a missing redirected file is refused", () => {
		const read = readInterpretedScriptBodies("bash < missing-installer", root, 8000);
		expect(read.refusal?.why).toContain("missing-installer");
	});
});

describe("wrapper option arity", () => {
	test("env -u consumes its value before locating the interpreter", async () => {
		writeScript(root, "payload.py", HARMFUL_CODE);
		const result = await gate("env -u FOO python3 payload.py");
		expect(refusalOf(result).why).toContain("flags: python3 runs payload.py");
		expect(String(stateOf(0).command)).toContain("subprocess.run(");
	});

	test("env --unset consumes its separated value", () => {
		writeScript(root, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies("env --unset FOO python3 payload.py", root, 8000);
		expect(read.refusal).toBeNull();
		expect(read.bodies.map(body => body.operand)).toEqual(["payload.py"]);
	});

	test("an unknown env option makes the command opaque", () => {
		writeScript(root, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies("env --unknown-option VALUE python3 payload.py", root, 8000);
		expect(read.refusal?.why).toContain("unknown env option");
		expect(read.bodies).toEqual([]);
	});

	test("an unknown timeout option makes the command opaque", () => {
		writeScript(root, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies("timeout --unknown-option 5s python3 payload.py", root, 8000);
		expect(read.refusal?.why).toContain("unknown timeout option");
		expect(read.bodies).toEqual([]);
	});
});

describe("heredocs inside shell script bodies", () => {
	test("a body that writes and runs a heredoc payload is refused", async () => {
		writeScript(root, "payload.sh", "cat <<'EOF' > x.sh\nrm -rf ./out\nEOF\nbash x.sh\n");
		const result = await gate("bash payload.sh");
		const payload = refusalOf(result);
		expect(payload.layer).toBe("script-body");
		expect(payload.why).toContain("heredoc");
		expect(modelCalls.length).toBe(0);
	});

	test("a body that pipes a heredoc to an interpreter is refused", async () => {
		writeScript(root, "payload.sh", "cat <<'EOF' | bash\nrm -rf ./out\nEOF\n");
		const result = await gate("bash payload.sh");
		const payload = refusalOf(result);
		expect(payload.layer).toBe("script-body");
		expect(payload.why).toContain("heredoc");
		expect(modelCalls.length).toBe(0);
	});
});

describe("the interpreter's own options, not the gate's guess at them", () => {
	// Round 1 review: one global flag table made `python3 -E probe.py` end the
	// scan, because `-E` was read as an inline-program spelling. `-E` is
	// PYTHON* environment control — a boolean — so python still ran probe.py.
	test("a boolean option does not end the scan (-E)", () => {
		writeScript(root, "probe.py", BENIGN);
		const read = readInterpretedScriptBodies("python3 -E probe.py", root, 8000);
		expect(read.bodies.map(b => `${b.verb} ${b.operand}`)).toEqual(["python3 probe.py"]);
		expect(read.text).toContain('print("scratch probe ok")');
	});

	test("a boolean option before a shell program does not either", async () => {
		writeScript(root, "probe.sh", HARMFUL_SHELL);
		// `bash -E` is errtrace: a boolean, not an inline program.
		const result = await gate("bash -E probe.sh");
		expect(refusalOf(result).why).toContain("flags: rm");
	});

	// Round 1 review, P2: `-W` takes a warning filter, so `ignore` is not the
	// program; treating it as one shifted `payload` into the load arm, where an
	// extensionless word is passed over — although python ran `payload`.
	test("a value-taking option consumes its value, not the program (-W ignore)", () => {
		writeScript(root, "payload", BENIGN);
		const read = readInterpretedScriptBodies("python3 -W ignore payload", root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["payload"]);
		expect(read.text).toContain('print("scratch probe ok")');
	});

	test("an extensionless program behind a value-taking option is read off disk", async () => {
		writeScript(root, "payload", "rm -rf ./out\n");
		const result = await gate("python3 -W ignore payload");
		expect(refusalOf(result).why).toContain("flags: rm");
	});

	test("the inline-code spellings still end the scan", () => {
		for (const command of ["python3 -c 'print(1)'", "node -e 'x'", "perl -E 'x'", "bash -c 'echo hi'", "php -r 'echo 1;'"]) {
			const read = readInterpretedScriptBodies(command, root, 8000);
			expect({ command, bodies: read.bodies, refusal: read.refusal }).toEqual({ command, bodies: [], refusal: null });
		}
	});

	test("a flag letter is read per interpreter: -E is code for perl, boolean for python", () => {
		writeScript(root, "probe.pl", "print 1;\n");
		// perl -E takes the code that follows, so there is no file to read.
		expect(readInterpretedScriptBodies("perl -E probe.pl", root, 8000).bodies).toEqual([]);
		expect(readInterpretedScriptBodies("python3 -E probe.pl", root, 8000).bodies.map(b => b.operand)).toEqual(["probe.pl"]);
	});

	test("a flag letter is read per interpreter: -s is stdin for a shell, a switch flag for perl", () => {
		writeScript(root, "probe.pl", "print 1;\n");
		expect(readInterpretedScriptBodies("perl -s probe.pl", root, 8000).bodies.map(b => b.operand)).toEqual(["probe.pl"]);
		expect(readInterpretedScriptBodies("bash -s", root, 8000).bodies).toEqual([]);
	});

	// Round 2 review: a flag whose value is a FILE the interpreter runs was
	// consumed as if it were a setting, so `bun --preload ./payload.ts run
	// safe.ts` read only safe.ts while the preload ran unjudged. The value of
	// such a flag is the interpreter's own operand, and the program slot stays
	// open for the word after it.
	test("a flag whose value is a file the interpreter runs is read (bun --preload)", () => {
		writeScript(root, "payload.ts", HARMFUL_CODE);
		writeScript(root, "safe.ts", BENIGN);
		const read = readInterpretedScriptBodies("bun --preload ./payload.ts run safe.ts", root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["./payload.ts", "safe.ts"]);
		expect(read.text).toContain("subprocess");
	});

	test("the preload aliases this machine's bun ships are read the same way", () => {
		// `bun --help` here: `-r, --preload=<val>`, `--require` and `--import`
		// are aliases of it.
		writeScript(root, "payload.ts", HARMFUL_CODE);
		for (const flag of ["-r", "--require", "--import"]) {
			const read = readInterpretedScriptBodies(`bun ${flag} ./payload.ts run safe.ts`, root, 8000);
			expect({ flag, operands: read.bodies.map(b => b.operand) }).toEqual({ flag, operands: ["./payload.ts"] });
		}
	});

	test("an expanded preload value is a refusal, not a word to pass over", () => {
		const read = readInterpretedScriptBodies("bun --preload $PAYLOAD run safe.ts", root, 8000);
		expect(read.refusal?.why).toContain("$PAYLOAD");
	});

	// Round 3 review: the round-2 fix closed the separated spelling and not its
	// class. A value attached to its flag is the SAME value, and reading the
	// flag word alone loses it: `bun --preload=./payload.ts run safe.ts` matched
	// only the separate `--preload`, so the preload was never read while the
	// program slot moved on to safe.ts.
	test("the attached spelling of a loader flag names the same file", () => {
		writeScript(root, "payload.ts", HARMFUL_CODE);
		writeScript(root, "safe.ts", BENIGN);
		const read = readInterpretedScriptBodies("bun --preload=./payload.ts run safe.ts", root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["./payload.ts", "safe.ts"]);
		expect(read.text).toContain("subprocess");
	});

	test("the getopt short spelling is the same flag, and the `=` after it is a separator", () => {
		// `bun --help`: `-r, --preload=<val>`. `bun -r./payload.ts run safe.ts`
		// loads that file on this machine, and `php -f=eq-marker.php` runs
		// `eq-marker.php` (measured) — the `=` is dropped, not part of the name.
		writeScript(root, "payload.ts", HARMFUL_CODE);
		writeScript(root, "safe.ts", BENIGN);
		writeScript(root, "payload.php", HARMFUL_CODE);
		for (const command of ["bun -r./payload.ts run safe.ts", "bun -r=./payload.ts run safe.ts"]) {
			const read = readInterpretedScriptBodies(command, root, 8000);
			expect({ command, operands: read.bodies.map(b => b.operand) }).toEqual({ command, operands: ["./payload.ts", "safe.ts"] });
		}
		for (const command of ["php -f=./payload.php", "php -f./payload.php"]) {
			const read = readInterpretedScriptBodies(command, root, 8000);
			expect({ command, operands: read.bodies.map(b => b.operand) }).toEqual({ command, operands: ["./payload.php"] });
		}
	});

	test("node's and php's script flags carry their file in the flag too", () => {
		// `node --require=./pre.cjs` loads that file (measured), and the operand
		// scan left the attached spelling unread: node's `-r`/`--require`/
		// `--import` belong to the file class, as php's `-f` does.
		writeScript(root, "pre.cjs", HARMFUL_CODE);
		writeScript(root, "main.cjs", BENIGN);
		const node = readInterpretedScriptBodies("node --require=./pre.cjs main.cjs", root, 8000);
		expect(node.bodies.map(b => b.operand)).toEqual(["./pre.cjs", "main.cjs"]);
		// The separated spelling keeps reading the same file it always did.
		expect(readInterpretedScriptBodies("node --require ./pre.cjs main.cjs", root, 8000).bodies.map(b => b.operand)).toEqual(["./pre.cjs", "main.cjs"]);
	});

	test("an attached value of a setting flag consumes no program word", () => {
		// `python3 -Wignore payload` and `python3 -Xutf8 payload` are one word
		// for the flag and one for the program: nothing is consumed here; the
		// program slot still holds the next word.
		writeScript(root, "payload", BENIGN);
		for (const command of ["python3 -Wignore payload", "python3 -Xutf8 payload", "php -dmemory_limit=64M payload"]) {
			const read = readInterpretedScriptBodies(command, root, 8000);
			expect({ command, operands: read.bodies.map(b => b.operand) }).toEqual({ command, operands: ["payload"] });
		}
	});

	test("a short word that is a flag cluster keeps its program slot", () => {
		// `bash -cx ./probe.sh` runs probe.sh: `-cx` is `-c -x`, and the shell
		// takes the NEXT word as the code. A short word is therefore never read
		// as its first letter's attached value — that would end the scan and
		// drop a file the shell runs (measured: `bash -cx ./x.sh` executes x.sh,
		// while `bash -cecho hi` is an invalid option cluster).
		writeScript(root, "probe.sh", HARMFUL_SHELL);
		const read = readInterpretedScriptBodies("bash -cx ./probe.sh", root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["./probe.sh"]);
		expect(read.text).toContain("rm -rf ./out");
	});

	test("an expanded attached value is a refusal, not a word to pass over", () => {
		const read = readInterpretedScriptBodies("bun --preload=$PAYLOAD run safe.ts", root, 8000);
		expect(read.refusal?.why).toContain("$PAYLOAD");
	});

	test("the gate refuses a harmful preload behind the attached spelling", async () => {
		writeScript(root, "payload.ts", HARMFUL_CODE);
		writeScript(root, "safe.ts", BENIGN);
		const result = await gate("bun --preload=./payload.ts run safe.ts");
		expect(refusalOf(result).why).toContain("flags: bun runs ./payload.ts");
	});

	test("an end-of-options marker does not eat the program (lua --)", () => {
		writeScript(root, "payload.lua", 'print("lua payload")\n');
		const read = readInterpretedScriptBodies("lua -- ./payload.lua", root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["./payload.lua"]);
		expect(read.text).toContain("lua payload");
	});

	test("an osascript option with no value does not eat the program file (-i)", () => {
		// The synopsis on this machine: `osascript [-l language] [-i] [-s
		// flags] [-e statement | programfile] [argument ...]` — `-i` is
		// interactive mode and takes no value word.
		writeScript(root, "payload.applescript", 'do shell script "rm -rf ./out"\n');
		const read = readInterpretedScriptBodies("osascript -i ./payload.applescript", root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["./payload.applescript"]);
		expect(read.text).toContain("do shell script");
	});
});

describe("a loader operand the gate could not read is a refusal", () => {
	// Round 1 review: the load arm passed over a read refusal, so `bun run
	// huge.ts` ended with no body read and a matching allow rule could release
	// it. "This word is not a program" and "this program could not be read" are
	// different answers; only the first may be passed over.
	const huge = (): string => `${"// padding line\n".repeat(1200)}rm -rf ./out\n`;

	test("an over-limit file behind a runner subcommand is refused, not passed over", async () => {
		writeScript(root, "huge.ts", huge());
		const result = await gate("bun run huge.ts");
		const payload = refusalOf(result);
		expect(payload.layer).toBe("script-body");
		expect(payload.why).toContain("review limit");
		expect(payload.why).toContain("huge.ts");
		expect(modelCalls.length).toBe(0);
	});

	test("an allow rule for the runner command cannot release it", async () => {
		await loadPlugin(makeSettings([{ match: "bun run *", approval: "allow" }]));
		writeScript(root, "huge.ts", huge());
		const result = await gate("bun run huge.ts");
		expect(refusalOf(result).layer).toBe("script-body");
	});

	test("a word the runner does not resolve to a file is still passed over", async () => {
		// `bun run dev` reads package.json, not ./dev.
		fs.mkdirSync(path.join(root, "dev"));
		expect(await gate("bun run dev")).toBe("ALLOWED");
	});
});

describe("the directory the shell will be in", () => {
	// Round 1 review: the scan resolved every operand against the session's own
	// directory, so `cd /tmp; python3 payload.py` read nothing at all — the
	// shell changed directory and ran /tmp/payload.py while the gate judged the
	// command text.
	test("a semicolon-separated cd decides where the program is read from", () => {
		writeScript(outside, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside}; python3 payload.py`, root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["payload.py"]);
		expect(read.text).toContain('print("scratch probe ok")');
	});

	test("a leading cd && is applied on top of the directory the command starts in", () => {
		writeScript(outside, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside} && python3 payload.py`, root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["payload.py"]);
	});

	test("a newline-separated cd counts too, and a relative target chains", () => {
		const nested = path.join(outside, "nested");
		fs.mkdirSync(nested);
		writeScript(nested, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside}\ncd nested\npython3 payload.py`, root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["payload.py"]);
	});

	test("a cd inside a pipe stage does not move the next stage", () => {
		writeScript(outside, "payload.py", BENIGN);
		// A pipeline stage is a subshell: the runner's own directory is unchanged.
		const read = readInterpretedScriptBodies(`cd ${outside} | python3 payload.py`, root, 8000);
		expect(read.bodies).toEqual([]);
	});

	test("a cd this scan cannot resolve refuses the later program instead of guessing", () => {
		const read = readInterpretedScriptBodies('cd "$DIR"; python3 payload.py', root, 8000);
		expect(read.refusal?.why).toContain("payload.py");
	});

	test("the body of a script reached through a cd is what the gate judges", async () => {
		writeScript(outside, "payload.py", HARMFUL_CODE);
		const result = await gate(`cd ${outside}; python3 payload.py`);
		expect(refusalOf(result).why).toContain("flags: python3 runs payload.py");
	});

	// Round 2 review: the walk read a `||` terminator as "that cd failed", so
	// `cd /tmp || true; python3 payload.py` kept the starting directory and the
	// lookup read the wrong file — or, when the payload lived only in /tmp,
	// skipped it entirely and judged the command text. Whether a `cd` took
	// effect is not in the text: the branch runs on failure, and the shell
	// after the branch is in the moved-to directory or the old one.
	test("a cd on an '||' chain leaves the directory after the chain unknown, not stale", async () => {
		// The same name in both directories: before the fix the scan read the
		// one in the starting directory, which the interpreter never ran.
		writeScript(root, "payload.py", BENIGN);
		writeScript(outside, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside} || true; python3 payload.py`, root, 8000);
		expect(read.bodies).toEqual([]);
		expect(read.refusal?.why).toContain("payload.py");
		expect(read.refusal?.why).toContain("cannot be resolved from the command text");
	});

	test("the gate asks rather than judging text whose directory it cannot pin", async () => {
		writeScript(outside, "payload.py", HARMFUL_CODE);
		const result = await gate(`cd ${outside} || true; python3 payload.py`);
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("working directory");
	});

	test("the '||' branch itself is still read from the directory the cd found", () => {
		// The branch runs only if the `cd` failed, so its own directory IS in
		// the text: this is the case the deferred doubt must not break.
		writeScript(root, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside} || python3 payload.py`, root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["payload.py"]);
	});

	// Round 3 review: the round-2 fix closed the spelling it was shown (`cd
	// /tmp || true; …`) and not its class. The `||` BRANCH can move the shell
	// itself, and the `&&` after it gates the whole `||` chain rather than the
	// last `cd` in it: in `cd A || cd B && python3 payload.py` the second `cd`
	// runs only when the first FAILED, so the program runs in A when A exists
	// and in B when it does not. Reading B's payload.py was the wrong file
	// whenever A exists — and the walk had no way to know it was wrong.
	test("a cd on the '||' branch leaves the directory after the chain unknown too", () => {
		// The same name in three directories, so any single answer is a guess.
		const branch = path.join(outside, "branch");
		fs.mkdirSync(branch);
		writeScript(root, "payload.py", BENIGN);
		writeScript(outside, "payload.py", BENIGN);
		writeScript(branch, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside} || cd ${branch} && python3 payload.py`, root, 8000);
		expect(read.bodies).toEqual([]);
		expect(read.refusal?.why).toContain("payload.py");
		expect(read.refusal?.why).toContain("cannot be resolved from the command text");
	});

	test("a chained '||' with a plain separator after it is the same doubt", () => {
		// `cd A || cd B; …`: the branch may or may not have run, so the shell
		// after the chain is in A or in B.
		const branch = path.join(outside, "branch");
		fs.mkdirSync(branch);
		writeScript(root, "payload.py", BENIGN);
		writeScript(outside, "payload.py", BENIGN);
		writeScript(branch, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside} || cd ${branch}; python3 payload.py`, root, 8000);
		expect(read.bodies).toEqual([]);
		expect(read.refusal?.why).toContain("cannot be resolved from the command text");
	});

	test("the gate asks rather than judging text whose directory it cannot pin", async () => {
		const branch = path.join(outside, "branch");
		fs.mkdirSync(branch);
		writeScript(outside, "payload.py", HARMFUL_CODE);
		writeScript(branch, "payload.py", BENIGN);
		const result = await gate(`cd ${outside} || cd ${branch} && python3 payload.py`);
		expect(refusalOf(result).layer).toBe("script-body");
		expect(refusalOf(result).why).toContain("working directory");
	});

	test("a cd chain continued by '&&' still names its last directory", () => {
		// The precise half the doubt must not swallow: after `cd A && cd B &&`
		// the next segment runs only if B ran and moved, so B's directory is a
		// fact in the text.
		const nested = path.join(outside, "nested");
		fs.mkdirSync(nested);
		writeScript(nested, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`cd ${outside} && cd nested && python3 payload.py`, root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["payload.py"]);
		expect(read.text).toContain('print("scratch probe ok")');
	});

	// Round 4 review: the doubt was asked for too often. A `&&` arm may not
	// run, but when it cannot MOVE the shell it leaves the shell in the same
	// place either way — `: && :; python3 payload.py` has exactly one possible
	// directory, and the reader refused it (and the gate blocked before any
	// classification) for a doubt the text does not carry.
	test("a conditional chain that cannot move the shell keeps the known directory", () => {
		writeScript(root, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(": && :; python3 payload.py", root, 8000);
		expect(read.bodies.map(b => b.operand)).toEqual(["payload.py"]);
		expect(read.text).toContain('print("scratch probe ok")');
	});

	test("the gate reads the body of a chain that cannot move it", async () => {
		writeScript(root, "payload.py", HARMFUL_CODE);
		const result = await gate(": && :; python3 payload.py");
		// The flag can only come from the body, which is what the refusal proves
		// was read: before the fix this blocked as an unresolvable directory.
		expect(refusalOf(result).why).toContain("python3 runs payload.py");
	});

	test("a conditional arm that CAN move the shell keeps its doubt", () => {
		// The boundary the round-4 fix must not cross, as the neighbouring
		// spelling of the case it fixes: here the `&&` arm moves the directory,
		// and whether it ran — its condition is a program that can fail —
		// decides where the program runs.
		writeScript(root, "payload.py", BENIGN);
		writeScript(outside, "payload.py", BENIGN);
		const read = readInterpretedScriptBodies(`make build && cd ${outside}; python3 payload.py`, root, 8000);
		expect(read.bodies).toEqual([]);
		expect(read.refusal?.why).toContain("cannot be resolved from the command text");
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
