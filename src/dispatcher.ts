/**
 * Dispatcher: a singleton Durable Object holding the spawn queue and the
 * table of live containers. Single-threaded, so admission against
 * MAX_CONCURRENT cannot race.
 *
 * State (DO storage):
 *   pending        PendingJob[]          jobs waiting for a container
 *   active         Record<doName, Entry> one entry per live container
 *   mints          Record<runner, ts>    recent mints, protected from the reaper
 *   runnerJobs     Record<runner, {...}> which job each runner actually took
 *   repos          Record<repo, facts>   repos seen on verified webhooks
 *   settled:<day>  number                container-minutes settled that UTC day
 *   stranded / deadlineKilled / reconciled   last 50 of each, for /stats
 *
 * Entries are keyed by CONTAINER (its DO name), not by job: GitHub hands a
 * JIT runner whichever queued job matches its labels, so the job a container
 * serves is learned from the `in_progress` webhook, never assumed.
 */
import { type Config, parseConfig, type RunnerClass } from "./config";
import type { Env, NamespaceLike, StateLike } from "./env";
import { assertContainerEnv, EnvGuardError } from "./env-guard";
import { describeGitHubFailure, GitHubClient } from "./github";
import {
	admit,
	applyAlarmOutcome,
	applyCompleted,
	applyInProgress,
	type Entries,
	type Entry,
	type InProgressPlan,
	classifyWedge,
	estimateMinutesToday,
	exitPlan,
	isContainerCapacityError,
	type LocalReason,
	type PendingJob,
	REAP_MINT_GRACE_MS,
	retryDecision,
	shouldAlertBudget,
	shouldReap,
	spendBoundPerWave,
	utcDay,
	withoutJobIds,
	withPendingJob,
} from "./policy";
import {
	checkAllowlist,
	type RepoFacts,
	routeLabels,
	runnerNameFor,
} from "./routing";


interface Noted {
	jobId: number;
	why: string;
	at: number;
}

export interface DispatcherDeps {
	github?: GitHubClient;
	now?: () => number;
}

const SWEEP_INTERVAL_MS = 60_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const HYGIENE_INTERVAL_MS = 5 * 60_000;
const IDLE_HEARTBEAT_MS = 5 * 60_000;
/** A container younger than this is booting; never judge it. */
const BOOT_GRACE_MS = 5 * 60_000;
/** A job must be GitHub-queued this long before reconcile treats our silence as loss. */
const RECONCILE_GRACE_MS = 3 * 60_000;
const RUNNER_JOBS_TTL_MS = 24 * 60 * 60_000;

function pushCapped<T>(list: T[] | undefined, item: T, cap = 50): T[] {
	return [item, ...(list ?? [])].slice(0, cap);
}

export class Dispatcher {
	private readonly now: () => number;
	private githubClient: GitHubClient | undefined;
	private spawnNonce = 0;

	constructor(
		private readonly ctx: StateLike,
		private readonly env: Env,
		deps: DispatcherDeps = {},
	) {
		this.now = deps.now ?? Date.now;
		this.githubClient = deps.github;
	}

	private cfg(): Config {
		return parseConfig(this.env);
	}

	private github(cfg: Config): GitHubClient {
		this.githubClient ??= new GitHubClient(this.env, cfg);
		return this.githubClient;
	}

	private ns(cls: RunnerClass): NamespaceLike | undefined {
		return cls === "heavy" ? this.env.RUNNER_HEAVY : this.env.RUNNER_LIGHT;
	}

	private stub(cls: RunnerClass, doName: string) {
		const ns = this.ns(cls);
		return ns ? ns.get(ns.idFromName(doName)) : null;
	}

	// ── Storage deltas (re-read, apply pure fn, write; no await in between) ──

	private async mutatePending(
		fn: (p: readonly PendingJob[]) => PendingJob[],
	): Promise<PendingJob[]> {
		const next = fn(
			(await this.ctx.storage.get<PendingJob[]>("pending")) ?? [],
		);
		await this.ctx.storage.put("pending", next);
		return next;
	}

