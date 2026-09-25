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
 * The gate it prints has two halves and needs both: a clear share above 30% of
 * the volume, and a safety half that is verified rather than assumed — no
 * cleared row refused by the log or a label, and no cleared row without
 * evidence either way. An unlabeled row is not a pass.
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
 *     as neither a pass nor a miss, and it blocks the gate: a GO needs the
 *     safety half verified, so a share nothing can check is not a share the
 *     issue's gate may accept.
 *   - the log stores commands redacted and cut to 120 characters, so the join
 *     key is that same transform on the corpus side; a command longer than the
 *     cut joins only through a prefix, which is reported and counted as no
 *     evidence at all (a different suffix stores the same key).
 *
 * The taint is another input the corpus cannot supply: a mined row has no
 * session around it, so every call says `"unknown"`, and a shape that expands
 * a variable does not clear (`echo $CAPTURED` after a secret capture is the
 * case the recognizer's taint input exists for).
 *
 * Command text printed here is redacted and truncated, the same rule the
 * decisions log itself follows (#71): real history carries private paths,
 * hosts and credential-bearing flags.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decisionsLogPath, type DecisionRecord } from "../index";
import { redactSecrets } from "../redact";
import { type RoutineRule, type RoutineVariant, ROUTINE_VERBS, SEARCH_VERBS, type SessionTaint, recognizeRoutineCommand } from "../recognizer";
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
	/** One line, redacted, for the report's example rows. */
	sample: string;
}

/** How a cleared row's safety resolved. */
type Safety = "pass" | "miss" | "unlabeled";

/** What the log said about one cleared row, for the outcome histogram: every
 *  outcome any of its lines carries, or the row's own label when the corpus has
 *  one, or `unlabeled` when nothing does. A row that joined the log only
 *  through the 120-character cut gets its own bucket: the line it found is
 *  about a command that shares its first 120 characters, not about this one. */
type ClearedOutcome = LogOutcome | "label-allow" | "label-ask" | "no-record" | "cut-ambiguous";

const MAX_LOG_CMD = 120;

/** The character the log's writer appends when it had to cut a command
 *  (`truncated`, index.ts): a stored key that carries it holds only the first
 *  120 characters of the command it came from. */
const CUT_MARK = "…";

/** The corpus carries no session taint: a row has a command and a count, and
 *  nothing about what an earlier command in that session captured. So every
 *  call says "unknown", which is not the same as "nothing was captured" —
 *  with an empty list, `echo $CAPTURED` after a secret capture would clear
 *  here and inflate the measured share with a shape the real session refuses. */
const CORPUS_TAINT: SessionTaint = "unknown";

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
 *  refused. A row whose only link is the log's 120-character cut is unlabeled:
 *  the stored key is a prefix, and a different suffix would carry it. */
function safetyOf(row: { label?: "allow" | "ask" }, join: LogJoin | undefined): Safety {
	if (row.label !== undefined) return row.label === "allow" ? "pass" : "miss";
	if (join === undefined || join.cut) return "unlabeled";
	const { link } = join;
	if (REFUSAL_OUTCOMES.some(outcome => link.outcomes.has(outcome))) return "miss";
	if (ALLOW_OUTCOMES.some(outcome => link.outcomes.has(outcome))) return "pass";
	return "unlabeled";
}

/** What the log says about one corpus command, and how it was asked for. Only
 *  an exact key is evidence: `cut` marks a join that went through the log's
 *  120-character cut, where the stored text is a prefix of this command rather
 *  than the whole of it. */
interface LogJoin {
	link: LogLink;
	/** The key is the first 120 characters of this command, and this command is
	 *  longer than that: a different suffix stores the same key. */
	cut: boolean;
}

/** Index the log by command text, with a second index for the keys its writer
 *  had to cut, because those can only ever be answered as prefixes. A key is
 *  cut when the writer marked it, or when it is exactly 120 characters long:
 *  at that length it is the whole of one command and the beginning of any
 *  longer one, and the two are not told apart by the text alone. */
