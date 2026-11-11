// source: wrangler.jsonc var contract documented in README.md "Configuration"
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config";

describe("parseConfig", () => {
	it("applies safe defaults", () => {
		const c = parseConfig({});
		expect(c.allowedRepos).toEqual([]);
		expect(c.maxConcurrent).toBe(4);
		expect(c.maxJobMinutes).toBe(60);
		expect(c.softDailyBudgetMinutes).toBe(0);
		expect(c.runnerScope).toBe("repo");
		expect(c.labels.get("cf-runner")).toBe("light");
		expect(c.unwedgeCancel).toBe(false);
	});

	it("normalises lists to lower case", () => {
		const c = parseConfig({ ALLOWED_REPOS: " Acme/App , other/* ", RUNNER_LABELS: "Big=heavy" });
		expect(c.allowedRepos).toEqual(["acme/app", "other/*"]);
		expect([...c.labels]).toEqual([["big", "heavy"]]);
	});

	it.each([
		[{ ALLOWED_REPOS: "acme" }, "ALLOWED_REPOS"],
		[{ ALLOW_PUBLIC_REPOS: "acme/*" }, "no wildcards"],
		[{ RUNNER_LABELS: "x=huge" }, "class"],
		[{ RUNNER_LABELS: "self-hosted=light" }, "implicit"],
		[{ RUNNER_LABELS: "a=light,a=heavy" }, "twice"],
		[{ MAX_CONCURRENT: "0" }, "MAX_CONCURRENT"],
		[{ MAX_JOB_MINUTES: "1.5" }, "MAX_JOB_MINUTES"],
		[{ RUNNER_SCOPE: "enterprise" }, "RUNNER_SCOPE"],
		[{ RUNNER_NAME_PREFIX: "9bad" }, "RUNNER_NAME_PREFIX"],
	])("rejects %j", (vars, msg) => {
		expect(() => parseConfig(vars)).toThrow(ConfigError);
		expect(() => parseConfig(vars)).toThrow(msg);
	});
});
