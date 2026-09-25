/**
 * Gate-measured network provenance (#65).
 *
 * The measured friction: `curl http://localhost:8000/…` and `ssh raw-ovh …`
 * were the two most common network false-asks in the decision log, because the
 * state carried no provenance for the called host. The tier rule is #63's —
 * the gate measures from this machine's own config and process state, and a
 * destination it could not measure produces no field at all, never a benign
 * guess.
 *
 * Every case here reads real files and real docker state: the fixtures write an
 * SSH config, a hosts file, a compose file, and a `docker ps` table, and the
 * measurement reads them. Nothing touches this machine's own /etc/hosts, its
 * SSH config, or the docker daemon, so the file is the same everywhere.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJevState, isLoopbackHost, jevQuestions, JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION, measureNetworkProvenance, type DockerTarget, type JevBatteryVersion, type NetworkSources } from "../jev.ts";
import { fire, jevSafeAnswer, loadPlugin, makeCtx, makeEvent, makeSettings, modelCalls, removeConfigFile, setJevAnswer, stateOf } from "./fixtures";

const SOCKET = { names: ["fixture-web", "fixture-db"], bindings: [{ container: "fixture-web", hostPort: 8000, containerPort: 80 }] };

const cleanup = (dir: string): void => {
	execSync(`trash ${JSON.stringify(dir)} 2>/dev/null || rm -rf ${JSON.stringify(dir)}`);
};

/** A docker CLI config dir whose current context names `endpoint`, written the
 *  way `docker context use` records it: the context name is in `config.json`,
 *  and the endpoint in the metadata dir named by its SHA-256. */
const dockerContext = (dir: string, name: string, endpoint: string): string => {
	const meta = join(dir, "contexts", "meta", createHash("sha256").update(name).digest("hex"));
	mkdirSync(meta, { recursive: true });
	writeFileSync(join(meta, "meta.json"), JSON.stringify({ Name: name, Endpoints: { docker: { Host: endpoint } } }));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ currentContext: name }));
	return dir;
};

/** A temp home with an SSH config, a hosts file, and an empty docker config
 *  dir, and a temp project with a compose file. Sources are injected so no test
 *  depends on this machine: the empty environment and the home-local config
 *  dir are what make the daemon measurement hermetic too. */
const fixture = (): { sources: NetworkSources; home: string; project: string; remove: () => void } => {
	const home = mkdtempSync(join(tmpdir(), "jev65-home-"));
	const project = mkdtempSync(join(tmpdir(), "jev65-project-"));
	mkdirSync(join(home, ".ssh"), { recursive: true });
	writeFileSync(join(home, ".ssh", "config"), "Host fixture-host\n  HostName 10.1.2.3\n  User deploy\n\nHost *\n  AddKeysToAgent yes\n");
	const hostsFile = join(home, "hosts");
	writeFileSync(hostsFile, "192.168.1.9 fixture-nas alias-nas\n127.0.0.1 fixture-www fixture.local\n");
	writeFileSync(join(project, "compose.yaml"), "services:\n  db:\n    image: mysql:8\n  web:\n    image: wordpress\nvolumes:\n  data:\n");
	return {
		sources: { sshConfigPaths: [join(home, ".ssh", "config")], hostsFile, dockerState: () => SOCKET, env: {}, dockerConfigDir: join(home, ".docker") },
		home,
		project,
		remove: () => {
			cleanup(home);
			cleanup(project);
		},
	};
};

