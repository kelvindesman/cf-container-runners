import { describe, expect, it } from "vitest";
import type { ContainerLike } from "../src/env";
import type { JobState } from "../src/github";
import { exitReason, LightRunner } from "../src/runner";
import { baseEnv, fakeNamespace, fakeState } from "./fakes";

function fakeContainer(): ContainerLike & { running: boolean; startedWith?: unknown; destroyed?: unknown } {
	const c = {
		running: false,
		startedWith: undefined as unknown,
		destroyed: undefined as unknown,
		start(opts?: unknown) {
			c.running = true;
			c.startedWith = opts;
		},
		monitor: () => new Promise<void>(() => {}),
		async destroy(reason?: unknown) {
			c.running = false;
			c.destroyed = reason;
		},
	};
	return c;
}

function setup(jobState: JobState | null = null) {
	const clock = { t: 1_000_000 };
	const state = fakeState();
	const container = fakeContainer();
	state.container = container;
	const dispatcher = fakeNamespace(() => new Response("ok"));
	const r = new LightRunner(state, baseEnv({ DISPATCHER: dispatcher }), { now: () => clock.t, jobState: async () => jobState });
	const start = () =>
		r.fetch(new Request("https://runner/start", {
			method: "POST",
			body: JSON.stringify({ env: { RUNNER_JITCONFIG: "JIT" }, maxJobMinutes: 30, doName: "ccr-1-sa", repo: "acme/app", spawnedFor: 1 }),
		}));
	return { r, state, container, dispatcher, clock, start };
}

// source: docs/LESSONS.md "deadline enforced by the container's own DO alarm" + "never conclude dead from one read"
describe("LightRunner", () => {
	it("starts with only the allowed env, internet on, and arms an alarm", async () => {
		const s = setup();
		expect(await (await s.start()).text()).toBe("started");
		expect(s.container.startedWith).toEqual({ env: { RUNNER_JITCONFIG: "JIT" }, enableInternet: true });
		expect(s.state.storage.alarm).toBe(s.clock.t + LightRunner.POLL_MS);
	});

	it("refuses to pass a non-allowlisted env var into the container", async () => {
		const s = setup();
		const req = new Request("https://runner/start", {
			method: "POST",
			body: JSON.stringify({ env: { RUNNER_JITCONFIG: "JIT", GITHUB_APP_PRIVATE_KEY: "k" }, maxJobMinutes: 30, doName: "d", repo: "acme/app", spawnedFor: 1 }),
		});
		await expect(s.r.fetch(req)).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY/);
		expect(s.container.running).toBe(false);
	});

	it("kills at the deadline and reports reason=deadline before destroying", async () => {
		const s = setup();
		await s.start();
		s.clock.t += 31 * 60_000;
		await s.r.alarm();
		expect(s.container.destroyed).toBe("deadline");
		expect(s.dispatcher.calls[0]).toMatchObject({ path: "/container_exited", body: { doName: "ccr-1-sa", reason: "deadline" } });
		expect(s.state.storage.alarm).toBeNull();
	});

	it("needs two false reads and GitHub's agreement to report an exit", async () => {
		const s = setup({ kind: "in_progress", runId: 1, startedAtMs: 0 });
		await s.start();
		await s.r.fetch(new Request("https://runner/serving", { method: "POST", body: JSON.stringify({ jobId: 1 }) }));
		s.container.running = false;
		await s.r.alarm(); // suspect
		expect(s.dispatcher.calls).toEqual([]);
		s.clock.t += 30_000;
		await s.r.alarm(); // GitHub says in_progress: keep
		expect(s.dispatcher.calls).toEqual([]);
		expect(await s.state.storage.get("suspectedAt")).toBeUndefined();
	});

	it("reports exit after two false reads when no job was ever taken", async () => {
		const s = setup();
		await s.start();
		s.container.running = false;
		await s.r.alarm();
		s.clock.t += 30_000;
		await s.r.alarm();
		expect(s.dispatcher.calls[0]).toMatchObject({ path: "/container_exited", body: { reason: "unknown" } });
	});

	it("names a platform no-instance refusal", () => {
		expect(exitReason({ kind: "error", at: 0, message: "There is no container instance that can be provided" })).toBe("no-instance");
		expect(exitReason({ kind: "exit", at: 0 })).toBe("exit");
		expect(exitReason(undefined)).toBe("unknown");
	});
});
