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
	/\bfrom\s+(?:os|posix|nt|asyncio)\s+import\b[^\n;]*(?:\*|\b(?:system|popen\d?|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?|startfile|create_subprocess_\w+)\b)/u,
	/pickle|\bunsafe_load\b|\bUnsafeLoader\b|\byaml\s*\.\s*load\s*\(|\btorch\s*\.\s*load\b/u,
];

const IMPORT_STATEMENT = /(?:^|[;:])[ \t]*import[ \t]+([^\n;#]+)/gmu;
const FROM_STATEMENT = /(?:^|[;:])[ \t]*from[ \t]+(\S+)[ \t]+import\b/gmu;
const IMPORT_ITEM = /^([A-Za-z_]\w*)(?:\.\w+)*(?:\s+as\s+\w+)?$/u;

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

/** The top-level names `code` imports, or the reason an import cannot be read. */
function importedNames(code: string): string[] | string {
	const names: string[] = [];
	for (const match of code.matchAll(FROM_STATEMENT)) {
		const module = match[1];
		if (module.startsWith(".")) return "a relative import runs a local module";
		const top = IMPORT_ITEM.exec(module)?.[1];
		if (top === undefined) return `an import the gate cannot read (from ${module})`;
		names.push(top);
	}
	for (const match of code.matchAll(IMPORT_STATEMENT)) {
		for (const item of match[1].split(",")) {
			const top = IMPORT_ITEM.exec(item.trim())?.[1];
			if (top === undefined) return `an import the gate cannot read (import ${item.trim()})`;
			names.push(top);
		}
	}
	return names;
}

/** Why one module name runs code the gate did not read, or undefined. */
function moduleRefusal(name: string, roots: readonly string[], libs: readonly string[] | undefined): string | undefined {
	if (HANDOFF_MODULES.has(name)) return `imports ${name}, which runs code the gate did not read`;
	if (roots.some(root => shadows(root, name))) return `imports the local module ${name}`;
	if (libs !== undefined && !installed(name, libs)) return `imports ${name}, which is not in the interpreter's library`;
	return undefined;
}

/**
 * Why Python `code` runs code the gate did not read, or undefined. `roots`
 * are the directories Python searches before its library (`sys.path[0]`):
 * the script's own directory, or the working directory for `-c` and stdin.
 * `libs` are the library directories, when the interpreter is known; a name
 * found in none of them is refused, so a module the code writes before it
 * imports it cannot slip through.
 */
export function pythonHandOff(code: string, roots: readonly string[], libs: readonly string[] | undefined): string | undefined {
	const text = code
		.split("\n")
		.filter(line => !/^\s*#/u.test(line))
		.join("\n");
	for (const marker of HANDOFF_MARKERS) {
		const hit = marker.exec(text);
		if (hit !== null) return `uses ${hit[0].trim()}, which can run code the gate did not read`;
	}
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
const PYTHON_FLAGS = /^-[uBEsSIOqbP]+$/u;

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