describe("the loopback tier is read from the command's own URLs (#65)", () => {
	test("a loopback port is measured, whatever spelling the URL uses", () => {
		expect(measureNetworkProvenance("curl -s http://localhost:8000/x", "/tmp", {})?.localPorts).toEqual([8000]);
		expect(measureNetworkProvenance("curl -s http://127.0.0.1:3111/health", "/tmp", {})?.localPorts).toEqual([3111]);
		expect(measureNetworkProvenance("curl -s 'http://[::1]:8011/v1/models'", "/tmp", {})?.localPorts).toEqual([8011]);
		// No port named, no port measured.
		expect(measureNetworkProvenance("curl -s http://localhost/x", "/tmp", {})).toBeUndefined();
	});

	test("a port a port flag names on a loopback destination counts too", () => {
		expect(measureNetworkProvenance("ssh -p 2222 localhost uptime", "/tmp", {})?.localPorts).toEqual([2222]);
		expect(measureNetworkProvenance("nc -z localhost 5434", "/tmp", {})?.localPorts).toEqual([5434]);
	});

	test("the loopback predicate is the claim `localPorts` rests on", () => {
		for (const host of ["localhost", "LOCALHOST", "api.localhost", "127.0.0.1", "127.13.9.4", "::1"]) expect(isLoopbackHost(host)).toBe(true);
		for (const host of ["127.0.0.1.example.com", "notlocalhost", "0.0.0.0", "192.168.1.4", "localhost.example.com"]) expect(isLoopbackHost(host)).toBe(false);
	});
});

describe("the known-host tier is measured against this machine (#65)", () => {
	test("an SSH config alias is measured as known, with its source", () => {
		const { sources, project, remove } = fixture();
		try {
			const measured = measureNetworkProvenance("ssh fixture-host 'ls /tmp'", project, sources);
			expect(measured?.knownHosts).toEqual([{ host: "fixture-host", source: "ssh-config" }]);
			// The same alias reached through scp and rsync names the host too.
			expect(measureNetworkProvenance("scp build.tar fixture-host:/srv", project, sources)?.knownHosts[0]?.source).toBe("ssh-config");
			expect(measureNetworkProvenance("rsync -a build/ fixture-host:/srv/", project, sources)?.knownHosts[0]?.source).toBe("ssh-config");
		} finally {
			remove();
		}
	});

	test("a hosts-file name is measured as known; a user@ prefix and a port do not confuse it", () => {
		const { sources, project, remove } = fixture();
		try {
			expect(measureNetworkProvenance("curl -s http://fixture-nas:8080/", project, sources)?.knownHosts).toEqual([{ host: "fixture-nas", source: "hosts-file" }]);
			expect(measureNetworkProvenance("ssh deploy@fixture-nas uptime", project, sources)?.knownHosts).toEqual([{ host: "fixture-nas", source: "hosts-file" }]);
			// A name only one alias of the hosts line carries is still this machine's own naming.
			expect(measureNetworkProvenance("ssh alias-nas uptime", project, sources)?.knownHosts[0]?.host).toBe("alias-nas");
		} finally {
			remove();
		}
	});

	test("a container this machine runs is a known host; nothing else is", () => {
		const { sources, project, remove } = fixture();
		try {
			expect(measureNetworkProvenance("curl -s http://fixture-db:3000/", project, sources)?.knownHosts).toEqual([{ host: "fixture-db", source: "docker" }]);
			// Measured, not inferred from the shape of the name.
			expect(measureNetworkProvenance("ssh nobody-configured-this uptime", project, sources)).toBeUndefined();
			expect(measureNetworkProvenance("curl -s https://api.github.com/x", project, sources)).toBeUndefined();
		} finally {
			remove();
		}
	});

	test("a bare host mentioned inside a message is not a destination", () => {
		const { sources, project, remove } = fixture();
		try {
			// A remote verb is only read at the start of a segment, so the host a
			// commit message mentions is not a destination.
			expect(measureNetworkProvenance("git commit -m 'document ssh fixture-host'", project, sources)).toBeUndefined();
			// A URL is a URL wherever it is written — the same text a human
			// reads as an address — so a mention of one is measured as a
			// destination. The field still claims only what this machine's own
			// configuration names, never that the command reaches it.
			expect(measureNetworkProvenance("echo 'see http://fixture-nas/ for the docs'", project, sources)?.knownHosts).toEqual([{ host: "fixture-nas", source: "hosts-file" }]);
		} finally {
			remove();
		}
	});
});

