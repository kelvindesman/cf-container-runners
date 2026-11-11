/**
 * One Durable Object per container spawn. It starts the container with a
 * single-use JIT config, watches it on an alarm, enforces the hard deadline,
 * and reports the exit (with a named reason) to the Dispatcher.
 *
 * Why an alarm and not an awaited `monitor()`: a Durable Object with no
 * inbound requests is evicted after a minute or two, and a CI job runs for
 * much longer. An alarm is an event, so it wakes the DO; each wake also
 * re-attaches a floating `monitor()` so the platform always sees an observer.
 *
 * The low-level `ctx.container` API is used (not the `Container` helper
 * class) because that class reserves `alarm()` for its own lifecycle.
 */
import { parseConfig } from "./config";
import type { Env, StateLike } from "./env";
import { assertContainerEnv } from "./env-guard";
import { GitHubClient, type JobState } from "./github";
import { isContainerCapacityError, pollDecision } from "./policy";

export interface ExitInfo {
	kind: "exit" | "error";
	at: number;
	message?: string;
}

/** Name the exit so an operator can tell a platform refusal from a finished job. */
export function exitReason(info: ExitInfo | undefined): string {
	if (!info) return "unknown";
	if (
		info.kind === "error" &&
		info.message &&
		isContainerCapacityError(info.message)
	)
		return "no-instance";
	return info.kind === "error" ? "error" : "exit";
}

export interface RunnerDeps {
	jobState?: (repo: string, jobId: number) => Promise<JobState | null>;
	now?: () => number;
}

export class LightRunner {
	/** 15 s keeps the DO hot and the observer attached through hibernation windows. */
	static readonly POLL_MS = 15_000;
	/** Gap between the two "not running" reads that must agree. */
	static readonly SUSPECT_RECHECK_MS = 30_000;
	private readonly now: () => number;

	constructor(
		private readonly ctx: StateLike,
		private readonly env: Env,
		private readonly deps: RunnerDeps = {},
	) {
		this.now = deps.now ?? Date.now;
	}

	async fetch(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		if (path === "/start") return this.start(await req.json());
		if (path === "/serving") {
			const { jobId } = (await req.json()) as { jobId: number };
			await this.ctx.storage.put("servingJob", jobId);
			return new Response("ok");
		}
		if (path === "/status")
			return Response.json({ running: !!this.ctx.container?.running });
		if (path === "/stop") return this.stop("asked to stop");
		return new Response("not found", { status: 404 });
	}

	private attachMonitor(): void {
		try {
			void this.ctx.container
				?.monitor()
				.then(() => this.recordExit({ kind: "exit", at: this.now() }))
				.catch((err: unknown) =>
					this.recordExit({
						kind: "error",
						at: this.now(),
						message: String(err instanceof Error ? err.message : err).slice(
							0,
							300,
						),
					}),
				);
		} catch {
			// no container handle: nothing to observe
		}
	}

	private recordExit(info: ExitInfo): void {
		void this.ctx.storage.put("exit", info).catch(() => undefined);
	}

	private async start(body: {
		env: Record<string, string>;
		maxJobMinutes: number;
		doName: string;
		repo: string;
		spawnedFor: number;
	}): Promise<Response> {
		if (!this.ctx.container)
			return new Response("no container binding", { status: 500 });
		if (this.ctx.container.running)
			return new Response("already running", { status: 409 });
		// Second line of defence; the Dispatcher checked too.
		const env = assertContainerEnv(body.env);
		try {
			await this.ctx.container.start({ env, enableInternet: true });
		} catch (err) {
			// Surfaced to the Dispatcher verbatim so it can classify a
			// "no container instance" refusal as Cloudflare capacity.
			const msg = err instanceof Error ? err.message : String(err);
			return new Response(msg.slice(0, 500), { status: 503 });
		}
		this.attachMonitor();
		await this.ctx.storage.put("meta", {
			doName: body.doName,
			repo: body.repo,
			spawnedFor: body.spawnedFor,
			maxJobMinutes: body.maxJobMinutes,
			startedAt: this.now(),
		});
		await this.ctx.storage.setAlarm(this.now() + LightRunner.POLL_MS);
		return new Response("started");
	}

