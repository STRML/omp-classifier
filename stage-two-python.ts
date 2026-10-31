/**
 * stage-two-python: what stage 2 checks before it shows the reviewer a Python
 * run (docs/plans/2026-10-27-stage-2-reviewer.md, shape C).
 *
 * The reviewer reads the code Python is handed: a `-c` operand, a quoted
 * here-document, or a script file. Python can still run code nobody read: a
 * module it imports, a string run as code, an edited import path, a module
 * the code plants and then loads. The reviewer judges what the body does,
 * spawns included; this module guarantees only that what runs is that body,
 * from Python's own parse: the code goes to `ast.parse` under a root-owned
 * Python, never to a pattern over its text, because every pattern misread
 * some corner of the tokenizer.
 *
 * It decides nothing about which file is the interpreter; stage-two.ts does.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ShellWord } from "./shell-ast";

/** The file name a Python interpreter resolves to. */
export const PYTHON_NAME = /^python(?:3(?:\.\d+)?)?$/u;

/** The first four bytes of a native executable: Mach-O thin (32 or 64 bit,
 *  either byte order) or fat, and ELF. A script, however it is named, has none. */
const NATIVE_MAGIC = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "7f454c46"]);

export function isNativeExecutable(file: string): boolean {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const head = Buffer.alloc(4);
			return fs.readSync(fd, head, 0, 4, 0) === 4 && NATIVE_MAGIC.has(head.toString("hex"));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

const PYVENV_MAX_BYTES = 4096;

/** The venv `located` sits in, when it is `<venv>/bin/<name>` and
 *  `<venv>/pyvenv.cfg` names a `home` whose python is `real`, the file
 *  `located` resolves to. `python -m venv`, virtualenv and uv all write it. */
export function venvOf(located: string, real: string): { root: string; systemSite: boolean } | undefined {
	const bin = path.dirname(located);
	if (path.basename(bin) !== "bin") return undefined;
	const root = path.dirname(bin);
	let cfg: string;
	try {
		const file = path.join(root, "pyvenv.cfg");
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > PYVENV_MAX_BYTES) return undefined;
		cfg = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const home = /^home\s*=\s*(.+?)\s*$/mu.exec(cfg)?.[1];
	if (home === undefined || !path.isAbsolute(home)) return undefined;
	const same = [path.basename(real), "python3", "python"].some(name => {
		try {
			return fs.realpathSync(path.join(home, name)) === real;
		} catch {
			return false;
		}
	});
	if (!same) return undefined;
	return { root, systemSite: /^include-system-site-packages\s*=\s*true\s*$/imu.test(cfg) };
}

/** Where an import by name can come from other than the code's own
 *  directory: the standard library and the site-packages the interpreter
 *  uses. Undefined when the standard library is not where the layout puts it. */
export function libraryDirs(real: string, venv: { root: string; systemSite: boolean } | undefined): string[] | undefined {
	const prefix = path.dirname(path.dirname(real));
	let version = /^python(\d+\.\d+)$/u.exec(path.basename(real))?.[1];
	if (version === undefined) {
		const found = safeList(path.join(prefix, "lib")).flatMap(entry => /^python(\d+\.\d+)$/u.exec(entry)?.[1] ?? []);
		if (found.length !== 1) return undefined;
		version = found[0];
	}
	const stdlib = path.join(prefix, "lib", `python${version}`);
	if (!isDirectory(stdlib)) return undefined;
	const site = path.join(stdlib, "site-packages");
	const dirs = [stdlib, path.join(stdlib, "lib-dynload")];
	if (venv === undefined) return [...dirs, site];
	dirs.push(path.join(venv.root, "lib", `python${version}`, "site-packages"));
	return venv.systemSite ? [...dirs, site] : dirs;
}

/** Modules compiled into the interpreter: no file, so nothing to shadow. */
const BUILTIN_MODULES = new Set(["atexit", "errno", "faulthandler", "gc", "itertools", "posix", "pwd", "sys", "time"]);

/** Modules that load or run code the reviewer cannot read: by module or file
 *  name, from a string, or from bytes on disk (unpickling). */
const DYNAMIC_MODULES = new Set(["importlib", "imp", "runpy", "zipimport", "pkgutil", "site", "sitecustomize", "usercustomize", "builtins", "code", "codeop", "ctypes", "pickle", "cPickle", "marshal", "shelve"]);

/** `python -m` modules that run a file or string they are handed. */
const RUNNER_MODULES = new Set(["runpy", "pdb", "bdb", "cProfile", "profile", "trace", "timeit", "code", "doctest", "idlelib", "pickle", "pickletools", "zipapp"]);

/** Names that run a string as code, or reach code or a namespace by a
 *  computed name, so the reviewer cannot read what runs. */
const DYNAMIC_NAMES = new Set(["exec", "eval", "compile", "execfile", "breakpoint", "__import__", "__builtins__", "getattr", "setattr", "delattr", "globals", "locals", "vars"]);
const DYNAMIC_ATTRIBUTES = new Set(["__dict__", "__getattribute__", "__subclasses__", "__globals__", "__code__", "__builtins__", "__loader__", "__import__"]);

/** Attributes that hold where imports come from (`sys.path`, `sys.modules`).
 *  Refused on any base: only `os.path` is exempt, and only while `os` is the
 *  module `import os` binds (see GUARDED_NAMES). */
const IMPORT_STATE = new Set(["path", "meta_path", "path_hooks", "path_importer_cache", "modules"]);

/** Names the exemptions above rely on. Rebinding one, importing one under
 *  another name, binding another module to one, or passing the module object
 *  anywhere but as an attribute base refuses. */
const GUARDED_NAMES = new Set(["os", "sys", "shutil", "pathlib", "posix", "Path", "open"]);

/** A file name an import could load from `sys.path[0]`. */
const MODULE_FILE = /(?:\.(?:py|pyc|pyw|pth|so)|__init__|sitecustomize|usercustomize)$/u;

const IMPORT_ITEM = /^([A-Za-z_]\w*)(?:\.\w+)*$/u;

/**
 * The parser: run under a root-owned Python with `-I -S`, the code on stdin.
 * `ast.parse` reads the bytes through the tokenizer that runs them, so an
 * encoding declaration, a backslash-newline, a form feed or a comment inside
 * a name list come out as Python reads them. It parses and never executes.
 * Written for the oldest parser it runs under (Python 3.9).
 */
const PARSER = String.raw`import ast, io, json, sys, tokenize
src = sys.stdin.buffer.read()
encoding = tokenize.detect_encoding(io.BytesIO(src).readline)[0]
tree = ast.parse(src)
MODULES = {"os", "sys", "shutil", "pathlib", "posix"}
WRITE_METHODS = {"write_text", "write_bytes", "touch", "symlink_to", "hardlink_to", "link_to"}
TWO_PATH = {"rename", "replace", "link", "symlink", "copy", "copy2", "copyfile", "copytree", "move"}
def text(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None
def literal_path(node):
    if text(node) is not None:
        return text(node)
    if isinstance(node, ast.Call) and not node.keywords and node.args:
        f = node.func
        name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
        parts = [text(a) for a in node.args]
        if name in ("Path", "PurePath", "PosixPath") and None not in parts:
            return "/".join(parts)
    return None
def base_name(node):
    return node.id if isinstance(node, ast.Name) else None
def write_target(node):
    f = node.func
    name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
    method = isinstance(f, ast.Attribute)
    args = node.args
    kw = {k.arg: k.value for k in node.keywords if k.arg}
    if name == "open":
        builtin = not method or base_name(f.value) in ("os", "io", "codecs")
        mode = kw.get("mode", kw.get("flags", (args[1] if len(args) > 1 else None) if builtin else (args[0] if args else None)))
        if mode is None:
            return None
        if text(mode) is not None and not any(c in text(mode) for c in "wax+"):
            return None
        return [literal_path(args[0]) if builtin and args else literal_path(kw.get("file")) if builtin else literal_path(f.value)]
    if method and name in WRITE_METHODS:
        return [literal_path(f.value)]
    if name in ("extractall", "unpack_archive"):
        return [None]
    if name in TWO_PATH:
        if len(args) >= 2 and (name != "replace" or not method or base_name(f.value) == "os"):
            return [literal_path(args[1])]
        if len(args) == 1 and method and name in ("rename", "replace"):
            return [literal_path(args[0])]
        if "dst" in kw:
            return [literal_path(kw["dst"])]
    return None
attribute_bases = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
imports, names, bare, bound, attrs, writes = [], set(), set(), set(), [], []
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            imports.append({"module": alias.name, "level": 0, "names": [], "asname": alias.asname})
    elif isinstance(node, ast.ImportFrom):
        imports.append({"module": node.module or "", "level": node.level, "names": [n for a in node.names for n in (a.name, a.asname) if n], "asname": None})
    elif isinstance(node, ast.Name):
        if isinstance(node.ctx, ast.Load):
            names.add(node.id)
            if node.id in MODULES and id(node) not in attribute_bases:
                bare.add(node.id)
        else:
            bound.add(node.id)
    elif isinstance(node, ast.arg):
        bound.add(node.arg)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        bound.add(node.name)
    elif isinstance(node, ast.ExceptHandler) and node.name:
        bound.add(node.name)
    elif isinstance(node, (ast.Global, ast.Nonlocal)):
        bound.update(node.names)
    elif isinstance(node, ast.Attribute):
        attrs.append([base_name(node.value), node.attr])
    if isinstance(node, ast.Call):
        target = write_target(node)
        if target is not None:
            writes.append(target[0])
print(json.dumps({"encoding": encoding, "imports": imports, "names": sorted(names), "bare": sorted(bare), "bound": sorted(bound), "attrs": attrs, "writes": writes}))
`;

interface ParsedImport {
	module: string;
	level: number;
	names: string[];
	asname: string | null;
}

interface PythonFacts {
	encoding: string;
	imports: ParsedImport[];
	/** Names read anywhere. */
	names: string[];
	/** GUARDED module names read other than as an attribute base. */
	bare: string[];
	/** Names assigned, deleted, declared or taken as parameters. */
	bound: string[];
	/** Every attribute, with its base when the base is a plain name. */
	attrs: Array<[string | null, string]>;
	/** Each file write's target path, or null when it is computed. */
	writes: Array<string | null>;
}

const PARSER_TIMEOUT_MS = 3000;
const PARSER_MAX_OUTPUT = 8 * 1024 * 1024;

/** What `parser` (a root-owned Python) reads in `code`, or why it could not. */
function parsePython(code: string, parser: string): PythonFacts | string {
	const result = spawnSync(parser, ["-I", "-S", "-B", "-c", PARSER], { input: Buffer.from(code, "utf8"), timeout: PARSER_TIMEOUT_MS, maxBuffer: PARSER_MAX_OUTPUT, env: {}, cwd: os.tmpdir() });
	if (result.error !== undefined || result.status !== 0) {
		const last = result.stderr?.toString("utf8").trim().split("\n").at(-1) ?? "";
		return `the gate's Python could not parse it (${result.error?.message ?? (last || `exit ${String(result.status)}`)})`;
	}
	try {
		const facts = JSON.parse(result.stdout.toString("utf8")) as PythonFacts;
		const lists = [facts.imports, facts.names, facts.bare, facts.bound, facts.attrs, facts.writes];
		if (typeof facts.encoding !== "string" || !lists.every(Array.isArray)) return "the gate's Python returned a shape it does not read";
		return facts;
	} catch {
		return "the gate's Python returned output it could not read";
	}
}

function safeList(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Whether `dir` holds anything an import of `name` could load: a module,
 *  a package, a namespace directory, a compiled file or an extension. A
 *  directory the gate cannot list counts, so the check errs toward refusing. */
function shadows(dir: string, name: string): boolean {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return true;
	}
	return entries.some(entry => entry === name || entry.startsWith(`${name}.`));
}

function installed(name: string, libs: readonly string[]): boolean {
	if (BUILTIN_MODULES.has(name)) return true;
	return libs.some(dir => safeList(dir).some(entry => entry === name || entry === `${name}.py` || (entry.startsWith(`${name}.`) && entry.endsWith(".so"))));
}

/** The interpreter's standard library: `libraryDirs` without site-packages. */
function standardLibrary(libs: readonly string[]): string[] {
	return libs.filter(dir => path.basename(dir) !== "site-packages");
}

/** Why one import brings in code the reviewer cannot read, or undefined. */
function importRefusal(item: ParsedImport, roots: readonly string[], stdlib: readonly string[]): string | undefined {
	if (item.level > 0) return "a relative import runs a local module";
	const top = IMPORT_ITEM.exec(item.module)?.[1];
	if (top === undefined) return `an import the gate cannot read (${item.module})`;
	const dynamic = [...item.module.split("."), ...item.names].find(name => DYNAMIC_MODULES.has(name) || DYNAMIC_NAMES.has(name));
	if (dynamic !== undefined) return `imports ${dynamic}, which loads or runs code the reviewer cannot read`;
	if (top.startsWith("_") && top !== "__future__") return `imports the private module ${top}`;
	if (roots.some(root => shadows(root, top))) return `imports the local module ${top}`;
	if (!installed(top, stdlib)) return `imports ${top}, which is not in the standard library`;
	if (top === "sys") {
		const state = item.names.find(name => IMPORT_STATE.has(name));
		if (state !== undefined) return `imports sys.${state}, which changes where imports come from`;
	}
	const guarded = [item.asname, ...item.names].find(name => name !== null && GUARDED_NAMES.has(name) && !(name === "Path" && top === "pathlib") && !(name === "path" && top === "os"));
	if (guarded !== undefined && guarded !== top) return `binds ${guarded} by import, which the gate's checks rely on`;
	if (item.asname !== null && GUARDED_NAMES.has(top)) return `imports ${top} as ${item.asname}, a name the gate does not follow`;
	return undefined;
}

/**
 * Why Python `code` runs code the reviewer cannot read, or undefined, from
 * Python's own parse of it (`parser` is a root-owned Python). The reviewer
 * reads the whole body and judges what it does, spawns included. The gate
 * guarantees only that what the body runs is the body:
 *
 *  - every import is of the standard library, found in the interpreter's own
 *    library and not shadowed in `sys.path[0]` (`roots`: the script's
 *    directory, or the working directory for `-c` and stdin);
 *  - no code runs from a string, a computed name or bytes on disk;
 *  - nothing touches where imports come from (`sys.path`, `sys.modules`);
 *  - no file write lands on a computed path or a module file name, so the
 *    body cannot plant a module that a later import, its own or a library's,
 *    would load.
 */
export function pythonHandOff(code: string, roots: readonly string[], libs: readonly string[], parser: string): string | undefined {
	const facts = parsePython(code, parser);
	if (typeof facts === "string") return facts;
	// The reviewer reads the text: code in another encoding is not what it sees.
	if (!/^utf-8(?:-sig)?$/u.test(facts.encoding)) return `declares the encoding ${facts.encoding}, so the code that runs is not the text the reviewer reads`;
	const stdlib = standardLibrary(libs);
	for (const item of facts.imports) {
		const why = importRefusal(item, roots, stdlib);
		if (why !== undefined) return why;
	}
	const dynamic = facts.names.find(name => DYNAMIC_NAMES.has(name));
	if (dynamic !== undefined) return `uses ${dynamic}, which runs code the reviewer cannot read`;
	const rebound = facts.bound.find(name => GUARDED_NAMES.has(name));
	if (rebound !== undefined) return `rebinds ${rebound}, which the gate's checks rely on`;
	if (facts.bare.length > 0) return `passes the ${facts.bare[0]} module around, which the gate's checks cannot follow`;
	for (const [base, attr] of facts.attrs) {
		if (DYNAMIC_ATTRIBUTES.has(attr)) return `uses .${attr}, which reaches code the reviewer cannot read`;
		if (IMPORT_STATE.has(attr) && !(attr === "path" && base === "os")) return `uses ${base ?? "…"}.${attr}, which can change where imports come from`;
	}
	for (const target of facts.writes) {
		if (target === null) return "writes a file at a path built at run time, which could plant a module an import then loads";
		if (MODULE_FILE.test(target)) return `writes ${target}, a file an import could load`;
	}
	return undefined;
}

/** A Python on a root-owned chain to parse with, or undefined. Not the
 *  interpreter the command runs: that one is user-owned, and running it at
 *  gate time would run a planted binary before any verdict. */
export function parserPython(isSystemProgram: (file: string) => boolean): string | undefined {
	const candidates = process.platform === "darwin" ? ["/Library/Developer/CommandLineTools/usr/bin/python3"] : ["/usr/bin/python3"];
	return candidates.find(candidate => isSystemProgram(candidate));
}

/** Why `python -m <module>` runs code the gate did not read, or undefined. An
 *  installed module runs like `bun test`: the repository's own tooling, which
 *  the reviewer is told about. One in the working directory, one that runs a
 *  file or string it is handed, or one that is not installed is refused. */
export function pythonModuleRefusal(module: string, cwd: string, libs: readonly string[]): string | undefined {
	const top = IMPORT_ITEM.exec(module)?.[1];
	if (top === undefined) return `python -m ${module} names no module`;
	if (RUNNER_MODULES.has(top) || DYNAMIC_MODULES.has(top) || (top.startsWith("_") && top !== "__future__")) return `python -m ${top} runs a file or string the reviewer cannot read`;
	if (shadows(cwd, top)) return `runs the local module ${top}`;
	if (!installed(top, libs)) return `python -m ${top}, which is not installed`;
	return undefined;
}

/** What one Python run executes, read from the words after the interpreter. */
export type PythonMode = { mode: "code"; code: string } | { mode: "stdin" } | { mode: "module"; module: string } | { mode: "file"; spelled: string };

/** Single-letter options that change nothing about which code runs. */
export const PYTHON_FLAGS = /^-[uBEsSIOqbP]+$/u;

/** The mode `words` (everything after the interpreter) select, or why the
 *  gate cannot tell. Any option outside PYTHON_FLAGS refuses. */
export function pythonMode(words: readonly ShellWord[]): PythonMode | string {
	for (let at = 0; at < words.length; at += 1) {
		const value = words[at].value;
		if (PYTHON_FLAGS.test(value)) continue;
		if (value === "-c" || value === "-m") {
			const operand = words[at + 1]?.value;
			if (operand === undefined) return `python ${value} with no operand`;
			return value === "-c" ? { mode: "code", code: operand } : { mode: "module", module: operand };
		}
		if (value === "-") return { mode: "stdin" };
		if (value.startsWith("-")) return `a python option the gate does not know (${value})`;
		return { mode: "file", spelled: value };
	}
	return "python with no program reads the terminal's stdin";
}

/** Environment that points Python's imports or startup at other code. */
export const PYTHON_ENVIRONMENT = ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE", "PYTHONPLATLIBDIR", "PYTHONEXECUTABLE"];
