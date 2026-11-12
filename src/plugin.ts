import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { NotionError } from "./shared/notion.ts";
import { parseNotionId } from "./shared/properties.ts";
import { Budget } from "./plugin/budget.ts";
import { type RunResult, runOnce } from "./plugin/job.ts";
import { notionClient, readNextPage } from "./plugin/source.ts";

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
	| { status: "notion_error"; httpStatus: number; code: string | undefined; message: string }
	| (RunResult & { calls: number });

export type PreviewResult =
	| { status: "not_configured"; missing: string[] }
	| { status: "notion_error"; httpStatus: number; code: string | undefined; message: string }
	| { status: "schema_invalid"; problems: string[] }
	| { status: "nothing_to_send" }
	| {
			status: "ready";
			page: { id: string; title: string; slug: string; notionUrl: string };
			blocks: number;
			images: number;
			skipped: { type: string; reason: string }[];
			waiting: number;
	  };

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
		publish: text("mode") !== "draft",
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

function missingSettings(settings: Awaited<ReturnType<typeof readSettings>>): string[] {
	return [...(settings.notionToken ? [] : ["notionToken"]), ...(settings.databaseId ? [] : ["databaseId"])];
}

/** One run: carries the current page one or more steps further. */
export async function sync(ctx: PluginContext, budget = new Budget()): Promise<SyncResult> {
	budget.take();
	const settings = await readSettings(ctx);
	const missing = missingSettings(settings);
	if (missing.length > 0 || !settings.databaseId) return { status: "not_configured", missing };

	try {
		const result = await runOnce(
			ctx,
			{ notionToken: settings.notionToken, databaseId: settings.databaseId, publish: settings.publish },
			budget,
		);
		if (result.status === "sent") {
			ctx.log.info("Sent a Notion page", { title: result.title, contentId: result.contentId, created: result.created });
		}
		return { ...result, calls: budget.used };
	} catch (error) {
		if (error instanceof NotionError) {
			ctx.log.warn("Notion refused a request", { status: error.status, code: error.code, message: error.message });
			return { status: "notion_error", httpStatus: error.status, code: error.code, message: error.message };
		}
		throw error;
	}
}

/** What the next run would send, without sending it. */
export async function preview(ctx: PluginContext): Promise<PreviewResult> {
	const settings = await readSettings(ctx);
	const missing = missingSettings(settings);
	if (missing.length > 0 || !settings.databaseId) return { status: "not_configured", missing };

	try {
		const next = await readNextPage(notionClient(ctx, settings.notionToken), settings.databaseId);
		if (next.status !== "ready") return next;
		const { article, body } = next;
		return {
			status: "ready",
			page: { id: article.pageId, title: article.title, slug: article.slug, notionUrl: article.notionUrl },
			blocks: body.blocks.length,
			images: body.images.length,
			skipped: body.skipped,
			waiting: next.waiting,
		};
	} catch (error) {
		if (error instanceof NotionError) {
			return { status: "notion_error", httpStatus: error.status, code: error.code, message: error.message };
		}
		throw error;
	}
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
		// Admin-only: show which page the next run would send, without sending it.
		preview: {
			methods: ["POST"],
			handler: async (_routeCtx, ctx) => preview(ctx),
		},
	},
};

export default plugin;
