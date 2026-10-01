/**
 * Spec step 1b. The common unreadable spawn cwd is a name bound once to a
 * literal (`cwd = "/…"` then `subprocess.run(…, cwd=cwd)`). The scan reads
 * that one shape and nothing near it. `evalSpawnCwd` is tested alone first,
 * the adversarial matrix included; the plugin path follows.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { evalSpawnCwd, type DecisionRecord } from "../index";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeSettings, modelCalls, removeConfigFile, setJevAnswer, stateOf, useTempConfigFile } from "./fixtures";

const SESSION = "/workspace";
const literal = (code: string) => evalSpawnCwd(code, SESSION);
const opaqueWhy = (code: string): string => {
	const scan = evalSpawnCwd(code, SESSION);
	expect(scan.kind).toBe("opaque");
	return scan.kind === "opaque" ? scan.why : "";
};

describe("evalSpawnCwd reads a name bound once to a literal", () => {
	test("a name bound once at top level resolves", () => {
		expect(literal(`import subprocess\ncwd = "/tmp/wt"\nsubprocess.run(["git", "status"], cwd=cwd)`)).toEqual({ kind: "literal", cwd: "/tmp/wt" });
		expect(literal(`import subprocess\nwt = "/tmp/wt2"  # the worktree\nsubprocess.run(["ls"], cwd=wt)`)).toEqual({ kind: "literal", cwd: "/tmp/wt2" });
		expect(literal(`const cp = require("child_process");\nconst cwd = "/tmp/js";\ncp.execSync("ls", { cwd });`)).toEqual({ kind: "literal", cwd: "/tmp/js" });
		expect(literal(`R = "/tmp/rb"\nsystem("ls", chdir: R)`)).toEqual({ kind: "literal", cwd: "/tmp/rb" });
		expect(literal(`W = "/tmp/rbw"\nDir.chdir(W) do\n  system("ls")\nend`)).toEqual({ kind: "literal", cwd: "/tmp/rbw" });
		// A relative binding resolves where the spawn runs, like an inline literal.
		expect(literal(`import subprocess\ncwd = "sub"\nsubprocess.run(["ls"], cwd=cwd)`)).toEqual({ kind: "literal", cwd: "/workspace/sub" });
		// A string that merely spells a rebinding is text, not code.
		expect(literal(`import subprocess\ncwd = "/tmp/a"\nprint("cwd = '/evil'")\nsubprocess.run(["ls"], cwd=cwd)`)).toEqual({ kind: "literal", cwd: "/tmp/a" });
		// A function defined after the binding that only reads the name.
		expect(literal(`import subprocess\ncwd = "/tmp/fn"\ndef go():\n    subprocess.run(["ls"], cwd=cwd)\ngo()`)).toEqual({ kind: "literal", cwd: "/tmp/fn" });
	});

	test("reassignment anywhere keeps it unreadable", () => {
		expect(opaqueWhy(`import subprocess\ncwd = "/tmp/a"\ncwd = "/tmp/b"\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess, os\ncwd = "/tmp/a"\nsubprocess.run(["ls"], cwd=cwd)\ncwd = os.environ["X"]`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\ncwd = "/tmp/a"\ncwd += "/b"\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`cwd = "/tmp/a"\ncwd ||= "/tmp/b"\nsystem("ls", chdir: cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\ncwd = "/tmp/a"\nhelper(cwd=cwd)\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
	});

	test("a name shadowed in a nested scope stays opaque", () => {
		expect(opaqueWhy(`import subprocess, os\ncwd = "/tmp/a"\ndef go(cwd):\n    subprocess.run(["ls"], cwd=cwd)\ngo(os.environ["X"])`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\nfor cwd in ["/a", "/b"]:\n    subprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\ncwd = "/tmp/a"\n[subprocess.run(["ls"], cwd=cwd) for cwd in dirs]`)).toContain("not a literal (cwd)");
	});

	test("global rebinding inside a function stays opaque", () => {
		expect(opaqueWhy(`import subprocess\ncwd = "/tmp/a"\ndef move():\n    global cwd\n    cwd = "/"\nmove()\nsubprocess.run(["rm", "-rf", "."], cwd=cwd)`)).toContain("not a literal (cwd)");
	});

	test("a binding that is not straight-line stays opaque", () => {
		expect(opaqueWhy(`import subprocess\ndef setup():\n    cwd = "/tmp/a"\n    subprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\nif flag:\n    cwd = "/tmp/a"\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`if flag\ncwd = "/tmp/a"\nend\nsystem("ls", chdir: cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`if flag\nputs 1\ncwd = "/tmp/a"\nend\nsystem("ls", chdir: cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`const cp = require("child_process");\nif (flag)\ncwd = "/tmp/a"\ncp.execSync("ls", { cwd });`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`const cp = require("child_process");\n{ const cwd = "/tmp/a"; }\ncp.execSync("ls", { cwd });`)).toContain("not a literal (cwd)");
	});

	test("anything but one string literal stays opaque", () => {
		expect(opaqueWhy(`import subprocess\nW = f"{H}/scripts"\nsubprocess.run(["ls"], cwd=W)`)).toContain("not a literal (W)");
		expect(opaqueWhy(`import subprocess, os\ncwd = os.getcwd()\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\ncwd = base + "/x"\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\ncwd, other = "/a", "/b"\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`import subprocess\nk = {"cwd": "/tmp"}\nsubprocess.run(["ls"], **k)`)).toContain("not a literal");
		expect(opaqueWhy(`import subprocess\nsubprocess.run(["ls"], cwd=cwd)\ncwd = "/tmp/late"`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`const cp = require("child_process");\nvar cwd = "/tmp/var";\ncp.execSync("ls", { cwd });`)).toContain("not a literal (cwd)");
		// No binding at all: the shorthand still names a variable nobody set.
		expect(opaqueWhy(`spawn(file, args, { cwd })`)).toContain("not a literal (cwd)");
	});

	test("scope escapes keep every binding unread", () => {
		expect(opaqueWhy(`import subprocess\ncwd = "/tmp/a"\nglobals()["cwd"] = "/evil"\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`const cp = require("child_process");\nlet cwd = "/tmp/a";\neval("cwd = '/evil'");\ncp.execSync("ls", { cwd });`)).toContain("not a literal (cwd)");
		expect(opaqueWhy(`const cp = require("child_process");\nconst cwd = "/tmp/a";\nwith (o) { cp.execSync("ls", { cwd }); }`)).toContain("not a literal (cwd)");
	});

	test("a bare exec anywhere keeps every binding unread", () => {
		// A deliberate false ask: a bare `exec` may be Python's, which rebinds
		// names by string. The qualified `cp.exec` above is not one.
		expect(opaqueWhy(`const { exec } = require("child_process");\nconst cwd = "/tmp/a";\nexec("ls", { cwd });`)).toContain("not a literal (cwd)");
	});

	test("a binding to a non-directory is unreadable", () => {
		expect(opaqueWhy(`import subprocess\ncwd = ""\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("does not name a directory");
		expect(opaqueWhy(`import subprocess\ncwd = "local://x"\nsubprocess.run(["ls"], cwd=cwd)`)).toContain("does not name a directory");
	});

	test("two spawns on one binding agree; a second literal elsewhere still disagrees", () => {
		expect(literal(`import subprocess\ncwd = "/tmp/two"\nsubprocess.run(["ls"], cwd=cwd)\nsubprocess.run(["pwd"], cwd=cwd)`)).toEqual({ kind: "literal", cwd: "/tmp/two" });
		expect(opaqueWhy(`import subprocess\ncwd = "/tmp/a"\nsubprocess.run(["ls"], cwd=cwd)\nsubprocess.run(["pwd"], cwd="/tmp/b")`)).toContain("different directories");
	});
});

describe("the eval gate judges a bound cwd where it runs", () => {
	let dir = "";
	let seq = 0;
	const decisions = (): DecisionRecord[] =>
		fs
			.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
			.split("\n")
			.filter(line => line.trim() !== "")
			.map(line => JSON.parse(line) as DecisionRecord);
	beforeEach(async () => {
		removeConfigFile();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-binding-"));
		process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
		await loadPlugin(makeSettings([]));
		setJevAnswer(jevSafeAnswer());
	});
	afterEach(() => {
		process.env.OMP_JEV_CONFIG = useTempConfigFile();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const evalCall = (code: string) => ({ toolName: "eval", input: { code, language: "py" } });

	test("the bound directory is the judged one", async () => {
		const result = await fire("tool_call", evalCall(`import subprocess\ncwd = "/tmp/wt-e2e"\nsubprocess.run(["git", "status"], cwd=cwd)`), makeCtx({ sessionId: `binding-${++seq}` }));
		expect(result).toBeUndefined();
		expect(stateOf(0).workingDirectory).toBe("/tmp/wt-e2e");
		expect(decisions()[0]).toMatchObject({ layer: "verdict", spawnCwd: "/tmp/wt-e2e", cwd: "/tmp/wt-e2e" });
	});

	test("a reassigned name still asks without judging", async () => {
		await fire("tool_call", evalCall(`import subprocess, os\ncwd = "/tmp/a"\ncwd = os.environ["X"]\nsubprocess.run(["ls"], cwd=cwd)`), makeCtx({ sessionId: `binding-${++seq}` }));
		expect(modelCalls).toHaveLength(0);
		expect(decisions()[0]).toMatchObject({ layer: "cwd", decision: "block" });
		expect(decisions()[0].why).toContain("not a literal (cwd)");
	});
});
