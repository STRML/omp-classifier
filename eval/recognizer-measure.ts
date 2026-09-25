#!/usr/bin/env bun
/**
 * The routine recognizer measurement (issue #34).
 *
 * The issue's gate is measurement before build: a cheap pre-filter for
 * provably routine calls is worth building only if it clears a meaningful
 * share of the volume a gate actually sees, with zero allow-labeled misses.
 * The first pass ran over the adversarial corpus and came back NO-GO (2/92);
 * the Aug-31 triage comment moved the gate to the mined history corpus
 * (`eval/corpus/history.jsonl`, ~19k distinct commands), and this script is
 * that measurement.
 *
 *   bun eval/recognizer-measure.ts
 *   bun eval/recognizer-measure.ts --corpus eval/corpus/adversarial.jsonl
 *   bun eval/recognizer-measure.ts --variant core --rows
 *
 * It reports, per variant:
 *
 *   - clear share: distinct rows and weighted calls (a row's `count` is how
 *     many times that command really ran, which is what the 30% gate means by
 *     volume).
 *   - where the rest went: a first-decline histogram and an any-decline table,
 *     with the concrete tokens that tripped each rule.
 *   - the safety half: for every cleared row, what the log says happened to
 *     that command. Rows carrying a `label` (the authored corpora) use it;
 *     mined history carries none, so the join is by command text against
 *     `decisions.jsonl`.
 *
 * Two things it states rather than hides:
 *
 *   - a cleared row with no log line and no label is UNLABELED. It is counted
 *     as neither a pass nor a miss: the corpus cannot answer for it.
 *   - the log stores commands redacted and truncated to 120 characters, so the
 *     join key is that same transform on the corpus side; a link found through
 *     the truncation prefix is reported separately.
 *
 * Command text printed here is redacted and truncated, the same rule the
 * decisions log itself follows (#71): real history carries private paths,
 * hosts and credential-bearing flags.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decisionsLogPath, type DecisionRecord } from "../index";
import { redactSecrets } from "../redact";
import { type RoutineRule, type RoutineVariant, ROUTINE_VERBS, SEARCH_VERBS, recognizeRoutineCommand } from "../recognizer";
import { parseShell, verbOf } from "../shell-ast";
import { type DecisionLog, readDecisionLog } from "./live-report";

/** One mined row. `count` only exists on history rows; `label` only on the
 *  authored corpora; `_comment` is the schema line and is skipped. */
interface CorpusRow {
	command: string;
	count?: number;
	label?: "allow" | "ask";
	family?: string;
	kind?: string;
}

/** The log's own answer for one command text, one word per line shape. */
type LogOutcome = "auto-allowed" | "allowed-by-layer" | "user-approved" | "user-denied" | "headless-blocked" | "blocked-static" | "unavailable";

/** Everything the log says about one command text. */
interface LogLink {
	lines: number;
	outcomes: Set<LogOutcome>;
	layers: Set<string>;
	verdicts: Set<string>;
	reasonCodes: Set<string>;
	/** Linked through a 120-character prefix rather than an exact key. */
	prefix: boolean;
	/** One line, redacted, for the report's example rows. */
	sample: string;
}

/** How a cleared row's safety resolved. */
type Safety = "pass" | "miss" | "unlabeled";

/** What the log said about one cleared row, for the outcome histogram: every
 *  outcome any of its lines carries, or the row's own label when the corpus has
 *  one, or `unlabeled` when nothing does. */
type ClearedOutcome = LogOutcome | "label-allow" | "label-ask" | "no-record";

const MAX_LOG_CMD = 120;

/** The decisions.jsonl writer's own transform (#71): a command stored in the
 *  log has had continuations joined, whitespace flattened, secrets redacted
 *  and the text cut to 120 characters. Matching the same transform on the
 *  corpus side is what makes the join possible at all. */
function logForm(command: string): string {
	return redactSecrets(command.replace(/\\\r?\n/gu, "")).replace(/\s+/gu, " ").trim();
}

/** A command as the report may print it. */
function printable(command: string): string {
	const flat = logForm(command);
	return flat.length > MAX_LOG_CMD ? `${flat.slice(0, MAX_LOG_CMD)}…` : flat;
}

