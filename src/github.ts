/**
 * The GitHub REST calls this service makes, and nothing else.
 *
 * Auth: a GitHub App (primary) or a fine-grained PAT (fallback). The App path
 * signs a 9-minute RS256 JWT with WebCrypto, exchanges it for an installation
 * token per repository owner, and caches that token in isolate memory until
 * five minutes before it expires. Neither credential ever leaves the Worker;
 * a container only ever receives a single-use JIT runner config.
 */
import type { Config } from "./config";

const API = "https://api.github.com";
const UA = "cf-container-runners";

export interface GitHubSecrets {
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	/** Optional fallback: a fine-grained personal access token. */
	GITHUB_PAT?: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

// ── RS256 JWT for GitHub App auth ────────────────────────────────────────────

function b64urlFromBytes(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(s: string): string {
	return b64urlFromBytes(new TextEncoder().encode(s));
}

function derLength(n: number): number[] {
	if (n < 0x80) return [n];
	const out: number[] = [];
	let v = n;
	while (v > 0) {
		out.unshift(v & 0xff);
		v >>= 8;
	}
	return [0x80 | out.length, ...out];
}

/**
 * GitHub hands out App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`); WebCrypto
 * only imports PKCS#8. Wrap the PKCS#1 body in the PKCS#8 envelope:
 * SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption OID, NULL }, OCTET STRING pkcs1 }.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
	const version = [0x02, 0x01, 0x00];
	const algorithm = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
		0x01, 0x05, 0x00,
	];
	const octet = [0x04, ...derLength(pkcs1.length)];
	const bodyLen =
		version.length + algorithm.length + octet.length + pkcs1.length;
	const head = [
		0x30,
		...derLength(bodyLen),
		...version,
		...algorithm,
		...octet,
	];
	const out = new Uint8Array(head.length + pkcs1.length);
	out.set(head, 0);
	out.set(pkcs1, head.length);
	return out;
}

/** Accepts PKCS#1 or PKCS#8 PEM, with real or escaped (`\n`) newlines. */
export function pemToPkcs8(pem: string): Uint8Array {
	const text = pem.replace(/\\n/g, "\n").trim();
	const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
	if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
	const bin = atob((m[2] ?? "").replace(/\s+/g, ""));
	const der = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	if (m[1] === "RSA PRIVATE KEY") return pkcs1ToPkcs8(der);
	if (m[1] === "PRIVATE KEY") return der;
	throw new Error(`unsupported PEM type "${m[1]}" for GITHUB_APP_PRIVATE_KEY`);
}

export async function signAppJwt(
	appId: string,
	privateKeyPem: string,
	nowMs: number,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const now = Math.floor(nowMs / 1000);
	// iat backdated 60 s for clock skew; GitHub caps exp at 10 minutes.
	const header = b64urlFromString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64urlFromString(
		JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }),
	);
	const data = `${header}.${payload}`;
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(data),
	);
	return `${data}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

// ── Transient-failure classification ─────────────────────────────────────────

/**
 * Worth retrying? `null` = no HTTP response (DNS/TLS/reset/timeout). 5xx
 * includes the 52x family Cloudflare synthesises on its own egress (522 is a
 * connect timeout GitHub never sends). Any other 4xx is a verdict on the
 * request or credential; retrying it only adds noise.
 */
export function isTransientStatus(status: number | null): boolean {
	if (status === null) return true;
	return status === 408 || status === 429 || status >= 500;
}

/** The sentence an operator should act on, by status. Never "check the token" for a network fault. */
export function describeGitHubFailure(status: number | null): string {
	if (status === null)
		return "no HTTP response (DNS/TLS/connection fault or timeout): network, not credentials";
	if (status === 401)
		return "credential rejected: App key / PAT invalid, expired or revoked";
	if (status === 403)
		return "credential lacks a permission, or secondary rate limit: check the App's permissions before rotating anything";
	if (status === 404)
		return "not visible to the credential: App not installed on this repo/org, or the name is wrong";
	if (status === 409) return "conflict: runner name already registered";
	if (status === 422)
		return "request rejected as invalid (e.g. runner group id, labels)";
	if (status === 429) return "rate limited";
	if (status >= 500)
		return "upstream/edge fault (GitHub 5xx or a Cloudflare 52x): credentials are NOT implicated";
	return "unexpected status";
}

// ── Client ───────────────────────────────────────────────────────────────────

export type JobState =
	| { kind: "queued"; runId: number | null }
	| { kind: "in_progress"; runId: number | null; startedAtMs: number | null }
	| { kind: "completed"; runId: number | null; completedAtMs: number | null }
	| { kind: "missing" };

export interface QueuedJob {
	id: number;
	runId: number;
	labels: string[];
	createdAtMs: number;
}

export interface RunnerRow {
	id: number;
	name: string;
	status: string;
	busy: boolean;
}

export type ApiResult<T> =
	| { ok: true; status: number; value: T }
	| { ok: false; status: number | null; detail: string };

interface CachedToken {
	token: string;
	expiresAt: number;
}

/** Per-isolate cache. Installation tokens live 1 h; we refresh 5 min early. */
const tokenCache = new Map<string, CachedToken>();

export function clearTokenCache(): void {
	tokenCache.clear();
}

export class GitHubClient {
	constructor(
		private readonly secrets: GitHubSecrets,
		private readonly cfg: Pick<Config, "runnerScope" | "runnerGroupId">,
		private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
		private readonly sleep: SleepFn = realSleep,
		private readonly now: () => number = Date.now,
	) {}

	static ownerOf(repo: string): string {
		return repo.slice(0, repo.indexOf("/"));
	}

	/** An installation token for `repo`'s owner, or the PAT. Throws with a named cause. */
	async token(repo: string): Promise<string> {
		if (this.secrets.GITHUB_APP_ID && this.secrets.GITHUB_APP_PRIVATE_KEY) {
			const owner = GitHubClient.ownerOf(repo).toLowerCase();
			const hit = tokenCache.get(owner);
			if (hit && hit.expiresAt - 5 * 60_000 > this.now()) return hit.token;
			const jwt = await signAppJwt(
				this.secrets.GITHUB_APP_ID,
				this.secrets.GITHUB_APP_PRIVATE_KEY,
				this.now(),
			);
			const appHeaders = {
				...this.baseHeaders(),
				authorization: `Bearer ${jwt}`,
			};
			const inst = await this.fetchFn(`${API}/repos/${repo}/installation`, {
				headers: appHeaders,
				signal: AbortSignal.timeout(10_000),
			});
			if (!inst.ok) {
				throw new Error(
					`GitHub App installation lookup for ${repo} failed: HTTP ${inst.status} (${describeGitHubFailure(inst.status)})`,
				);
			}
			const { id } = (await inst.json()) as { id: number };
			const res = await this.fetchFn(
				`${API}/app/installations/${id}/access_tokens`,
				{
					method: "POST",
					headers: appHeaders,
					signal: AbortSignal.timeout(10_000),
				},
			);
			if (!res.ok) {
				throw new Error(
					`installation token for ${owner} failed: HTTP ${res.status} (${describeGitHubFailure(res.status)})`,
				);
			}
			const body = (await res.json()) as { token: string; expires_at: string };
			const expiresAt = Date.parse(body.expires_at);
			tokenCache.set(owner, {
				token: body.token,
				expiresAt: Number.isNaN(expiresAt)
					? this.now() + 30 * 60_000
					: expiresAt,
			});
			return body.token;
		}
		if (this.secrets.GITHUB_PAT) return this.secrets.GITHUB_PAT;
		throw new Error(
			"no GitHub credential: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (or GITHUB_PAT)",
		);
	}

	private baseHeaders(): Record<string, string> {
		return {
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": UA,
		};
	}

	/** Base path for runner registration endpoints under the configured scope. */
	runnersBase(repo: string): string {
		return this.cfg.runnerScope === "org"
			? `${API}/orgs/${GitHubClient.ownerOf(repo)}/actions/runners`
			: `${API}/repos/${repo}/actions/runners`;
	}

	/**
	 * One request. GETs are retried on transient failures (3 attempts); writes
	 * are not, because a retried POST can double-act and the callers already
	 * have their own retry schedule.
	 */
	async request<T>(
		repo: string,
		url: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<ApiResult<T>> {
		const method = init.method ?? "GET";
		const attempts = method === "GET" ? 3 : 1;
		const delays = [750, 2_500];
		let status: number | null = null;
		let detail = "";
		for (let i = 1; i <= attempts; i++) {
			try {
				const token = await this.token(repo);
				const res = await this.fetchFn(url, {
					method,
					headers: {
						...this.baseHeaders(),
						authorization: `Bearer ${token}`,
						...(init.body !== undefined
							? { "content-type": "application/json" }
							: {}),
					},
					body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					const text = await res.text();
					return {
						ok: true,
						status: res.status,
						value: (text ? JSON.parse(text) : null) as T,
					};
				}
				status = res.status;
				detail = (await res.text().catch(() => "")).slice(0, 300);
			} catch (err) {
				status = null;
				detail = err instanceof Error ? err.message : String(err);
			}
			if (!isTransientStatus(status) || i === attempts) break;
			await this.sleep(delays[i - 1] ?? 2_500);
		}
		return { ok: false, status, detail };
	}

	/** Mint a single-use, single-job JIT runner config. */
	async generateJitConfig(
		repo: string,
		name: string,
		label: string,
	): Promise<ApiResult<string>> {
		const res = await this.request<{ encoded_jit_config?: string }>(
			repo,
			`${this.runnersBase(repo)}/generate-jitconfig`,
			{
				method: "POST",
				body: {
					name,
					// Repo-level runners only have the Default group (id 1).
					runner_group_id:
						this.cfg.runnerScope === "org" ? this.cfg.runnerGroupId : 1,
					labels: [label],
					work_folder: "_work",
				},
			},
		);
		if (!res.ok) return res;
		const jit = res.value?.encoded_jit_config;
		if (!jit)
			return {
				ok: false,
				status: res.status,
				detail: "response had no encoded_jit_config",
			};
		return { ok: true, status: res.status, value: jit };
	}

	async jobState(repo: string, jobId: number): Promise<JobState | null> {
		const res = await this.request<{
			status?: string;
			run_id?: number;
			started_at?: string | null;
			completed_at?: string | null;
		}>(repo, `${API}/repos/${repo}/actions/jobs/${jobId}`);
		if (!res.ok) return res.status === 404 ? { kind: "missing" } : null;
		const b = res.value ?? {};
		const runId = typeof b.run_id === "number" ? b.run_id : null;
		const ms = (s: string | null | undefined) => {
			const n = s ? Date.parse(s) : Number.NaN;
			return Number.isNaN(n) ? null : n;
		};
		if (b.status === "completed")
			return { kind: "completed", runId, completedAtMs: ms(b.completed_at) };
		if (
			b.status === "queued" ||
			b.status === "waiting" ||
			b.status === "pending"
		)
			return { kind: "queued", runId };
		return { kind: "in_progress", runId, startedAtMs: ms(b.started_at) };
	}

	/**
	 * Every queued job of every queued run in `repo`. Fails PARTIAL, never throws:
	 * a caller treating "fewer jobs than reality" as safe recovers nothing extra.
	 */
	async listQueuedJobs(
		repo: string,
		maxRunPages = 5,
	): Promise<{ jobs: QueuedJob[]; error: ApiResult<never> | null }> {
		const jobs: QueuedJob[] = [];
		for (let page = 1; page <= maxRunPages; page++) {
			const runs = await this.request<{
				workflow_runs?: Array<{ id: number }>;
			}>(
				repo,
				`${API}/repos/${repo}/actions/runs?status=queued&per_page=50&page=${page}`,
			);
			if (!runs.ok) return { jobs, error: runs };
			const list = runs.value?.workflow_runs ?? [];
			for (const run of list) {
				const res = await this.request<{
					jobs?: Array<{
						id: number;
						status: string;
						labels: string[];
						created_at: string;
					}>;
				}>(
					repo,
					`${API}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
				);
				if (!res.ok) continue;
				for (const j of res.value?.jobs ?? []) {
					if (j.status !== "queued") continue;
					jobs.push({
						id: j.id,
						runId: run.id,
						labels: j.labels ?? [],
						createdAtMs: Date.parse(j.created_at),
					});
				}
			}
			if (list.length < 50) break;
		}
		return { jobs, error: null };
	}

	/** Paginated runner list under the configured scope. Partial on failure. */
	async listRunners(
		repo: string,
		maxPages = 10,
	): Promise<{ runners: RunnerRow[]; error: ApiResult<never> | null }> {
		const runners: RunnerRow[] = [];
		for (let page = 1; page <= maxPages; page++) {
			const res = await this.request<{ runners?: RunnerRow[] }>(
				repo,
				`${this.runnersBase(repo)}?per_page=100&page=${page}`,
			);
			if (!res.ok) return { runners, error: res };
			const list = res.value?.runners ?? [];
			runners.push(...list);
			if (list.length < 100) break;
		}
		return { runners, error: null };
	}

	async deleteRunner(
		repo: string,
		runnerId: number,
	): Promise<ApiResult<unknown>> {
		return this.request(repo, `${this.runnersBase(repo)}/${runnerId}`, {
			method: "DELETE",
		});
	}

	async cancelRun(repo: string, runId: number): Promise<ApiResult<unknown>> {
		return this.request(
			repo,
			`${API}/repos/${repo}/actions/runs/${runId}/cancel`,
			{
				method: "POST",
			},
		);
	}
}
