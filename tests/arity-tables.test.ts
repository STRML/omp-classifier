/**
 * The generated tool grammars: `arity.generated.ts` (the table),
 * `tools/generate-arity.ts` (the generator and its parsers) and `arity.ts` (the
 * summary's reader).
 *
 * The table is only as good as the probes behind it, so it is checked twice.
 * The parsers are pinned against recorded excerpts of the tools' own help,
 * which always runs and is deterministic. The entries the summary actually
 * reads are then re-derived from the live tools, through the same probe
 * function the generator uses: a tool that moved and no longer agrees with the
 * table fails that half, and the fix is `bun run generate-arity`. A tool that is
 * not installed skips its own check, which is what CI without kubectl looks
 * like — the parsers are the CI signal, the live checks are the drift signal.
 */
import { describe, expect, test } from "bun:test";
import { toolGrammar } from "../arity";
import { commandSections, gitGlobalReadings, kubectlReadings, leadingWords, npmCommands, npmFlagReadings, pflagReadings, probe, yarnFlagReadings, type FlagReading } from "../tools/generate-arity";

const bySpelling = (readings: readonly FlagReading[]): Record<string, FlagReading | undefined> => {
	const table: Record<string, FlagReading | undefined> = {};
	for (const reading of readings) for (const spelling of [reading.short, reading.long]) if (spelling !== undefined) table[spelling] = reading;
	return table;
};

/** A check against a live tool, skipped when the tool is not installed. */
const live = (name: string, tool: string, body: () => void): void => {
	test.skipIf(Bun.which(tool) === null)(name, body);
};

describe("the parsers read the tools' own help", () => {
	test("a typed usage block separates a value placeholder from a description", () => {
		// Recorded from `gh api --help` (gh 2.101.0).
		const help = [
			"FLAGS",
			"      --allow-escape-sequences   Allow printing terminal escape sequences",
			'      --cache duration           Cache the response, e.g. "3600s", "60m", "1h"',
			"  -F, --field key=value          Add a typed parameter in key=value format",
			'  -X, --method string            The HTTP method for the request (default "GET")',
			"  -i, --include                  Include HTTP response status line and headers in the output",
		].join("\n");
		const readings = bySpelling(pflagReadings(help));
		expect(readings["--method"]).toMatchObject({ short: "-X", valued: true });
		expect(readings["-X"]).toMatchObject({ long: "--method", valued: true });
		expect(readings["--field"]).toMatchObject({ valued: true });
		// `Allow printing…` is a description, not a placeholder, and the flag
		// takes no value.
		expect(readings["--allow-escape-sequences"]).toMatchObject({ valued: false });
		expect(readings["--include"]).toMatchObject({ valued: false });
	});

	test("git's help puts a value in angle brackets and a long description below", () => {
		// Recorded from `git push -h` (git 2.54.0).
		const help = [
			"usage: git push [<options>] [<repository> [<refspec>...]]",
			"",
			"    -v, --[no-]verbose    be more verbose",
			"    --[no-]repo <repository>",
			"                          repository",
			"    --[no-]force-with-lease[=<refname>:<expect>]",
			"                          require old value of ref to be at this value",
			"    -f, --[no-]force      force updates",
		].join("\n");
		const readings = bySpelling(pflagReadings(help));
		expect(readings["--repo"]).toMatchObject({ valued: true });
		// A value that only ever arrives attached never eats the next word.
		expect(readings["--force-with-lease"]).toMatchObject({ valued: false, attached: true });
		expect(readings["--force"]).toMatchObject({ short: "-f", valued: false });
		expect(readings["--verbose"]).toMatchObject({ valued: false });
	});

	test("kubectl prints each flag with its default", () => {
		// Recorded from `kubectl delete --help` (kubectl v1.33.9).
		const help = [
			"Options:",
			"    --all=false:",
			"\tDelete all resources, in the namespace of the specified resource types.",
			"",
			"    -f, --filename=[]:",
			"\tcontaining the resource to delete.",
			"",
			"    --wait=true:",
			"\tIf true, wait for resources to be gone before returning. This waits for finalizers.",
		].join("\n");
		const readings = bySpelling(kubectlReadings(help));
		expect(readings["--all"]).toMatchObject({ valued: false });
		expect(readings["--wait"]).toMatchObject({ valued: false });
		expect(readings["-f"]).toMatchObject({ long: "--filename", valued: true });
	});

	test("npm marks a value with a placeholder in its bracketed usage", () => {
		// Recorded from `npm -l` (npm 12.0.1).
		const options = "[--audit-level <info|low|moderate|high|critical|none>] [--dry-run] [-f|--force] [--omit <dev|optional|peer> [--omit <dev|optional|peer> ...]]";
		const readings = bySpelling(npmFlagReadings(options));
		expect(readings["--audit-level"]).toMatchObject({ valued: true });
		expect(readings["--omit"]).toMatchObject({ valued: true });
		expect(readings["--dry-run"]).toMatchObject({ valued: false });
		expect(readings["-f"]).toMatchObject({ long: "--force", valued: false });
	});

	test("yarn marks a value with its own placeholder", () => {
		// Recorded from `yarn --help` (yarn 4.18.0).
		const usage = "npm publish [--access #0] [--tag #0] [--tolerate-republish] [--otp #0] [--provenance] [-n,--dry-run] [--json] [--staged]";
		const readings = bySpelling(yarnFlagReadings(usage));
		expect(readings["--tag"]).toMatchObject({ valued: true });
		expect(readings["--access"]).toMatchObject({ valued: true });
		expect(readings["--provenance"]).toMatchObject({ valued: false });
		expect(readings["-n"]).toMatchObject({ long: "--dry-run", valued: false });
	});

	test("a sectioned command list is read, and prose is not", () => {
		// Recorded from `gh --help`, `docker --help` and `kubectl --help`.
		expect(commandSections(["USAGE", "  gh auth <command> [flags]", "", "AVAILABLE COMMANDS", "  login:         Log in to a GitHub account", "  token:         Print the authentication token"].join("\n"))).toEqual(["login", "token"]);
		expect(commandSections(["Management Commands:", "  buildx*     Docker Buildx", "  container   Manage containers", "", "  $ docker run hello-world"].join("\n"))).toEqual(["buildx", "container"]);
		// A usage line is not an entry: one space after its first word.
		expect(commandSections(["Usage:  docker rm [OPTIONS] CONTAINER [CONTAINER...]", "  rm          Remove one or more containers"].join("\n"))).toEqual(["rm"]);
	});

	test("git's global flags come off its own usage line", () => {
		// Recorded from `git --help` (git 2.54.0), which prints no flag table:
		// the usage line is the tool's only statement of these.
		const help = [
			"usage: git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]",
			"           [--exec-path[=<path>]] [--html-path] [--man-path] [--info-path]",
			"           [-p | --paginate | -P | --no-pager] [--no-replace-objects]",
			"           [--git-dir=<path>] [--work-tree=<path>] [--namespace=<name>]",
			"           <command> [<args>]",
			"",
			"The most commonly used git commands are:",
		].join("\n");
		const readings = bySpelling(gitGlobalReadings(help));
		// `-C /repo push` is a push, not a command called `/repo`.
		expect(readings["-C"]).toMatchObject({ valued: true });
		expect(readings["-c"]).toMatchObject({ valued: true });
		expect(readings["--paginate"]).toMatchObject({ short: "-p", valued: false });
		expect(readings["--no-pager"]).toMatchObject({ valued: false });
		// A value that only ever arrives attached takes no next word.
		expect(readings["--git-dir"]).toMatchObject({ valued: false, attached: true });
		expect(readings["--exec-path"]).toMatchObject({ valued: false, attached: true });
	});

	test("a usage line names its command path and stops at the first argument", () => {
		expect(leadingWords("access set status=public|private [<package>]")).toEqual(["access", "set"]);
		expect(leadingWords("run <command>")).toEqual(["run"]);
		expect(leadingWords("stage approve [--otp #0] <stageId>")).toEqual(["stage", "approve"]);
	});
});

