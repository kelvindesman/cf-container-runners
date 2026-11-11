import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearTokenCache,
	GitHubClient,
	isTransientStatus,
	signAppJwt,
} from "../src/github";

// source: GitHub docs, "Generating a JSON Web Token (JWT) for a GitHub App" (RS256; iat backdated 60 s; exp <= 10 min; iss = app id; keys are PKCS#1 PEM)
describe("GitHub App JWT", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
	const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

	function verify(jwt: string): Record<string, number | string> {
		const [h, p, s] = jwt.split(".");
		const v = createVerify("RSA-SHA256");
		v.update(`${h}.${p}`);
		expect(v.verify(publicKey, Buffer.from(s as string, "base64url"))).toBe(
			true,
		);
		return JSON.parse(Buffer.from(p as string, "base64url").toString());
	}

	it("signs with a PKCS#1 key as GitHub issues it", async () => {
		const claims = verify(await signAppJwt("12345", pkcs1, 1_700_000_000_000));
		expect(claims).toEqual({
			iat: 1_700_000_000 - 60,
			exp: 1_700_000_000 + 540,
			iss: "12345",
		});
	});

	it("accepts PKCS#8 and escaped newlines (as pasted into a secret)", async () => {
		verify(await signAppJwt("1", pkcs8, Date.now()));
		verify(await signAppJwt("1", pkcs1.replace(/\n/g, "\\n"), Date.now()));
	});

	it("rejects a non-key", async () => {
		await expect(signAppJwt("1", "not a key", Date.now())).rejects.toThrow(
			/PEM/,
		);
	});
});