	private async mutateActive(
		fn: (a: Readonly<Entries>) => Entries,
	): Promise<Entries> {
		const next = fn((await this.ctx.storage.get<Entries>("active")) ?? {});
		await this.ctx.storage.put("active", next);
		return next;
	}

	private async active(): Promise<Entries> {
		return (await this.ctx.storage.get<Entries>("active")) ?? {};
	}

	private async armAt(at: number): Promise<void> {
		const existing = await this.ctx.storage.getAlarm();
		if (existing === null || existing > at) await this.ctx.storage.setAlarm(at);
	}

	private async note(
		key: "stranded" | "deadlineKilled" | "reconciled",
		item: Noted,
	): Promise<void> {
		await this.ctx.storage.put(
			key,
			pushCapped(await this.ctx.storage.get<Noted[]>(key), item),
		);
	}

	private async strand(
		job: Pick<PendingJob, "jobId" | "repo">,
		why: string,
	): Promise<void> {
		console.error(
			`STRANDED job ${job.jobId} (${job.repo}): ${why}. It will not self-heal; re-run the workflow.`,
		);
		await this.note("stranded", { jobId: job.jobId, why, at: this.now() });
	}

	// ── HTTP surface (internal; the Worker has already verified + filtered) ──

	async fetch(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		try {
			if (path === "/queued") return await this.onQueued(await req.json());
			if (path === "/in_progress")
				return await this.onInProgress(await req.json());
			if (path === "/completed")
				return await this.onCompleted(await req.json());
			if (path === "/container_exited")
				return await this.onContainerExited(await req.json());
			if (path === "/tick") return await this.onTick();
			if (path === "/stats") return Response.json(await this.stats());
		} catch (err) {
			console.error(`dispatcher ${path} failed`, err);
			return new Response("dispatcher error", { status: 500 });
		}
		return new Response("not found", { status: 404 });
	}

	async onQueued(body: {
		jobId: number;
		repo: string;
		runnerClass: RunnerClass;
		label: string;
		facts?: RepoFacts;
	}): Promise<Response> {
		const now = this.now();
		if (body.facts) await this.rememberRepo(body.facts);
		let added = false;
		await this.mutatePending((q) => {
			const next = withPendingJob(q, {
				jobId: body.jobId,
				repo: body.repo,
				runnerClass: body.runnerClass,
				label: body.label,
				dueAt: now,
			});
			added = next.length !== q.length;
			return next;
		});
		if (!added) return new Response("dup");
		await this.armAt(now);
		return new Response("queued");
	}

	private async rememberRepo(facts: RepoFacts): Promise<void> {
		const repos =
			(await this.ctx.storage.get<
				Record<string, RepoFacts & { seenAt: number }>
			>("repos")) ?? {};
		repos[facts.fullName.toLowerCase()] = { ...facts, seenAt: this.now() };
		await this.ctx.storage.put("repos", repos);
	}

	async onInProgress(body: {
		jobId: number;
		repo: string;
		runnerName: string | null;
	}): Promise<Response> {
		const { jobId, runnerName } = body;
		const now = this.now();
		await this.mutatePending((q) => withoutJobIds(q, [jobId]));
		if (runnerName) {
			const rj =
				(await this.ctx.storage.get<
					Record<string, { jobId: number; repo: string; at: number }>
				>("runnerJobs")) ?? {};
			for (const [k, v] of Object.entries(rj))
				if (now - v.at > RUNNER_JOBS_TTL_MS) delete rj[k];
			rj[runnerName] = { jobId, repo: body.repo, at: now };
			await this.ctx.storage.put("runnerJobs", rj);
		}

		let plan: InProgressPlan | null = null;
		await this.mutateActive((a) => {
			plan = applyInProgress(a, jobId, runnerName);
			return plan.next;
		});
		const p = plan as InProgressPlan | null;
		const takerDoName = p?.takerKey ?? null;
		const reassigned = p?.reassigned ?? null;
		const displaced = p?.displaced ? { jobId: p.displaced.jobId, entry: p.displaced.from } : null;
		if (takerDoName) await this.tellServing(takerDoName, jobId);
		if (reassigned) {
			const r = reassigned as { doName: string; jobId: number };
			console.log(
				`job ${r.jobId}: displaced; handed to idle container ${r.doName}`,
			);
		}
		if (displaced) {
			const d = displaced as { jobId: number; entry: Entry };
			console.log(
				`job ${d.jobId}: its container took job ${jobId} instead; re-queued for its own container`,
			);
			await this.requeue({
				jobId: d.jobId,
				repo: d.entry.repo,
				runnerClass: d.entry.runnerClass,
				label: d.entry.label,
				exitRequeues: 0,
			});
		}
		return new Response("ok");
	}