function outcomeOf(line: DecisionRecord): LogOutcome {
	if (line.approval === "unavailable") return "unavailable";
	switch (line.approval) {
		case "allow-once":
		case "allow-session":
		case "always-allow":
			return "user-approved";
		case "deny":
			return "user-denied";
		case "headless":
			return "headless-blocked";
		default:
			break;
	}
	if (line.verdict === "UNAVAILABLE") return "unavailable";
	if (line.decision === "block") return "blocked-static";
	// An allow from any other layer — a static rule, a grant, the cache, an
	// approved dialog — is still the gate's own answer that this runs.
	return line.layer === "verdict" ? "auto-allowed" : "allowed-by-layer";
}

/** The outcomes that mean the gate, or a human, said no; and those that mean it
 *  said yes. Everything else (`unavailable`, a line with no answer) cannot
 *  classify a cleared row either way. */
const REFUSAL_OUTCOMES: readonly LogOutcome[] = ["user-denied", "headless-blocked", "blocked-static"];
const ALLOW_OUTCOMES: readonly LogOutcome[] = ["auto-allowed", "allowed-by-layer", "user-approved"];

/** How a cleared row's safety resolved: its own label when the corpus carries
 *  one, otherwise the log — and "unlabeled" when neither can answer, which is
 *  a third state rather than a silent pass. A row is a miss as soon as one log
 *  line refused that command; it is a pass when a line allowed it and none
 *  refused. */
function safetyOf(row: { label?: "allow" | "ask" }, link: LogLink | undefined): Safety {
	if (row.label !== undefined) return row.label === "allow" ? "pass" : "miss";
	if (link === undefined) return "unlabeled";
	if (REFUSAL_OUTCOMES.some(outcome => link.outcomes.has(outcome))) return "miss";
	if (ALLOW_OUTCOMES.some(outcome => link.outcomes.has(outcome))) return "pass";
	return "unlabeled";
}

/** Index the log by command text, with a prefix index for the truncated keys,
 *  because a stored key that is 120 characters long may be a prefix of a
 *  longer command the corpus still holds in full. */
function indexLog(lines: readonly DecisionRecord[]): { byCmd: Map<string, LogLink>; byPrefix: Map<string, LogLink[]> } {
	const byCmd = new Map<string, LogLink>();
	const byPrefix = new Map<string, LogLink[]>();
	for (const line of lines) {
		const key = line.cmd;
		if (typeof key !== "string" || key === "") continue;
		let link = byCmd.get(key);
		if (link === undefined) {
			link = { lines: 0, outcomes: new Set(), layers: new Set(), verdicts: new Set(), reasonCodes: new Set(), prefix: false, sample: printable(line.cmd) };
			byCmd.set(key, link);
			if (key.length === MAX_LOG_CMD) {
				const short = key.slice(0, 100);
				const bucket = byPrefix.get(short);
				if (bucket === undefined) byPrefix.set(short, [link]);
				else bucket.push(link);
			}
		}
		link.lines++;
		link.outcomes.add(outcomeOf(line));
		link.layers.add(line.layer);
		if (line.verdict !== null && line.verdict !== undefined) link.verdicts.add(line.verdict);
		if (typeof line.reasonCode === "string") link.reasonCodes.add(line.reasonCode);
	}
	return { byCmd, byPrefix };
}

function linkOf(index: { byCmd: Map<string, LogLink>; byPrefix: Map<string, LogLink[]> }, command: string): LogLink | undefined {
	const form = logForm(command);
	const direct = index.byCmd.get(form) ?? index.byCmd.get(form.slice(0, MAX_LOG_CMD));
	if (direct !== undefined) return direct;
	const bucket = index.byPrefix.get(form.slice(0, 100));
	if (bucket === undefined) return undefined;
	// A truncated key links only when it really is a prefix of this command.
	for (const candidate of bucket) {
		if (form.startsWith(candidate.sample)) {
			candidate.prefix = true;
			return candidate;
		}
	}
	return undefined;
}

