/**
 * Stage 2 and a Python interpreter (docs/plans/2026-10-27-stage-2-reviewer.md,
 * "Shape C"). A venv's `bin/python` links into a user-owned install, so the
 * root-owned-chain check refused it as "a binary", and with it every
 * `python -c`, `python - <<'PY'` and `python x.py` an agent runs. The gate
 * now admits one Python run when it can tell the program is a real
 * interpreter and can see every module the code imports. Each test is one
 * failure-matrix row. The interpreters here are fakes: a native-executable
 * header and padding, never run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DecisionRecord } from "../index";
import { fire, jevUnsureAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, REVIEWER_TEST_MODEL, refusalOf, removeConfigFile, resetReviewer, resultText, reviewerCalls, reviewerReply, scriptReviewer, setJevAnswer, setJevAnsweringApi } from "./fixtures";

type Entry = { type: string; id?: string; message?: Record<string, unknown> };

let dir = "";
let seq = 0;
const nextSession = (): string => `reviewer-python-${(seq += 1)}`;
const user = (id: string, content: string): Entry => ({ type: "message", id, message: { role: "user", attribution: "user", content } });
const uiCtx = (sessionId: string, branch: Entry[], cwd = dir) => makeCtx({ sessionId, hasUI: true, branch, cwd });
const words = [user("u1", "run the probe")];

const readDecisions = (): DecisionRecord[] =>
	fs
		.readFileSync(path.join(dir, "decisions.jsonl"), "utf8")
		.split("\n")
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as DecisionRecord);
const reviewerAudit = (): Record<string, unknown> | undefined =>
	readDecisions()
		.map(line => (line as unknown as { reviewer?: Record<string, unknown> }).reviewer)
		.filter(entry => entry !== undefined)
		.at(-1);

/** A 64-bit little-endian Mach-O header, then padding: what the gate reads of a real interpreter. */
const MACHO = Buffer.concat([Buffer.from("cffaedfe0c000001", "hex"), Buffer.alloc(120)]);
const ELF = Buffer.concat([Buffer.from("7f454c460201", "hex"), Buffer.alloc(120)]);