	/** Best-effort: lets the container's own liveness check ask GitHub about the right job. */
	private async tellServing(doName: string, jobId: number): Promise<void> {
		const entry = (await this.active())[doName];
		if (!entry) return;
		try {
			await this.stub(entry.runnerClass, doName)?.fetch(
				"https://runner/serving",
				{
					method: "POST",
					body: JSON.stringify({ jobId }),
					signal: AbortSignal.timeout(5_000),
				},
			);
		} catch (err) {
			console.warn(`container ${doName}: serving update failed`, err);
		}
	}

	private async requeue(job: Omit<PendingJob, "dueAt">): Promise<void> {
		const now = this.now();
		await this.mutatePending((q) => withPendingJob(q, { ...job, dueAt: now }));
		await this.armAt(now);
	}

	async onCompleted(body: { jobId: number }): Promise<Response> {
		const now = this.now();
		await this.mutatePending((q) => withoutJobIds(q, [body.jobId]));
		await this.mutateActive((a) => {
			const next: Entries = { ...a };
			for (const [k, e] of Object.entries(next)) {
				if (e.servingJob !== body.jobId) continue;
				// In progress: the container exits on its own after its one job.
				// Not in progress (cancelled while queued): it is now idle and will idle-exit.
				next[k] = e.inProgress
					? { ...e, completedAt: now }
					: { ...e, servingJob: null };
			}
			return next;
		});
		return new Response("ok");
	}

	/** The container's own exit report: the authoritative settle, with measured runtime. */
	async onContainerExited(body: {
		doName: string;
		runtimeMin?: number;
		reason?: string;
		message?: string;
	}): Promise<Response> {
		const reason = body.reason ?? "unknown";
		let gone: Entry | undefined;
		await this.mutateActive((a) => {
			gone = a[body.doName];
			const next: Entries = { ...a };
			delete next[body.doName];
			return next;
		});
		const entry = gone as Entry | undefined;
		if (!entry) return new Response("unknown");
		await this.settleMinutes(entry, body.runtimeMin);
		console.log(
			`container ${body.doName} exited after ${(body.runtimeMin ?? 0).toFixed(1)} min reason=${reason}${body.message ? ` msg=${body.message}` : ""} job=${entry.servingJob ?? "none"}`,
		);
		if (reason === "deadline") {
			await this.note("deadlineKilled", {
				jobId: entry.servingJob ?? entry.spawnedFor,
				why: `killed at the ${this.cfg().maxJobMinutes}-minute deadline`,
				at: this.now(),
			});
			return new Response("ok");
		}
		if (entry.servingJob === null) return new Response("ok");
		const plan = exitPlan(entry, reason);
		const job = { jobId: entry.servingJob, repo: entry.repo };
		if (plan.action === "strand") await this.strand(job, plan.why);
		if (plan.action === "requeue") {
			console.log(
				`job ${job.jobId}: container exited before taking it (reason=${reason}); re-queue #${plan.attempt}`,
			);
			await this.requeue({
				...job,
				runnerClass: entry.runnerClass,
				label: entry.label,
				exitRequeues: plan.attempt,
			});
		}
		return new Response("ok");
	}

