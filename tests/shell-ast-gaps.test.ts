/**
 * Three gaps in the parser adapter, each a place where a caller was told less
 * than bash does:
 *
 * - mvdan-sh's Walk does not enter a parameter expansion's slice, and keeps an
 *   extended glob's pattern as raw text, so `${x:$(cmd):1}` and `@($(cmd)|c)`
 *   listed no nested command although bash runs `cmd`;
 * - every `>&word` was a descriptor copy, but bash copies only for a number or
 *   `-`, so `>&out.txt` (a file written like `&>out.txt`) left no write in the
 *   action summary;
 * - a pipeline of a few thousand stages parses and then overflows Walk's
 *   stack, and two exported readers let that RangeError escape.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { summarizeActions } from "../authorization";
import { hiddenArithmetic, parseShell, shellDefinesFunction, shellRunsInSourceOrder, substitutionSpans, type ShellCommand } from "../shell-ast";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, modelCalls, refusalOf, removeConfigFile, resultText, setJevAnswer } from "./fixtures";

const nested = (text: string): string[] => {
	const parsed = parseShell(text);
	if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.reason}`);
	return parsed.commands.filter((command: ShellCommand) => command.nested).map(command => command.words.map(word => word.value).join(" "));
};

describe("a substitution inside a parameter slice is a command", () => {
	test.each([
		["a slice offset", "echo ${x:$(echo SENT):1}"],
		["a slice length", "echo ${x:0:$(echo SENT)}"],
		["a negative offset in quotes", 'echo "${x: -$(echo SENT)}"'],
		["a slice inside an unquoted heredoc body", "cat <<EOF\n${x:$(echo SENT):1}\nEOF"],
		["a default inside a slice", "echo ${x:${y:-$(echo SENT)}}"],
	])("%s", (_name, command) => {
		expect(nested(command)).toEqual(["echo SENT"]);
		expect(substitutionSpans(command)).toEqual(["echo SENT"]);
	});

	test("the action summary sees the delete", () => {
		const kinds = summarizeActions({ command: "echo ${x:$(rm -rf ~/proj):1}" }).map(action => action.kind);
		expect(kinds).toContain("delete");
	});
});

describe("an extended glob that holds a substitution is not read", () => {
	test("the parse refuses it rather than listing no command", () => {
		const parsed = parseShell("echo @($(rm -rf ~/proj)|c)");
		expect(parsed.ok).toBe(false);
		// The fallback pairing still names the substitution.
		expect(substitutionSpans("echo @($(echo SENT)|c)")).toEqual(["echo SENT"]);
	});

	test("an extended glob of plain words still parses", () => {
		expect(parseShell("ls @(a|b).txt").ok).toBe(true);
	});
});

describe(">&word writes a file unless word is a descriptor", () => {
	const redirectOf = (text: string) => {
		const parsed = parseShell(text);
		if (!parsed.ok) throw new Error(parsed.reason);
		return parsed.commands[0].redirects[0];
	};

	test.each([
		[">&out.txt", "cat secrets >&out.txt", "&"],
		["1>&out.txt", "cat secrets 1>&out.txt", "&"],
		[">&$f", "cat secrets >&$f", "&"],
	])("%s is a file write", (_name, command, fd) => {
		const redirect = redirectOf(command);
		expect(redirect.duplicate).toBe(false);
		expect(redirect.fd).toBe(fd);
	});

	test.each([
		["2>&1", "cat x 2>&1"],
		[">&2", "cat x >&2"],
		[">&-", "cat x >&-"],
		["<&0", "cat <&0"],
	])("%s is a descriptor copy", (_name, command) => {
		expect(redirectOf(command).duplicate).toBe(true);
	});

	test("the action summary lists the write", () => {
		const writes = summarizeActions({ command: "cat ~/.aws/credentials >&out.txt" }).filter(action => action.kind === "write");
		expect(writes.flatMap(action => action.targets)).toContain("out.txt");
	});
});

describe("a tree too deep to walk fails closed", () => {
	const deep = `${Array(2800).fill("a").join("|")}|echo $(x)`;

	test("the exported readers answer instead of throwing", () => {
		expect(parseShell(deep).ok).toBe(true);
		expect(shellRunsInSourceOrder(deep)).toBe(false);
		expect(shellDefinesFunction(deep)).toBe(true);
		expect(substitutionSpans(deep)).toEqual(["x"]);
		expect(hiddenArithmetic(deep)).toBe("its shell body is too deep to read");
	}, 60_000);

	describe("through the gate", () => {
		beforeEach(async () => {
			removeConfigFile();
			await loadPlugin(makeSettings([]));
			setJevAnswer(jevSafeAnswer());
		});

		test("the call is judged, not an internal error", async () => {
			// Before, the RangeError escaped into the gate's catch-all and every
			// such call blocked as `internal-error` without a judgement.
			const result = resultText(await fire("tool_call", makeEvent(deep), makeCtx({ sessionId: "shell-ast-gaps-deep" })));
			if (result !== "ALLOWED") expect(refusalOf(result).layer).not.toBe("internal-error");
			expect(modelCalls.length).toBeGreaterThan(0);
		}, 60_000);
	});
});