function write(rel: string, content: string | Buffer, mode = 0o644): string {
	const file = path.join(dir, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	fs.chmodSync(file, mode);
	return file;
}

/** An install under `base/`: the interpreter, its standard library, its site-packages. */
function fakeInstall(base = "base", interpreter: string | Buffer = MACHO): string {
	const python = write(`${base}/bin/python3.12`, interpreter, 0o755);
	for (const module of ["json/__init__.py", "pathlib.py", "platform.py", "io.py", "logging/__init__.py", "threading.py", "operator.py", "urllib/request.py", "tarfile.py", "sys.py", "pickle.py", "importlib/__init__.py", "_posixsubprocess.py", "re/__init__.py", "os.py", "shutil.py", "subprocess.py", "importlib/__init__.py", "xml/etree/ElementTree.py", "collections/__init__.py"]) write(`${base}/lib/python3.12/${module}`, "");
	write(`${base}/lib/python3.12/lib-dynload/_json.cpython-312-darwin.so`, "");
	write(`${base}/lib/python3.12/site-packages/requests/__init__.py`, "");
	return python;
}

/** A venv over `python`, the way `python -m venv` lays one out. */
function fakeVenv(python: string, venv = "venv", home = path.dirname(python), systemSite = false): string {
	fs.mkdirSync(path.join(dir, venv, "bin"), { recursive: true });
	fs.symlinkSync(python, path.join(dir, venv, "bin", "python3.12"));
	fs.symlinkSync("python3.12", path.join(dir, venv, "bin", "python"));
	fs.symlinkSync("python3.12", path.join(dir, venv, "bin", "python3"));
	write(`${venv}/pyvenv.cfg`, `home = ${home}\ninclude-system-site-packages = ${systemSite}\nversion = 3.12.2\n`);
	write(`${venv}/lib/python3.12/site-packages/pytest/__init__.py`, "");
	return path.join(dir, venv, "bin", "python");
}

beforeEach(async () => {
	removeConfigFile();
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-reviewer-python-")));
	process.env.OMP_JEV_CONFIG = path.join(dir, "omp-classifier.json");
	fs.writeFileSync(process.env.OMP_JEV_CONFIG, JSON.stringify({ reviewerModel: REVIEWER_TEST_MODEL }));
	await loadPlugin(makeSettings([]));
	resetReviewer();
	setJevAnsweringApi();
	setJevAnswer(jevUnsureAnswer());
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function expectReviewed(command: string, cwd = dir): Promise<void> {
	scriptReviewer(reviewerReply("allow", "run the probe"));
	const result = await fire("tool_call", makeEvent(command), uiCtx(nextSession(), words, cwd));
	expect(reviewerAudit()).toMatchObject({ decision: "allow" });
	expect(resultText(result)).toBe("ALLOWED");
	expect(reviewerCalls).toHaveLength(1);
}

async function expectRefused(command: string, why: string, cwd = dir): Promise<void> {
	const result = await fire("tool_call", makeEvent(command), uiCtx(nextSession(), words, cwd));
	expect(refusalOf(result).layer).toBe("unsure");
	expect(reviewerCalls).toHaveLength(0);
	expect(reviewerAudit()).toMatchObject({ skipped: expect.stringContaining(why) });
}

describe("a venv interpreter the gate can identify", () => {
	test("python -c: the code is in the command, and no body is read", async () => {
		const python = fakeVenv(fakeInstall());
		await expectReviewed(`${python} -c "import json, pathlib; print(json.dumps(pathlib.Path('.').name))"`);
		expect(reviewerCalls[0].input.scriptBodies).toEqual([]);
		expect(reviewerCalls[0].input.command).toContain("import json, pathlib");
	});

	test("python - with a quoted here-document, after a cd: the body is in the command", async () => {
		const python = fakeVenv(fakeInstall());
		fs.mkdirSync(path.join(dir, "work"));
		await expectReviewed(`cd work && ${python} - <<'PY'\nimport re, pathlib\nimport xml.etree.ElementTree\nprint(re.sub("a", "b", "abc"))\nPY`);
		expect(reviewerCalls[0].input.scriptBodies).toEqual([]);
		expect(reviewerCalls[0].input.command).toContain('print(re.sub("a", "b", "abc"))');
	});

	test("a here-document that reads a .py file and edits its text with str.replace", async () => {
		const python = fakeVenv(fakeInstall());
		await expectReviewed(`${python} - <<'PY'\nimport pathlib\nt = pathlib.Path("tests/test_page.py").read_text()\nprint(t.replace("a", "b"))\nPY`);
	});

	test("python x.py under a timeout, into an output filter: the body is read", async () => {
		const python = fakeVenv(fakeInstall());
		write(".scratch/build_page.py", "import json\nfrom pathlib import Path\nprint('from-build')\n");
		await expectReviewed(`timeout 2400 ${python} -u .scratch/build_page.py --write 2>&1 | tail -5`);
		expect(JSON.stringify(reviewerCalls[0].input.scriptBodies)).toContain("from-build");
	});

	test("python x.py where x.py has no extension and no shebang", async () => {
		const python = fakeVenv(fakeInstall());
		write("probe", "import json\nprint('from-probe')\n");
		await expectReviewed(`${python} probe`);
		expect(JSON.stringify(reviewerCalls[0].input.scriptBodies)).toContain("from-probe");
	});

	test("python -m on a module installed in the venv runs like `bun test`", async () => {
		const python = fakeVenv(fakeInstall());
		await expectReviewed(`${python} -m pytest tests/test_page.py -q 2>&1 | tail -25`);
		expect(reviewerCalls[0].input.scriptBodies).toEqual([]);
	});

	test("an import from the venv's site-packages is refused: the reviewer cannot read it", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} -c "import pytest"`, "imports pytest, which is not in the standard library");
	});

	test("a venv over an ELF interpreter", async () => {
		const python = fakeVenv(fakeInstall("base", ELF));
		await expectReviewed(`${python} -c "import json"`);
	});

	test("a bare python3 that PATH resolves into an activated venv", async () => {
		fakeVenv(fakeInstall());
		const previous = process.env.PATH;
		process.env.PATH = `${path.join(dir, "venv", "bin")}${path.delimiter}${previous ?? ""}`;
		try {
			await expectReviewed(`python3 -c "import json"`);
		} finally {
			process.env.PATH = previous;
		}
	});

	test("a relative venv path resolves from the cd", async () => {
		fs.mkdirSync(path.join(dir, "repo"));
		fakeVenv(fakeInstall(), "repo/.venv");
		await expectReviewed(`cd repo && .venv/bin/python -c "import json"`);
	});

	test("an allow fails when the script changes after the read", async () => {
		const python = fakeVenv(fakeInstall());
		const file = write("probe.py", "print('before')\n");
		scriptReviewer(async () => {
			fs.writeFileSync(file, "import os\nos.system('id')\n");
			return reviewerReply("allow", "run the probe");
		});
		const result = await fire("tool_call", makeEvent(`${python} probe.py`), uiCtx(nextSession(), words));
		expect(refusalOf(result).layer).toBe("unsure");
		expect(reviewerAudit()).toMatchObject({ failed: expect.stringContaining("changed") });
	});
});

describe("a program the gate cannot tell is Python stays refused", () => {
	test("a shell script named python3.12 in a venv is read as the shell script it is", async () => {
		const python = fakeVenv(fakeInstall("base", "#!/bin/sh\necho not-python\n"));
		await expectReviewed(`${python} -c "import json"`);
		expect(JSON.stringify(reviewerCalls[0].input.scriptBodies)).toContain("echo not-python");
	});

	test("a shell script named python3.12 that runs another file stays refused", async () => {
		const python = fakeVenv(fakeInstall("base", "#!/bin/sh\nexec ./payload \"$@\"\n"));
		await expectRefused(`${python} -c "import json"`, "unread script");
	});

	test("a native binary with no pyvenv.cfg beside its bin/", async () => {
		const python = fakeInstall();
		await expectRefused(`${python} -c "import json"`, "a binary");
	});

	test("a venv whose pyvenv.cfg names another home", async () => {
		const elsewhere = fakeInstall("other");
		fakeInstall();
		const python = fakeVenv(path.join(dir, "base", "bin", "python3.12"), "venv", path.dirname(elsewhere));
		await expectRefused(`${python} -c "import json"`, "a binary");
	});

	test("a native binary in a venv that is not named python", async () => {
		const python = fakeInstall();
		fakeVenv(python);
		const tool = write("base/bin/tool", MACHO, 0o755);
		fs.symlinkSync(tool, path.join(dir, "venv", "bin", "tool"));
		await expectRefused(`${path.join(dir, "venv", "bin", "tool")} -c "import json"`, "a binary");
	});

	test("a bare python3 on PATH outside any venv", async () => {
		fakeInstall();
		const previous = process.env.PATH;
		fs.symlinkSync(path.join(dir, "base", "bin", "python3.12"), path.join(dir, "base", "bin", "python3"));
		process.env.PATH = `${path.join(dir, "base", "bin")}${path.delimiter}${previous ?? ""}`;
		try {
			await expectRefused(`python3 -c "import json"`, "python3 runs a program the gate does not read");
		} finally {
			process.env.PATH = previous;
		}
	});
});

describe("a spawn the body spells out is the reviewer's to judge", () => {
	// The reviewer reads the body and treats what it hands off to as unknown;
	// the gate does not recognize spawns by name. Stage 1's INTERPRETER_CODE_RISK
	// overlay still flags them after an allow, so only the review is checked.
	test.each([
		["subprocess", "import subprocess; subprocess.run(['./x.sh'])"],
		["os.system", "import os; os.system('./x.sh')"],
		["a spawn imported by name", "from os import execv; execv('/bin/sh', ['sh'])"],
	])("python -c with %s reaches the reviewer", async (_name, code) => {
		const python = fakeVenv(fakeInstall());
		scriptReviewer(reviewerReply("block"));
		await fire("tool_call", makeEvent(`${python} -c "${code}"`), uiCtx(nextSession(), words));
		expect(reviewerCalls).toHaveLength(1);
		expect(reviewerCalls[0].input.command).toContain(code);
	});
});

describe("Python the gate cannot read all of stays refused", () => {
	test.each([
		["a local module next to the code", "import helpers", "imports the local module helpers"],
		["a local module shadowing the standard library", "import json", "shadows the standard library"],
		["a relative import", "from . import helpers", "relative import"],
		["a module the interpreter does not have", "import notinstalled", "imports notinstalled"],
		["exec", "exec(open('payload.txt').read())", "uses exec"],
		["eval", "eval(input())", "uses eval"],
		["__import__", "__import__('subprocess')", "__import__"],
		["importlib", "import importlib; importlib.import_module('helpers')", "importlib"],
		["an import path edit", "import sys; sys.path.insert(0, 'scripts')", "sys.path"],
		["reflection by a computed name", "import os; getattr(os, 'sys' + 'tem')('id')", "getattr"],
		["a deserializer that runs code", "import pickle; pickle.load(open('x', 'rb'))", "pickle"],
		["a string run as code by the standard library", "import timeit; timeit.timeit(open('x').read())", "timeit"],
	])("python -c with %s", async (_name, code, why) => {
		const python = fakeVenv(fakeInstall());
		write("helpers.py", "import os\nos.system('id')\n");
		if (code === "import json") write("json.py", "import os\nos.system('id')\n");
		await expectRefused(`${python} -c "${code.replaceAll('"', '\\"')}"`, why);
	});

	test("a script that imports a module next to it", async () => {
		const python = fakeVenv(fakeInstall());
		write("tools/run.py", "import round_trip\nround_trip.main()\n");
		write("tools/round_trip.py", "import os\nos.system('id')\n");
		await expectRefused(`${python} tools/run.py`, "imports the local module round_trip");
	});

	test("-m on a module in the working directory", async () => {
		const python = fakeVenv(fakeInstall());
		write("scripts/__init__.py", "");
		write("scripts/flow.py", "print('x')\n");
		await expectRefused(`timeout 2400 ${python} -m scripts.flow "a name" 2>&1 | tail -40`, "local module scripts");
	});

	test("-m on a module that runs a file or string it is handed", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} -m runpy payload.py`, "runpy");
	});

	test("an unquoted here-document delimiter: the shell expands the body", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} - <<PY\nprint("$SECRET_VALUE")\nPY`, "reads a redirect");
	});

	test("an unquoted here-document delimiter whose body runs a command substitution", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} - <<PY\nprint("$(cat payload.txt)")\nPY`, "unread script");
	});

	test("a quoted here-document on a file descriptor other than stdin", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} - 3<<'PY'\nprint(1)\nPY`, "reads a redirect");
	});

	test("a here-string", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} - <<< 'print(1)'`, "reads a redirect");
	});

	test("stdin from a file", async () => {
		const python = fakeVenv(fakeInstall());
		write("payload.py", "print(1)\n");
		await expectRefused(`${python} - < payload.py`, "reads a redirect");
	});

	test("a script run with a here-document on stdin as well", async () => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", "import sys\nprint(sys.stdin)\n");
		await expectRefused(`${python} probe.py <<'PY'\nprint(1)\nPY`, "reads a redirect");
	});

	test("python - with nothing on stdin", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} -`, "stdin");
	});

	test.each([
		["-W", "-W error -c 'import json'"],
		["-X", "-X dev -c 'import json'"],
		["a long option", "--check-hash-based-pycs always -c 'import json'"],
		["-c clustered with a flag", "-uc 'import json'"],
	])("an interpreter option the gate does not know: %s", async (_name, args) => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} ${args}`, "option");
	});

	test("code built at run time", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`${python} -c "$CODE"`, "built at run time");
	});

	test("an assignment before the interpreter", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`PYTHONPATH=. ${python} -c "import json"`, "assignment");
	});

	test("PYTHONPATH in the environment the command inherits", async () => {
		const python = fakeVenv(fakeInstall());
		const previous = process.env.PYTHONPATH;
		process.env.PYTHONPATH = dir;
		try {
			await expectRefused(`${python} -c "import json"`, "PYTHONPATH");
		} finally {
			if (previous === undefined) delete process.env.PYTHONPATH;
			else process.env.PYTHONPATH = previous;
		}
	});
});