	private async patchEntry(doName: string, patch: Partial<Entry>): Promise<void> {
		await this.mutateActive((a) => {
			const e = a[doName];
			return e ? { ...a, [doName]: { ...e, ...patch } } : { ...a };
		});
	}

	private async settleMinutes(
		entry: Entry,
		runtimeMin?: number,
	): Promise<void> {
		const cfg = this.cfg();
		const measured =
			runtimeMin !== undefined && Number.isFinite(runtimeMin)
				? runtimeMin
				: (this.now() - entry.startedAt) / 60_000;
		const minutes = Math.min(cfg.maxJobMinutes, Math.max(0, measured));
		// Bill the day the container started, not the day bookkeeping settled.
		const key = `settled:${utcDay(entry.startedAt)}`;
		await this.ctx.storage.put(
			key,
			((await this.ctx.storage.get<number>(key)) ?? 0) + minutes,
		);
	}

	async minutesToday(): Promise<number> {
		const now = this.now();
		const cfg = this.cfg();
		return estimateMinutesToday({
			settled:
				(await this.ctx.storage.get<number>(`settled:${utcDay(now)}`)) ?? 0,
			startedAts: Object.values(await this.active()).map((e) => e.startedAt),
			maxJobMinutes: cfg.maxJobMinutes,
			now,
		});
	}

	// ── Alarm: spawn due jobs; sweep, reconcile and clean up on throttles ────

	async alarm(): Promise<void> {
		const cfg = this.cfg();
		const now = this.now();
		await this.throttled("lastSweep", SWEEP_INTERVAL_MS, () => this.sweep(cfg));
		await this.throttled("lastReconcile", RECONCILE_INTERVAL_MS, () =>
			this.reconcile(cfg),
		);
		await this.throttled("lastHygiene", HYGIENE_INTERVAL_MS, () =>
			this.hygiene(cfg),
		);

		const pending = (await this.ctx.storage.get<PendingJob[]>("pending")) ?? [];
		const due = pending
			.filter((p) => p.dueAt <= now)
			.sort((a, b) => a.dueAt - b.dueAt);
		const handled = new Set(due.map((p) => p.jobId));
		const requeue: PendingJob[] = [];

		for (const job of due) {
			const verdict = admit({
				enabled: cfg.dispatchEnabled,
				activeCount: Object.keys(await this.active()).length,
				maxConcurrent: cfg.maxConcurrent,
				lastStartAt: (await this.ctx.storage.get<number>("lastStartAt")) ?? 0,
				spacingMs: cfg.spawnSpacingMs,
				now: this.now(),
			});
			if (!verdict.admit && verdict.reason === "disabled") {
				console.log(`job ${job.jobId}: DISPATCH_ENABLED is off; not spawning`);
				continue; // dropped; reconcile re-adds it once dispatch is back on
			}
			if (!verdict.admit && verdict.reason === "spacing") {
				requeue.push({ ...job, dueAt: verdict.retryAt });
				continue;
			}
			let outcome: "spawned" | "local" | "upstream" | "dropped" = "local";
			let localReason: LocalReason = "at-capacity";
			if (verdict.admit) {
				try {
					outcome = await this.spawn(cfg, job);
				} catch (err) {
					if (isContainerCapacityError(err)) {
						console.warn(
							`job ${job.jobId}: Cloudflare has no container instance available; retrying (this is Cloudflare capacity, not GitHub)`,
						);
						outcome = "local";
						localReason = "cf-capacity";
					} else if (err instanceof EnvGuardError) {
						await this.strand(job, err.message);
						outcome = "dropped";
					} else {
						console.error(`job ${job.jobId}: spawn failed`, err);
						outcome = "upstream";
					}
				}
			}
			if (outcome === "spawned" || outcome === "dropped") continue;
			const t = this.now();
			if (outcome === "local") {
				// A change of local reason restarts the clock: different condition, different evidence.
				const since =
					job.localReason === localReason ? (job.localSince ?? t) : t;
				const d = retryDecision("local", t - since);
				if (d.strand) {
					await this.strand(
						job,
						localReason === "cf-capacity"
							? `Cloudflare had no container instance for ${Math.round((t - since) / 60_000)} min`
							: `at MAX_CONCURRENT for ${Math.round((t - since) / 60_000)} min`,
					);
				} else {
					requeue.push({
						...job,
						attempts: (job.attempts ?? 0) + 1,
						localSince: since,
						localReason,
						upstreamSince: undefined,
						dueAt: t + d.nextDelayMs,
					});
				}
			} else {
				const since = job.upstreamSince ?? t;
				const d = retryDecision("upstream", t - since);
				if (d.strand) {
					await this.strand(
						job,
						`GitHub would not mint a runner for ${Math.round((t - since) / 60_000)} min`,
					);
				} else {
					requeue.push({
						...job,
						upstreamSince: since,
						localSince: undefined,
						localReason: undefined,
						dueAt: t + d.nextDelayMs,
					});
				}
			}
		}

		const rest = await this.mutatePending((cur) =>
			applyAlarmOutcome(cur, handled, requeue),
		);
		if (rest.length > 0) {
			await this.ctx.storage.setAlarm(Math.min(...rest.map((p) => p.dueAt)));
		} else if (Object.keys(await this.active()).length > 0) {
			// Nothing pending, but a leaked entry would hold a slot until the next
			// job arrives and pays for it. Keep a slow heartbeat while anything is live.
			await this.ctx.storage.setAlarm(this.now() + IDLE_HEARTBEAT_MS);
		}
	}