interface VariantTally {
	variant: RoutineVariant;
	clearedRows: number;
	clearedCalls: number;
	/** Cleared rows whose command text was found in the decision log. */
	linked: number;
	/** ... of those, linked through the 120-character truncation prefix. */
	linkedByPrefix: number;
	/** First-decline attribution: rows and calls, per rule. */
	first: Map<RoutineRule, { rows: number; calls: number; reasons: Map<string, number> }>;
	/** Rows where the rule declined at all (rules after a `segments` decline do
	 *  not run, so this is conditional on reaching the rule). */
	any: Map<RoutineRule, number>;
	safety: Record<Safety, { rows: number; calls: number }>;
	/** Cleared rows by what the log (or the row's own label) says happened. */
	outcomeHistogram: Map<ClearedOutcome, number>;
	/** Misses whose link carries an UNSAFE verdict, and misses a human denied. */
	missUnsafe: number;
	missDenied: number;
	/** Rows and calls the loosest bound (segment count + verb) would clear. */
	ceilingRows: number;
	ceilingCalls: number;
	misses: Array<{ command: string; count: number; link: LogLink | undefined; label: string }>;
	passes: Array<{ command: string; count: number; link: LogLink | undefined; label: string }>;
}

/** The loosest possible bound on clearing: one plain segment whose verb is on
 *  the list, with every other rule ignored. Reported so a NO-GO cannot be
 *  blamed on the stricter rules — if the ceiling itself is under the gate, no
 *  amount of rule loosening reaches it. */
function ceilingRoutine(command: string, variant: RoutineVariant): boolean {
	const parsed = parseShell(command.trim());
	if (!parsed.ok || parsed.commands.length !== 1) return false;
	const [segment] = parsed.commands;
	if (segment === undefined || segment.nested || segment.join !== "first") return false;
	if (segment.unreadShape !== undefined || segment.expression !== undefined || segment.words.length === 0) return false;
	const verb = verbOf(segment);
	return Object.hasOwn(ROUTINE_VERBS, verb) || (variant === "search" && Object.hasOwn(SEARCH_VERBS, verb));
}

const RULES: readonly RoutineRule[] = [
	"unreadable", "segments", "operators", "substitution", "markers", "verb",
	"expansion", "redirect", "assignment", "flags", "secret-path", "floor",
];