describe("a Python script run by its shebang reads under the same rules", () => {
	test("one naming a venv interpreter that only uses the standard library is reviewed", async () => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", `#!${python} -u\nimport json\nprint('from-shebang')\n`, 0o755);
		await expectReviewed("./probe.py");
		expect(JSON.stringify(reviewerCalls[0].input.scriptBodies)).toContain("from-shebang");
	});

	test("one reaching a venv interpreter through env and PATH is reviewed", async () => {
		fakeVenv(fakeInstall());
		write("probe.py", "#!/usr/bin/env python3\nimport json\n", 0o755);
		const previous = process.env.PATH;
		process.env.PATH = `${path.join(dir, "venv", "bin")}${path.delimiter}${previous ?? ""}`;
		try {
			await expectReviewed("./probe.py");
		} finally {
			process.env.PATH = previous;
		}
	});

	test("one that writes to a computed path is refused", async () => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", `#!${python}\nimport pathlib, sys\npathlib.Path(sys.argv[1]).write_text('x')\n`, 0o755);
		await expectRefused("./probe.py", "path built at run time");
	});

	test("one that imports a module next to it is refused", async () => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", `#!${python}\nimport helpers\n`, 0o755);
		write("helpers.py", "import os\nos.system('id')\n");
		await expectRefused("./probe.py", "imports the local module helpers");
	});

	// The script's directory comes first on sys.path, so a local file named
	// like any stdlib module wins for every import of it, including the ones
	// stdlib modules make among themselves (`json` imports `re`).
	test.each([
		["a module file", "re.py"],
		["a package directory", "collections/__init__.py"],
		["a compiled file", "os.pyc"],
	])("one whose directory holds a stdlib-named %s is refused, even unimported", async (_name, shadow) => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", `#!${python}\nimport json\n`, 0o755);
		write(shadow, "import os\nos.system('id')\n");
		await expectRefused("./probe.py", "shadows the standard library");
	});

	test("python -m with a stdlib-named file in the working directory is refused", async () => {
		const python = fakeVenv(fakeInstall());
		write("re.py", "import os\nos.system('id')\n");
		await expectRefused(`${python} -m json.tool data.json`, "shadows the standard library");
	});

	test("an env shebang names env by a path that is not a system program", async () => {
		const python = fakeVenv(fakeInstall());
		const env = write("bin/env", "#!/bin/sh\nexec /bin/sh -c 'id'\n", 0o755);
		write("probe.py", `#!${env} python3\nimport json\n`, 0o755);
		expect(python).toContain("venv");
		await expectRefused("./probe.py", "names an env that is not a system program");
	});

	test("one that imports a module its interpreter does not have is refused", async () => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", `#!${python}\nimport notinstalled\n`, 0o755);
		await expectRefused("./probe.py", "imports notinstalled");
	});

	test.each([
		["env -S splitting more arguments", "#!/usr/bin/env -S python3 -c 'import os'"],
		["env with an assignment", "#!/usr/bin/env PYTHONPATH=. python3"],
		["-m", "#!__PY__ -m runpy"],
		["-c", "#!__PY__ -c 'import os'"],
		["-W", "#!__PY__ -W ignore"],
		["-X", "#!__PY__ -X dev"],
		["a python outside any venv", "#!__BASE__"],
		["a relative interpreter", "#!venv/bin/python"],
	])("one whose shebang the gate cannot read is refused: %s", async (_name, shebang) => {
		const base = fakeInstall();
		const python = fakeVenv(base);
		write("probe.py", `${shebang.replace("__PY__", python).replace("__BASE__", base)}\nimport json\n`, 0o755);
		await expectRefused("./probe.py", "shebang");
	});
});