	private async throttled(
		key: string,
		everyMs: number,
		fn: () => Promise<unknown>,
	): Promise<void> {
		const last = (await this.ctx.storage.get<number>(key)) ?? 0;
		if (this.now() - last < everyMs) return;
		await this.ctx.storage.put(key, this.now());
		try {
			await fn();
		} catch (err) {
			console.error(`${key} pass failed`, err);
		}
	}

	private async spawn(
		cfg: Config,
		job: PendingJob,
	): Promise<"spawned" | "upstream" | "dropped"> {
		const stubNs = this.ns(job.runnerClass);
		if (!stubNs) {
			await this.strand(
				job,
				`no Durable Object binding for the "${job.runnerClass}" class; deploy it or remap the label`,
			);
			return "dropped";
		}
		const now = this.now();
		const runnerName = runnerNameFor(
			cfg.runnerNamePrefix,
			job.jobId,
			now,
			this.spawnNonce++,
		);
		// Protect the name from the reaper BEFORE GitHub pre-registers it.
		const mints =
			(await this.ctx.storage.get<Record<string, number>>("mints")) ?? {};
		for (const [k, ts] of Object.entries(mints))
			if (now - ts > REAP_MINT_GRACE_MS) delete mints[k];
		mints[runnerName] = now;
		await this.ctx.storage.put("mints", mints);

		const jit = await this.github(cfg).generateJitConfig(
			job.repo,
			runnerName,
			job.label,
		);
		if (!jit.ok) {
			console.error(
				`job ${job.jobId}: generate-jitconfig failed HTTP ${jit.status ?? "none"} (${describeGitHubFailure(jit.status)}) ${jit.detail}`,
			);
			return "upstream";
		}
		const containerEnv = assertContainerEnv({
			RUNNER_JITCONFIG: jit.value,
			...(cfg.idleGraceSeconds
				? { IDLE_GRACE_SECONDS: cfg.idleGraceSeconds }
				: {}),
		});
		const doName = runnerName;
		const stub = stubNs.get(stubNs.idFromName(doName));
		const res = await stub.fetch("https://runner/start", {
			method: "POST",
			body: JSON.stringify({
				env: containerEnv,
				maxJobMinutes: cfg.maxJobMinutes,
				doName,
				repo: job.repo,
				spawnedFor: job.jobId,
			}),
		});
		if (!res.ok)
			throw new Error(
				`container start failed: HTTP ${res.status} ${await res.text()}`,
			);
		const startedAt = this.now();
		await this.ctx.storage.put("lastStartAt", startedAt);
		await this.mutateActive((a) => ({
			...a,
			[doName]: {
				repo: job.repo,
				runnerClass: job.runnerClass,
				label: job.label,
				doName,
				runnerName,
				spawnedFor: job.jobId,
				servingJob: job.jobId,
				startedAt,
				exitRequeues: job.exitRequeues ?? 0,
			},
		}));
		const today = await this.minutesToday();
		console.log(
			`job ${job.jobId}: started ${job.runnerClass} container ${doName} (${today.toFixed(0)} container-min today)`,
		);
		await this.maybeBudgetAlert(cfg, today);
		return "spawned";
	}

