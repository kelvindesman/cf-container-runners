import { describe, expect, it } from "vitest";
import { Dispatcher, } from "../src/dispatcher";
import type { GitHubClient, JobState } from "../src/github";
import type { Entries, PendingJob } from "../src/policy";
import { baseEnv, fakeNamespace, fakeState } from "./fakes";

interface Harness {
	d: Dispatcher;
	state: ReturnType<typeof fakeState>;
	light: ReturnType<typeof fakeNamespace>;
	clock: { t: number };
	mints: string[];
	gh: Partial<Record<string, unknown>> & { jitStatus: number; states: Map<number, JobState | null> };
}

function harness(opts: { maxConcurrent?: string; containerStart?: () => Response; running?: boolean } = {}): Harness {
	const clock = { t: Date.UTC(2026, 0, 1, 12) };
	const state = fakeState();
	const light = fakeNamespace((path) => {
		if (path === "/start") return opts.containerStart?.() ?? new Response("started");
		if (path === "/status") return Response.json({ running: opts.running ?? true });
		return new Response("ok");
	});
	const mints: string[] = [];
	const gh = {
		jitStatus: 201,
		states: new Map<number, JobState | null>(),
		runnersBase: (repo: string) => `https://api.github.com/repos/${repo}/actions/runners`,
		async generateJitConfig(_repo: string, name: string) {
			mints.push(name);
			return gh.jitStatus === 201 ? { ok: true, status: 201, value: "JITCONFIG" } : { ok: false, status: gh.jitStatus, detail: "" };
		},
		async jobState(_repo: string, id: number) {
			return gh.states.has(id) ? (gh.states.get(id) ?? null) : { kind: "queued", runId: 1 };
		},
		async listQueuedJobs() {
			return { jobs: [], error: null };
		},
		async listRunners() {
			return { runners: [], error: null };
		},
	};
	const env = baseEnv({ RUNNER_LIGHT: light, MAX_CONCURRENT: opts.maxConcurrent ?? "2" });
	const d = new Dispatcher(state, env, { github: gh as unknown as GitHubClient, now: () => clock.t });
	return { d, state, light, clock, mints, gh };
}

const queued = (jobId: number) => ({ jobId, repo: "acme/app", runnerClass: "light" as const, label: "cf-runner", facts: { fullName: "acme/app", private: true } });

async function active(h: Harness): Promise<Entries> {
	return (await h.state.storage.get<Entries>("active")) ?? {};
}
async function pending(h: Harness): Promise<PendingJob[]> {
	return (await h.state.storage.get<PendingJob[]>("pending")) ?? [];
}

