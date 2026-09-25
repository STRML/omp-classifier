/**
 * The classifier's own file locations (issue #9).
 *
 * `classifierConfigPath()` and `classifierDataDir()` must be placed by the
 * host's directory resolver — the same way the host places its lockfile — so a
 * named profile, `PI_CONFIG_DIR`, and an XDG-migrated config root each get
 * their own file. A hand-built `~/.omp/...` puts every profile on one config
 * file, and `/classifier enabled false` under `--profile work` then turns the
 * classifier off everywhere with no indication that happened.
 *
 * Each case runs in a subprocess: pi-utils derives its resolver from
 * `process.env` at module load, so the environment has to be in place when the
 * module loads (see tests/config-path-probe.ts). The literal expectations pin
 * the host's rule; the `hostDataRoot` comparison additionally proves the
 * resolved path tracks that resolver rather than a coincidence of one machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROBE = path.join(import.meta.dir, "config-path-probe.ts");
const PLUGIN_NAME = "omp-classifier";
const CONFIG_FILE = "omp-classifier.json";

/** Temp roots the case that is running made, removed when it ends. Every case
 *  needs a fresh home (the probe's resolver reads it at load), so a run that
 *  keeps them accumulates a directory per case per run. */
let MADE: string[] = [];

afterEach(() => {
	if (MADE.length === 0) return;
	// `trash` where the CLI exists, `rm -rf` where it does not: the same
	// convention the repo's other temp-dir tests use. One call for the case's
	// roots rather than one per root.
	const roots = MADE.map(root => JSON.stringify(root)).join(" ");
	execSync(`trash ${roots} 2>/dev/null || rm -rf ${roots}`);
	MADE = [];
});

/** A fresh temp root, removed when its case ends. */
function tempRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	MADE.push(root);
	return root;
}

interface Paths {
	configPath: string;
	dataDir: string;
	decisionsLogPath: string;
	pluginsDir: string;
	hostDataRoot: string;
}