	/** Log-only. Never gates a spawn: see the spend law in policy.ts. */
	private async maybeBudgetAlert(
		cfg: Config,
		minutesToday: number,
	): Promise<void> {
		const today = utcDay(this.now());
		const lastAlertDay =
			(await this.ctx.storage.get<string>("budgetAlertDay")) ?? null;
		if (
			!shouldAlertBudget({
				softDailyBudgetMinutes: cfg.softDailyBudgetMinutes,
				minutesToday,
				lastAlertDay,
				today,
			})
		)
			return;
		await this.ctx.storage.put("budgetAlertDay", today);
		console.warn(
			`BUDGET ALERT: ${minutesToday.toFixed(0)} container-minutes today >= soft budget ${cfg.softDailyBudgetMinutes}. Not refusing spawns; spend stays bounded by MAX_CONCURRENT=${cfg.maxConcurrent} x MAX_JOB_MINUTES=${cfg.maxJobMinutes}.`,
		);
	}

	/**
	 * Backstop for exit reports that never arrived. Only judges containers past
	 * boot grace, treats a failed status read as "running", and asks GitHub
	 * before declaring an in-progress container dead.
	 */
	async sweep(cfg: Config): Promise<void> {
		const now = this.now();
		for (const [doName, e] of Object.entries(await this.active())) {
			const age = now - e.startedAt;
			const overDeadline = age > (cfg.maxJobMinutes + 10) * 60_000;
			if (!overDeadline && age <= BOOT_GRACE_MS) continue;
			const stub = this.stub(e.runnerClass, doName);
			let requeueJob: number | null = null;
			if (!overDeadline) {
				const running = await (stub
					? stub
							.fetch("https://runner/status")
							.then((r) => r.json() as Promise<{ running: boolean }>)
							.then((s) => s.running)
							.catch(() => true)
					: Promise.resolve(false));
				if (running) {
					if (e.suspectAt !== undefined) await this.patchEntry(doName, { suspectAt: undefined });
					continue;
				}
				// Never conclude "dead" from one platform read: the first false read
				// only marks the entry; the next sweep (>= 1 min later) acts.
				if (e.suspectAt === undefined) {
					await this.patchEntry(doName, { suspectAt: now });
					continue;
				}
				if (e.servingJob !== null) {
					const state = await this.github(cfg).jobState(e.repo, e.servingJob);
					if (state === null) continue; // unreadable: do not act on a guess
					if (state.kind === "in_progress") continue; // GitHub is the authority
					if (state.kind === "queued") requeueJob = e.servingJob;
				}
			}
			await stub?.fetch("https://runner/stop").catch(() => undefined);
			let removed = false;
			await this.mutateActive((a) => {
				if (!a[doName]) return { ...a };
				removed = true;
				const next = { ...a };
				delete next[doName];
				return next;
			});
			if (!removed) continue;
			await this.settleMinutes(e);
			console.log(
				`sweep: reclaimed container ${doName} (${(age / 60_000).toFixed(1)} min old${overDeadline ? ", past deadline" : ""})`,
			);
			if (requeueJob !== null) {
				const plan = exitPlan(e, "lost (sweep)");
				if (plan.action === "requeue") {
					await this.requeue({
						jobId: requeueJob,
						repo: e.repo,
						runnerClass: e.runnerClass,
						label: e.label,
						exitRequeues: plan.attempt,
					});
				} else if (plan.action === "strand") {
					await this.strand({ jobId: requeueJob, repo: e.repo }, plan.why);
				}
			}
		}
	}

