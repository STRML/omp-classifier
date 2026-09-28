import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { filterChildShellEnv, getAgentDir, getProjectDir, pathIsWithin } from "@oh-my-pi/pi-utils";

export interface TrustPolicyFilePin {
	path: string;
	sha256: string | null;
	bytes: number | null;
}

export interface TrustPolicyPin {
	version: 1;
	sha256: string;
	files: TrustPolicyFilePin[];
}

export interface TrustedPolicyDocument {
	file: string;
	content: string;
}

export interface TrustPolicyResolution {
	/** Included in classifierConfigSignature whether the pin is current or stale. */
	signature: string;
	documents: TrustedPolicyDocument[];
}

interface ReadPolicyFile extends TrustPolicyFilePin {
	content: string | null;
}

const SHA256_RE = /^[a-f0-9]{64}$/u;
const TRUST_POLICY_VERSION = 1;

export const MAX_TRUST_POLICY_BYTES = 32 * 1024;

const PROJECT_PATH_ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"OMP_PROFILE",
	"PI_PROFILE",
	"OMP_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"OMP_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"CLAUDE_CONFIG_DIR",
] as const;

function gitRepositoryRoot(projectDir: string, env: Record<string, string>): string | null {
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: projectDir, env, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		const root = result.stdout.toString().trim();
		return root && path.isAbsolute(root) ? path.resolve(root) : null;
	} catch {
		return null;
	}
}

function isRepositoryLocal(repositoryRoot: string, filePath: string): boolean {
	let candidate = filePath;
	try {
		candidate = fs.realpathSync(filePath);
	} catch {
		try {
			candidate = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
		} catch {
			// A missing path remains subject to the lexical containment check.
		}
	}
	return pathIsWithin(repositoryRoot, candidate);
}

function assertUserControlledPaths(projectDir: string): { root: string; env: Record<string, string> } {
	const root = path.resolve(projectDir);
	const env = filterChildShellEnv(process.env, root);
	if (PROJECT_PATH_ENV_KEYS.some(key => process.env[key] !== env[key])) {
		throw new Error("project dotenv controls a user instruction path");
	}
	return { root, env };
}

