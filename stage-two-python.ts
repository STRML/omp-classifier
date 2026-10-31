/**
 * stage-two-python: what stage 2 checks before it shows the reviewer a Python
 * run (docs/plans/2026-10-27-stage-2-reviewer.md, shape C).
 *
 * The reviewer reads the code Python is handed: a `-c` operand, a quoted
 * here-document, or a script file. Python can still run code nobody read: a
 * module next to the code, a spawned process, a string run as code, an edited
 * import path. This module refuses the ones Python's own parse shows: the
 * code goes to `ast.parse` under a root-owned Python, never to a pattern
 * over its text, because every pattern misread some corner of the tokenizer.
 * The checks over the parse are still a deny list, the same kind stage 2
 * applies to a shell body, and the reviewer is told that anything the code
 * hands off to is unknown.
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

/** Modules whose job is to run code the reader did not see: spawn a process,
 *  load or run a module or file by name, run a string, or unpickle. */
const HANDOFF_MODULES = new Set([
	"subprocess",
	"pty",
	"pexpect",
	"sh",
	"plumbum",
	"multiprocessing",
	"webbrowser",
	"runpy",
	"importlib",
	"imp",
	"zipimport",
	"pkgutil",
	"site",
	"sitecustomize",
	"usercustomize",
	"builtins",
	"code",
	"codeop",
	"pdb",
	"bdb",
	"cProfile",
	"profile",
	"trace",
	"timeit",
	"doctest",
	"unittest",
	"idlelib",
	"ensurepip",
	"venv",
	"pip",
	"ctypes",
	"cffi",
	"pickle",
	"_pickle",
	"cPickle",
	"cloudpickle",
	"dill",
	"joblib",
	"marshal",
	"shelve",
	"interpreters",
]);

/** A name that starts a process: `os.system`, `posix.execv`, `asyncio.create_subprocess_exec`. */
const SPAWN_NAME = /^(?:system|popen\d?|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?|startfile|create_subprocess_\w+)$/u;
/** Modules whose star import brings a spawn in under its bare name. */
const SPAWN_MODULES = new Set(["os", "posix", "nt", "asyncio"]);
/** Names that run a string as code or reach an object by a computed name. */
const DYNAMIC_NAMES = new Set(["exec", "eval", "compile", "execfile", "breakpoint", "__import__", "__builtins__", "getattr", "setattr", "delattr", "attrgetter", "methodcaller", "globals", "locals", "vars"]);
/** Attributes that reach code or namespaces by a route the gate cannot follow. */
const DYNAMIC_ATTRIBUTES = new Set(["__dict__", "__getattribute__", "__subclasses__", "__globals__", "__code__", "__builtins__", "__loader__", "__import__", "attrgetter", "methodcaller", "unsafe_load", "UnsafeLoader"]);
/** `sys` attributes that change where an import is found. */
const SYS_IMPORT_STATE = new Set(["path", "meta_path", "path_hooks", "path_importer_cache", "modules"]);
const IMPORT_ITEM = /^([A-Za-z_]\w*)(?:\.\w+)*$/u;

/**
 * The parser: run under a root-owned Python with `-I -S`, the code on stdin.
 * `ast.parse` reads the bytes through the tokenizer that runs them, so an
 * encoding declaration, a backslash-newline, a form feed or a comment inside
 * a name list come out as Python reads them. It parses and never executes.
 */
const PARSER = String.raw`import ast, io, json, sys, tokenize
src = sys.stdin.buffer.read()
encoding = tokenize.detect_encoding(io.BytesIO(src).readline)[0]
tree = ast.parse(src)
head = set()
for at, stmt in enumerate(tree.body):
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        head.add(id(stmt))
    elif not (at == 0 and isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str)):
        break
def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))
imports, names, attrs, keywords = [], set(), [], set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            imports.append({"module": alias.name, "level": 0, "names": [], "asname": alias.asname, "head": id(node) in head})
    elif isinstance(node, ast.ImportFrom):
        imports.append({"module": node.module or "", "level": node.level, "names": [n for a in node.names for n in (a.name, a.asname) if n], "asname": None, "head": id(node) in head})
    elif isinstance(node, ast.Name):
        names.add(node.id)
    elif isinstance(node, ast.Attribute):
        attrs.append([dotted(node.value), node.attr])
    elif isinstance(node, ast.keyword) and node.arg:
        keywords.add(node.arg)
print(json.dumps({"encoding": encoding, "imports": imports, "names": sorted(names), "attrs": attrs, "keywords": sorted(keywords)}))
`;

interface ParsedImport {
	module: string;
	level: number;
	names: string[];
	asname: string | null;
	head: boolean;
}

