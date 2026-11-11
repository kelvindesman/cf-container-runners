/**
 * GitHub webhook authentication: HMAC-SHA256 over the raw body, compared in
 * constant time. The Worker is publicly routable (GitHub must reach it), and a
 * forged `workflow_job` would make us mint runner registrations and start
 * billed containers, so the body is verified BEFORE it is parsed.
 */

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Constant-time string compare for secret-derived values. Never use `===` on
 * these: an early-exit compare leaks how many leading characters matched to
 * anyone who can time the response.
 *
 * The length check is not a timing leak worth closing: the expected length of a
 * hex SHA-256 digest (64) is public.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const ab = encoder.encode(a);
	const bb = encoder.encode(b);
	if (ab.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ab.length; i++) {
		diff |= (ab[i] as number) ^ (bb[i] as number);
	}
	return diff === 0;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

/**
 * Verify `X-Hub-Signature-256: sha256=<hex>` against `body`.
 * Returns false (never throws) on a missing secret, header or prefix.
 */
export async function verifyWebhookSignature(
	secret: string | undefined,
	body: string,
	header: string | null | undefined,
): Promise<boolean> {
	if (!secret || !header) return false;
	const prefix = "sha256=";
	if (!header.startsWith(prefix)) return false;
	const given = header.slice(prefix.length).trim().toLowerCase();
	const expected = await hmacSha256Hex(secret, body);
	return timingSafeEqual(expected, given);
}