function userInstructionPaths(projectDir: string = getProjectDir()): string[] {
	const { root: projectRoot, env } = assertUserControlledPaths(projectDir);
	const agentDir = getAgentDir();
	const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim()
		? path.resolve(process.env.CLAUDE_CONFIG_DIR)
		: path.join(os.homedir(), ".claude");
	const paths = [...new Set([
		path.join(agentDir, "AGENTS.md"),
		path.join(agentDir, "RULES.md"),
		path.join(agentDir, "SYSTEM.md"),
		path.join(claudeConfigDir, "CLAUDE.md"),
	].map(filePath => path.resolve(filePath)))];
	const repositoryRoot = gitRepositoryRoot(projectRoot, env);
	if (repositoryRoot !== null && paths.some(filePath => isRepositoryLocal(repositoryRoot, filePath))) {
		throw new Error("user instruction path is inside the current repository");
	}
	return paths;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function readPolicyFile(filePath: string): ReadPolicyFile {
	try {
		if (fs.statSync(filePath).size > MAX_TRUST_POLICY_BYTES) throw new RangeError("user instruction file exceeds the trust-policy size limit");
		const bytes = fs.readFileSync(filePath);
		if (bytes.byteLength > MAX_TRUST_POLICY_BYTES) throw new RangeError("user instruction file exceeds the trust-policy size limit");
		return { path: filePath, sha256: sha256(bytes), bytes: bytes.byteLength, content: bytes.toString("utf8") };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { path: filePath, sha256: null, bytes: null, content: null };
		throw error;
	}
}

function pinHash(files: readonly TrustPolicyFilePin[]): string {
	const material = JSON.stringify(files.map(file => [file.path, file.sha256, file.bytes]));
	return createHash("sha256").update(`omp-classifier-trust-policy-v${TRUST_POLICY_VERSION}\0${material}`).digest("hex");
}

/** Read only fixed user-level instruction paths for the explicit trust command. */
export function pinUserInstructionFiles(projectDir?: string): TrustPolicyPin {
	const files = userInstructionPaths(projectDir).map(filePath => {
		const { path: pinnedPath, sha256: digest, bytes } = readPolicyFile(filePath);
		return { path: pinnedPath, sha256: digest, bytes };
	});
	if (files.reduce((total, file) => total + (file.bytes ?? 0), 0) > MAX_TRUST_POLICY_BYTES) {
		throw new RangeError("user instruction snapshot exceeds the trust-policy size limit");
	}
	return { version: TRUST_POLICY_VERSION, sha256: pinHash(files), files };
}

/** Ignore malformed config pins rather than treating them as a source of paths. */
export function normalizeTrustPolicyPin(value: unknown): TrustPolicyPin | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (raw.version !== TRUST_POLICY_VERSION || typeof raw.sha256 !== "string" || !SHA256_RE.test(raw.sha256)) return null;
	if (!Array.isArray(raw.files) || raw.files.length > 4) return null;
	const files: TrustPolicyFilePin[] = [];
	for (const item of raw.files) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
		const file = item as Record<string, unknown>;
		if (typeof file.path !== "string" || !path.isAbsolute(file.path) || path.resolve(file.path) !== file.path) return null;
		if (file.sha256 !== null && (typeof file.sha256 !== "string" || !SHA256_RE.test(file.sha256))) return null;
		if (file.bytes !== null && (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) return null;
		if ((file.sha256 === null) !== (file.bytes === null)) return null;
		files.push({ path: file.path, sha256: file.sha256 as string | null, bytes: file.bytes as number | null });
	}
	if (files.reduce((total, file) => total + (file.bytes ?? 0), 0) > MAX_TRUST_POLICY_BYTES) return null;
	return { version: TRUST_POLICY_VERSION, sha256: raw.sha256, files };
}

/**
 * Return the pinned user-file contents only while every byte still matches the
 * explicit snapshot. The current read is hashed and the same bytes are used;
 * modified files are never reinterpreted as policy.
 */
export function resolvePinnedUserPolicy(pin: TrustPolicyPin | null, projectDir?: string): TrustPolicyResolution {
	if (pin === null) return { signature: "unpinned", documents: [] };
	const stale = (): TrustPolicyResolution => ({ signature: `${pin.sha256}:stale`, documents: [] });
	let currentPaths: string[];
	try {
		if (pin.files.reduce((total, file) => total + (file.bytes ?? 0), 0) > MAX_TRUST_POLICY_BYTES) return stale();
		currentPaths = userInstructionPaths(projectDir);
	} catch {
		return stale();
	}
	if (pin.version !== TRUST_POLICY_VERSION || pin.files.length !== currentPaths.length || pinHash(pin.files) !== pin.sha256) return stale();
	for (let index = 0; index < currentPaths.length; index++) {
		if (pin.files[index].path !== currentPaths[index]) return stale();
	}
	let current: ReadPolicyFile[];
	try {
		current = currentPaths.map(readPolicyFile);
	} catch {
		return stale();
	}
	if (current.some((file, index) => file.sha256 !== pin.files[index].sha256 || file.bytes !== pin.files[index].bytes)) return stale();
	return {
		signature: `${pin.sha256}:current`,
		documents: current.flatMap(file => file.content === null ? [] : [{ file: path.basename(file.path), content: file.content }]),
	};
}

/** The command's report contains only paths, hashes, and byte lengths. */
export function formatTrustPolicyPin(pin: TrustPolicyPin): string {
	const lines = pin.files.map(file => `${file.path} sha256=${file.sha256 ?? "absent"} bytes=${file.bytes ?? 0}`);
	return [`classifier trust-policy pinned sha256=${pin.sha256}`, ...lines].join("\n");
}