describe("Python's own parse decides, so prose about imports is not an import", () => {
	test.each([
		["an import mentioned only in a comment", "# import helpers_missing\nimport json\nprint(1)\n"],
		["the word import in a string", "import json\nprint('import helpers_missing')\n"],
		["a docstring before the imports", '"""Probe."""\nimport json\nprint(json.dumps(1))\n'],
		["platform.system, which reads a name", "import platform\nprint(platform.system())\n"],
		["a utf-8 coding declaration", "# -*- coding: utf-8 -*-\nimport json\n"],
		["a write after every import", "import json, pathlib\npathlib.Path('out.json').write_text(json.dumps(1))\n"],
	])("%s is reviewed", async (_name, code) => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", code);
		await expectReviewed(`${python} probe.py`);
	});
});

describe("the gate's four guarantees hold however the code is spelled", () => {
	test.each([
		// Every import is of the standard library and not shadowed locally.
		["a backslash-newline joining an import of a local module", "import \\\nhelpers\n", "imports the local module helpers"],
		["a form feed before an import of a missing module", "\fimport notinstalled\n", "imports notinstalled"],
		["a ) inside a comment in a parenthesized from-import", "from helpers import (  # )\n    run as r\n)\n", "imports the local module helpers"],
		["a # comment inside a parenthesized from-import", "from json import (loads,  # x\n    dumps)\nimport notinstalled\n", "imports notinstalled"],
		["an import inside a function", "def main():\n    import notinstalled\n", "imports notinstalled"],
		["an import inside try/except", "try:\n    import notinstalled\nexcept ImportError:\n    pass\n", "imports notinstalled"],
		["a private C module", "import _posixsubprocess\n", "private module _posixsubprocess"],
		["a site-packages module", "import requests\n", "imports requests, which is not in the standard library"],
		["a utf-7 coding declaration", "# -*- coding: utf-7 -*-\n+AGkAbQBwAG8AcgB0ACAAcwB1AGIAcAByAG8AYwBlAHMAcw-\n", "declares the encoding utf-7"],
		["a coding declaration on line 2", "#!/usr/bin/env python3\n# vim: set fileencoding=utf-7 :\nprint(1)\n", "declares the encoding utf-7"],
		["code that does not parse", "def broken(:\n", "could not parse"],
		// No code runs from a string, a computed name or bytes on disk.
		["reflection through __dict__", "import os\nos.__dict__['sys' + 'tem']('id')\n", "__dict__"],
		["getattr", "import os\ngetattr(os, 'sys' + 'tem')('id')\n", "getattr"],
		["unpickling", "import pickle\n", "imports pickle"],
		["importlib by an imported name", "from importlib import import_module\n", "imports importlib"],
		// Nothing touches where imports come from.
		["sys.path", "import sys\nsys.path.insert(0, 'scripts')\n", "sys.path"],
		["sys.path through a rebinding", "import sys\ns = sys\ns.path.insert(0, 'scripts')\n", "passes the sys module around"],
		["sys.path through an import alias", "import sys as s\ns.path.insert(0, 'scripts')\n", "imports sys as s"],
		["sys.path imported by name", "from sys import path\npath.insert(0, 'scripts')\n", "imports sys.path"],
		["sys.path through a function argument", "import sys\ndef f(m):\n    m.path.insert(0, 'x')\nf(sys)\n", "passes the sys module around"],
		["os rebound to sys, so os.path is sys.path", "import os, sys\nos = sys\nos.path.insert(0, 'x')\n", "rebinds os"],
		["sys bound to the name os by import", "import sys as os\nos.path.insert(0, 'x')\n", "binds os by import"],
		["platform rebound to os", "import os\nplatform = os\nplatform.system('id')\n", "passes the os module around"],
		["sys.modules", "import sys, json\nsys.modules['json'] = None\n", "sys.modules"],
		// No write lands on a computed path or a module file name.
		["a module file written and then imported", "import json\nopen('json.py', 'w').write('import os')\n", "writes json.py"],
		["a file moved onto a module name", "import pathlib\npathlib.Path('payload.txt').replace('json.py')\n", "writes json.py"],
		["a computed write target", "import pathlib\npathlib.Path('js' + 'on.py').write_text('x')\n", "path built at run time"],
		["a write with a computed mode to a module file", "import sys\nopen('json.py', sys.argv[1])\n", "writes json.py"],
		["a package __init__ written", "import os\nos.makedirs('json', exist_ok=True)\nopen('json/__init__.py', 'w')\n", "writes json/__init__.py"],
		["a shutil copy onto a module name", "import shutil\nshutil.copy('payload.txt', 'json.py')\n", "writes json.py"],
		["a shutil copy to a computed path", "import shutil, sys\nshutil.copytree('a', sys.argv[1])\n", "path built at run time"],
		["an archive extracted", "import tarfile\ntarfile.open('x.tar').extractall()\n", "imports tarfile"],
		// The fourth security round: each is a write the allowlist must catch.
		["str.replace with computed arguments (a possible Path.replace)", "import sys\nprint(sys.argv[0].replace(sys.argv[1], 'x'))\n", "path built at run time"],
		["io.FileIO opened for writing", "import io\nio.FileIO('json.py', 'w')\n", "writes json.py"],
		["urlretrieve to a computed path", "import sys, urllib.request\nurllib.request.urlretrieve('https://example.com/x', sys.argv[1])\n", "path built at run time"],
		["a logging file handler", "import logging\nlogging.FileHandler('json.py')\n", "writes json.py"],
		["a target= keyword", "import sys, threading\nthreading.Thread(target=sys.exit)\n", "path built at run time"],
		["a write function named without a call", "import pathlib\nw = pathlib.Path.write_text\n", "without calling it"],
		["a copy into a directory named like a module", "import shutil\nshutil.copytree('payload', 'json')\n", "under a name an import could load"],
		["a copy into sys.path[0] itself", "import shutil\nshutil.copytree('payload', '.', dirs_exist_ok=True)\n", "a directory on sys.path"],
		["a json.dump to an open file", "import json, sys\njson.dump({}, sys.stdout)\n", "path built at run time"],
		["a star import", "from sys import *\npath.insert(0, 'x')\n", "star import"],
		["operator.attrgetter", "import operator\noperator.attrgetter('system')\n", "attrgetter"],
		["attrgetter imported by name", "from operator import attrgetter\n", "attrgetter"],
		// The fifth security round.
		["an archive unpacked to a literal directory", "import shutil\nshutil.unpack_archive('x.tar', 'out')\n", "unpacks an archive"],
		["an archive member extracted", "import tarfile\ntarfile.open('x.tar').extract('m', path='out')\n", "imports tarfile"],
		["any call into zipfile", "import zipfile\nzipfile.ZipFile('x.zip').namelist()\n", "imports zipfile"],
		["logging.config", "import logging.config\n", "logging.config"],
		["logging.config imported by name", "from logging import config\n", "logging.config"],
		["pydoc", "import pydoc\n", "imports pydoc"],
		["os rebound by a match pattern", "import os, sys\nmatch sys:\n    case os:\n        os.path.insert(0, 'x')\n", "unread script"],
	])("%s", async (_name, code, why) => {
		const python = fakeVenv(fakeInstall());
		write("helpers.py", "import os\nos.system('id')\n");
		write("probe.py", code);
		await expectRefused(`${python} probe.py`, why);
	});

	test.each([
		["os.path", "import os\nprint(os.path.join('a', 'b'))\n"],
		["from os import path", "from os import path\nprint(path.join('a', 'b'))\n"],
		["a write to a literal path", "import json, pathlib\npathlib.Path('out.json').write_text(json.dumps(1))\n"],
		["a write through open with a literal path", "with open('out.txt', 'w') as f:\n    f.write('x')\n"],
		["a read through open with a computed path", "import sys\nprint(open(sys.argv[1]).read())\n"],
		["str.replace with literal arguments", "import sys\nprint(sys.argv[0].replace('a', 'b'))\n"],
		["platform.system", "import platform\nprint(platform.system())\n"],
		["an import inside a function, of the standard library", "def main():\n    import json\n    print(json.dumps(1))\nmain()\n"],
		["a copy to a literal directory that is not a module name", "import shutil\nshutil.copytree('a', 'configs/out')\n"],
	])("%s is reviewed", async (_name, code) => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", code);
		await expectReviewed(`${python} probe.py`);
	});
});

