/**
 * Every scheduling decision, as pure functions over plain data, so the policy
 * can be tested without a Durable Object, a container or the network.
 *
 * THE SPEND LAW. Spend is bounded structurally, never by bookkeeping:
 *   at most MAX_CONCURRENT containers exist, each one is killed by its own
 *   Durable Object alarm at MAX_JOB_MINUTES, and a stopped container bills $0.
 * The soft daily budget is an ALERT. It must never refuse a spawn: a refused
 * spawn leaves the job `queued` until GitHub expires it 24 h later, with no
 * red check and no failure anyone will see. A minute ledger also inflates
 * fastest under exactly the load you would gate on.
 */
import type { RunnerClass } from "./config";

// ── Data ─────────────────────────────────────────────────────────────────────

export type LocalReason = "at-capacity" | "cf-capacity" | "spacing";

export interface PendingJob {
	jobId: number;
	repo: string;
	runnerClass: RunnerClass;
	label: string;
	dueAt: number;
	/** First time this job hit LOCAL contention (our cap, CF capacity). */
	localSince?: number;
	localReason?: LocalReason;
	/** First time GitHub refused to mint a runner for it. */
	upstreamSince?: number;
	attempts?: number;
	/** How many times a container for this job exited before taking any job. */
	exitRequeues?: number;
}

/** One live container, keyed in `active` by its Durable Object name. */
export interface Entry {
	repo: string;
	runnerClass: RunnerClass;
	label: string;
	/** Durable Object name of the container; also its runner name. Never changes. */
	doName: string;
	runnerName: string;
	/** The job id the container was minted for. */
	spawnedFor: number;
	/** The job it is believed to serve; null = idle / unassigned. */
	servingJob: number | null;
	startedAt: number;
	/** Set once GitHub reports this container's runner started `servingJob`. */
	inProgress?: boolean;
	completedAt?: number;
	/** Set by the sweep on a first "not running" read; acted on only on the second. */
	suspectAt?: number;
	exitRequeues?: number;
}

export type Entries = Record<string, Entry>;

// ── Delta algebra ────────────────────────────────────────────────────────────
//
// Never write back a snapshot of `pending`/`active` read before an await.
// A concurrent webhook that landed in the gap would be silently reverted: a
// completed job resurrected into `active` (holding a slot forever), or a newly
// queued job deleted from `pending` (nothing will ever spawn for it). Every
// mutation is a pure delta applied to a fresh read with no await in between.

export function withPendingJob(
	pending: readonly PendingJob[],
	job: PendingJob,
): PendingJob[] {
	if (pending.some((p) => p.jobId === job.jobId)) return [...pending];
	return [...pending, job];
}

export function withoutJobIds(
	pending: readonly PendingJob[],
	ids: Iterable<number>,
): PendingJob[] {
	const drop = new Set(ids);
	return pending.filter((p) => !drop.has(p.jobId));
}

/**
 * Apply one alarm pass to whatever `pending` looks like NOW: jobs added during
 * the pass survive, handled jobs that must retry are replaced in place, and
 * handled jobs someone else removed meanwhile stay removed.
 */
export function applyAlarmOutcome(
	current: readonly PendingJob[],
	handled: ReadonlySet<number>,
	requeue: readonly PendingJob[],
): PendingJob[] {
	const updated = new Map(requeue.map((j) => [j.jobId, j]));
	return current
		.filter((p) => !handled.has(p.jobId) || updated.has(p.jobId))
		.map((p) => updated.get(p.jobId) ?? p);
}

export function activeCount(active: Entries): number {
	return Object.keys(active).length;
}

// ── Admission ────────────────────────────────────────────────────────────────

export type Admission =
	| { admit: true }
	| { admit: false; reason: "disabled" }
	| { admit: false; reason: "at-capacity" }
	| { admit: false; reason: "spacing"; retryAt: number };

/**
 * May one more container start now? Only two things can say no: the
 * concurrency cap (structural spend bound) and start spacing (bursts of
 * simultaneous starts are what the platform refuses). Budget is not an input.
 */
