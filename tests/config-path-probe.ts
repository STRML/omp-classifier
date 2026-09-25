/**
 * Subprocess fixture for config-path.test.ts (issue #9).
 *
 * pi-utils freezes its directory resolver from the environment at module load,
 * so a path resolution can only be observed in a process that STARTED with the
 * environment under test — setting the variables inside `bun test` would not
 * move the resolver. Prints the paths the plugin would use, plus the host's own
 * plugin-root handle so the test can compare the two without assuming the
 * composition.
 *
 * Not a test file: `bun test` never collects it, it is spawned by the test with
 * an explicit env (never the suite's `OMP_JEV_CONFIG`).
 */
import * as path from "node:path";
import { getPluginsDir } from "@oh-my-pi/pi-utils";
import { classifierConfigPath, classifierDataDir, decisionsLogPath } from "../index";

console.log(
	JSON.stringify({
		configPath: classifierConfigPath(),
		dataDir: classifierDataDir(),
		decisionsLogPath: decisionsLogPath(),
		pluginsDir: getPluginsDir(),
		hostDataRoot: path.dirname(getPluginsDir()),
	}),
);
