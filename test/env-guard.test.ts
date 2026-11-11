// source: docs/LESSONS.md "16,000-byte env var" (Cloudflare Containers reject a single env var over 16,000 bytes)
import { describe, expect, it } from "vitest";
import { assertContainerEnv, CONTAINER_ENV_MAX_BYTES, EnvGuardError } from "../src/env-guard";

describe("assertContainerEnv", () => {
	it("passes a realistic JIT config", () => {
		const env = { RUNNER_JITCONFIG: "x".repeat(3000), IDLE_GRACE_SECONDS: "90" };
		expect(assertContainerEnv(env)).toBe(env);
	});

	it("rejects a variable over the limit and names it", () => {
		const env = { RUNNER_JITCONFIG: "x".repeat(CONTAINER_ENV_MAX_BYTES) };
		expect(() => assertContainerEnv(env)).toThrow(EnvGuardError);
		expect(() => assertContainerEnv(env)).toThrow(/RUNNER_JITCONFIG is \d+ bytes/);
	});

	it("counts bytes, not UTF-16 code units", () => {
		// 5,400 three-byte characters = 16,200 bytes, but only 5,400 .length
		expect(() => assertContainerEnv({ RUNNER_JITCONFIG: "€".repeat(5400) })).toThrow(EnvGuardError);
	});

	// source: SECURITY.md "no secrets in container env beyond the JIT config"
	it("refuses any variable that is not on the allowlist", () => {
		expect(() => assertContainerEnv({ RUNNER_JITCONFIG: "x", GITHUB_APP_PRIVATE_KEY: "k" })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
		expect(() => assertContainerEnv({ RUNNER_JITCONFIG: "x", GITHUB_TOKEN: "t" })).toThrow(EnvGuardError);
	});
});