export function admit(input: {
	enabled: boolean;
	activeCount: number;
	maxConcurrent: number;
	lastStartAt: number;
	spacingMs: number;
	now: number;
}): Admission {
	if (!input.enabled) return { admit: false, reason: "disabled" };
	if (input.activeCount >= input.maxConcurrent)
		return { admit: false, reason: "at-capacity" };
	const next = input.lastStartAt + input.spacingMs;
	if (input.spacingMs > 0 && input.now < next) {
		return { admit: false, reason: "spacing", retryAt: next };
	}
	return { admit: true };
}

/** Worst-case spend the config permits per hour, in container-minutes. */
export function spendBoundMinutesPerHour(maxConcurrent: number): number {
	return maxConcurrent * 60;
}

/** Worst-case minutes a single wave can burn: every slot runs to its deadline. */
export function spendBoundPerWave(
	maxConcurrent: number,
	maxJobMinutes: number,
): number {
	return maxConcurrent * maxJobMinutes;
}

// ── Retry schedules ──────────────────────────────────────────────────────────

/** Local contention (our cap, CF capacity): fixed fast poll, 2 h wall clock. */
export const LOCAL_RETRY_MS = 30_000;
export const LOCAL_MAX_WALL_MS = 2 * 60 * 60_000;
/** GitHub refusing to mint: backoff 30 s → 90 s, 6 h wall clock. */
export const UPSTREAM_RETRY_MIN_MS = 30_000;
export const UPSTREAM_RETRY_MAX_MS = 90_000;
export const UPSTREAM_MAX_WALL_MS = 6 * 60 * 60_000;

export function upstreamBackoffMs(waitedMs: number): number {
	const doublings = Math.floor(Math.max(0, waitedMs) / UPSTREAM_RETRY_MIN_MS);
	return Math.min(
		UPSTREAM_RETRY_MAX_MS,
		UPSTREAM_RETRY_MIN_MS * 2 ** Math.min(doublings, 10),
	);
}

/**
 * Budgets are WALL CLOCK, not attempt counts: "60 tries" sounds generous but
 * is 30 minutes, and both a wedged lane and a provider outage outlast that.
 * Both walls sit well inside GitHub's 24 h queued-job expiry, so a job we give
 * up on is one GitHub was going to expire anyway.
 */
export function retryDecision(
	kind: "local" | "upstream",
	waitedMs: number,
): { strand: boolean; nextDelayMs: number } {
	if (kind === "local") {
		return {
			strand: waitedMs >= LOCAL_MAX_WALL_MS,
			nextDelayMs: LOCAL_RETRY_MS,
		};
	}
	return {
		strand: waitedMs >= UPSTREAM_MAX_WALL_MS,
		nextDelayMs: upstreamBackoffMs(waitedMs),
	};
}

/**
 * Cloudflare declining to place a container throws a plain Error:
 * "There is no container instance that can be provided to this Durable
 * Object, try again later". That is Cloudflare capacity, not GitHub, and it
 * clears in minutes: it belongs on the fast local schedule.
 */
export function isContainerCapacityError(err: unknown): boolean {
	const message =
		err instanceof Error
			? err.message
			: typeof err === "string"
				? err
				: ((err as { message?: unknown } | null)?.message ?? "");
	return typeof message === "string" && /no container instance/i.test(message);
}

// ── Re-key: GitHub does not bind a JIT runner to the job it was minted for ──

export interface InProgressPlan {
	next: Entries;
	/** Our container that took the job, if any. */
	takerKey: string | null;
	/** A displaced job handed to an idle container we already pay for. */
	reassigned: { doName: string; jobId: number } | null;
	/** A displaced job with no container at all: must be re-queued. */
	displaced: { jobId: number; from: Entry } | null;
}

/**
 * A runner minted for job A can be handed job B (any queued job whose labels
 * match). Bookkeeping must follow the container, and job A, which just lost
 * its machine, must get another one. Under a backlog this is the common case:
 * without the hand-off, every new job donates its container to an older one
 * and the backlog is conserved instead of drained.
 *
 *  1. Any OTHER container we thought was serving B, but has not started it,
 *     is not serving it (one job, one machine): mark it idle.
 *  2. The taker now serves B, in progress.
 *  3. A (the taker's previous assignment) goes to an idle container of the
 *     same repo + label if we have one, else is returned for re-queue.
 */
