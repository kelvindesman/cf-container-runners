/**
 * Bindings and the narrow slices of the Durable Object / Container runtime
 * this service uses. Declared structurally so tests can supply fakes.
 */
import type { RawVars } from "./config";
import type { GitHubSecrets } from "./github";

export interface StorageLike {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<boolean>;
	deleteAll(): Promise<void>;
	getAlarm(): Promise<number | null>;
	setAlarm(at: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}

export interface ContainerLike {
	readonly running: boolean;
	start(options?: {
		env?: Record<string, string>;
		enableInternet?: boolean;
	}): void | Promise<void>;
	monitor(): Promise<void>;
	destroy(reason?: unknown): Promise<void>;
}

export interface StateLike {
	storage: StorageLike;
	container?: ContainerLike;
}

export interface StubLike {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface NamespaceLike {
	idFromName(name: string): unknown;
	get(id: unknown): StubLike;
}

export interface Env extends RawVars, GitHubSecrets {
	/** HMAC secret configured on the GitHub App / webhook. Required. */
	GITHUB_WEBHOOK_SECRET?: string;
	/** Bearer token for GET /stats. Optional; /stats is disabled without it. */
	ADMIN_TOKEN?: string;
	DISPATCHER: NamespaceLike;
	RUNNER_LIGHT: NamespaceLike;
	RUNNER_HEAVY?: NamespaceLike;
}