function indexLog(lines: readonly DecisionRecord[]): { byCmd: Map<string, LogLink>; byCut: Map<string, Array<{ key: string; link: LogLink }>> } {
	const byCmd = new Map<string, LogLink>();
	const byCut = new Map<string, Array<{ key: string; link: LogLink }>>();
	for (const line of lines) {
		const key = line.cmd;
		if (typeof key !== "string" || key === "") continue;
		let link = byCmd.get(key);
		if (link === undefined) {
			link = { lines: 0, outcomes: new Set(), layers: new Set(), verdicts: new Set(), reasonCodes: new Set(), sample: printable(key) };
			byCmd.set(key, link);
			const prefix = key.endsWith(CUT_MARK) ? key.slice(0, -1) : key;
			if (prefix.length >= MAX_LOG_CMD) {
				const bucket = byCut.get(prefix.slice(0, 100));
				if (bucket === undefined) byCut.set(prefix.slice(0, 100), [{ key: prefix, link }]);
				else bucket.push({ key: prefix, link });
			}
		}
		link.lines++;
		link.outcomes.add(outcomeOf(line));
		link.layers.add(line.layer);
		if (line.verdict !== null && line.verdict !== undefined) link.verdicts.add(line.verdict);
		if (typeof line.reasonCode === "string") link.reasonCodes.add(line.reasonCode);
	}
	return { byCmd, byCut };
}

function linkOf(index: { byCmd: Map<string, LogLink>; byCut: Map<string, Array<{ key: string; link: LogLink }>> }, command: string): LogJoin | undefined {
	const form = logForm(command);
	const exact = index.byCmd.get(form);
	if (exact !== undefined) return { link: exact, cut: false };
	// Longer than the log's cut: no key can hold this command whole, so a key
	// that matches its first 120 characters matches only that much. Reported as
	// a join, counted as nothing.
	if (form.length <= MAX_LOG_CMD) return undefined;
	const bucket = index.byCut.get(form.slice(0, 100));
	if (bucket === undefined) return undefined;
	for (const candidate of bucket) {
		if (form.startsWith(candidate.key)) return { link: candidate.link, cut: true };
	}
	return undefined;
}

