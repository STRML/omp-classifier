import { describe, expect, test } from "bun:test";
import { literalMatchTally } from "../eval/literal-match-probe";

describe("literalMatchTally", () => {
	test("names the rows that match and tallies why the rest do not", () => {
		const tally = literalMatchTally(
			[
				{ source: "intent:45", command: "./scripts/deploy.sh --staging", cwd: "/Users/you/sites/project", userMessages: ["deploy to staging so I can check it"] },
				{ source: "intent:4", command: "cd /Users/you/sites/project && ./scripts/deploy.sh --prod 2>&1 | tail -5", cwd: "/Users/you/sites/project", userMessages: ["deploy to prod"] },
			],
			"/Users/you",
		);
		expect(tally.rows).toBe(2);
		expect(tally.matched.map(row => row.source)).toEqual(["intent:45"]);
		expect(tally.reasons["segment not extracted or inert"]).toBe(1);
	});
});
