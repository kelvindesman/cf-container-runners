import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// Small machines welcome: two workers are plenty for this suite.
		maxWorkers: 2,
	},
});