export function applyInProgress(
	entries: Readonly<Entries>,
	jobId: number,
	runnerName: string | null,
): InProgressPlan {
	const next: Entries = { ...entries };
	const takerKey =
		runnerName === null
			? null
			: (Object.keys(next).find((k) => next[k]?.runnerName === runnerName) ??
				null);
	for (const [k, e] of Object.entries(next)) {
		if (k !== takerKey && e.servingJob === jobId && !e.inProgress) {
			next[k] = { ...e, servingJob: null };
		}
	}
	if (takerKey === null)
		return { next, takerKey, reassigned: null, displaced: null };
	const taker = next[takerKey] as Entry;
	const prior = taker.servingJob;
	next[takerKey] = {
		...taker,
		servingJob: jobId,
		inProgress: true,
		suspectAt: undefined,
	};
	if (prior === null || prior === jobId) {
		return { next, takerKey, reassigned: null, displaced: null };
	}
	const idleKey = Object.keys(next).find((k) => {
		const e = next[k] as Entry;
		return (
			k !== takerKey &&
			!e.inProgress &&
			e.servingJob === null &&
			e.repo === taker.repo &&
			e.label === taker.label
		);
	});
	if (idleKey !== undefined) {
		next[idleKey] = { ...(next[idleKey] as Entry), servingJob: prior };
		return {
			next,
			takerKey,
			reassigned: { doName: idleKey, jobId: prior },
			displaced: null,
		};
	}
	return {
		next,
		takerKey,
		reassigned: null,
		displaced: { jobId: prior, from: taker },
	};
}

/** `completed`: an in-progress container exits by itself; a never-started one is now idle. */
export function applyCompleted(
	entries: Readonly<Entries>,
	jobId: number,
	now: number,
): Entries {
	const next: Entries = { ...entries };
	for (const [k, e] of Object.entries(next)) {
		if (e.servingJob !== jobId) continue;
		next[k] = e.inProgress
			? { ...e, completedAt: now }
			: { ...e, servingJob: null };
	}
	return next;
}

// ── Container liveness: never conclude "dead" from one platform read ────────

export type PollDecision =
	| { action: "keep"; clearSuspicion: boolean }
	| { action: "suspect" }
	| { action: "ask-github" }
	| { action: "exited" }
	| { action: "deadline" };

/**
 * One alarm tick of a runner container's Durable Object.
 *
 * `container.running` has been observed reading false for containers that were
 * alive. Acting on one false read orphans a live job ("lost communication with
 * the server", no logs). So: two consecutive false reads, and then GitHub
 * must agree the job is not running, before we call it exited.
 */
export function pollDecision(input: {
	running: boolean;
	suspectedAt: number | null;
	elapsedMin: number;
	deadlineMin: number;
	githubSays?: "queued" | "in_progress" | "completed" | "missing" | "unknown";
	hasJobToAsk: boolean;
}): PollDecision {
	if (input.running) {
		if (input.elapsedMin > input.deadlineMin) return { action: "deadline" };
		return { action: "keep", clearSuspicion: input.suspectedAt !== null };
	}
	if (input.suspectedAt === null) return { action: "suspect" };
	if (input.hasJobToAsk && input.githubSays === undefined)
		return { action: "ask-github" };
	// Past the deadline nothing keeps an entry alive: it bounds every guess below.
	if (input.elapsedMin > input.deadlineMin) return { action: "exited" };
	// GitHub is the authority on whether work is happening; the platform flag is a hint.
	if (input.githubSays === "in_progress")
		return { action: "keep", clearSuspicion: true };
	// Unreadable: do not act on a guess. Stay suspicious and ask again next tick.
	if (input.githubSays === "unknown")
		return { action: "keep", clearSuspicion: false };
	return { action: "exited" };
}

// ── Exit handling ────────────────────────────────────────────────────────────

/** How many times a job may lose its container before taking work. */
export const MAX_EXIT_REQUEUES = 3;

export type ExitPlan =
	| { action: "settle" }
	| { action: "requeue"; attempt: number }
	| { action: "strand"; why: string };

/**
 * A container exited. If its runner never started a job, the job it was
 * minted for still has no machine: re-queue it (bounded, so a broken image
 * cannot loop forever), naming the exit reason when it finally strands.
 */
