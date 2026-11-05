/**
 * End-to-end check of plan v4 (docs/plans/2026-11-04-stage-2-latch-scope.md)
 * against a real pi-natives Shell: the host's report goes through the gate's
 * own `fromHostReport` and `reportRefusal`, and the allow's token goes back to
 * the shell's `run({ expect })`.
 *
 *   OMP_NATIVES=<fork>/packages/natives/native/index.js bun eval/shell-state-e2e.ts
 *
 * Prints one row per step and exits non-zero when any row is not what the plan
 * says. The rows are the PR's artifact.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandStateRefusal, fromHostReport, reportRefusal, shellStateToken } from "../shell-state";
import { gateResolve, withSearchPath } from "../stage-two";
import { touchesShellEnv } from "../index";

const nativesPath = process.env.OMP_NATIVES;
if (!nativesPath) throw new Error("set OMP_NATIVES to a pi-natives build that has Shell.inspect");
const { Shell } = (await import(nativesPath)) as { Shell: new () => NativeShell };

interface NativeShell {
	inspect(names: string[]): Promise<Parameters<typeof fromHostReport>[0] | null>;
	run(options: Record<string, unknown>, onChunk?: (error: unknown, chunk: string) => void): Promise<{ exitCode?: number; refused?: string }>;
}

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shell-state-e2e-")));
fs.mkdirSync(path.join(dir, "extract"));
fs.writeFileSync(path.join(dir, "src.txt"), "hello\n");
const shell = new Shell();
let failures = 0;

const run = async (command: string, expect?: unknown) => shell.run({ command, cwd: dir, ...(expect === undefined ? {} : { expect }) }, () => {});

/** What the gate decides for `command` on the shell as it is now. */
async function gate(command: string): Promise<{ decision: string; token?: unknown }> {
	const own = commandStateRefusal(command, touchesShellEnv);
	if (own !== undefined) return { decision: `skip: ${own}` };
	const words = ["tar"];
	const raw = await shell.inspect(words);
	if (raw === null) return { decision: "skip: no shell yet" };
	const report = fromHostReport(raw);
	const why = reportRefusal(report, words, word => withSearchPath(report.path, () => gateResolve(word, dir)));
	if (why !== undefined) return { decision: `skip: ${why}` };
	return { decision: "review", token: shellStateToken(report, []) };
}

function row(step: string, got: string, want: RegExp): void {
	const ok = want.test(got);
	if (!ok) failures += 1;
	console.log(`${ok ? "✓" : "✗"} ${step.padEnd(46)} ${got}`);
}

const TAR = "tar -xf archive.tar -C extract";
row("fresh session (no core yet)", (await gate(TAR)).decision, /^skip: no shell yet$/u);
await run("tar -cf archive.tar src.txt");
await run("NOW=$(date +%s); echo $((NOW-3600)) >/dev/null");
const first = await gate(TAR);
row("after DOPL's first call", first.decision, /^review$/u);
const ran = await run(TAR, first.token);
row("token-bound tar on that state", ran.refused ?? `exit ${ran.exitCode ?? 0}`, /^exit 0$/u);
row("the command's own arithmetic", (await gate(`echo $[w]; ${TAR}`)).decision, /^skip: .*arithmetic|^skip: the command itself/u);
// A name the gate's own environment does not hold, so unsetting it returns the
// shell to its baseline (GIT_SSH_COMMAND itself may already be exported).
const PROBE = "OMP_E2E_SSH_COMMAND";
if (process.env[PROBE] !== undefined) throw new Error(`${PROBE} must not be set for this run`);
await run(`export ${PROBE}='sh -c evil'`);
row(`after export ${PROBE}`, (await gate(TAR)).decision, new RegExp(PROBE, "u"));
const stale = await run("touch extract/MARKER", first.token);
row("old token after the export", `${stale.refused ?? "ran"}; marker ${fs.existsSync(path.join(dir, "extract/MARKER")) ? "created" : "absent"}`, /^shell state changed; marker absent$/u);
await run(`unset ${PROBE}`);
row(`after unset ${PROBE}`, (await gate(TAR)).decision, /^review$/u);
await run("trap 'echo hi' DEBUG");
row("after trap ... DEBUG", (await gate(TAR)).decision, /trap:DEBUG/u);
await run("trap - DEBUG; tar(){ echo shadow; }");
row("after tar(){ ... }", (await gate(TAR)).decision, /function/u);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "all rows as planned" : `${failures} row(s) not as planned`);
process.exit(failures === 0 ? 0 : 1);