describe("the generated table carries the tools' own grammar", () => {
	test("every tool the summary reads a grammar from is in the table", () => {
		for (const tool of ["npm", "yarn", "gh", "docker", "kubectl", "git", "brew"]) expect({ tool, grammar: toolGrammar(tool) !== undefined }).toEqual({ tool, grammar: true });
	});

	test("a tool with no table has no grammar, so its callers keep the old rules", () => {
		for (const tool of ["ssh", "glab", "pnpm", "podman", "aws"]) expect({ tool, grammar: toolGrammar(tool) }).toEqual({ tool, grammar: undefined });
	});

	test("a nested namespace knows its own commands", () => {
		// The issue's two namespace shapes, plus the deeper path a tool states.
		expect(toolGrammar("yarn")?.names(["npm"], "publish")).toBe(true);
		expect(toolGrammar("brew")?.names(["bundle"], "install")).toBe(true);
		expect(toolGrammar("docker")?.names(["container"], "rm")).toBe(true);
		// `npm run publish` runs a script: npm's own tree says `run` has no
		// children, which is what keeps the kind off the second word.
		expect(toolGrammar("npm")?.names(["run"], "publish")).toBe(false);
		expect(toolGrammar("npm")?.names([], "publish")).toBe(true);
	});

	test("a valued flag keeps the tool's own name for its value", () => {
		expect(toolGrammar("gh")?.flags(["api"])?.valued("-X")).toBe("method");
		expect(toolGrammar("gh")?.flags(["api"])?.valued("--method")).toBe("method");
		expect(toolGrammar("kubectl")?.flags(["delete"])?.valued("-f")).toBe("filename");
		// docker's `-f` is `--force` to `docker container rm` and a filename to
		// `docker build`, which is why an arity has to be per command.
		expect(toolGrammar("docker")?.flags(["container", "rm"])?.valued("-f")).toBeUndefined();
		expect(toolGrammar("docker")?.flags(["build"])?.valued("-f")).toBe("file");
	});

	test("a short spelling's own long name is what decides a widening", () => {
		expect(toolGrammar("git")?.flags(["push"])?.widening("-f")).toBe("force");
		expect(toolGrammar("docker")?.flags(["container", "rm"])?.widening("-f")).toBe("force");
		expect(toolGrammar("gh")?.flags(["pr", "merge"])?.widening("-d")).toBe("delete-branch");
		// A spelling the tool does not print has no reading at all.
		expect(toolGrammar("git")?.flags(["push"])?.valued("-Z")).toBeUndefined();
		expect(toolGrammar("git")?.flags(["push"])?.boolean("-Z")).toBe(false);
	});
});

