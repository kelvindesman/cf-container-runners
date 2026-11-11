import { describe, expect, it } from "vitest";
import {
	admit,
	applyAlarmOutcome,
	applyCompleted,
	applyInProgress,
	classifyWedge,
	type Entries,
	type Entry,
	estimateMinutesToday,
	exitPlan,
	isContainerCapacityError,
	LOCAL_MAX_WALL_MS,
	MAX_EXIT_REQUEUES,
	type PendingJob,
	pollDecision,
	REAP_MINT_GRACE_MS,
	retryDecision,
	shouldAlertBudget,
	shouldReap,
	spendBoundPerWave,
	UPSTREAM_MAX_WALL_MS,
	upstreamBackoffMs,
	withoutJobIds,
	withPendingJob,
} from "../src/policy";

const job = (jobId: number, dueAt = 0): PendingJob => ({ jobId, repo: "acme/app", runnerClass: "light", label: "cf-runner", dueAt });
const entry = (over: Partial<Entry> & { doName: string }): Entry => ({
	repo: "acme/app",
	runnerClass: "light",
	label: "cf-runner",
	runnerName: over.doName,
	spawnedFor: 1,
	servingJob: 1,
	startedAt: 0,
	...over,
});

// source: docs/LESSONS.md "no hard daily cap" (a ledger-gated spawn refusal stranded every queued job for ~23 h)
describe("admission: spend is bounded structurally, never by budget", () => {
	const base = { enabled: true, activeCount: 0, maxConcurrent: 3, lastStartAt: 0, spacingMs: 0, now: 1_000_000 };

	it("admits under the cap", () => {
		expect(admit(base)).toEqual({ admit: true });
	});

	it("refuses at the cap", () => {
		expect(admit({ ...base, activeCount: 3 })).toEqual({ admit: false, reason: "at-capacity" });
	});

	it("has no budget input at all: a huge spend still admits under the cap", () => {
		// The type has no budget field; this pins that the only refusals are cap/spacing/disabled.
		expect(admit({ ...base, activeCount: 2 })).toEqual({ admit: true });
		expect(shouldAlertBudget({ softDailyBudgetMinutes: 10, minutesToday: 10_000, lastAlertDay: null, today: "2026-01-01" })).toBe(true);
	});

	it("honours the kill switch", () => {
		expect(admit({ ...base, enabled: false })).toEqual({ admit: false, reason: "disabled" });
	});

	// source: docs/LESSONS.md "space container starts" (burst starts drew "no container instance" refusals)
	it("spaces starts", () => {
		expect(admit({ ...base, spacingMs: 2000, lastStartAt: 999_000 })).toEqual({ admit: false, reason: "spacing", retryAt: 1_001_000 });
		expect(admit({ ...base, spacingMs: 2000, lastStartAt: 990_000 })).toEqual({ admit: true });
	});

	it("worst case per wave is concurrency x deadline", () => {
		expect(spendBoundPerWave(4, 60)).toBe(240);
	});
});

describe("soft budget alert", () => {
	it("fires once per UTC day and never when disabled", () => {
		const b = { softDailyBudgetMinutes: 100, minutesToday: 150, lastAlertDay: null, today: "2026-01-02" };
		expect(shouldAlertBudget(b)).toBe(true);
		expect(shouldAlertBudget({ ...b, lastAlertDay: "2026-01-02" })).toBe(false);
		expect(shouldAlertBudget({ ...b, minutesToday: 99 })).toBe(false);
		expect(shouldAlertBudget({ ...b, softDailyBudgetMinutes: 0 })).toBe(false);
	});

	// source: docs/LESSONS.md "derived, not reserved ledger" (reserved worst cases read 30x real spend)
	it("estimates from settled + live time, each live entry capped at the deadline", () => {
		const now = 10 * 60 * 60_000;
		expect(estimateMinutesToday({ settled: 5, startedAts: [now - 10 * 60_000, now - 600 * 60_000], maxJobMinutes: 60, now })).toBe(75);
	});
});

