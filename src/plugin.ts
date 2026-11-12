import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { parseNotionId } from "./shared/properties.ts";

const CRON_TASK = "sync";
export const DEFAULT_SCHEDULE = "*/5 * * * *";
/**
 * Time limit for one scheduled run when the plugin runs in-process. The
 * host's default is 5 seconds, which a deployed run can exceed when the
 * database is far away. The sandbox has its own 30-second limit.
 */
const CRON_TIMEOUT_MS = 120_000;

export type SyncResult =
	| { status: "not_configured"; missing: string[] }
	| { status: "idle" };

/** All settings in one call, to save subrequests. */
async function readSettings(ctx: PluginContext) {
	const values = new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
	const text = (key: string) => {
		const value = values.get(key);
		return typeof value === "string" ? value.trim() : "";
	};
	return {
		notionToken: text("notionToken"),
		databaseId: parseNotionId(text("databaseId")),
		schedule: text("schedule") || DEFAULT_SCHEDULE,
	};
}

/**
 * Keeps the cron task on the interval from the settings. Scheduling the
 * same task name again replaces its schedule.
 */
async function scheduleSync(ctx: PluginContext, schedule?: string) {
	const wanted = schedule ?? (await readSettings(ctx)).schedule;
	const current = (await ctx.cron?.list())?.find((task) => task.name === CRON_TASK);
	if (current?.schedule === wanted) return;
	await ctx.cron?.schedule(CRON_TASK, { schedule: wanted });
}

export async function sync(ctx: PluginContext): Promise<SyncResult> {
	const settings = await readSettings(ctx);
	const missing = [
		...(settings.notionToken ? [] : ["notionToken"]),
		...(settings.databaseId ? [] : ["databaseId"]),
	];
	if (missing.length > 0) return { status: "not_configured", missing };

	// Reading Notion and sending pages comes in steps 4 to 6 of the plan.
	return { status: "idle" };
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => scheduleSync(ctx),
		"plugin:activate": async (_event, ctx) => scheduleSync(ctx),
		cron: {
			timeout: CRON_TIMEOUT_MS,
			handler: async (event, ctx) => {
				if (event.name === CRON_TASK) await sync(ctx);
			},
		},
	},
	routes: {
		// Admin-only (the default `plugins:manage` permission): run a sync now.
		sync: {
			methods: ["POST"],
			handler: async (_routeCtx, ctx) => sync(ctx),
		},
	},
};

export default plugin;
