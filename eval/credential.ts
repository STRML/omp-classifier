import { join } from "node:path";
import { type ApiKeyResolver, TYPESAFE_PROVIDER } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAuthStorage, Settings } from "@oh-my-pi/pi-coding-agent/sdk";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface TypesafeCredential {
	/** The host's own auth-retry resolver: what NativeJudge takes as `apiKey`. */
	apiKey: ApiKeyResolver;
	/** Whether any source holds a key, checked once so a run can warn up front. */
	present: boolean;
	close(): void;
}

/**
 * The TypeSafe credential an eval run judges with, resolved the way a session
 * resolves it: the host ModelRegistry over the native auth store, which also
 * installs `providers.typesafe.apiKey` from models.yml (a literal or a
 * `!command`). The auth store opened alone misses a models.yml key, and every
 * uncached case of such a run came back UNAVAILABLE. Settings load read-only:
 * an eval run must not migrate or write the user's agent dir. The store owns a
 * SQLite handle, so callers close it on every exit path.
 */
export async function openTypesafeCredential(): Promise<TypesafeCredential> {
	const settings = await Settings.loadReadOnly();
	const store = await discoverAuthStorage();
	try {
		const registry = new ModelRegistry(store, join(getAgentDir(), "models.yml"), { settings });
		const present = (await registry.getApiKeyForProvider(TYPESAFE_PROVIDER)) !== undefined;
		return { apiKey: registry.resolver(TYPESAFE_PROVIDER), present, close: () => store.close() };
	} catch (err) {
		store.close();
		throw err;
	}
}
