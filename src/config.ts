/**
 * Configuration: every knob comes from `wrangler.jsonc` `vars` or a secret.
 * Nothing about the deployer (account, org, repo, domain, label) is hardcoded.
 *
 * `parseConfig` is pure and throws `ConfigError` on anything ambiguous, so a
 * typo in `wrangler.jsonc` fails loudly at the first webhook instead of
 * silently serving the wrong repos.
 */

/** Container classes. Each maps to one Durable Object class + instance type. */
export type RunnerClass = "light" | "heavy";
export const RUNNER_CLASSES: readonly RunnerClass[] = ["light", "heavy"];

export type RunnerScope = "repo" | "org";

export interface Config {
	/** Master switch. "0" stops all new spawns (webhooks are still verified + logged). */
	dispatchEnabled: boolean;
	/** Lower-cased allowlist entries: `owner/repo` or `owner/*`. Empty = nothing allowed. */
	allowedRepos: readonly string[];
	/** Lower-cased `owner/repo` entries allowed to use runners even though they are PUBLIC. */
	allowPublicRepos: readonly string[];
	/** Lower-cased runner label → container class. */
	labels: ReadonlyMap<string, RunnerClass>;
	/** Total containers alive at once, across all classes. The spend bound's first factor. */
	maxConcurrent: number;
	/** Hard wall-clock deadline per container. The spend bound's second factor. */
	maxJobMinutes: number;
	/** Log-only alert threshold. NEVER refuses a spawn. 0 disables. */
	softDailyBudgetMinutes: number;
	/** Where JIT runners register: per repository, or per organization. */
	runnerScope: RunnerScope;
	/** Runner group for org-scoped runners (1 = "Default"). Ignored for repo scope (always 1). */
	runnerGroupId: number;
	/** Prefix of every runner name this service mints. The reaper only ever touches this prefix. */
	runnerNamePrefix: string;
	/** Seconds a booted runner waits for a job before deregistering. Empty = image default. */
	idleGraceSeconds: string;
	/** Minimum gap between two container starts. Bursts are what the platform refuses. */
	spawnSpacingMs: number;
	/** Opt-in: the wedge sweeper may cancel the run pinning a wedged runner (needs Actions: write). */
	unwedgeCancel: boolean;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

/** The raw shape of `vars` (all strings; wrangler vars are untyped text). */
export interface RawVars {
	DISPATCH_ENABLED?: string;
	ALLOWED_REPOS?: string;
	ALLOW_PUBLIC_REPOS?: string;
	RUNNER_LABELS?: string;
	MAX_CONCURRENT?: string;
	MAX_JOB_MINUTES?: string;
	SOFT_DAILY_BUDGET_MINUTES?: string;
	RUNNER_SCOPE?: string;
	RUNNER_GROUP_ID?: string;
	RUNNER_NAME_PREFIX?: string;
	IDLE_GRACE_SECONDS?: string;
	SPAWN_SPACING_MS?: string;
	UNWEDGE_CANCEL?: string;
}

/** Default label map used when RUNNER_LABELS is unset. */
export const DEFAULT_RUNNER_LABELS = "cf-runner=light,cf-runner-heavy=heavy";

/** Labels GitHub adds to every self-hosted runner. A job may request these freely. */
export const IMPLICIT_RUNNER_LABELS: ReadonlySet<string> = new Set([
	"self-hosted",
	"linux",
	"x64",
]);

const REPO_ENTRY = /^[a-z0-9-]+\/(\*|[a-z0-9._-]+)$/;
const LABEL = /^[a-z0-9._-]{1,100}$/;
const PREFIX = /^[a-z][a-z0-9-]{0,19}$/;

function list(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function int(
	raw: string | undefined,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new ConfigError(
			`${name} must be an integer in [${min}, ${max}], got "${raw}"`,
		);
	}
	return n;
}

export function parseLabels(raw: string | undefined): Map<string, RunnerClass> {
	const map = new Map<string, RunnerClass>();
	const source = raw?.trim() ? raw : DEFAULT_RUNNER_LABELS;
	for (const pair of list(source)) {
		const [label, cls, extra] = pair.split("=").map((s) => s.trim());
		if (!label || !cls || extra !== undefined) {
			throw new ConfigError(
				`RUNNER_LABELS entry "${pair}" must look like label=class`,
			);
		}
		if (!LABEL.test(label)) {
			throw new ConfigError(
				`RUNNER_LABELS label "${label}" is not a valid label`,
			);
		}
		if (IMPLICIT_RUNNER_LABELS.has(label)) {
			throw new ConfigError(
				`RUNNER_LABELS label "${label}" is implicit on every self-hosted runner; pick a distinctive label`,
			);
		}
		if (!RUNNER_CLASSES.includes(cls as RunnerClass)) {
			throw new ConfigError(
				`RUNNER_LABELS class "${cls}" must be one of ${RUNNER_CLASSES.join(", ")}`,
			);
		}
		if (map.has(label)) {
			throw new ConfigError(`RUNNER_LABELS label "${label}" is listed twice`);
		}
		map.set(label, cls as RunnerClass);
	}
	if (map.size === 0) throw new ConfigError("RUNNER_LABELS maps no labels");
	return map;
}

export function parseConfig(vars: RawVars): Config {
	const allowedRepos = list(vars.ALLOWED_REPOS);
	for (const entry of allowedRepos) {
		if (!REPO_ENTRY.test(entry)) {
			throw new ConfigError(
				`ALLOWED_REPOS entry "${entry}" must be owner/repo or owner/*`,
			);
		}
	}
	const allowPublicRepos = list(vars.ALLOW_PUBLIC_REPOS);
	for (const entry of allowPublicRepos) {
		// Deliberately no wildcard: opting a public repo into running fork code on
		// your infrastructure is a per-repo decision.
		if (!REPO_ENTRY.test(entry) || entry.endsWith("/*")) {
			throw new ConfigError(
				`ALLOW_PUBLIC_REPOS entry "${entry}" must be an exact owner/repo (no wildcards)`,
			);
		}
	}
	const scope = (vars.RUNNER_SCOPE ?? "repo").trim().toLowerCase() || "repo";
	if (scope !== "repo" && scope !== "org") {
		throw new ConfigError(
			`RUNNER_SCOPE must be "repo" or "org", got "${scope}"`,
		);
	}
	const prefix = (vars.RUNNER_NAME_PREFIX ?? "").trim() || "ccr";
	if (!PREFIX.test(prefix)) {
		throw new ConfigError(
			`RUNNER_NAME_PREFIX "${prefix}" must be 1-20 chars of [a-z0-9-], starting with a letter`,
		);
	}
	const idle = (vars.IDLE_GRACE_SECONDS ?? "").trim();
	if (idle !== "") int(idle, "IDLE_GRACE_SECONDS", 90, 10, 3600);
	return {
		dispatchEnabled: (vars.DISPATCH_ENABLED ?? "1").trim() === "1",
		allowedRepos,
		allowPublicRepos,
		labels: parseLabels(vars.RUNNER_LABELS),
		maxConcurrent: int(vars.MAX_CONCURRENT, "MAX_CONCURRENT", 4, 1, 1000),
		maxJobMinutes: int(vars.MAX_JOB_MINUTES, "MAX_JOB_MINUTES", 60, 1, 24 * 60),
		softDailyBudgetMinutes: int(
			vars.SOFT_DAILY_BUDGET_MINUTES,
			"SOFT_DAILY_BUDGET_MINUTES",
			0,
			0,
			10_000_000,
		),
		runnerScope: scope,
		runnerGroupId: int(
			vars.RUNNER_GROUP_ID,
			"RUNNER_GROUP_ID",
			1,
			1,
			1_000_000,
		),
		runnerNamePrefix: prefix,
		idleGraceSeconds: idle,
		spawnSpacingMs: int(
			vars.SPAWN_SPACING_MS,
			"SPAWN_SPACING_MS",
			2000,
			0,
			60_000,
		),
		unwedgeCancel: (vars.UNWEDGE_CANCEL ?? "0").trim() === "1",
	};
}

/**
 * Worst-case container-minutes per hour the configuration can ever spend.
 * This is the number to budget against, not the soft daily alert.
 */
export function worstCaseMinutesPerHour(cfg: Config): number {
	return cfg.maxConcurrent * 60;
}