// source: docs/LESSONS.md "transient runners-list GET" (a Cloudflare-synthesised 522 was blamed on the token)
describe("request retries", () => {
	beforeEach(() => clearTokenCache());
	const cfg = { runnerScope: "repo" as const, runnerGroupId: 1 };

	it("classifies transient statuses", () => {
		expect([null, 408, 429, 500, 522].every(isTransientStatus)).toBe(true);
		expect([400, 401, 403, 404, 409, 422].some(isTransientStatus)).toBe(false);
	});

	it("retries a transient GET, then succeeds", async () => {
		const statuses = [522, 503, 200];
		const seen: string[] = [];
		const gh = new GitHubClient(
			{ GITHUB_PAT: "pat" },
			cfg,
			async (url, init) => {
				seen.push(`${init?.method} ${url}`);
				const status = statuses.shift() as number;
				return new Response(
					status === 200
						? JSON.stringify({
								runners: [
									{ id: 1, name: "ccr-1-sa", status: "offline", busy: false },
								],
							})
						: "",
					{ status },
				);
			},
			async () => {},
		);
		const res = await gh.listRunners("acme/app");
		expect(res.error).toBeNull();
		expect(res.runners).toHaveLength(1);
		expect(seen).toHaveLength(3);
		expect(seen[0]).toBe(
			"GET https://api.github.com/repos/acme/app/actions/runners?per_page=100&page=1",
		);
	});

	it("does not retry a 401, and never retries a POST", async () => {
		let calls = 0;
		const gh = new GitHubClient(
			{ GITHUB_PAT: "pat" },
			cfg,
			async () => {
				calls++;
				return new Response("", { status: calls === 1 ? 401 : 503 });
			},
			async () => {},
		);
		expect(await gh.jobState("acme/app", 1)).toBeNull();
		expect(calls).toBe(1);
		const jit = await gh.generateJitConfig("acme/app", "ccr-1-sa", "cf-runner");
		expect(jit).toMatchObject({ ok: false, status: 503 });
		expect(calls).toBe(2);
	});

	it("mints at repo scope with the Default group and only the class label", async () => {
		let body: unknown;
		let url = "";
		const gh = new GitHubClient({ GITHUB_PAT: "pat" }, cfg, async (u, init) => {
			url = u;
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ encoded_jit_config: "JIT" }), {
				status: 201,
			});
		});
		expect(
			await gh.generateJitConfig("acme/app", "ccr-9-sx", "cf-runner"),
		).toEqual({ ok: true, status: 201, value: "JIT" });
		expect(url).toBe(
			"https://api.github.com/repos/acme/app/actions/runners/generate-jitconfig",
		);
		expect(body).toEqual({
			name: "ccr-9-sx",
			runner_group_id: 1,
			labels: ["cf-runner"],
			work_folder: "_work",
		});
	});

	it("mints at org scope with the configured group", async () => {
		let url = "";
		let body: { runner_group_id?: number } = {};
		const gh = new GitHubClient(
			{ GITHUB_PAT: "pat" },
			{ runnerScope: "org", runnerGroupId: 7 },
			async (u, init) => {
				url = u;
				body = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({ encoded_jit_config: "JIT" }), {
					status: 201,
				});
			},
		);
		await gh.generateJitConfig("acme/app", "ccr-9-sx", "cf-runner");
		expect(url).toBe(
			"https://api.github.com/orgs/acme/actions/runners/generate-jitconfig",
		);
		expect(body.runner_group_id).toBe(7);
	});

	// source: GitHub docs, "Create an installation access token for an app" (`repositories` narrows the token; organization permissions need an installation-wide token)
	describe("installation token scoping", () => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
		const app = { GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: pem };

		/** Fake GitHub: mints `ghs_<repos or ORG>` tokens, records which token each API call carried. */
		function fakeGitHub() {
			const mints: Array<{ repositories?: string[] }> = [];
			const used: Array<{ url: string; token: string }> = [];
			let lookups = 0;
			const fetchFn = async (u: string, init?: RequestInit) => {
				if (u.endsWith("/installation")) {
					lookups++;
					return Response.json({ id: 99 });
				}
				if (u.endsWith("/app/installations/99/access_tokens")) {
					const body = JSON.parse(String(init?.body)) as {
						repositories?: string[];
					};
					mints.push(body);
					const token = `ghs_${body.repositories?.join("+") ?? "ORG"}`;
					return Response.json(
						{
							token,
							expires_at: new Date(Date.now() + 3600_000).toISOString(),
						},
						{ status: 201 },
					);
				}
				const auth = (init?.headers as Record<string, string>).authorization;
				used.push({ url: u, token: (auth ?? "").replace("Bearer ", "") });
				if (u.includes("generate-jitconfig"))
					return Response.json({ encoded_jit_config: "JIT" }, { status: 201 });
				if (u.includes("/actions/runners"))
					return Response.json({ runners: [] });
				return Response.json({ status: "queued", run_id: 5 });
			};
			return { fetchFn, mints, used, lookups: () => lookups };
		}

		it("repo scope: every call carries a token narrowed to the job's one repository", async () => {
			const f = fakeGitHub();
			const gh = new GitHubClient(app, cfg, f.fetchFn);
			await gh.jobState("acme/app", 1);
			await gh.generateJitConfig("acme/app", "ccr-1-sa", "cf-runner");
			await gh.listRunners("acme/app");
			await gh.jobState("acme/other", 2);
			expect(f.mints).toEqual([
				{ repositories: ["app"] },
				{ repositories: ["other"] },
			]);
			expect(f.lookups()).toBe(1);
			expect(f.used.map((c) => c.token)).toEqual([
				"ghs_app",
				"ghs_app",
				"ghs_app",
				"ghs_other",
			]);
		});

		it("org scope: org runner endpoints use the org token, job reads stay repo-narrowed", async () => {
			const f = fakeGitHub();
			const gh = new GitHubClient(
				app,
				{ runnerScope: "org", runnerGroupId: 7 },
				f.fetchFn,
			);
			await gh.generateJitConfig("acme/app", "ccr-1-sa", "cf-runner");
			await gh.listRunners("acme/app");
			await gh.deleteRunner("acme/app", 3);
			await gh.jobState("acme/app", 1);
			await gh.cancelRun("acme/app", 5);
			expect(f.mints).toEqual([{}, { repositories: ["app"] }]);
			expect(f.used).toEqual([
				{
					url: "https://api.github.com/orgs/acme/actions/runners/generate-jitconfig",
					token: "ghs_ORG",
				},
				{
					url: "https://api.github.com/orgs/acme/actions/runners?per_page=100&page=1",
					token: "ghs_ORG",
				},
				{
					url: "https://api.github.com/orgs/acme/actions/runners/3",
					token: "ghs_ORG",
				},
				{
					url: "https://api.github.com/repos/acme/app/actions/jobs/1",
					token: "ghs_app",
				},
				{
					url: "https://api.github.com/repos/acme/app/actions/runs/5/cancel",
					token: "ghs_app",
				},
			]);
		});
	});
});
