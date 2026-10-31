/**
 * stage-two-python: what stage 2 checks before it shows the reviewer a Python
 * run (docs/plans/2026-10-27-stage-2-reviewer.md, shape C).
 *
 * The reviewer reads the code Python is handed: a `-c` operand, a quoted
 * here-document, or a script file. Python can still run code nobody read: a
 * module next to the code, a spawned process, a string run as code, an edited
 * import path. This module refuses the ones a read of the text can see. It is
 * a deny list over text, the same kind of check stage 2 applies to a shell
 * body, and the reviewer is told that anything the code hands off to is
 * unknown.
 *
 * It decides nothing about which file is the interpreter; stage-two.ts does.
 */
import * as fs from "node:fs";
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
]);

/** The same, reached without an import statement: dynamic code, reflection
 *  by a computed name, the import machinery, a spawn imported by name, and
 *  loaders that unpickle. */
const HANDOFF_MARKERS: readonly RegExp[] = [
	/(?<![.\w])(?:exec|eval|compile|execfile|breakpoint)\s*\(/u,
	/\b(?:__import__|__builtins__|__dict__|__getattribute__|__subclasses__|__globals__|__code__|__loader__|getattr|setattr|delattr|attrgetter|methodcaller|globals|locals|vars)\b/u,
	/\bsys\s*\.\s*(?:path|meta_path|path_hooks|path_importer_cache|modules)\b/u,
	/(?<!platform\s*)\.\s*(?:system|popen\d?|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?|startfile|create_subprocess_(?:exec|shell))\b/u,
	/(?<![.\w])(?:system|popen\d?|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?|startfile)\s*\(/u,
	/pickle|\bunsafe_load\b|\bUnsafeLoader\b|\byaml\s*\.\s*load\s*\(|\btorch\s*\.\s*load\b/u,
];

/** A name that starts a process, wherever an import brings it in. */
const SPAWN_NAME = /\b(?:system|popen\d?|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?|startfile|create_subprocess_\w+)\b/u;
/** Modules whose star import brings a spawn in under its bare name. */
const SPAWN_MODULES = new Set(["os", "posix", "nt", "asyncio"]);

/** Text Python reads differently from the gate: a backslash-newline joins
 *  two lines into one statement, and a form feed is whitespace to Python. */
const LINE_JOIN = /\\\r?\n|\f/u;
/** PEP 263: a comment on line 1 or 2 naming an encoding. Under utf-7 the
 *  scanned text and the code Python runs differ, so any declaration refuses. */
const CODING_DECLARATION = /^[ \t]*#.*?coding[:=]/u;

const IMPORT_STATEMENT = /(?:^|[;:])[ \t]*import[ \t]+([^\n;#]+)/gmu;
/** `from X import names`, with a parenthesized name list read across lines. */
const FROM_STATEMENT = /(?:^|[;:])[ \t]*from[ \t]+(\S+)[ \t]+import\b[ \t]*(\([^)]*\)|[^\n;#]*)/gmu;
const IMPORT_ITEM = /^([A-Za-z_]\w*)(?:\.\w+)*(?:\s+as\s+\w+)?$/u;

/** A literal that names a file Python would import, and a call that writes
 *  a file: together they can plant a module the import check never saw. */
const MODULE_FILE_LITERAL = /['"][^'"\n]*(?:\.(?:py|pyc|pyw|pth|so)|__init__|sitecustomize|usercustomize)['"]/u;
/** `str.replace` is common in read-only code, so `replace` counts only from
 *  `os` or with a module file name as its first argument (`Path.replace`). */
const FILE_WRITE = /\b(?:write_text|write_bytes|write|writelines|copy\w*|move|rename|symlink\w*|link|hardlink_to|extract\w*|unpack_archive|mkstemp|NamedTemporaryFile|open)\s*\(|\bos\s*\.\s*replace\s*\(|\.replace\s*\(\s*['"][^'"\n]*(?:\.(?:py|pyc|pyw|pth|so)|__init__|sitecustomize|usercustomize)['"]/u;

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

/**
 * The top-level names `code` imports, or the reason an import cannot be read.
 * Every `import` word in the text must sit inside a statement this read
 * parsed: one anywhere else (a statement shape the patterns miss, or the
 * word in a string or comment) refuses rather than being skipped.
 */
function importedNames(code: string): string[] | string {
	const names: string[] = [];
	const spans: Array<[number, number]> = [];
	for (const match of code.matchAll(FROM_STATEMENT)) {
		spans.push([match.index, match.index + match[0].length]);
		const module = match[1];
		if (module.startsWith(".")) return "a relative import runs a local module";
		const top = IMPORT_ITEM.exec(module)?.[1];
		if (top === undefined) return `an import the gate cannot read (from ${module})`;
		const imported = match[2];
		const spawn = SPAWN_NAME.exec(imported)?.[0] ?? (SPAWN_MODULES.has(top) && imported.includes("*") ? "*" : undefined);
		if (spawn !== undefined) return `imports ${spawn} from ${module}, which can run code the gate did not read`;
		names.push(top);
	}
	for (const match of code.matchAll(IMPORT_STATEMENT)) {
		spans.push([match.index, match.index + match[0].length]);
		for (const item of match[1].split(",")) {
			const top = IMPORT_ITEM.exec(item.trim())?.[1];
			if (top === undefined) return `an import the gate cannot read (import ${item.trim()})`;
			names.push(top);
		}
	}
	for (const word of code.matchAll(/\bimport\b/gu)) {
		if (!spans.some(([start, end]) => word.index >= start && word.index < end)) return "the word import outside an import statement the gate read";
	}
	return names;
}

/** Why one module name runs code the gate did not read, or undefined. */
function moduleRefusal(name: string, roots: readonly string[], libs: readonly string[]): string | undefined {
	if (HANDOFF_MODULES.has(name)) return `imports ${name}, which runs code the gate did not read`;
	if (roots.some(root => shadows(root, name))) return `imports the local module ${name}`;
	if (!installed(name, libs)) return `imports ${name}, which is not in the interpreter's library`;
	return undefined;
}

/**
 * Why Python `code` runs code the gate did not read, or undefined. `roots`
 * are the directories Python searches before its library (`sys.path[0]`):
 * the script's own directory, or the working directory for `-c` and stdin.
 * `libs` are the library directories; a name found in none of them is
 * refused, so a module the code writes before it imports it cannot slip
 * through, and a literal module file name beside a file write refuses too,
 * since such a write can shadow a name that is installed.
 *
 * The whole text is scanned, comments and strings included: a mention
 * refuses, which errs toward blocking, and nothing is stripped by a pattern
 * that could misjudge where a comment or string ends.
 */
export function pythonHandOff(code: string, roots: readonly string[], libs: readonly string[]): string | undefined {
	const text = code.startsWith("﻿") ? code.slice(1) : code;
	if (text.split(/\r\n|\r|\n/u, 2).some(line => CODING_DECLARATION.test(line))) return "an encoding declaration: Python may decode it differently from the text the gate read";
	if (LINE_JOIN.test(text)) return "a backslash-newline or form feed: Python joins what the gate reads apart";
	for (const marker of HANDOFF_MARKERS) {
		const hit = marker.exec(text);
		if (hit !== null) return `uses ${hit[0].trim()}, which can run code the gate did not read`;
	}
	if (MODULE_FILE_LITERAL.test(text) && FILE_WRITE.test(text)) return "writes a file named like a Python module, which an import could then load";
	const names = importedNames(text);
	if (typeof names === "string") return names;
	for (const name of names) {
		const why = moduleRefusal(name, roots, libs);
		if (why !== undefined) return why;
	}
	return undefined;
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
