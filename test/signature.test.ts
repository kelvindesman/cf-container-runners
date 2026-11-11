// source: GitHub docs, "Validating webhook deliveries" (X-Hub-Signature-256 = HMAC-SHA256 hex, constant-time compare)
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacSha256Hex, timingSafeEqual, verifyWebhookSignature } from "../src/signature";

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyWebhookSignature", () => {
	const body = JSON.stringify({ action: "queued", workflow_job: { id: 1 } });

	it("accepts a correct signature", async () => {
		expect(await verifyWebhookSignature("s3cret", body, sign("s3cret", body))).toBe(true);
	});

	// source: GitHub docs test vector ("It's a Secret to Everybody" / "Hello, World!")
	it("matches GitHub's published test vector", async () => {
		expect(await hmacSha256Hex("It's a Secret to Everybody", "Hello, World!")).toBe(
			"757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
		);
	});

	it("rejects a signature made with another secret", async () => {
		expect(await verifyWebhookSignature("s3cret", body, sign("other", body))).toBe(false);
	});

	it("rejects a tampered body", async () => {
		expect(await verifyWebhookSignature("s3cret", `${body} `, sign("s3cret", body))).toBe(false);
	});

	it("rejects missing header, missing prefix, sha1 header and empty secret", async () => {
		const good = sign("s3cret", body);
		expect(await verifyWebhookSignature("s3cret", body, null)).toBe(false);
		expect(await verifyWebhookSignature("s3cret", body, good.slice("sha256=".length))).toBe(false);
		expect(await verifyWebhookSignature("s3cret", body, `sha1=${good.slice(7)}`)).toBe(false);
		expect(await verifyWebhookSignature("", body, sign("", body))).toBe(false);
		expect(await verifyWebhookSignature(undefined, body, good)).toBe(false);
	});

	it("rejects a truncated digest", async () => {
		expect(await verifyWebhookSignature("s3cret", body, sign("s3cret", body).slice(0, -2))).toBe(false);
	});
});

describe("timingSafeEqual", () => {
	it("compares by value, length first", () => {
		expect(timingSafeEqual("abc", "abc")).toBe(true);
		expect(timingSafeEqual("abc", "abd")).toBe(false);
		expect(timingSafeEqual("abc", "abcd")).toBe(false);
		expect(timingSafeEqual("", "")).toBe(true);
	});
});
