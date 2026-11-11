import type { Env, NamespaceLike, StateLike, StorageLike, StubLike } from "../src/env";

export class FakeStorage implements StorageLike {
	data = new Map<string, unknown>();
	alarm: number | null = null;
	async get<T>(key: string): Promise<T | undefined> {
		const v = this.data.get(key);
		return v === undefined ? undefined : (structuredClone(v) as T);
	}
	async put<T>(key: string, value: T): Promise<void> {
		this.data.set(key, structuredClone(value));
	}
	async delete(key: string): Promise<boolean> {
		return this.data.delete(key);
	}
	async deleteAll(): Promise<void> {
		this.data.clear();
	}
	async getAlarm(): Promise<number | null> {
		return this.alarm;
	}
	async setAlarm(at: number): Promise<void> {
		this.alarm = at;
	}
	async deleteAlarm(): Promise<void> {
		this.alarm = null;
	}
}

export function fakeState(): StateLike & { storage: FakeStorage } {
	return { storage: new FakeStorage() };
}

export type Handler = (path: string, init: RequestInit | undefined, name: string) => Response | Promise<Response>;

/** A namespace whose stubs record every call and answer via `handler`. */
export function fakeNamespace(handler: Handler): NamespaceLike & { calls: Array<{ name: string; path: string; body: unknown }> } {
	const calls: Array<{ name: string; path: string; body: unknown }> = [];
	return {
		calls,
		idFromName: (name: string) => name,
		get(id: unknown): StubLike {
			const name = String(id);
			return {
				async fetch(input: string, init?: RequestInit) {
					const path = new URL(input).pathname;
					calls.push({ name, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
					return handler(path, init, name);
				},
			};
		},
	};
}

export function baseEnv(overrides: Partial<Env> = {}): Env {
	const noop = fakeNamespace(() => new Response("ok"));
	return {
		ALLOWED_REPOS: "acme/app",
		RUNNER_LABELS: "cf-runner=light,cf-runner-heavy=heavy",
		MAX_CONCURRENT: "2",
		MAX_JOB_MINUTES: "30",
		SPAWN_SPACING_MS: "0",
		GITHUB_WEBHOOK_SECRET: "test-secret",
		DISPATCHER: noop,
		RUNNER_LIGHT: noop,
		RUNNER_HEAVY: noop,
		...overrides,
	};
}