describe("the table still says what the installed tools say", () => {
	live("gh types -X as its method flag", "gh", () => {
		const reading = pflagReadings(probe(["gh", "api", "--help"]) ?? "").find(entry => entry.short === "-X");
		expect(reading).toMatchObject({ valued: true });
		expect(toolGrammar("gh")?.flags(["api"])?.valued("-X")).toBe((reading?.long ?? "").replace(/^--/u, ""));
	});

	live("docker knows container rm's -f and no value behind it", "docker", () => {
		const reading = pflagReadings(probe(["docker", "container", "rm", "--help"]) ?? "").find(entry => entry.short === "-f");
		expect(reading).toMatchObject({ valued: false });
		expect(toolGrammar("docker")?.flags(["container", "rm"])?.valued("-f")).toBeUndefined();
		expect(toolGrammar("docker")?.flags(["container", "rm"])?.widening("-f")).toBe((reading?.long ?? "--").replace(/^--/u, ""));
	});

	live("kubectl types -f as a filename", "kubectl", () => {
		const reading = kubectlReadings(probe(["kubectl", "delete", "--help"]) ?? "").find(entry => entry.short === "-f");
		expect(reading).toMatchObject({ valued: true });
		expect(toolGrammar("kubectl")?.flags(["delete"])?.valued("-f")).toBe((reading?.long ?? "").replace(/^--/u, ""));
	});

	live("git types push's -o as a value", "git", () => {
		const readings = pflagReadings(probe(["git", "push", "-h"]) ?? "");
		const option = readings.find(entry => entry.short === "-o");
		const force = readings.find(entry => entry.short === "-f");
		expect(option).toMatchObject({ valued: true });
		expect(force).toMatchObject({ valued: false });
		expect(toolGrammar("git")?.flags(["push"])?.valued("-o")).toBe((option?.long ?? "").replace(/^--/u, ""));
		// The widening comes from the same line: `-f` is force because git says
		// `-f` is `--force`.
		expect(toolGrammar("git")?.flags(["push"])?.widening("-f")).toBe((force?.long ?? "--").replace(/^--/u, ""));
	});

	live("npm lists publish as a command and types --audit-level", "npm", () => {
		expect(npmCommands(probe(["npm", "--help"]) ?? "")).toContain("publish");
		expect(toolGrammar("npm")?.names([], "publish")).toBe(true);
		const reading = npmFlagReadings(probe(["npm", "audit", "--help"]) ?? "").find(entry => entry.long === "--audit-level");
		expect(reading).toMatchObject({ valued: true });
		expect(toolGrammar("npm")?.flags(["audit"])?.valued("--audit-level")).toBe("audit-level");
	});

	live("yarn names the npm namespace and types its tag", "yarn", () => {
		const help = probe(["yarn", "--help"]) ?? "";
		expect(help).toContain("yarn npm publish");
		expect(toolGrammar("yarn")?.names(["npm"], "publish")).toBe(true);
		const reading = yarnFlagReadings(help.split("\n").find(line => line.includes("yarn npm publish")) ?? "").find(entry => entry.long === "--tag");
		expect(reading).toMatchObject({ valued: true });
		expect(toolGrammar("yarn")?.flags(["npm", "publish"])?.valued("--tag")).toBe("tag");
	});

	live("brew names bundle's own subcommands", "brew", () => {
		// `brew commands` prints one bare name per line, its own list of them.
		const commands = (probe(["brew", "commands"]) ?? "")
			.split("\n")
			.map(line => line.trim());
		expect(commands).toContain("bundle");
		expect(toolGrammar("brew")?.names([], "bundle")).toBe(true);
		const help = probe(["brew", "bundle", "--help"]) ?? "";
		expect(commandSections(help)).toContain("install");
		expect(toolGrammar("brew")?.names(["bundle"], "install")).toBe(true);
	});
});
