import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import worker, { callDispatcher, handleWebhook } from "../src/index";
import { baseEnv, fakeNamespace } from "./fakes";

function delivery(payload: unknown, opts: { secret?: string; event?: string; sig?: string } = {}): Request {
	const body = JSON.stringify(payload);
	const sig = opts.sig ?? `sha256=${createHmac("sha256", opts.secret ?? "test-secret").update(body).digest("hex")}`;
	return new Request("https://runners.example/webhook", {
		method: "POST",
		headers: { "x-hub-signature-256": sig, "x-github-event": opts.event ?? "workflow_job", "content-type": "application/json" },
		body,
	});
}

const job = (over: Record<string, unknown> = {}) => ({
	action: "queued",
	workflow_job: { id: 77, labels: ["self-hosted", "cf-runner"], runner_name: null },
	repository: { full_name: "acme/app", private: true, visibility: "private" },
	...over,
});

function envWithDispatcher() {
	const dispatcher = fakeNamespace(() => new Response("queued"));
	return { env: baseEnv({ DISPATCHER: dispatcher }), dispatcher };
}

// source: GitHub docs, "Validating webhook deliveries" + SECURITY.md (verify before parse; allowlist; public repos denied)
describe("POST /webhook", () => {
	it("forwards a verified, allowed, routable queued job to the dispatcher", async () => {
		const { env, dispatcher } = envWithDispatcher();
		const res = await handleWebhook(delivery(job()), env);
		expect(res.status).toBe(200);
		expect(dispatcher.calls).toEqual([
			{
				name: "singleton",
				path: "/queued",
				body: expect.objectContaining({ jobId: 77, repo: "acme/app", runnerClass: "light", label: "cf-runner" }),
			},
		]);
	});

	it("rejects a bad signature before parsing anything", async () => {
		const { env, dispatcher } = envWithDispatcher();
		const res = await handleWebhook(delivery(job(), { secret: "wrong" }), env);
		expect(res.status).toBe(401);
		const garbage = new Request("https://x/webhook", { method: "POST", headers: { "x-hub-signature-256": "sha256=00" }, body: "{not json" });
		expect((await handleWebhook(garbage, env)).status).toBe(401);
		expect(dispatcher.calls).toEqual([]);
	});

	it("refuses every webhook when the secret is not configured", async () => {
		const { env } = envWithDispatcher();
		env.GITHUB_WEBHOOK_SECRET = undefined;
		expect((await handleWebhook(delivery(job()), env)).status).toBe(500);
	});

	it("refuses a repo outside the allowlist", async () => {
		const { env, dispatcher } = envWithDispatcher();
		const res = await handleWebhook(delivery(job({ repository: { full_name: "evil/app", private: true } })), env);
		expect(res.status).toBe(403);
		expect(dispatcher.calls).toEqual([]);
	});

	it("refuses a public repo unless explicitly allowed", async () => {
		const { env, dispatcher } = envWithDispatcher();
		const pub = job({ repository: { full_name: "acme/app", private: false, visibility: "public" } });
		expect((await handleWebhook(delivery(pub), env)).status).toBe(403);
		env.ALLOW_PUBLIC_REPOS = "acme/app";
		expect((await handleWebhook(delivery(pub), env)).status).toBe(200);
		expect(dispatcher.calls).toHaveLength(1);
	});

	it("ignores jobs for other runners and other events", async () => {
		const { env, dispatcher } = envWithDispatcher();
		const hosted = job({ workflow_job: { id: 1, labels: ["ubuntu-latest"] } });
		expect(await (await handleWebhook(delivery(hosted), env)).text()).toMatch(/^not ours/);
		expect(await (await handleWebhook(delivery({ zen: "hi" }, { event: "ping" }), env)).text()).toBe("pong");
		expect(await (await handleWebhook(delivery(job(), { event: "push" }), env)).text()).toBe("ignored");
		expect(dispatcher.calls).toEqual([]);
	});

	it("reports a config error loudly instead of guessing", async () => {
		const { env } = envWithDispatcher();
		env.RUNNER_LABELS = "oops";
		const res = await handleWebhook(delivery(job()), env);
		expect(res.status).toBe(500);
		expect(await res.text()).toContain("RUNNER_LABELS");
	});

	it("routes in_progress with the runner name and completed with the job id", async () => {
		const { env, dispatcher } = envWithDispatcher();
		await handleWebhook(delivery(job({ action: "in_progress", workflow_job: { id: 77, labels: ["self-hosted", "cf-runner"], runner_name: "ccr-77-sab" } })), env);
		await handleWebhook(delivery(job({ action: "completed" })), env);
		expect(dispatcher.calls.map((c) => [c.path, c.body])).toEqual([
			["/in_progress", { jobId: 77, repo: "acme/app", runnerName: "ccr-77-sab" }],
			["/completed", { jobId: 77 }],
		]);
	});
});

// source: docs/LESSONS.md "DO eviction retry" (an evicted stub must be replaced, not reused)
describe("callDispatcher", () => {
	it("retries once with a fresh stub on eviction, then 503s", async () => {
		let stubs = 0;
		const evicting = () => {
			stubs++;
			return { fetch: async () => { throw new Error("Connection closed: this Durable Object instance is no longer active"); } };
		};
		const res = await callDispatcher(evicting, "/queued", {});
		expect(res.status).toBe(503);
		expect(stubs).toBe(2);
	});

	it("rethrows anything else", async () => {
		await expect(callDispatcher(() => ({ fetch: async () => { throw new Error("boom"); } }), "/x", {})).rejects.toThrow("boom");
	});
});

describe("other routes", () => {
	it("/health says ok and nothing else; /stats is closed without ADMIN_TOKEN", async () => {
		const { env } = envWithDispatcher();
		expect(await (await worker.fetch(new Request("https://x/health"), env)).text()).toBe("ok");
		expect((await worker.fetch(new Request("https://x/stats"), env)).status).toBe(404);
		env.ADMIN_TOKEN = "admin";
		expect((await worker.fetch(new Request("https://x/stats", { headers: { authorization: "Bearer nope" } }), env)).status).toBe(401);
		expect((await worker.fetch(new Request("https://x/stats", { headers: { authorization: "Bearer admin" } }), env)).status).toBe(200);
	});
});
