/**
 * Which jobs we serve, and on which container class. Pure functions only.
 */
import {
	type Config,
	IMPLICIT_RUNNER_LABELS,
	type RunnerClass,
} from "./config";

export type RouteVerdict =
	| { ok: true; runnerClass: RunnerClass; label: string }
	| { ok: false; reason: string };

/**
 * Route a job by its `runs-on` labels.
 *
 * A job is ours only when its labels are EXACTLY satisfiable by a runner we
 * mint: one configured class label, plus any of the implicit labels GitHub puts
 * on every self-hosted runner (`self-hosted`, `linux`, `x64`). Anything else is
 * refused rather than guessed at:
 *
 *  - a label we do not mint means our runner could never take the job, so a
 *    container would boot, idle and exit for nothing;
 *  - two class labels is ambiguous about the machine size.
 *
 * Matching is case-insensitive, as GitHub's own label matching is.
 */
export function routeLabels(
	labels: readonly string[] | undefined,
	cfg: Pick<Config, "labels">,
): RouteVerdict {
	if (!labels || labels.length === 0) {
		return { ok: false, reason: "job has no labels" };
	}
	const lower = labels.map((l) => l.trim().toLowerCase());
	if (!lower.includes("self-hosted")) {
		return { ok: false, reason: "job does not request self-hosted" };
	}
	const classLabels = lower.filter((l) => cfg.labels.has(l));
	if (classLabels.length === 0) {
		return { ok: false, reason: "no configured runner label" };
	}
	if (new Set(classLabels).size > 1) {
		return {
			ok: false,
			reason: `ambiguous: several runner labels (${[...new Set(classLabels)].join(", ")})`,
		};
	}
	const unknown = lower.filter(
		(l) => !cfg.labels.has(l) && !IMPLICIT_RUNNER_LABELS.has(l),
	);
	if (unknown.length > 0) {
		return {
			ok: false,
			reason: `labels no minted runner carries: ${unknown.join(", ")}`,
		};
	}
	const label = classLabels[0] as string;
	return {
		ok: true,
		runnerClass: cfg.labels.get(label) as RunnerClass,
		label,
	};
}

export interface RepoFacts {
	/** `owner/repo` as GitHub sends it in `repository.full_name`. */
	fullName: string;
	/** `repository.private`. A missing value is treated as PUBLIC (fail closed). */
	private?: boolean;
	/** `repository.visibility`: "public" | "private" | "internal". */
	visibility?: string;
}

export type AllowVerdict = { ok: true } | { ok: false; reason: string };

function isPublic(repo: RepoFacts): boolean {
	if (repo.visibility) return repo.visibility.toLowerCase() === "public";
	return repo.private !== true;
}

/**
 * Is this repository allowed to run code on our containers?
 *
 * Two independent gates, both must pass:
 *  1. The repo matches an `ALLOWED_REPOS` entry (`owner/repo` or `owner/*`).
 *     An empty allowlist allows nothing: there is no "allow all" mode.
 *  2. A PUBLIC repo must additionally be listed by exact name in
 *     `ALLOW_PUBLIC_REPOS`. On a public repo, anyone can open a pull request
 *     from a fork, and a `pull_request` workflow runs that stranger's code on
 *     the runner. A wildcard org entry must never silently cover that.
 */
export function checkAllowlist(
	repo: RepoFacts,
	cfg: Pick<Config, "allowedRepos" | "allowPublicRepos">,
): AllowVerdict {
	const name = repo.fullName.trim().toLowerCase();
	const slash = name.indexOf("/");
	if (slash <= 0 || slash === name.length - 1) {
		return {
			ok: false,
			reason: `malformed repository name "${repo.fullName}"`,
		};
	}
	const owner = name.slice(0, slash);
	const listed = cfg.allowedRepos.some((e) => e === name || e === `${owner}/*`);
	if (!listed) {
		return { ok: false, reason: `${name} is not in ALLOWED_REPOS` };
	}
	if (isPublic(repo) && !cfg.allowPublicRepos.includes(name)) {
		return {
			ok: false,
			reason: `${name} is public; public repos run fork-PR code and are denied unless listed in ALLOW_PUBLIC_REPOS`,
		};
	}
	return { ok: true };
}

/**
 * Runner names: one per SPAWN, never per job. GitHub pre-registers a runner at
 * `generate-jitconfig` time and rejects a duplicate name with 409, so a name
 * derived only from the job id fails forever the moment a job needs a second
 * container.
 *
 *   <prefix>-<jobId>-s<base36 time><base36 nonce>
 */
export function runnerNameFor(
	prefix: string,
	jobId: number,
	now: number,
	nonce: number,
): string {
	return `${prefix}-${jobId}-s${now.toString(36)}${(nonce % 1296).toString(36)}`;
}

/** Which job a runner was minted for, from its name; null if not one of ours. */
export function spawnIdFromRunnerName(
	prefix: string,
	name: string | null | undefined,
): number | null {
	if (!name || !name.startsWith(`${prefix}-`)) return null;
	const m = /^(\d+)-s[0-9a-z]+$/.exec(name.slice(prefix.length + 1));
	if (!m) return null;
	const id = Number(m[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}
