// TEMPORARY, DO NOT MERGE. Finds what blocks a CI test for ~30 s: logs every
// synchronous child process, sync fs call and event-loop gap over a threshold,
// with the running test's name. Installed as a bun test preload by bunfig.toml.
import { afterEach, beforeEach, expect } from "bun:test";

const childProcess = require("node:child_process") as Record<string, unknown>;
const fs = require("node:fs") as Record<string, unknown>;
const realNow = performance.now.bind(performance);
const realSetInterval = globalThis.setInterval;
const testName = (): string => {
	try {
		return String((expect as unknown as { getState(): { currentTestName?: string } }).getState().currentTestName ?? "?");
	} catch {
		return "?";
	}
};
type Call = { label: string; start: number; dur: number };
const calls: Call[] = [];
const log = (line: string): void => {
	process.stderr.write(`CIPROBE ${line}\n`);
};

function wrap<T extends object>(target: T, name: keyof T & string, label: string, thresholdMs: number): void {
	const original = target[name] as unknown as (...args: unknown[]) => unknown;
	if (typeof original !== "function") return;
	try {
	const wrapped = function (this: unknown, ...args: unknown[]) {
		const started = realNow();
		try {
			return original.apply(this, args);
		} finally {
			const took = realNow() - started;
			calls.push({ label, start: started, dur: took });
			if (calls.length > 4000) calls.splice(0, 2000);
			if (took >= thresholdMs) log(`SLOW ${label} ${Math.round(took)}ms test=${testName()} args=${JSON.stringify(args[0]).slice(0, 160)}`);
		}
	};
	Object.assign(wrapped, original);
	(target as Record<string, unknown>)[name] = wrapped;
	} catch (error) {
		log(`wrap failed for ${label}: ${String(error)}`);
	}
}

wrap(Bun as unknown as Record<string, unknown>, "spawnSync", "Bun.spawnSync", 300);
for (const name of ["execFileSync", "execSync", "spawnSync"] as const) wrap(childProcess as Record<string, unknown>, name, `child_process.${name}`, 300);
for (const name of ["readFileSync", "realpathSync", "readdirSync", "statSync", "existsSync", "appendFileSync", "mkdirSync", "writeFileSync", "rmSync", "mkdtempSync"] as const) {
	wrap(fs, name, `fs.${name}`, 300);
}

let last = realNow();
let lastCpu = process.cpuUsage();
let lastRes = process.resourceUsage();
let startedAt = 0;
let running = "";
realSetInterval(() => {
	const now = realNow();
	const gap = now - last;
	last = now;
	const cpu = process.cpuUsage(lastCpu);
	const res = process.resourceUsage();
	if (gap > 1000) {
		log(`LOOP-GAP ${Math.round(gap)}ms userCpu=${Math.round(cpu.user / 1000)}ms sysCpu=${Math.round(cpu.system / 1000)}ms majorFaults+${res.majorPageFault - lastRes.majorPageFault} minorFaults+${res.minorPageFault - lastRes.minorPageFault} voluntaryCtx+${res.voluntaryContextSwitches - lastRes.voluntaryContextSwitches} rssMB=${Math.round(process.memoryUsage().rss / 1e6)} heapUsedMB=${Math.round(process.memoryUsage().heapUsed / 1e6)} test=${running}`);
	}
	if (gap > 1000) {
		const inGap = calls.filter(c => c.start >= now - gap - 50);
		const total = inGap.reduce((sum, c) => sum + c.dur, 0);
		const byLabel: Record<string, { n: number; ms: number }> = {};
		for (const c of inGap) { const e = (byLabel[c.label] ??= { n: 0, ms: 0 }); e.n += 1; e.ms += c.dur; }
		const top = Object.entries(byLabel).sort((a, b) => b[1].ms - a[1].ms).slice(0, 4).map(([k, v]) => `${k}:${v.n}x=${Math.round(v.ms)}ms`).join(' ');
		log(`GAP-EXPLAINED gap=${Math.round(gap)}ms wrappedCalls=${inGap.length} wrappedTotal=${Math.round(total)}ms unexplained=${Math.round(gap - total)}ms top=[${top}]`);
	}
	lastCpu = process.cpuUsage();
	lastRes = res;
	if (running !== "" && now - startedAt > 4000 && Math.round((now - startedAt) / 1000) % 5 === 0) {
		log(`STILL-RUNNING ${Math.round((now - startedAt) / 1000)}s test=${running} loopAlive=true`);
	}
}, 200);

beforeEach(() => {
	running = testName();
	startedAt = realNow();
});
afterEach(() => {
	const took = realNow() - startedAt;
	if (took > 3000) log(`TEST-SLOW ${Math.round(took)}ms test=${running}`);
	running = "";
});