	async alarm(): Promise<void> {
		const meta = await this.ctx.storage.get<{
			doName: string;
			repo: string;
			spawnedFor: number;
			maxJobMinutes: number;
			startedAt: number;
		}>("meta");
		if (!meta) return;
		const running = !!this.ctx.container?.running;
		const suspectedAt =
			(await this.ctx.storage.get<number>("suspectedAt")) ?? null;
		const servingJob =
			(await this.ctx.storage.get<number>("servingJob")) ?? null;
		const elapsedMin = (this.now() - meta.startedAt) / 60_000;
		const base = {
			running,
			suspectedAt,
			elapsedMin,
			deadlineMin: meta.maxJobMinutes,
			// Only ask GitHub about a job we KNOW this container started.
			hasJobToAsk: servingJob !== null,
		};
		let decision = pollDecision(base);
		if (decision.action === "ask-github" && servingJob !== null) {
			const state = await this.lookupJob(meta.repo, servingJob);
			decision = pollDecision({
				...base,
				githubSays: state?.kind ?? "unknown",
			});
		}
		switch (decision.action) {
			case "keep":
				if (running) this.attachMonitor();
				if (decision.clearSuspicion)
					await this.ctx.storage.delete("suspectedAt");
				await this.ctx.storage.setAlarm(this.now() + LightRunner.POLL_MS);
				return;
			case "suspect":
				await this.ctx.storage.put("suspectedAt", this.now());
				await this.ctx.storage.setAlarm(
					this.now() + LightRunner.SUSPECT_RECHECK_MS,
				);
				return;
			case "exited": {
				const info = await this.ctx.storage.get<ExitInfo>("exit");
				const reason = exitReason(info);
				console.log(
					`container ${meta.doName}: exited after ${elapsedMin.toFixed(1)} min reason=${reason}`,
				);
				await this.report(meta.doName, elapsedMin, reason, info?.message);
				await this.cleanup();
				return;
			}
			case "deadline":
				console.warn(
					`DEADLINE-KILLED container ${meta.doName} (job ${servingJob ?? meta.spawnedFor}, ${meta.repo}) after ${elapsedMin.toFixed(1)} min; MAX_JOB_MINUTES=${meta.maxJobMinutes}`,
				);
				// Report BEFORE destroying: the deadline kill must leave a named record,
				// or it reads as a mysterious "lost communication" on GitHub's side.
				await this.report(meta.doName, elapsedMin, "deadline");
				await this.ctx.container?.destroy("deadline").catch(() => undefined);
				await this.cleanup();
				return;
			case "ask-github":
				await this.ctx.storage.setAlarm(this.now() + LightRunner.POLL_MS);
				return;
		}
	}

	private async lookupJob(
		repo: string,
		jobId: number,
	): Promise<JobState | null> {
		if (this.deps.jobState) return this.deps.jobState(repo, jobId);
		try {
			return await new GitHubClient(this.env, parseConfig(this.env)).jobState(
				repo,
				jobId,
			);
		} catch {
			return null;
		}
	}

	/**
	 * Never called from `/stop`: the Dispatcher is awaiting that call, and a
	 * call back into it would be a re-entrant wait between two DOs. Bounded by
	 * a timeout for the same reason; a lost report is reclaimed by the sweep.
	 */
	private async report(
		doName: string,
		runtimeMin: number,
		reason: string,
		message?: string,
	): Promise<void> {
		try {
			const d = this.env.DISPATCHER.get(
				this.env.DISPATCHER.idFromName("singleton"),
			);
			await d.fetch("https://dispatcher/container_exited", {
				method: "POST",
				body: JSON.stringify({ doName, runtimeMin, reason, message }),
				signal: AbortSignal.timeout(5_000),
			});
		} catch (err) {
			console.error(`container ${doName}: exit report failed`, err);
		}
	}

	private async stop(reason: string): Promise<Response> {
		await this.ctx.container?.destroy(reason).catch(() => undefined);
		await this.cleanup();
		return new Response("stopped");
	}

	private async cleanup(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}
}

/**
 * Same lifecycle, bound to a bigger `instance_type` in wrangler.jsonc.
 * Cloudflare binds one instance type per container class, hence a class.
 */
export class HeavyRunner extends LightRunner {}