	private async allowedSeenRepos(cfg: Config): Promise<RepoFacts[]> {
		const repos =
			(await this.ctx.storage.get<Record<string, RepoFacts>>("repos")) ?? {};
		return Object.values(repos).filter((r) => checkAllowlist(r, cfg).ok);
	}

	/**
	 * Webhooks give latency; this gives liveness. GitHub does not retry a failed
	 * webhook delivery, so any job it still lists `queued` that we have no record
	 * of is re-queued. Only for repos seen on a verified webhook and still allowed.
	 */
	async reconcile(cfg: Config): Promise<void> {
		if (!cfg.dispatchEnabled) return;
		const now = this.now();
		for (const repo of await this.allowedSeenRepos(cfg)) {
			const { jobs, error } = await this.github(cfg).listQueuedJobs(
				repo.fullName,
			);
			if (error && !error.ok) {
				console.error(
					`reconcile ${repo.fullName}: list failed HTTP ${error.status ?? "none"} (${describeGitHubFailure(error.status)})`,
				);
			}
			const pending =
				(await this.ctx.storage.get<PendingJob[]>("pending")) ?? [];
			const known = new Set<number>(pending.map((p) => p.jobId));
			for (const e of Object.values(await this.active()))
				if (e.servingJob !== null) known.add(e.servingJob);
			for (const j of jobs) {
				if (
					known.has(j.id) ||
					Number.isNaN(j.createdAtMs) ||
					now - j.createdAtMs < RECONCILE_GRACE_MS
				)
					continue;
				const route = routeLabels(j.labels, cfg);
				if (!route.ok) continue;
				console.warn(
					`reconcile: recovered job ${j.id} (${repo.fullName}); GitHub lists it queued and we had no record`,
				);
				await this.requeue({
					jobId: j.id,
					repo: repo.fullName,
					runnerClass: route.runnerClass,
					label: route.label,
				});
				await this.note("reconciled", {
					jobId: j.id,
					why: "queued on GitHub, unknown here",
					at: now,
				});
			}
		}
	}

	/**
	 * Registration hygiene for runners we minted:
	 *  - reap `offline && !busy` corpses (never one minted in the last 10 min:
	 *    a booting runner looks exactly like that);
	 *  - detect `offline && busy` wedges and, if UNWEDGE_CANCEL=1, cancel the
	 *    pinning run first (deleting first just fails) and then delete.
	 */
	async hygiene(
		cfg: Config,
	): Promise<{ reaped: number; wedged: number; listFailed: boolean }> {
		const now = this.now();
		const gh = this.github(cfg);
		const mints =
			(await this.ctx.storage.get<Record<string, number>>("mints")) ?? {};
		const runnerJobs =
			(await this.ctx.storage.get<
				Record<string, { jobId: number; repo: string }>
			>("runnerJobs")) ?? {};
		const seenBases = new Set<string>();
		const report = { reaped: 0, wedged: 0, listFailed: false };
		for (const repo of await this.allowedSeenRepos(cfg)) {
			const base = gh.runnersBase(repo.fullName);
			if (seenBases.has(base)) continue;
			seenBases.add(base);
			const { runners, error } = await gh.listRunners(repo.fullName);
			if (error && !error.ok) {
				report.listFailed = true;
				console.error(
					`hygiene: cannot list runners for ${repo.fullName} (HTTP ${error.status ?? "none"}): ${describeGitHubFailure(error.status)}. Partial pass; stale registrations may accumulate.`,
				);
			}
			for (const r of runners) {
				if (shouldReap(r, cfg.runnerNamePrefix, mints[r.name], now)) {
					const del = await gh.deleteRunner(repo.fullName, r.id);
					if (del.ok) report.reaped++;
					else
						console.error(
							`hygiene: delete ${r.name} failed HTTP ${del.status ?? "none"}`,
						);
					continue;
				}
				if (
					!r.busy ||
					r.status === "online" ||
					!r.name.startsWith(`${cfg.runnerNamePrefix}-`)
				)
					continue;
				const took = runnerJobs[r.name];
				if (!took) continue; // we never learned which job it took: do not guess
				const state = await gh.jobState(took.repo, took.jobId);
				const verdict = classifyWedge(r, cfg.runnerNamePrefix, state, now);
				if (!verdict.wedged) continue;
				report.wedged++;
				if (!cfg.unwedgeCancel) {
					console.warn(
						`WEDGED runner ${r.name} (job ${took.jobId}): ${verdict.reason}. Set UNWEDGE_CANCEL=1 (needs Actions: write) to clear automatically, or cancel the run by hand.`,
					);
					continue;
				}
				const runId = state && "runId" in state ? state.runId : null;
				if (runId !== null) {
					const c = await gh.cancelRun(took.repo, runId);
					if (!c.ok && c.status !== 409) {
						console.error(
							`unwedge: cancel run ${runId} failed HTTP ${c.status ?? "none"} (${describeGitHubFailure(c.status)}); not deleting ${r.name}`,
						);
						continue;
					}
				}
				const del = await gh.deleteRunner(repo.fullName, r.id);
				console.warn(
					`unwedge: ${r.name} ${del.ok || del.status === 404 ? "cleared" : `delete failed HTTP ${del.status}`} (${verdict.reason}); its run was cancelled and must be re-run`,
				);
			}
		}
		await this.ctx.storage.put("lastHygieneReport", { ...report, at: now });
		return report;
	}

