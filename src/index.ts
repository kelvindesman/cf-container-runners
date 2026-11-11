/**
 * cf-container-runners: ephemeral GitHub Actions runners on Cloudflare Containers.
 *
 *   GitHub `workflow_job` webhook
 *     -> verify HMAC-SHA256 over the raw body (before parsing anything)
 *     -> allowlist (repo listed; public repos denied unless explicitly allowed)
 *     -> route by labels to a container class
 *     -> Dispatcher DO: queue, admit under MAX_CONCURRENT, mint a JIT runner,
 *        start one container, which runs one job and exits.
 *
 * Routes: POST /webhook (GitHub), GET /health (open, says nothing),
 * GET /stats (bearer ADMIN_TOKEN; disabled when unset).
 */
import { ConfigError, parseConfig } from "./config";
import { Dispatcher } from "./dispatcher";
import type { Env, StubLike } from "./env";
import { checkAllowlist, routeLabels } from "./routing";
import { HeavyRunner, LightRunner } from "./runner";
import { timingSafeEqual, verifyWebhookSignature } from "./signature";

export { Dispatcher, HeavyRunner, LightRunner };

/** Bodies over this are refused before HMAC; a `workflow_job` payload is a few KB. */
const MAX_WEBHOOK_BYTES = 1_000_000;

interface WorkflowJobEvent {
	action?: string;
	workflow_job?: {
		id: number;
		labels?: string[];
		runner_name?: string | null;
	};
	repository?: {
		full_name?: string;
		private?: boolean;
		visibility?: string;
	};
}

function dispatcher(env: Env): StubLike {
	return env.DISPATCHER.get(env.DISPATCHER.idFromName("singleton"));
}

const EVICTED = "this Durable Object instance is no longer active";

/**
 * A DO stub cannot be reused after the platform evicted its instance mid-call;
 * retry once with a fresh stub. If that fails too, answer 503: reconcile picks
 * the job up from GitHub's own queued list within minutes.
 */
export async function callDispatcher(
	getStub: () => StubLike,
	path: string,
	body: unknown,
): Promise<Response> {
	const init = () => ({ method: "POST", body: JSON.stringify(body) });
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			return await getStub().fetch(`https://dispatcher${path}`, init());
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes(EVICTED)) throw err;
		}
	}
	console.warn(
		`dispatcher evicted twice on ${path}; reconcile will recover the job`,
	);
	return new Response("dispatcher unavailable", { status: 503 });
}

export async function handleWebhook(req: Request, env: Env): Promise<Response> {
	const length = Number(req.headers.get("content-length") ?? "0");
	if (length > MAX_WEBHOOK_BYTES)
		return new Response("too large", { status: 413 });
	const body = await req.text();
	if (body.length > MAX_WEBHOOK_BYTES)
		return new Response("too large", { status: 413 });

	// Verify BEFORE parsing: a forged webhook would mint runners and start containers.
	if (!env.GITHUB_WEBHOOK_SECRET) {
		console.error("GITHUB_WEBHOOK_SECRET is not set; refusing every webhook");
		return new Response("not configured", { status: 500 });
	}
	const ok = await verifyWebhookSignature(
		env.GITHUB_WEBHOOK_SECRET,
		body,
		req.headers.get("x-hub-signature-256"),
	);
	if (!ok) return new Response("bad signature", { status: 401 });

	const eventName = req.headers.get("x-github-event");
	if (eventName === "ping") return new Response("pong");
	if (eventName !== "workflow_job") return new Response("ignored");

	let cfg: ReturnType<typeof parseConfig>;
	try {
		cfg = parseConfig(env);
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`config error: ${err.message}`);
			return new Response(`config error: ${err.message}`, { status: 500 });
		}
		throw err;
	}

	let event: WorkflowJobEvent;
	try {
		event = JSON.parse(body) as WorkflowJobEvent;
	} catch {
		return new Response("bad json", { status: 400 });
	}
	const job = event.workflow_job;
	const repoName = event.repository?.full_name;
	if (!job || typeof job.id !== "number" || !repoName) {
		return new Response("missing workflow_job/repository", { status: 400 });
	}

	const route = routeLabels(job.labels, cfg);
	if (!route.ok) return new Response(`not ours: ${route.reason}`);

	const allowed = checkAllowlist(
		{
			fullName: repoName,
			private: event.repository?.private,
			visibility: event.repository?.visibility,
		},
		cfg,
	);
	if (!allowed.ok) {
		console.warn(`refused job ${job.id}: ${allowed.reason}`);
		return new Response(`refused: ${allowed.reason}`, { status: 403 });
	}

	const get = () => dispatcher(env);
	switch (event.action) {
		case "queued":
			return callDispatcher(get, "/queued", {
				jobId: job.id,
				repo: repoName,
				runnerClass: route.runnerClass,
				label: route.label,
				facts: {
					fullName: repoName,
					private: event.repository?.private,
					visibility: event.repository?.visibility,
				},
			});
		case "in_progress":
			return callDispatcher(get, "/in_progress", {
				jobId: job.id,
				repo: repoName,
				runnerName: job.runner_name ?? null,
			});
		case "completed":
			return callDispatcher(get, "/completed", { jobId: job.id });
		default:
			return new Response("ignored");
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/health") return new Response("ok");
		if (url.pathname === "/webhook" && req.method === "POST") {
			return handleWebhook(req, env);
		}
		if (url.pathname === "/stats" && req.method === "GET") {
			// Live job ids and spend are operational intelligence: never open.
			if (!env.ADMIN_TOKEN) return new Response("not found", { status: 404 });
			const bearer = req.headers.get("authorization") ?? "";
			if (!timingSafeEqual(bearer, `Bearer ${env.ADMIN_TOKEN}`)) {
				return new Response("unauthorized", { status: 401 });
			}
			return dispatcher(env).fetch("https://dispatcher/stats");
		}
		return new Response("not found", { status: 404 });
	},

	/**
	 * Cron backstop (wrangler.jsonc `triggers.crons`). Wakes the Dispatcher even
	 * if every alarm was lost: sweep, reconcile with GitHub, registration hygiene.
	 */
	async scheduled(
		_event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(
			dispatcher(env)
				.fetch("https://dispatcher/tick", { method: "POST" })
				.then(() => undefined)
				.catch((err) => console.error("cron tick failed", err)),
		);
	},
};