interface VariantTally {
	variant: RoutineVariant;
	clearedRows: number;
	clearedCalls: number;
	/** Cleared rows whose command text was found in the decision log. */
	linked: number;
	/** ... of those, joined only through the log's 120-character cut, which is
	 *  a prefix of the command rather than the command. */
	linkedByCut: number;
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

const pct = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

/** The issue's gate, both halves at once: the clear share has to be above 30%
 *  of the volume the gate sees, and the safety half has to be *verified* — no
 *  cleared row the log or a label refused, and no cleared row whose safety
 *  nothing can answer for.
 *
 *  The second requirement is what keeps a GO honest. An unlabeled row is not a
 *  pass: it is a row this corpus cannot check at all (no decision line, no
 *  authored label, or a line that only matches its first 120 characters), and
 *  a measurement that counted those as clear would report GO on a share it
 *  never verified. Fail closed: the gate says NO-GO and names what is missing. */
function gateOf(tally: VariantTally, calls: number, logRead: boolean): { go: boolean; why: string[] } {
	const why: string[] = [];
	if (!(tally.clearedCalls / calls > 0.3)) why.push(`volume ${pct(tally.clearedCalls, calls)} is not above 30.0%`);
	if (tally.safety.miss.rows > 0) why.push(`${tally.safety.miss.rows} cleared row(s) were refused by the log or an allow-label`);
	if (tally.safety.unlabeled.rows > 0) {
		const cut = tally.linkedByCut > 0 ? `, ${tally.linkedByCut} of them joined the log only through its 120-character cut` : "";
		why.push(`${tally.safety.unlabeled.rows} cleared row(s) carry no safety evidence${cut}${logRead ? "" : " (no decision log was read)"}`);
	}
	return { go: why.length === 0, why };
}

function emptyTally(variant: RoutineVariant): VariantTally {
	return {
		variant,
		clearedRows: 0,
		clearedCalls: 0,
		linked: 0,
		linkedByCut: 0,
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
			const verdict = recognizeRoutineCommand(row.command, { variant: tally.variant, taintedVars: CORPUS_TAINT });
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
			const join = row.label === undefined ? linkOf(index, row.command) : undefined;
			if (join !== undefined) {
				tally.linked++;
				if (join.cut) tally.linkedByCut++;
			}
			const resolved = safetyOf(row, join);
			tally.safety[resolved].rows++;
			tally.safety[resolved].calls += count;
			const link = join?.link;
			if (row.label !== undefined) {
				const bucket: ClearedOutcome = row.label === "allow" ? "label-allow" : "label-ask";
				tally.outcomeHistogram.set(bucket, (tally.outcomeHistogram.get(bucket) ?? 0) + 1);
			} else if (join === undefined) {
				tally.outcomeHistogram.set("no-record", (tally.outcomeHistogram.get("no-record") ?? 0) + 1);
			} else if (join.cut) {
				tally.outcomeHistogram.set("cut-ambiguous", (tally.outcomeHistogram.get("cut-ambiguous") ?? 0) + 1);
			} else {
				for (const outcome of join.link.outcomes) tally.outcomeHistogram.set(outcome, (tally.outcomeHistogram.get(outcome) ?? 0) + 1);
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

	console.log(`corpus      ${corpusPath}`);
	console.log(`rows        ${rows.length} distinct, ${calls} weighted calls`);
	console.log(`indexer     ${log.lines.length} decision lines${log.malformed.length > 0 ? `, ${log.malformed.length} unreadable` : ""}${logNote === "" ? "" : ` — ${logNote}`}`);
	console.log(`taint       ${CORPUS_TAINT} — a corpus row carries no session, so a shape that expands a variable cannot clear; "unknown" is not "nothing was captured"`);
	console.log("");

	for (const tally of tallies) {
		console.log(`=== variant: ${tally.variant} ===`);
		console.log(`clear share rows   ${tally.clearedRows}/${rows.length} = ${pct(tally.clearedRows, rows.length)}`);
		console.log(`clear share volume ${tally.clearedCalls}/${calls} = ${pct(tally.clearedCalls, calls)}  <- the gate's number`);
		console.log(`ceiling (one segment + a listed verb, every other rule ignored): ${tally.ceilingRows}/${rows.length} rows = ${pct(tally.ceilingRows, rows.length)}, ${tally.ceilingCalls}/${calls} calls = ${pct(tally.ceilingCalls, calls)}`);
		console.log(`safety: pass=${tally.safety.pass.rows} rows (${tally.safety.pass.calls} calls), miss=${tally.safety.miss.rows} rows (${tally.safety.miss.calls} calls), unlabeled=${tally.safety.unlabeled.rows} rows (${tally.safety.unlabeled.calls} calls)`);
		console.log(`miss severity: ${tally.missUnsafe} carry an UNSAFE verdict, ${tally.missDenied} were denied by a human, ${tally.misses.length - tally.missDenied} were blocked by a non-verdict layer, a headless session or an outage`);
		console.log(`safety evidence: ${tally.linked}/${tally.clearedRows} cleared rows found in the log${tally.linkedByCut > 0 ? `, ${tally.linkedByCut} of them only through its 120-character cut (a prefix: a different suffix would store the same key)` : ""}; an unlabeled row is not a pass and blocks the gate`);
		const histogram = [...tally.outcomeHistogram.entries()].sort((a, b) => b[1] - a[1]);
		console.log(`what the record says about cleared rows (a row can carry more than one outcome): ${histogram.length === 0 ? "nothing" : histogram.map(([outcome, rows]) => `${outcome}=${rows}`).join(", ")}`);
		const gate = gateOf(tally, calls, logNote === "");
		console.log(`gate: ${gate.go ? "GO" : `NO-GO — ${gate.why.join("; ")}`} — needs >30.0% of volume, zero refused rows and zero unverified rows`);
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
				const verdict = recognizeRoutineCommand(row.command, { variant: tally.variant, taintedVars: CORPUS_TAINT });
				if (!verdict.routine) continue;
				const join = row.label === undefined ? linkOf(index, row.command) : undefined;
				console.log(`  ${safetyOf(row, join).padEnd(9)} ${String(row.count ?? 1).padStart(4)} ${printable(row.command)}`);
			}
			console.log("");
		}
	}
}

if (import.meta.main) await main();