export function exitPlan(
	entry: Pick<Entry, "inProgress" | "exitRequeues">,
	reason: string,
): ExitPlan {
	if (entry.inProgress) return { action: "settle" };
	const attempt = (entry.exitRequeues ?? 0) + 1;
	if (attempt > MAX_EXIT_REQUEUES) {
		return {
			action: "strand",
			why: `container exited ${MAX_EXIT_REQUEUES}x before taking a job (last reason: ${reason})`,
		};
	}
	return { action: "requeue", attempt };
}

// ── Soft budget (log only) ───────────────────────────────────────────────────

export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Today's minutes = settled + what live containers have run so far, each live
 * entry capped at its deadline. Derived, never reserved: an entry that
 * vanishes stops costing, and none can inflate the figure past reality.
 */
export function estimateMinutesToday(input: {
	settled: number;
	startedAts: readonly number[];
	maxJobMinutes: number;
	now: number;
}): number {
	let live = 0;
	for (const s of input.startedAts) {
		live += Math.min(
			input.maxJobMinutes,
			Math.max(0, (input.now - s) / 60_000),
		);
	}
	return input.settled + live;
}

/** Should we log a BUDGET ALERT now? Once per UTC day. Never gates anything. */
export function shouldAlertBudget(input: {
	softDailyBudgetMinutes: number;
	minutesToday: number;
	lastAlertDay: string | null;
	today: string;
}): boolean {
	if (input.softDailyBudgetMinutes <= 0) return false;
	if (input.lastAlertDay === input.today) return false;
	return input.minutesToday >= input.softDailyBudgetMinutes;
}

// ── Registration hygiene ─────────────────────────────────────────────────────

/** A freshly minted runner is `offline && !busy` for its whole boot. Never reap it. */
export const REAP_MINT_GRACE_MS = 10 * 60_000;
/** offline+busy for longer than this, with its job long finished, is a wedge. */
export const WEDGE_AFTER_MS = 20 * 60_000;
/** GitHub clears offline+busy itself within minutes of a job completing. */
export const COMPLETED_LAG_GRACE_MS = 15 * 60_000;

export function shouldReap(
	runner: { name: string; status: string; busy: boolean },
	prefix: string,
	mintedAt: number | undefined,
	now: number,
): boolean {
	if (!runner.name.startsWith(`${prefix}-`)) return false; // never someone else's runner
	if (mintedAt !== undefined && now - mintedAt < REAP_MINT_GRACE_MS)
		return false;
	return runner.status === "offline" && !runner.busy;
}

export type WedgeVerdict =
	| { wedged: false; reason: string }
	| { wedged: true; reason: string };

/**
 * offline + busy = the runner's container is gone but GitHub still thinks it
 * holds a job, which blocks that job forever. Only act on evidence; every
 * unreadable state is "not wedged".
 */
export function classifyWedge(
	runner: { name: string; status: string; busy: boolean },
	prefix: string,
	job: {
		kind: string;
		startedAtMs?: number | null;
		completedAtMs?: number | null;
	} | null,
	now: number,
): WedgeVerdict {
	if (!runner.name.startsWith(`${prefix}-`))
		return { wedged: false, reason: "not ours" };
	if (!runner.busy || runner.status === "online")
		return { wedged: false, reason: "not offline+busy" };
	if (job === null)
		return {
			wedged: false,
			reason: "job state unreadable; refusing to act on a guess",
		};
	if (job.kind === "queued")
		return { wedged: false, reason: "job still queued (boot window)" };
	if (job.kind === "missing")
		return { wedged: true, reason: "offline+busy, its job does not exist" };
	if (job.kind === "completed") {
		if (job.completedAtMs == null)
			return { wedged: true, reason: "offline+busy, job completed" };
		return now - job.completedAtMs > COMPLETED_LAG_GRACE_MS
			? { wedged: true, reason: "offline+busy long after its job completed" }
			: {
					wedged: false,
					reason: "job just completed; GitHub clears this itself",
				};
	}
	if (job.startedAtMs == null)
		return { wedged: false, reason: "in_progress with no start time" };
	return now - job.startedAtMs > WEDGE_AFTER_MS
		? {
				wedged: true,
				reason: `offline+busy, job in_progress > ${WEDGE_AFTER_MS / 60_000} min`,
			}
		: { wedged: false, reason: "within the legitimate window" };
}
