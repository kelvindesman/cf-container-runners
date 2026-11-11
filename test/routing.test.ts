// source: GitHub docs, "Using labels with self-hosted runners" (job runs only on a runner carrying ALL its labels; self-hosted/linux/x64 are default labels)
import { describe, expect, it } from "vitest";
import { parseLabels } from "../src/config";
import { checkAllowlist, routeLabels, runnerNameFor, spawnIdFromRunnerName } from "../src/routing";

const cfg = { labels: parseLabels("cf-runner=light,cf-runner-heavy=heavy") };

describe("routeLabels", () => {
	it("routes self-hosted + class label", () => {
		expect(routeLabels(["self-hosted", "cf-runner"], cfg)).toEqual({ ok: true, runnerClass: "light", label: "cf-runner" });
		expect(routeLabels(["self-hosted", "linux", "x64", "cf-runner-heavy"], cfg)).toEqual({
			ok: true,
			runnerClass: "heavy",
			label: "cf-runner-heavy",
		});
	});

	it("is case-insensitive like GitHub", () => {
		expect(routeLabels(["Self-Hosted", "Linux", "CF-Runner"], cfg)).toMatchObject({ ok: true, runnerClass: "light" });
	});

	it("refuses GitHub-hosted jobs and jobs without self-hosted", () => {
		expect(routeLabels(["ubuntu-latest"], cfg).ok).toBe(false);
		expect(routeLabels(["cf-runner"], cfg).ok).toBe(false);
		expect(routeLabels([], cfg).ok).toBe(false);
		expect(routeLabels(undefined, cfg).ok).toBe(false);
	});

	it("refuses a label no minted runner carries (it could never take the job)", () => {
		const v = routeLabels(["self-hosted", "cf-runner", "gpu"], cfg);
		expect(v).toEqual({ ok: false, reason: expect.stringContaining("gpu") });
	});

	it("refuses two class labels as ambiguous", () => {
		expect(routeLabels(["self-hosted", "cf-runner", "cf-runner-heavy"], cfg).ok).toBe(false);
	});

	it("refuses self-hosted alone (that belongs to some other runner fleet)", () => {
		expect(routeLabels(["self-hosted", "linux"], cfg).ok).toBe(false);
	});
});

// source: GitHub docs, "Security hardening for GitHub Actions" (self-hosted runners should almost never be used for public repositories)
describe("checkAllowlist", () => {
	const lists = { allowedRepos: ["acme/app", "tools-org/*"], allowPublicRepos: ["acme/oss"] };

	it("allows an exact private repo and an org wildcard", () => {
		expect(checkAllowlist({ fullName: "acme/app", private: true }, lists)).toEqual({ ok: true });
		expect(checkAllowlist({ fullName: "Tools-Org/Anything", visibility: "internal" }, lists)).toEqual({ ok: true });
	});

	it("denies repos not listed", () => {
		expect(checkAllowlist({ fullName: "acme/other", private: true }, lists).ok).toBe(false);
		expect(checkAllowlist({ fullName: "evil/app", private: true }, lists).ok).toBe(false);
	});

	it("denies an empty allowlist (no allow-all mode)", () => {
		expect(checkAllowlist({ fullName: "acme/app", private: true }, { allowedRepos: [], allowPublicRepos: [] }).ok).toBe(false);
	});

	it("denies public repos by default, even under a wildcard", () => {
		const v = checkAllowlist({ fullName: "tools-org/site", private: false, visibility: "public" }, lists);
		expect(v.ok).toBe(false);
		expect(!v.ok && v.reason).toContain("public");
	});

	it("allows a public repo only when listed in ALLOW_PUBLIC_REPOS and ALLOWED_REPOS", () => {
		const both = { allowedRepos: ["acme/oss"], allowPublicRepos: ["acme/oss"] };
		expect(checkAllowlist({ fullName: "acme/oss", visibility: "public" }, both)).toEqual({ ok: true });
		const onlyPublicList = { allowedRepos: ["acme/app"], allowPublicRepos: ["acme/oss"] };
		expect(checkAllowlist({ fullName: "acme/oss", visibility: "public" }, onlyPublicList).ok).toBe(false);
	});

	it("treats missing visibility facts as public (fail closed)", () => {
		expect(checkAllowlist({ fullName: "acme/app" }, lists).ok).toBe(false);
	});

	it("rejects malformed names", () => {
		expect(checkAllowlist({ fullName: "acme", private: true }, lists).ok).toBe(false);
		expect(checkAllowlist({ fullName: "acme/", private: true }, lists).ok).toBe(false);
	});
});

// source: docs/LESSONS.md "runner name per spawn" (generate-jitconfig 409s a reused name)
describe("runner names", () => {
	it("are unique per spawn of the same job and parse back to the job", () => {
		const a = runnerNameFor("ccr", 42, 1_700_000_000_000, 0);
		const b = runnerNameFor("ccr", 42, 1_700_000_000_000, 1);
		expect(a).not.toBe(b);
		expect(spawnIdFromRunnerName("ccr", a)).toBe(42);
		expect(spawnIdFromRunnerName("ccr", b)).toBe(42);
		expect(a.length).toBeLessThanOrEqual(64);
	});

	it("never claims someone else's runner", () => {
		expect(spawnIdFromRunnerName("ccr", "my-build-box")).toBeNull();
		expect(spawnIdFromRunnerName("ccr", "ccrx-42-sabc")).toBeNull();
		expect(spawnIdFromRunnerName("ccr", null)).toBeNull();
	});
});