interface PythonFacts {
	encoding: string;
	imports: ParsedImport[];
	names: string[];
	attrs: Array<[string | null, string]>;
	keywords: string[];
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
		if (typeof facts.encoding !== "string" || !Array.isArray(facts.imports) || !Array.isArray(facts.names) || !Array.isArray(facts.attrs) || !Array.isArray(facts.keywords)) return "the gate's Python returned a shape it does not read";
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

/** Why one module name runs code the gate did not read, or undefined. A
 *  private module (`_posixsubprocess`, `_ctypes`, `_interpreters`) is the C
 *  side of the public ones, so every one but `__future__` refuses. */
function moduleRefusal(name: string, roots: readonly string[], libs: readonly string[]): string | undefined {
	if (HANDOFF_MODULES.has(name) || (name.startsWith("_") && name !== "__future__")) return `imports ${name}, which runs code the gate did not read`;
	if (roots.some(root => shadows(root, name))) return `imports the local module ${name}`;
	if (!installed(name, libs)) return `imports ${name}, which is not in the interpreter's library`;
	return undefined;
}

/** Why one import statement runs code the gate did not read. `aliases`
 *  collects what `import a.b as c` binds, for the attribute checks. */
function importRefusal(item: ParsedImport, roots: readonly string[], libs: readonly string[], aliases: Map<string, string>): string | undefined {
	if (item.level > 0) return "a relative import runs a local module";
	const top = IMPORT_ITEM.exec(item.module)?.[1];
	if (top === undefined) return `an import the gate cannot read (${item.module})`;
	// Every import must run before any other statement, so the code cannot
	// write a module into sys.path[0] before importing it.
	if (!item.head) return `imports ${item.module} after other code runs, or inside a block`;
	// A submodule or imported name can be a hand-off too: `concurrent.interpreters`.
	const nested = [...item.module.split(".").slice(1), ...item.names].find(name => HANDOFF_MODULES.has(name));
	if (nested !== undefined) return `imports ${nested} from ${item.module}, which runs code the gate did not read`;
	const spawn = item.names.find(name => SPAWN_NAME.test(name) || DYNAMIC_NAMES.has(name) || name.includes("pickle")) ??(SPAWN_MODULES.has(top) && item.names.includes("*") ? "*" : undefined);
	if (spawn !== undefined) return `imports ${spawn} from ${item.module}, which can run code the gate did not read`;
	const state = top === "sys" ? item.names.find(name => SYS_IMPORT_STATE.has(name)) : undefined;
	if (state !== undefined) return `imports sys.${state}, which changes where imports come from`;
	aliases.set(item.asname ?? top, item.asname === null ? top : item.module);
	return moduleRefusal(top, roots, libs);
}

/** Why one attribute access reaches code the gate did not read. */
function attributeRefusal(base: string | null, attr: string, aliases: ReadonlyMap<string, string>): string | undefined {
	const owner = (base === null ? "" : (aliases.get(base) ?? base)).split(".").at(-1) ?? "";
	const spelled = `${base ?? "…"}.${attr}`;
	if (SPAWN_NAME.test(attr) && owner !== "platform") return `uses ${spelled}, which can run code the gate did not read`;
	if (DYNAMIC_ATTRIBUTES.has(attr) || attr.includes("pickle")) return `uses ${spelled}, which can run code the gate did not read`;
	if (owner === "sys" && SYS_IMPORT_STATE.has(attr)) return `uses ${spelled}, which changes where imports come from`;
	if (attr === "load" && (owner === "yaml" || owner === "torch")) return `uses ${spelled}, which can unpickle code`;
	return undefined;
}

/**
 * Why Python `code` runs code the gate did not read, or undefined, read from
 * Python's own parse of it (`parser` is a root-owned Python). `roots` are the
 * directories Python searches before its library (`sys.path[0]`): the
 * script's own directory, or the working directory for `-c` and stdin.
 * `libs` are the library directories; an imported name found in none of
 * them is refused.
 *
 * Imports must all sit at the head of the module, before any other
 * statement, so the code cannot plant a module and then import it. A library
 * that imports lazily after the code writes a file is the planted-file class
 * the plan doc leaves uncovered.
 */
export function pythonHandOff(code: string, roots: readonly string[], libs: readonly string[], parser: string): string | undefined {
	const facts = parsePython(code, parser);
	if (typeof facts === "string") return facts;
	// The reviewer reads the text: code in another encoding is not what it sees.
	if (!/^utf-8(?:-sig)?$/u.test(facts.encoding)) return `declares the encoding ${facts.encoding}, so the code that runs is not the text the reviewer reads`;
	const aliases = new Map<string, string>();
	for (const item of facts.imports) {
		const why = importRefusal(item, roots, libs, aliases);
		if (why !== undefined) return why;
	}
	const name = facts.names.find(id => DYNAMIC_NAMES.has(id) || SPAWN_NAME.test(id) || id.includes("pickle"));
	if (name !== undefined) return `uses ${name}, which can run code the gate did not read`;
	const keyword = facts.keywords.find(arg => arg.includes("pickle"));
	if (keyword !== undefined) return `passes ${keyword}, which can unpickle code`;
	for (const [base, attr] of facts.attrs) {
		const why = attributeRefusal(base, attr, aliases);
		if (why !== undefined) return why;
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
	return moduleRefusal(top, [cwd], libs);
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