// source: README.md "How it works" (one queued job -> one JIT runner -> one container)
describe("Dispatcher", () => {
	it("queued -> alarm mints one JIT runner and starts one container", async () => {
		const h = harness();
		await h.d.onQueued(queued(101));
		expect(h.state.storage.alarm).toBe(h.clock.t);
		await h.d.alarm();
		expect(h.mints).toHaveLength(1);
		const start = h.light.calls.find((c) => c.path === "/start");
		expect(start?.body).toMatchObject({ env: { RUNNER_JITCONFIG: "JITCONFIG" }, maxJobMinutes: 30, spawnedFor: 101 });
		expect(Object.keys((start?.body as { env: object }).env)).toEqual(["RUNNER_JITCONFIG"]);
		expect(Object.values(await active(h))).toMatchObject([{ servingJob: 101, spawnedFor: 101 }]);
		expect(await pending(h)).toEqual([]);
	});

	it("a redelivered queued webhook does not double-spawn", async () => {
		const h = harness();
		expect(await (await h.d.onQueued(queued(1))).text()).toBe("queued");
		expect(await (await h.d.onQueued(queued(1))).text()).toBe("dup");
		await h.d.alarm();
		expect(h.mints).toHaveLength(1);
	});

	// source: docs/LESSONS.md "no hard daily cap"
	it("at MAX_CONCURRENT the job waits (local retry), and a soft budget never blocks", async () => {
		const h = harness({ maxConcurrent: "1" });
		await h.d.onQueued(queued(1));
		await h.d.onQueued(queued(2));
		await h.d.alarm();
		expect(h.mints).toHaveLength(1);
		const p = await pending(h);
		expect(p).toMatchObject([{ jobId: 2, localReason: "at-capacity" }]);
		expect(h.state.storage.alarm).toBe(h.clock.t + 30_000);
	});

	it("GitHub refusing to mint goes on the upstream schedule", async () => {
		const h = harness();
		h.gh.jitStatus = 503;
		await h.d.onQueued(queued(1));
		await h.d.alarm();
		expect(await pending(h)).toMatchObject([{ jobId: 1, upstreamSince: h.clock.t }]);
		expect(await active(h)).toEqual({});
	});

	// source: docs/LESSONS.md "name the vendor" (CF capacity was reported as a GitHub outage)
	it("Cloudflare 'no container instance' goes on the local schedule as cf-capacity", async () => {
		const h = harness({
			containerStart: () => new Response("There is no container instance that can be provided to this Durable Object, try again later", { status: 503 }),
		});
		await h.d.onQueued(queued(1));
		await h.d.alarm();
		expect(await pending(h)).toMatchObject([{ jobId: 1, localReason: "cf-capacity" }]);
		expect(await active(h)).toEqual({});
	});

	// source: docs/LESSONS.md "re-queue a displaced job"
	it("in_progress on a container minted for another job re-queues the displaced job", async () => {
		const h = harness();
		await h.d.onQueued(queued(1));
		await h.d.alarm();
		const [c1] = Object.values(await active(h));
		await h.d.onInProgress({ jobId: 9, repo: "acme/app", runnerName: c1?.runnerName ?? null });
		const a = await active(h);
		expect(a[c1?.doName as string]).toMatchObject({ servingJob: 9, inProgress: true });
		expect(await pending(h)).toMatchObject([{ jobId: 1 }]);
		// the container learns which job it is really serving
		expect(h.light.calls.some((c) => c.path === "/serving" && (c.body as { jobId: number }).jobId === 9)).toBe(true);
	});

	it("in_progress for a pending job (taken elsewhere) cancels its spawn", async () => {
		const h = harness();
		await h.d.onQueued(queued(1));
		await h.d.onInProgress({ jobId: 1, repo: "acme/app", runnerName: "someone-elses-box" });
		await h.d.alarm();
		expect(h.mints).toHaveLength(0);
	});

	// source: docs/LESSONS.md "retry no-instance exits, name the reason"
	it("a container that exits before taking a job re-queues it, then strands with the reason", async () => {
		const h = harness();
		await h.d.onQueued(queued(1));
		for (let i = 1; i <= 4; i++) {
			h.clock.t += 60_000;
			await h.d.alarm();
			const [c] = Object.values(await active(h));
			expect(c).toBeDefined();
			await h.d.onContainerExited({ doName: c?.doName as string, runtimeMin: 0.5, reason: "no-instance" });
		}
		const stranded = (await h.state.storage.get<Array<{ jobId: number; why: string }>>("stranded")) ?? [];
		expect(stranded[0]).toMatchObject({ jobId: 1 });
		expect(stranded[0]?.why).toContain("no-instance");
		expect(await pending(h)).toEqual([]);
		expect(h.mints).toHaveLength(4);
	});

	it("a container exit after its job settles minutes and frees the slot", async () => {
		const h = harness({ maxConcurrent: "1" });
		await h.d.onQueued(queued(1));
		await h.d.alarm();
		const [c] = Object.values(await active(h));
		await h.d.onInProgress({ jobId: 1, repo: "acme/app", runnerName: c?.runnerName ?? null });
		await h.d.onCompleted({ jobId: 1 });
		await h.d.onContainerExited({ doName: c?.doName as string, runtimeMin: 12.5, reason: "exit" });
		expect(await active(h)).toEqual({});
		expect(await h.state.storage.get("settled:2026-01-01")).toBe(12.5);
		expect(await pending(h)).toEqual([]);
	});

	// source: docs/LESSONS.md "deadline-killed log"
	it("a deadline kill leaves a named record and is not re-queued", async () => {
		const h = harness();
		await h.d.onQueued(queued(1));
		await h.d.alarm();
		const [c] = Object.values(await active(h));
		await h.d.onInProgress({ jobId: 1, repo: "acme/app", runnerName: c?.runnerName ?? null });
		await h.d.onContainerExited({ doName: c?.doName as string, runtimeMin: 30, reason: "deadline" });
		const killed = (await h.state.storage.get<Array<{ jobId: number; why: string }>>("deadlineKilled")) ?? [];
		expect(killed[0]).toMatchObject({ jobId: 1 });
		expect(killed[0]?.why).toContain("30-minute deadline");
		expect(await pending(h)).toEqual([]);
	});

	// source: docs/LESSONS.md "never conclude dead from one read"
	it("the sweep needs two not-running reads and GitHub's word before reclaiming", async () => {
		const h = harness({ running: false });
		await h.d.onQueued(queued(1));
		await h.d.alarm();
		const [c] = Object.values(await active(h));
		await h.d.onInProgress({ jobId: 1, repo: "acme/app", runnerName: c?.runnerName ?? null });
		h.gh.states.set(1, { kind: "in_progress", runId: 1, startedAtMs: h.clock.t });
		const cfg = (await import("../src/config")).parseConfig(baseEnv());
		h.clock.t += 6 * 60_000;
		await h.d.sweep(cfg); // first read: suspect only
		expect(Object.values(await active(h))[0]?.suspectAt).toBe(h.clock.t);
		h.clock.t += 60_000;
		await h.d.sweep(cfg); // second read, but GitHub says in_progress: keep
		expect(Object.keys(await active(h))).toHaveLength(1);
		h.gh.states.set(1, { kind: "completed", runId: 1, completedAtMs: h.clock.t });
		h.clock.t += 60_000;
		await h.d.sweep(cfg);
		expect(await active(h)).toEqual({});
	});

	it("DISPATCH_ENABLED=0 starts nothing", async () => {
		const h = harness();
		const d = new Dispatcher(h.state, baseEnv({ RUNNER_LIGHT: h.light, DISPATCH_ENABLED: "0" }), {
			github: h.gh as unknown as GitHubClient,
			now: () => h.clock.t,
		});
		await d.onQueued(queued(1));
		await d.alarm();
		expect(h.mints).toHaveLength(0);
	});
});