function emptyTally(variant: RoutineVariant): VariantTally {
	return {
		variant,
		clearedRows: 0,
		clearedCalls: 0,
		linked: 0,
		linkedByPrefix: 0,
		first: new Map(RULES.map(rule => [rule, { rows: 0, calls: 0, reasons: new Map<string, number>() }])),
		any: new Map(RULES.map(rule => [rule, 0])),
		safety: { pass: { rows: 0, calls: 0 }, miss: { rows: 0, calls: 0 }, unlabeled: { rows: 0, calls: 0 } },
		outcomeHistogram: new Map(),
		missUnsafe: 0,
		missDenied: 0,
		ceilingRows: 0,
		ceilingCalls: 0,
		misses: [],
		passes: [],
	};
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			corpus: { type: "string" },
			decisions: { type: "string" },
			variant: { type: "string" },
			rows: { type: "boolean", default: false },
			examples: { type: "string", default: "6" },
			help: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});
	if (values.help === true) {
		console.log(`bun eval/recognizer-measure.ts [--corpus <file>] [--decisions <file>] [--variant core|search|both] [--rows] [--examples N]

  --corpus     corpus JSONL to measure (default: eval/corpus/history.jsonl)
  --decisions  decision log to join against (default: ${decisionsLogPath()})
  --variant    which recognizer variant to report (default: both)
  --rows       print every cleared row with its safety verdict
  --examples   example rows to print per section (default 6)`);
		return;
	}

	const corpusPath = values.corpus ?? join(import.meta.dir, "corpus", "history.jsonl");
	const corpusFile = Bun.file(corpusPath);
	if (!(await corpusFile.exists())) {
		console.error(`no corpus at ${corpusPath} — run \`bun eval/mine-history.ts\` for history, or pass --corpus`);
		process.exit(1);
	}
	const rows: CorpusRow[] = [];
	for (const line of (await corpusFile.text()).split("\n")) {
		if (line.trim() === "") continue;
		const parsed = JSON.parse(line) as CorpusRow & { _comment?: string };
		if (typeof parsed._comment === "string") continue;
		if (typeof parsed.command !== "string" || parsed.command.trim() === "") continue;
		rows.push({
			command: parsed.command,
			...(typeof parsed.count === "number" ? { count: parsed.count } : {}),
			...(parsed.label === "allow" || parsed.label === "ask" ? { label: parsed.label } : {}),
			...(typeof parsed.family === "string" ? { family: parsed.family } : {}),
			...(typeof parsed.kind === "string" ? { kind: parsed.kind } : {}),
		});
	}
	const calls = rows.reduce((total, row) => total + (row.count ?? 1), 0);

	const logPath = values.decisions ?? decisionsLogPath();
	let log: DecisionLog = { lines: [], malformed: [] };
	let logNote = "";
	try {
		log = readDecisionLog(logPath);
	} catch (err) {
		logNote = `no decision log at ${logPath} (${err instanceof Error ? err.message : String(err)}) — rows without a label read as unlabeled`;
	}
	const index = indexLog(log.lines);

	const variants: RoutineVariant[] = values.variant === "core" || values.variant === "search"
		? [values.variant]
		: ["core", "search"];
	const tallies = variants.map(emptyTally);
	const examples = Number(values.examples ?? "6") || 0;

	for (const row of rows) {
		const count = row.count ?? 1;
		for (const tally of tallies) {
			if (ceilingRoutine(row.command, tally.variant)) {
				tally.ceilingRows++;
				tally.ceilingCalls += count;
			}
			const verdict = recognizeRoutineCommand(row.command, { variant: tally.variant, taintedVars: [] });
			for (const rule of verdict.declines) tally.any.set(rule, (tally.any.get(rule) ?? 0) + 1);
			const first = verdict.declinedBy;
			if (first !== undefined) {
				const bucket = tally.first.get(first);
				if (bucket !== undefined) {
					bucket.rows++;
					bucket.calls += count;
					const reason = verdict.reasons[verdict.declines.indexOf(first)] ?? "";
					bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1);
				}
				continue;
			}
			tally.clearedRows++;
			tally.clearedCalls += count;
			const link = row.label === undefined ? linkOf(index, row.command) : undefined;
			if (link !== undefined) {
				tally.linked++;
				if (link.prefix) tally.linkedByPrefix++;
			}
			const resolved = safetyOf(row, link);
			tally.safety[resolved].rows++;
			tally.safety[resolved].calls += count;
			if (row.label !== undefined) {
				const bucket: ClearedOutcome = row.label === "allow" ? "label-allow" : "label-ask";
				tally.outcomeHistogram.set(bucket, (tally.outcomeHistogram.get(bucket) ?? 0) + 1);
			} else if (link === undefined) {
				tally.outcomeHistogram.set("no-record", (tally.outcomeHistogram.get("no-record") ?? 0) + 1);
			} else {
				for (const outcome of link.outcomes) tally.outcomeHistogram.set(outcome, (tally.outcomeHistogram.get(outcome) ?? 0) + 1);
			}
			if (resolved === "miss") {
				if (link !== undefined && link.verdicts.has("UNSAFE")) tally.missUnsafe++;
				if (link !== undefined && link.outcomes.has("user-denied")) tally.missDenied++;
				tally.misses.push({ command: row.command, count, link, label: row.label ?? "log" });
			} else if (resolved === "pass") {
				tally.passes.push({ command: row.command, count, link, label: row.label ?? "log" });
			}
		}
	}

	const pct = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);
	console.log(`corpus      ${corpusPath}`);
	console.log(`rows        ${rows.length} distinct, ${calls} weighted calls`);
	console.log(`indexer     ${log.lines.length} decision lines${log.malformed.length > 0 ? `, ${log.malformed.length} unreadable` : ""}${logNote === "" ? "" : ` — ${logNote}`}`);
	console.log("");

	for (const tally of tallies) {
		console.log(`=== variant: ${tally.variant} ===`);
		console.log(`clear share rows   ${tally.clearedRows}/${rows.length} = ${pct(tally.clearedRows, rows.length)}`);
		console.log(`clear share volume ${tally.clearedCalls}/${calls} = ${pct(tally.clearedCalls, calls)}  <- the gate's number`);
		console.log(`ceiling (one segment + a listed verb, every other rule ignored): ${tally.ceilingRows}/${rows.length} rows = ${pct(tally.ceilingRows, rows.length)}, ${tally.ceilingCalls}/${calls} calls = ${pct(tally.ceilingCalls, calls)}`);
		console.log(`safety: pass=${tally.safety.pass.rows} rows (${tally.safety.pass.calls} calls), miss=${tally.safety.miss.rows} rows (${tally.safety.miss.calls} calls), unlabeled=${tally.safety.unlabeled.rows} rows (${tally.safety.unlabeled.calls} calls)`);
		console.log(`miss severity: ${tally.missUnsafe} carry an UNSAFE verdict, ${tally.missDenied} were denied by a human, ${tally.misses.length - tally.missDenied} were blocked by a non-verdict layer, a headless session or an outage`);
		console.log(`label coverage: ${tally.linked}/${tally.clearedRows} cleared rows found in the log${tally.linkedByPrefix > 0 ? ` (${tally.linkedByPrefix} through the 120-char prefix)` : ""}; the rest carry no verdict anywhere and count as neither pass nor miss`);
		const histogram = [...tally.outcomeHistogram.entries()].sort((a, b) => b[1] - a[1]);
		console.log(`what the record says about cleared rows (a row can carry more than one outcome): ${histogram.length === 0 ? "nothing" : histogram.map(([outcome, rows]) => `${outcome}=${rows}`).join(", ")}`);
		const gate = tally.clearedCalls / calls > 0.3 && tally.safety.miss.rows === 0;
		console.log(`gate: ${gate ? "GO" : "NO-GO"} — needs >30.0% of volume and zero allow-labeled misses`);
		console.log("");
		console.log("first-decline attribution (where the non-cleared volume goes):");
		for (const rule of RULES) {
			const bucket = tally.first.get(rule);
			if (bucket === undefined || bucket.rows === 0) continue;
			const top = [...bucket.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
			console.log(`  ${rule.padEnd(12)} ${String(bucket.rows).padStart(6)} rows ${String(bucket.calls).padStart(6)} calls ${pct(bucket.calls, calls).padStart(7)}`);
			for (const [reason, seen] of top) console.log(`      ${String(seen).padStart(6)}x ${reason.length > 150 ? `${reason.slice(0, 150)}…` : reason}`);
		}
		console.log("");
		console.log("any-decline (a rule that ran and declined; rules after `segments` do not run):");
		console.log(RULES.map(rule => `${rule}=${tally.any.get(rule) ?? 0}`).join(" "));
		console.log("");

		if (tally.misses.length > 0) {
			console.log(`MISSES (${tally.misses.length} cleared rows the gate or the label says are not allow):`);
			for (const miss of tally.misses) {
				const link = miss.link;
				console.log(`  [${miss.label}] ${printable(miss.command)}  <- ${link === undefined ? "?" : `${[...link.outcomes].join(",")} layer=${[...link.layers].join(",")} verdict=${[...link.verdicts].join(",") || "null"} reason=${[...link.reasonCodes].join(",") || "none"}`}`);
			}
			console.log("");
		}
		if (examples > 0 && tally.passes.length > 0) {
			console.log(`example passes (${tally.passes.length} total):`);
			for (const pass of tally.passes.slice(0, examples)) {
				console.log(`  [${pass.label}] ${printable(pass.command)}  <- ${pass.link === undefined ? "label allow" : `${[...pass.link.outcomes].join(",")} x${pass.link.lines}`}`);
			}
			console.log("");
		}
		if (values.rows === true) {
			console.log("cleared rows:");
			for (const row of rows) {
				const verdict = recognizeRoutineCommand(row.command, { variant: tally.variant, taintedVars: [] });
				if (!verdict.routine) continue;
				const link = row.label === undefined ? linkOf(index, row.command) : undefined;
				console.log(`  ${safetyOf(row, link).padEnd(9)} ${String(row.count ?? 1).padStart(4)} ${printable(row.command)}`);
			}
			console.log("");
		}
	}
}

if (import.meta.main) await main();