	/** Cron: a backstop that wakes the alarm path even if every alarm was lost. */
	async onTick(): Promise<Response> {
		const cfg = this.cfg();
		await this.ctx.storage.put("lastSweep", 0);
		await this.ctx.storage.put("lastReconcile", 0);
		await this.ctx.storage.put("lastHygiene", 0);
		await this.alarm();
		const strandedRecent = (
			(await this.ctx.storage.get<Noted[]>("stranded")) ?? []
		).filter((s) => this.now() - s.at < 60 * 60_000);
		if (strandedRecent.length > 0) {
			console.error(
				`${strandedRecent.length} job(s) stranded in the last hour; see /stats. dispatch=${cfg.dispatchEnabled ? "on" : "off"}`,
			);
		}
		return new Response("ok");
	}

	async stats(): Promise<Record<string, unknown>> {
		const cfg = this.cfg();
		const active = await this.active();
		return {
			dispatchEnabled: cfg.dispatchEnabled,
			maxConcurrent: cfg.maxConcurrent,
			maxJobMinutes: cfg.maxJobMinutes,
			spendBoundPerWaveMinutes: spendBoundPerWave(
				cfg.maxConcurrent,
				cfg.maxJobMinutes,
			),
			softDailyBudgetMinutes: cfg.softDailyBudgetMinutes,
			minutesToday: Number((await this.minutesToday()).toFixed(1)),
			active: Object.values(active).map((e) => ({
				container: e.doName,
				class: e.runnerClass,
				repo: e.repo,
				job: e.servingJob,
				inProgress: !!e.inProgress,
				ageMin: Number(((this.now() - e.startedAt) / 60_000).toFixed(1)),
			})),
			pending: (
				(await this.ctx.storage.get<PendingJob[]>("pending")) ?? []
			).map((p) => ({
				job: p.jobId,
				repo: p.repo,
				class: p.runnerClass,
				waitingOn: p.upstreamSince ? "github" : (p.localReason ?? "due"),
			})),
			stranded: (await this.ctx.storage.get<Noted[]>("stranded")) ?? [],
			deadlineKilled:
				(await this.ctx.storage.get<Noted[]>("deadlineKilled")) ?? [],
			reconciled: (await this.ctx.storage.get<Noted[]>("reconciled")) ?? [],
			lastHygiene: (await this.ctx.storage.get("lastHygieneReport")) ?? null,
		};
	}
}