// source: docs/LESSONS.md "wall-clock retry budgets" + "name the vendor"
describe("retry schedules", () => {
	it("local contention polls fast and strands at the wall", () => {
		expect(retryDecision("local", 0)).toEqual({ strand: false, nextDelayMs: 30_000 });
		expect(retryDecision("local", LOCAL_MAX_WALL_MS).strand).toBe(true);
	});

	it("upstream backs off 30 s -> 90 s and strands at 6 h", () => {
		expect(upstreamBackoffMs(0)).toBe(30_000);
		expect(upstreamBackoffMs(30_000)).toBe(60_000);
		expect(upstreamBackoffMs(10 * 60_000)).toBe(90_000);
		expect(retryDecision("upstream", UPSTREAM_MAX_WALL_MS).strand).toBe(true);
		expect(retryDecision("upstream", UPSTREAM_MAX_WALL_MS - 1).strand).toBe(false);
	});

	it("classifies Cloudflare's no-instance refusal as capacity, not GitHub", () => {
		expect(isContainerCapacityError(new Error("There is no container instance that can be provided to this Durable Object, try again later"))).toBe(true);
		expect(isContainerCapacityError("NO CONTAINER INSTANCE")).toBe(true);
		expect(isContainerCapacityError(new Error("HTTP 502 from api.github.com"))).toBe(false);
		expect(isContainerCapacityError(null)).toBe(false);
	});
});

// source: docs/LESSONS.md "snapshot then await then write" (a stale write-back resurrected and deleted jobs)
describe("pending deltas", () => {
	it("are idempotent and keep jobs added mid-pass", () => {
		const q = withPendingJob([job(1)], job(1));
		expect(q).toHaveLength(1);
		const current = [job(1), job(2), job(3)]; // 3 arrived during the pass
		const next = applyAlarmOutcome(current, new Set([1, 2]), [{ ...job(2), dueAt: 99 }]);
		expect(next.map((j) => [j.jobId, j.dueAt])).toEqual([[2, 99], [3, 0]]);
		expect(withoutJobIds(current, [2])).toHaveLength(2);
	});

	it("does not resurrect a handled job someone else removed", () => {
		expect(applyAlarmOutcome([job(3)], new Set([1]), [job(1)]).map((j) => j.jobId)).toEqual([3]);
	});
});

// source: docs/LESSONS.md "re-queue a displaced job" (GitHub gives a JIT runner any matching job; backlog was conserved, not drained)
describe("applyInProgress", () => {
	it("records the taker when it ran its own job", () => {
		const a: Entries = { c1: entry({ doName: "c1", spawnedFor: 1, servingJob: 1 }) };
		const p = applyInProgress(a, 1, "c1");
		expect(p.next.c1).toMatchObject({ servingJob: 1, inProgress: true });
		expect(p.displaced).toBeNull();
	});

	it("re-queues the job a container was minted for when it took another", () => {
		const a: Entries = {
			c1: entry({ doName: "c1", spawnedFor: 1, servingJob: 1 }),
			c2: entry({ doName: "c2", spawnedFor: 2, servingJob: 2 }),
		};
		const p = applyInProgress(a, 2, "c1"); // c1 took job 2
		expect(p.next.c1).toMatchObject({ servingJob: 2, inProgress: true });
		// c2 believed it served 2; it does not any more, so it is free...
		// ...and is handed job 1 instead of spawning a new container.
		expect(p.reassigned).toEqual({ doName: "c2", jobId: 1 });
		expect(p.next.c2?.servingJob).toBe(1);
		expect(p.displaced).toBeNull();
	});

	it("returns the displaced job when no idle container can take it", () => {
		const a: Entries = { c1: entry({ doName: "c1", spawnedFor: 1, servingJob: 1 }) };
		const p = applyInProgress(a, 7, "c1");
		expect(p.displaced?.jobId).toBe(1);
	});

	it("frees our not-started container when a foreign runner took its job", () => {
		const a: Entries = { c1: entry({ doName: "c1", spawnedFor: 1, servingJob: 1 }) };
		const p = applyInProgress(a, 1, "someone-elses-box");
		expect(p.takerKey).toBeNull();
		expect(p.next.c1?.servingJob).toBeNull();
	});

	it("never hands work to a container of another repo or label", () => {
		const a: Entries = {
			c1: entry({ doName: "c1", spawnedFor: 1, servingJob: 1 }),
			c2: entry({ doName: "c2", servingJob: null, label: "cf-runner-heavy", runnerClass: "heavy" }),
		};
		expect(applyInProgress(a, 7, "c1").displaced?.jobId).toBe(1);
	});

	it("completed: in-progress entries are marked, never-started ones go idle", () => {
		const a: Entries = {
			c1: entry({ doName: "c1", servingJob: 5, inProgress: true }),
			c2: entry({ doName: "c2", servingJob: 5 }),
		};
		const n = applyCompleted(a, 5, 123);
		expect(n.c1?.completedAt).toBe(123);
		expect(n.c2?.servingJob).toBeNull();
	});
});