describe("the docker tier is measured against this machine (#65)", () => {
	test("a loopback port a running container publishes is a docker target", () => {
		const { sources, project, remove } = fixture();
		try {
			const measured = measureNetworkProvenance("curl -s http://localhost:8000/my-garage/", project, sources);
			expect(measured?.localPorts).toEqual([8000]);
			expect(measured?.dockerNetworks).toEqual([{ target: "fixture-web", kind: "published-port", port: 8000, resolvesLocally: true }]);
			// An unpublished loopback port is a local process, but no docker target.
			expect(measureNetworkProvenance("curl -s http://localhost:9999/x", project, sources)).toEqual({ localPorts: [9999], knownHosts: [], dockerNetworks: [] });
		} finally {
			remove();
		}
	});

	test("a compose service the local compose file declares resolves locally", () => {
		const { sources, project, remove } = fixture();
		try {
			// The service name is measured against the file, so flags before and
			// after it cannot shift the operand.
			expect(measureNetworkProvenance("docker compose exec db wp db query 'SELECT 1'", project, sources)?.dockerNetworks).toEqual([
				{ target: "db", kind: "compose-service", resolvesLocally: true },
			]);
			// A daemon named as another host means the container runs there: the
			// local compose file declaring `web` is configuration for that stack,
			// not evidence that `web` runs on this machine (#121 review).
			expect(measureNetworkProvenance("docker -H tcp://x compose -f compose.yaml exec -u root web bash -c id", project, sources)?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			// A service the file does not declare is measured as not this stack's.
			expect(measureNetworkProvenance("docker compose exec cache redis-cli ping", project, sources)?.dockerNetworks).toEqual([
				{ target: "cache", kind: "compose-service", resolvesLocally: false },
			]);
			// A compound names its services in more than one segment.
			expect(measureNetworkProvenance("docker compose ps && docker compose exec db mysql -e 'select 1'", project, sources)?.dockerNetworks).toEqual([
				{ target: "db", kind: "compose-service", resolvesLocally: true },
			]);
			// No service named, nothing to measure.
			expect(measureNetworkProvenance("docker compose ps", project, sources)).toBeUndefined();
			expect(measureNetworkProvenance("docker ps", project, sources)).toBeUndefined();
		} finally {
			remove();
		}
	});

	test("a compose service is not measured without a compose file to read", () => {
		const { sources, remove } = fixture();
		const empty = mkdtempSync(join(tmpdir(), "jev65-empty-"));
		try {
			expect(measureNetworkProvenance("docker compose exec db mysql -e 'select 1'", empty, sources)).toBeUndefined();
		} finally {
			remove();
			cleanup(empty);
		}
	});
});

describe("the daemon decides the local claim, not the local file (#121 review)", () => {
	test("a daemon the command names as another host takes the local claim away", () => {
		const { sources, project, remove } = fixture();
		try {
			// The compose file declares `web`; the daemon the command names runs
			// on another host, so `web` is not a container on this machine.
			expect(measureNetworkProvenance("docker -H tcp://prod.example:2376 compose -f compose.yaml exec web sh", project, sources)?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			// The long form and the `=` form name the same daemon.
			expect(measureNetworkProvenance("docker --host tcp://prod.example:2376 compose exec web sh", project, sources)?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			expect(measureNetworkProvenance("docker --host=tcp://prod.example:2376 compose exec web sh", project, sources)?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			expect(measureNetworkProvenance("docker -H tcp://10.1.2.3:2376 compose exec web sh", project, sources)?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			// A docker-compose CLI's own globals come before its subcommand.
			expect(measureNetworkProvenance("docker-compose -H tcp://prod.example:2376 -f compose.yaml exec web sh", project, sources)?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
		} finally {
			remove();
		}
	});

	test("each segment's own daemon decides that segment's services", () => {
		const { sources, project, remove } = fixture();
		try {
			expect(measureNetworkProvenance("docker -H tcp://prod.example:2376 compose exec web sh && docker compose exec db sh", project, sources)?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
				{ target: "db", kind: "compose-service", resolvesLocally: true },
			]);
		} finally {
			remove();
		}
	});

	test("a loopback or local-socket daemon still measures as this machine", () => {
		const { sources, project, remove } = fixture();
		try {
			const local: DockerTarget[] = [{ target: "web", kind: "compose-service", resolvesLocally: true }];
			expect(measureNetworkProvenance("docker -H tcp://127.0.0.1:2375 compose exec web sh", project, sources)?.dockerNetworks).toEqual(local);
			expect(measureNetworkProvenance("docker -H tcp://localhost:2375 compose exec web sh", project, sources)?.dockerNetworks).toEqual(local);
			expect(measureNetworkProvenance("docker -H unix:///var/run/docker.sock compose exec web sh", project, sources)?.dockerNetworks).toEqual(local);
			// No daemon named at all is the CLI's own default local socket.
			expect(measureNetworkProvenance("docker compose exec web sh", project, sources)?.dockerNetworks).toEqual(local);
			// A `-c` after the subcommand is the shell's, not a context: it must
			// not be read as one and silence the claim.
			expect(measureNetworkProvenance("docker-compose -f compose.yaml exec web sh -c id", project, sources)?.dockerNetworks).toEqual(local);
			expect(measureNetworkProvenance("docker compose -f compose.yaml exec web sh -c id", project, sources)?.dockerNetworks).toEqual(local);
		} finally {
			remove();
		}
	});

	test("a daemon spelling this machine cannot read makes no local claim", () => {
		const { sources, project, remove } = fixture();
		try {
			// No scheme: nothing here measures which machine that names, and an
			// unmeasured daemon is never claimed as this machine's.
			const measured = measureNetworkProvenance("docker -H prod.example:2376 compose exec web sh", project, sources);
			expect(measured?.dockerNetworks).toEqual([{ target: "web", kind: "compose-service" }]);
			expect(JSON.stringify(measured?.dockerNetworks)).not.toContain("resolvesLocally");
		} finally {
			remove();
		}
	});

	test("DOCKER_HOST decides when the command names no daemon", () => {
		const { sources, project, remove } = fixture();
		try {
			const withHost = (host: string) => measureNetworkProvenance("docker compose exec web sh", project, { ...sources, env: { DOCKER_HOST: host } })?.dockerNetworks;
			expect(withHost("tcp://prod.example:2376")).toEqual([{ target: "web", kind: "compose-service", resolvesLocally: false }]);
			expect(withHost("unix:///var/run/docker.sock")).toEqual([{ target: "web", kind: "compose-service", resolvesLocally: true }]);
			expect(withHost("tcp://127.0.0.1:2375")).toEqual([{ target: "web", kind: "compose-service", resolvesLocally: true }]);
			expect(withHost("prod.example:2376")).toEqual([{ target: "web", kind: "compose-service" }]);
			// A `-H` the command carries still wins over the environment.
			expect(
				measureNetworkProvenance("docker -H unix:///var/run/docker.sock compose exec web sh", project, { ...sources, env: { DOCKER_HOST: "tcp://prod.example:2376" } })?.dockerNetworks,
			).toEqual([{ target: "web", kind: "compose-service", resolvesLocally: true }]);
		} finally {
			remove();
		}
	});

	test("the active docker context decides when nothing else names a daemon", () => {
		const { sources, home, project, remove } = fixture();
		try {
			const dir = join(home, ".docker");
			// The context `docker context use` made current names another host.
			dockerContext(dir, "prod", "tcp://prod.example:2376");
			expect(measureNetworkProvenance("docker compose exec web sh", project, { ...sources, dockerConfigDir: dir })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			expect(measureNetworkProvenance("docker compose exec web sh", project, { ...sources, dockerConfigDir: dir, env: { DOCKER_CONTEXT: "prod" } })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			// A context that names this machine's own socket is local.
			dockerContext(dir, "local", "unix:///var/run/docker.sock");
			expect(measureNetworkProvenance("docker compose exec web sh", project, { ...sources, dockerConfigDir: dir })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: true },
			]);
			// `--context` names the context the daemon comes from, and a context
			// whose endpoint cannot be read makes no claim.
			expect(measureNetworkProvenance("docker --context prod compose exec web sh", project, { ...sources, dockerConfigDir: dir })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			writeFileSync(join(dir, "config.json"), JSON.stringify({ currentContext: "ghost" }));
			expect(measureNetworkProvenance("docker compose exec web sh", project, { ...sources, dockerConfigDir: dir })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service" },
			]);
		} finally {
			remove();
		}
	});

	// Round 2 review: `DOCKER_HOST` answered alone and returned early, so a
	// `DOCKER_CONTEXT` naming another machine was never read — and `--config`,
	// which names the directory the CLI reads its contexts and its current
	// context from, was consumed and discarded. Both made a remote compose
	// service measure as local.
	test("a selector in the chain that names another machine is not answered alone", () => {
		const { sources, home, project, remove } = fixture();
		try {
			// A context that really resolves: `prod` names another machine, so the
			// chain contradicts the local `DOCKER_HOST`.
			const dir = dockerContext(join(home, ".docker"), "prod", "tcp://prod.example:2376");
			const env = { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "prod" };
			// The two selectors disagree about the machine, and which of them the
			// CLI's precedence picks is not recorded in this machine's state: no
			// local claim is made, and the port table is not read either (its
			// bindings would be claimed as this machine's own).
			const measured = measureNetworkProvenance("curl -s http://localhost:8000/x", project, { ...sources, dockerConfigDir: dir, env });
			expect(measured).toEqual({ localPorts: [8000], knownHosts: [], dockerNetworks: [] });
			expect(measureNetworkProvenance("docker compose exec web sh", project, { ...sources, dockerConfigDir: dir, env })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service" },
			]);
		} finally {
			remove();
		}
	});

	test("--config names the config directory the daemon is measured in, not the process's own", () => {
		const { sources, home, project, remove } = fixture();
		try {
			const processConfig = dockerContext(join(home, ".docker"), "local", "unix:///var/run/docker.sock");
			const remoteConfig = dockerContext(join(home, "remote-docker"), "prod", "tcp://prod.example:2376");
			// The process config is this machine's; the directory the command
			// names carries a context pointing at another machine.
			expect(measureNetworkProvenance(`docker --config ${remoteConfig} compose exec web sh`, project, { ...sources, dockerConfigDir: processConfig })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: false },
			]);
			// And the reverse: the command's own directory is the one that counts.
			expect(measureNetworkProvenance(`docker --config ${processConfig} compose exec web sh`, project, { ...sources, dockerConfigDir: remoteConfig })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service", resolvesLocally: true },
			]);
			// A `--config` value the shell would expand names no directory this
			// gate read, so the invocation's daemon is not measured — the fallback
			// to the process config would be a file the command never reads.
			expect(measureNetworkProvenance("docker --config $DOCKER_DIR compose exec web sh", project, { ...sources, dockerConfigDir: processConfig })?.dockerNetworks).toEqual([
				{ target: "web", kind: "compose-service" },
			]);
		} finally {
			remove();
		}
	});

	test("the docker port table is this machine's only when this machine's daemon is local", () => {
		const { sources, project, remove } = fixture();
		try {
			// The table is read from the gate's own daemon: when the machine's own
			// environment points that daemon elsewhere, the containers it lists are
			// not containers on this machine.
			const remote = { ...sources, env: { DOCKER_HOST: "tcp://prod.example:2376" } };
			expect(measureNetworkProvenance("curl -s http://localhost:8000/x", project, remote)).toEqual({ localPorts: [8000], knownHosts: [], dockerNetworks: [] });
			expect(measureNetworkProvenance("curl -s http://localhost:8000/x", project, sources)?.dockerNetworks).toEqual([
				{ target: "fixture-web", kind: "published-port", port: 8000, resolvesLocally: true },
			]);
		} finally {
			remove();
		}
	});
});

describe("the state carries the measured tier, and absence means nothing measured (#65)", () => {
	test("the measured field rides the state with its authority note", () => {
		const { sources, project, remove } = fixture();
		try {
			const measured = measureNetworkProvenance("ssh fixture-host 'ls /tmp'", project, sources);
			const state = buildJevState({ command: "ssh fixture-host 'ls /tmp'", workingDirectory: project, networkProvenance: measured }) as Record<string, unknown>;
			const provenance = state.networkProvenance as Record<string, unknown>;
			expect(provenance.knownHosts).toEqual([{ host: "fixture-host", source: "ssh-config" }]);
			expect(String(provenance.note)).toContain("measured by the gate");
			expect(String(provenance.note)).toContain("not written by the command's author");
		} finally {
			remove();
		}
	});

	test("nothing measured means no field at all", () => {
		const state = buildJevState({ command: "curl -s https://example.com/x", workingDirectory: "/repo" }) as Record<string, unknown>;
		expect("networkProvenance" in state).toBe(false);
		// An empty measurement is never emitted as an empty tier.
		expect(measureNetworkProvenance("bun test", "/tmp", {})).toBeUndefined();
	});

	test("the criteria name the field, so the model can use it", () => {
		const versions: JevBatteryVersion[] = [JEV_POLICY_VERSION, JEV_V3_POLICY_VERSION];
		for (const version of versions) {
			const questions = jevQuestions(version) as Record<string, { instructions: string; criteria: Record<string, string> }>;
			const egress = questions.sends_local_data_outbound;
			const remote = questions.contacts_remote_endpoint;
			expect(egress.instructions).toContain("`networkProvenance.localPorts`");
			expect(egress.instructions).toContain("`networkProvenance.knownHosts`");
			expect(egress.criteria.false).toContain("`networkProvenance.localPorts`");
			expect(egress.criteria.false).toContain("`networkProvenance.knownHosts`");
			expect(egress.criteria.false).toContain("`networkProvenance.dockerNetworks`");
			expect(remote.instructions).toContain("`networkProvenance.localPorts`");
			expect(remote.instructions).toContain("`networkProvenance.knownHosts`");
			expect(remote.instructions).toContain("`networkProvenance.dockerNetworks`");
		}
	});
});

describe("the gate measures it before the battery is asked (#65)", () => {
	let seq = 0;
	beforeEach(async () => {
		removeConfigFile();
		await loadPlugin(makeSettings([]));
		setJevAnswer(jevSafeAnswer());
	});

	// The command is textual-loopback, so the assertion holds on any machine;
	// the docker table only adds a published-port entry when one exists.
	const lastState = async (command: string): Promise<Record<string, unknown>> => {
		seq += 1;
		await fire("tool_call", makeEvent(command), makeCtx({ sessionId: `net-prov-${seq}` }));
		return stateOf(modelCalls.length - 1);
	};

	test("a loopback curl reaches Jev with its measured port", async () => {
		const state = await lastState("curl -s http://localhost:8000/x");
		const provenance = state.networkProvenance as { localPorts: number[]; note: string } | undefined;
		expect(provenance?.localPorts).toEqual([8000]);
		expect(String(provenance?.note)).toContain("measured by the gate");
	});

	test("an unknown host reaches Jev with no provenance field at all", async () => {
		const state = await lastState("ssh no-such-host-in-any-config uptime");
		expect("networkProvenance" in state).toBe(false);
	});

	// The tier is measured over the text the judge reads, and #67 made that text
	// the command with its script bodies spliced in. So a URL that only exists
	// inside a script is measured like one written on the command line: the
	// alternative (measuring the bare command) would hand the judge a body that
	// talks to a port the state says nothing about.
	test("a loopback URL inside a script body is measured, because the body is judged (#67)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jev65-judged-"));
		const script = join(dir, "probe.py");
		writeFileSync(script, 'import urllib.request\nurllib.request.urlopen("http://localhost:8000/x")\n');
		try {
			const state = await lastState(`python3 ${script}`);
			const provenance = state.networkProvenance as { localPorts: number[] } | undefined;
			expect(provenance?.localPorts).toEqual([8000]);
		} finally {
			cleanup(dir);
		}
	});
});