describe("startup code the interpreter runs before the body stays refused", () => {
	test.each([
		["a .pth file with an import line in the base install's site-packages", "base/lib/python3.12/site-packages/hook.pth", "import os; os.system('id')\n", "runs an import line at interpreter startup"],
		["a sitecustomize in the base install's site-packages", "base/lib/python3.12/site-packages/sitecustomize.py", "import os\n", "sitecustomize.py runs at interpreter startup"],
		["a usercustomize in the standard library", "base/lib/python3.12/usercustomize.py", "import os\n", "usercustomize.py runs at interpreter startup"],
	])("%s", async (_name, rel, content, why) => {
		const python = fakeVenv(fakeInstall(), "venv", undefined, true);
		write(rel, content);
		await expectRefused(`${python} -c "import json"`, why);
	});

	test.each([
		["a path line, which adds a directory to sys.path", "/opt/extra\n", "adds a directory to sys.path"],
		["the word import past the start of a line", "  import os; os.system('id')\n", "runs an import line"],
		["a carriage return, which Python reads as a line break", "# note\rimport os\n".replace("import", "imp" + "ort"), "runs an import line"],
		["a carriage return alone", "# a\r# b\n", "line break the gate splits differently"],
		["a form feed", "# a\f\n", "line break the gate splits differently"],
		["a byte-order mark", "\uFEFF# a\n", "line break the gate splits differently"],
		["a Unicode line separator", "# a\u2028/opt/x\n", "line break the gate splits differently"],
	])("a .pth file in the base install's site-packages with %s refuses", async (_name, content, why) => {
		const python = fakeVenv(fakeInstall(), "venv", undefined, true);
		write("base/lib/python3.12/site-packages/hook.pth", content);
		await expectRefused(`${python} -c "import json"`, why);
	});

	test("a .pth file of comments and blank lines is fine", async () => {
		const python = fakeVenv(fakeInstall());
		write("venv/lib/python3.12/site-packages/notes.pth", "# nothing here\n\n");
		await expectReviewed(`${python} -c "import json"`);
	});

	test("a standard-library zip on sys.path that is not root-owned refuses, even under -S", async () => {
		const python = fakeVenv(fakeInstall());
		write("base/lib/python312.zip", "PK");
		await expectRefused(`${python} -S -c "import json"`, "python312.zip is on sys.path and not root-owned");
	});

	test.each([["PYTHONSAFEPATH"], ["PYTHONSTARTUP"], ["PYTHONWARNINGS"]])("%s set in the inherited environment refuses", async name => {
		const python = fakeVenv(fakeInstall());
		const previous = process.env[name];
		process.env[name] = "1";
		try {
			await expectRefused(`${python} -c "import json"`, `${name} is set`);
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	});

	test("PYTHONUNBUFFERED set in the inherited environment is fine", async () => {
		const python = fakeVenv(fakeInstall());
		const previous = process.env.PYTHONUNBUFFERED;
		process.env.PYTHONUNBUFFERED = "1";
		try {
			await expectReviewed(`${python} -c "import json"`);
		} finally {
			if (previous === undefined) delete process.env.PYTHONUNBUFFERED;
			else process.env.PYTHONUNBUFFERED = previous;
		}
	});

	test("a PYTHON* assignment prefix on the command refuses", async () => {
		const python = fakeVenv(fakeInstall());
		await expectRefused(`PYTHONSTARTUP=payload.py ${python} -c "import json"`, "assignment");
	});

	test.each([["zipfile"], ["tarfile"]])("python -m %s refuses", async module => {
		const python = fakeVenv(fakeInstall());
		write(`base/lib/python3.12/${module}.py`, "");
		await expectRefused(`${python} -m ${module} -e x.zip out`, `python -m ${module} runs a file or string`);
	});

	test("-S skips site, so a .pth import line does not run", async () => {
		const python = fakeVenv(fakeInstall());
		write("venv/lib/python3.12/site-packages/hook.pth", "import os; os.system('id')\n");
		await expectReviewed(`${python} -S -c "import json"`);
	});

	test("-I still runs site, so a base-install .pth import line refuses", async () => {
		const python = fakeVenv(fakeInstall(), "venv", undefined, true);
		write("base/lib/python3.12/site-packages/hook.pth", "import os; os.system('id')\n");
		await expectRefused(`${python} -I -c "import json"`, "runs an import line at interpreter startup");
	});

	test("a shebang script whose interpreter's base site-packages has a .pth import line", async () => {
		const python = fakeVenv(fakeInstall(), "venv", undefined, true);
		write("base/lib/python3.12/site-packages/hook.pth", "import os; os.system('id')\n");
		write("probe.py", `#!${python}\nimport json\n`, 0o755);
		await expectRefused("./probe.py", "runs an import line at interpreter startup");
	});

	// Sam, 2026-10-31 ("Trust user site-packages"): the venv's own
	// site-packages is the user's installed tooling, read like the stdlib.
	test.each([
		["a .pth import line", "venv/lib/python3.12/site-packages/distutils-precedence.pth", "import os; var = 'X'; enabled = os.environ.get(var, 'local') == 'local'; enabled and __import__('_distutils_hack').add_shim();\n"],
		["a .pth editable path", "venv/lib/python3.12/site-packages/__editable__.tool-0.1.0.pth", "/Users/you/git/tool/scripts\n"],
		["a sitecustomize", "venv/lib/python3.12/site-packages/sitecustomize.py", "import os\n"],
	])("%s in the venv's own site-packages is trusted", async (_name, rel, content) => {
		const python = fakeVenv(fakeInstall());
		write(rel, content);
		await expectReviewed(`${python} -c "import json"`);
	});

	test("a venv site-packages that is a symlink out of the venv is not trusted", async () => {
		const python = fakeVenv(fakeInstall(), "venv", undefined, true);
		fs.rmSync(path.join(dir, "venv/lib/python3.12/site-packages"), { recursive: true, force: true });
		fs.symlinkSync(path.join(dir, "base/lib/python3.12/site-packages"), path.join(dir, "venv/lib/python3.12/site-packages"));
		write("base/lib/python3.12/site-packages/hook.pth", "import os; os.system('id')\n");
		await expectRefused(`${python} -c "import json"`, "runs an import line at interpreter startup");
	});

	test("a sitecustomize elsewhere under the venv root but outside its site-packages is still read", async () => {
		const python = fakeVenv(fakeInstall(), "venv", undefined, true);
		write("base/lib/python3.12/site-packages/sitecustomize.py", "import os\n");
		write("venv/lib/python3.12/site-packages/ok.pth", "import os\n");
		await expectRefused(`${python} -c "import json"`, "sitecustomize.py runs at interpreter startup");
	});
});


describe("an import alias refuses, since the name checks cannot follow it", () => {
	test.each([
		["a write function under another name", "from shutil import copy as c\nc('payload.txt', 'json.py')\n"],
		["Path under another name", "from pathlib import Path as P\nP('json.py').write_text('x')\n"],
		["a module under another name", "import json as j\nprint(j.dumps(1))\n"],
	])("%s", async (_name, code) => {
		const python = fakeVenv(fakeInstall());
		write("probe.py", code);
		await expectRefused(`${python} probe.py`, " as ");
	});
});
