import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

// Two projects: the GitHub Actions tool runs in Node, the plugin in the
// workerd-backed host that EmDash's plugin tests provide.
export default defineConfig({
	test: {
		projects: [
			{ test: { name: "action", include: ["tests/action/**/*.test.ts"], environment: "node" } },
			{ plugins: [emdashPluginTest()], test: { name: "plugin", include: ["tests/plugin/**/*.test.ts"] } },
		],
	},
});