// source: docs/LESSONS.md "never conclude dead from one read" (a false `running` flag killed 94 live jobs)
describe("pollDecision", () => {
	const base = { running: false, suspectedAt: null, elapsedMin: 5, deadlineMin: 30, hasJobToAsk: true };

	it("a single false read only raises suspicion", () => {
		expect(pollDecision(base)).toEqual({ action: "suspect" });
	});

	it("a second false read asks GitHub before concluding", () => {
		expect(pollDecision({ ...base, suspectedAt: 1 })).toEqual({ action: "ask-github" });
		expect(pollDecision({ ...base, suspectedAt: 1, githubSays: "in_progress" })).toEqual({ action: "keep", clearSuspicion: true });
		expect(pollDecision({ ...base, suspectedAt: 1, githubSays: "completed" })).toEqual({ action: "exited" });
		expect(pollDecision({ ...base, suspectedAt: 1, githubSays: "unknown" })).toEqual({ action: "keep", clearSuspicion: false });
	});

	it("without a known job, two false reads are enough", () => {
		expect(pollDecision({ ...base, suspectedAt: 1, hasJobToAsk: false })).toEqual({ action: "exited" });
	});

	it("a running container past its deadline is killed", () => {
		expect(pollDecision({ ...base, running: true, elapsedMin: 31 })).toEqual({ action: "deadline" });
		expect(pollDecision({ ...base, running: true, suspectedAt: 1 })).toEqual({ action: "keep", clearSuspicion: true });
	});

	it("the deadline bounds every guess", () => {
		expect(pollDecision({ ...base, suspectedAt: 1, elapsedMin: 31, githubSays: "unknown" })).toEqual({ action: "exited" });
	});
});

// source: docs/LESSONS.md "retry no-instance exits, name the reason"
describe("exitPlan", () => {
	it("settles a container that ran its job", () => {
		expect(exitPlan({ inProgress: true }, "exit")).toEqual({ action: "settle" });
	});

	it("re-queues a job whose container exited before taking it, bounded", () => {
		expect(exitPlan({ exitRequeues: 0 }, "no-instance")).toEqual({ action: "requeue", attempt: 1 });
		const last = exitPlan({ exitRequeues: MAX_EXIT_REQUEUES }, "no-instance");
		expect(last).toMatchObject({ action: "strand" });
		expect(last.action === "strand" && last.why).toContain("no-instance");
	});
});

// source: docs/LESSONS.md "reaper mint grace" + "wedge recovery"
describe("registration hygiene", () => {
	const now = 100 * 60_000;
	it("reaps only our offline idle runners outside the mint grace", () => {
		const r = { name: "ccr-1-sabc", status: "offline", busy: false };
		expect(shouldReap(r, "ccr", undefined, now)).toBe(true);
		expect(shouldReap(r, "ccr", now - REAP_MINT_GRACE_MS + 1, now)).toBe(false);
		expect(shouldReap({ ...r, busy: true }, "ccr", undefined, now)).toBe(false);
		expect(shouldReap({ ...r, status: "online" }, "ccr", undefined, now)).toBe(false);
		expect(shouldReap({ ...r, name: "build-box-1" }, "ccr", undefined, now)).toBe(false);
	});

	it("calls offline+busy a wedge only on evidence", () => {
		const r = { name: "ccr-1-sabc", status: "offline", busy: true };
		expect(classifyWedge(r, "ccr", null, now).wedged).toBe(false);
		expect(classifyWedge(r, "ccr", { kind: "queued" }, now).wedged).toBe(false);
		expect(classifyWedge(r, "ccr", { kind: "missing" }, now).wedged).toBe(true);
		expect(classifyWedge(r, "ccr", { kind: "completed", completedAtMs: now - 60_000 }, now).wedged).toBe(false);
		expect(classifyWedge(r, "ccr", { kind: "completed", completedAtMs: now - 30 * 60_000 }, now).wedged).toBe(true);
		expect(classifyWedge(r, "ccr", { kind: "in_progress", startedAtMs: now - 5 * 60_000 }, now).wedged).toBe(false);
		expect(classifyWedge(r, "ccr", { kind: "in_progress", startedAtMs: now - 25 * 60_000 }, now).wedged).toBe(true);
		expect(classifyWedge({ ...r, status: "online" }, "ccr", { kind: "missing" }, now).wedged).toBe(false);
	});
});
