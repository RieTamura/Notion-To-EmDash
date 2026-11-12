import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const DATABASE_ID = "0123456789abcdef0123456789abcdef";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function setup(settings: Record<string, string> = {}) {
	host = await createPluginRuntimeTestHost();
	for (const [key, value] of Object.entries(settings)) {
		await host.fixtures.plugin.setting(key, value);
	}
	return host;
}

describe("scheduling", () => {
	it("checks Notion every five minutes by default", async () => {
		const h = await setup();
		await h.actions.plugin.activate();
		expect(await h.inspect.scheduledTasks()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/5 * * * *", enabled: 1 })]),
		);
	});

	it("uses the interval from the settings", async () => {
		const h = await setup({ schedule: "*/15 * * * *" });
		await h.actions.plugin.activate();
		expect(await h.inspect.scheduledTasks()).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/15 * * * *" })]),
		);
	});
});

describe("sync", () => {
	it("does nothing until the token and the database are set", async () => {
		const h = await setup();
		expect(await h.transport.invokeRoute("sync", {}, { method: "POST" })).toEqual({
			status: "not_configured",
			missing: ["notionToken", "databaseId"],
		});
	});

	it("accepts a database link as well as an ID", async () => {
		const h = await setup({
			notionToken: "secret",
			databaseId: `https://www.notion.so/space/Posts-${DATABASE_ID}?v=fedcba9876543210fedcba9876543210`,
		});
		expect(await h.transport.invokeRoute("sync", {}, { method: "POST" })).toEqual({ status: "idle" });
	});
});
