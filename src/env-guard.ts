/**
 * Cloudflare Containers reject any single environment variable larger than
 * 16,000 bytes, and the refusal surfaces as a failed start, not as a clear
 * message about the variable. Check before starting, name the offender, and
 * refuse anything that is not on the allowlist of variables the image expects.
 */

export const CONTAINER_ENV_MAX_BYTES = 16_000;

/**
 * The ONLY variables a runner container may receive. The JIT config is the one
 * credential, scoped to a single job; no GitHub App key, installation token or
 * webhook secret ever enters the container.
 */
export const ALLOWED_CONTAINER_ENV: ReadonlySet<string> = new Set([
	"RUNNER_JITCONFIG",
	"IDLE_GRACE_SECONDS",
]);

export class EnvGuardError extends Error {
	override name = "EnvGuardError";
}

export function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

/** Throws EnvGuardError naming the variable; returns the env unchanged when valid. */
export function assertContainerEnv(
	env: Record<string, string>,
): Record<string, string> {
	for (const [name, value] of Object.entries(env)) {
		if (!ALLOWED_CONTAINER_ENV.has(name)) {
			throw new EnvGuardError(
				`refusing to pass ${name} into a runner container: only ${[...ALLOWED_CONTAINER_ENV].join(", ")} are allowed`,
			);
		}
		if (typeof value !== "string") {
			throw new EnvGuardError(`container env ${name} must be a string`);
		}
		const size = byteLength(name) + byteLength(value);
		if (size > CONTAINER_ENV_MAX_BYTES) {
			throw new EnvGuardError(
				`container env ${name} is ${size} bytes; Cloudflare Containers cap a single variable at ${CONTAINER_ENV_MAX_BYTES}`,
			);
		}
	}
	return env;
}