/** Resolve the plugin's paths in a process whose whole environment is `env`. */
function resolveWith(env: Record<string, string>): Paths {
	const proc = Bun.spawnSync({
		cmd: [process.execPath, PROBE],
		// Explicit env: an inherited one would carry the suite's OMP_JEV_CONFIG
		// override (tests/fixtures.ts sets it at load) and mask every case.
		env: { PATH: process.env.PATH ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(`probe exited ${proc.exitCode}: ${proc.stderr.toString()}`);
	}
	return JSON.parse(proc.stdout.toString().trim()) as Paths;
}

/** A fresh home plus case env vars, so no case can read another's fixtures. */
function env(extra: Record<string, string> = {}): { home: string; vars: Record<string, string> } {
	const home = tempRoot("omp-config-path-home-");
	return { home, vars: { HOME: home, ...extra } };
}

/** A temp XDG root, with `$XDG_DATA_HOME/omp` created when `migrated`. */
function xdgRoot(migrated: boolean): string {
	const root = tempRoot("omp-config-path-xdg-");
	if (migrated) fs.mkdirSync(path.join(root, "omp"), { recursive: true });
	return root;
}

describe("classifier paths follow the host directory resolver", () => {
	test("nothing set: the default locations are unchanged", () => {
		const { home, vars } = env();
		const paths = resolveWith(vars);
		// The pre-#9 deployment: ~/.omp/omp-classifier.json. Pinned literally so a
		// resolver change that moves the default file fails here.
		expect(paths.configPath).toBe(path.join(home, ".omp", CONFIG_FILE));
		expect(paths.dataDir).toBe(path.join(home, ".omp", PLUGIN_NAME));
		expect(paths.decisionsLogPath).toBe(path.join(home, ".omp", PLUGIN_NAME, "decisions.jsonl"));
	});

	test("OMP_PROFILE: config and artifacts move under the profile root", () => {
		const { home, vars } = env({ OMP_PROFILE: "work" });
		const paths = resolveWith(vars);
		expect(paths.configPath).toBe(path.join(home, ".omp", "profiles", "work", CONFIG_FILE));
		expect(paths.dataDir).toBe(path.join(home, ".omp", "profiles", "work", PLUGIN_NAME));
	});

	test("PI_PROFILE is the legacy fallback for the same profile root", () => {
		const { home, vars } = env({ PI_PROFILE: "work" });
		expect(resolveWith(vars).configPath).toBe(path.join(home, ".omp", "profiles", "work", CONFIG_FILE));
	});

	test("no two profiles share a config path", () => {
		const { vars } = env();
		const defaultPaths = resolveWith(vars);
		const work = resolveWith({ ...vars, OMP_PROFILE: "work" });
		const personal = resolveWith({ ...vars, OMP_PROFILE: "personal" });
		const configPaths = new Set([defaultPaths.configPath, work.configPath, personal.configPath]);
		const dataDirs = new Set([defaultPaths.dataDir, work.dataDir, personal.dataDir]);
		expect(configPaths.size).toBe(3);
		expect(dataDirs.size).toBe(3);
	});

	test("PI_CONFIG_DIR replaces the .omp segment", () => {
		const { home, vars } = env({ PI_CONFIG_DIR: ".omp-alt" });
		const paths = resolveWith(vars);
		expect(paths.configPath).toBe(path.join(home, ".omp-alt", CONFIG_FILE));
		expect(paths.dataDir).toBe(path.join(home, ".omp-alt", PLUGIN_NAME));
	});

	// XDG is a darwin/linux rule in the host resolver; on win32 neither the
	// resolver nor the expectation applies.
	test.skipIf(process.platform === "win32")("XDG_DATA_HOME redirects to the migrated data root", () => {
		const { home, vars } = env();
		const xdg = xdgRoot(true);
		const paths = resolveWith({ ...vars, XDG_DATA_HOME: xdg });
		expect(paths.configPath).toBe(path.join(xdg, "omp", CONFIG_FILE));
		expect(paths.dataDir).toBe(path.join(xdg, "omp", PLUGIN_NAME));
		expect(paths.configPath).not.toBe(path.join(home, ".omp", CONFIG_FILE));
	});

	test.skipIf(process.platform === "win32")("an absent $XDG_DATA_HOME/omp leaves the default in place", () => {
		const { home, vars } = env();
		const paths = resolveWith({ ...vars, XDG_DATA_HOME: xdgRoot(false) });
		expect(paths.configPath).toBe(path.join(home, ".omp", CONFIG_FILE));
	});

	test("the resolved paths are the ones the host resolver reports", () => {
		const { vars } = env();
		const cases: Record<string, string>[] = [
			vars,
			{ ...vars, OMP_PROFILE: "work" },
			{ ...vars, PI_PROFILE: "work" },
			{ ...vars, PI_CONFIG_DIR: ".omp-alt" },
			{ ...vars, XDG_DATA_HOME: xdgRoot(true) },
		];
		for (const caseEnv of cases) {
			const paths = resolveWith(caseEnv);
			expect(paths.configPath).toBe(path.join(paths.hostDataRoot, CONFIG_FILE));
			expect(paths.dataDir).toBe(path.join(paths.hostDataRoot, PLUGIN_NAME));
		}
	});

	test("OMP_JEV_CONFIG still overrides everything", () => {
		const { vars } = env({ OMP_PROFILE: "work", PI_CONFIG_DIR: ".omp-alt" });
		const dir = tempRoot("omp-config-path-override-");
		const override = path.join(dir, CONFIG_FILE);
		const paths = resolveWith({ ...vars, OMP_JEV_CONFIG: override });
		expect(paths.configPath).toBe(override);
		// Artifacts stay beside the override: tests point one variable at a temp
		// dir and find the config, the decision log and the status report there.
		expect(paths.dataDir).toBe(dir);
		expect(paths.decisionsLogPath).toBe(path.join(dir, "decisions.jsonl"));
	});
});

/**
 * The teardown, seen from inside: bun runs a file's cases in declaration order,
 * so the second case can look at what the first one left. Nine cases above each
 * make a home and a couple make an XDG root, and a run that kept them would
 * leave one directory per case per run behind.
 */
describe("temp roots do not accumulate", () => {
	let previous: string | undefined;

	test("a case's root is there while the case runs", () => {
		previous = env().home;
		expect(fs.existsSync(previous)).toBe(true);
	});

	test("the root the case before this one made is gone", () => {
		expect(previous).toBeDefined();
		expect(fs.existsSync(previous as string)).toBe(false);
	});
});
