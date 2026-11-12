import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { type LastRun, type PageState, renderPage, textFor } from "./plugin/admin.ts";
import { Budget, RUN_BUDGET } from "./plugin/budget.ts";
import { type CheckResult, checkNotion, forgetNotion, type Job, type PageRecord, type RunResult, runOnce } from "./plugin/job.ts";
import { NotionError } from "./shared/notion.ts";
import { parseNotionId } from "./shared/properties.ts";

const CRON_TASK = "sync";
export const DEFAULT_SCHEDULE = "*/5 * * * *";
/**
 * Time limit for one scheduled run when the plugin runs in-process. The
 * host's default is 5 seconds, which a deployed run can exceed when the
 * database is far away. The sandbox has its own 30-second limit.
 */
const CRON_TIMEOUT_MS = 120_000;
const LAST_RUN_KEY = "state:last";
/**
 * Calls left for the admin page after "Send now" or "Check": saving the
 * result and drawing the page again.
 */
const PAGE_CALLS = 6;

type NotionErrorResult = { status: "notion_error"; httpStatus: number; code: string | undefined; message: string };

export type SyncResult =
	| { status: "not_configured"; missing: string[] }
	| NotionErrorResult
	| (RunResult & { calls: number });

export type CheckRouteResult = { status: "not_configured"; missing: string[] } | NotionErrorResult | CheckResult;

/** All settings in one call, to save subrequests. */
async function readSettings(ctx: PluginContext) {
	const values = new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
	const text = (key: string) => {
		const value = values.get(key);
		return typeof value === "string" ? value.trim() : "";
	};
	return {
		notionToken: text("notionToken"),
		databaseInput: text("databaseId"),
		databaseId: parseNotionId(text("databaseId")),
		schedule: text("schedule") || DEFAULT_SCHEDULE,
		publish: text("mode") !== "draft",
	};
}

type SiteSettings = Awaited<ReturnType<typeof readSettings>>;

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

function missingSettings(settings: SiteSettings): string[] {
	return [...(settings.notionToken ? [] : ["notionToken"]), ...(settings.databaseId ? [] : ["databaseId"])];
}

function notionError(error: unknown): NotionErrorResult | null {
	if (!(error instanceof NotionError)) return null;
	return { status: "notion_error", httpStatus: error.status, code: error.code, message: error.message };
}

async function remember(ctx: PluginContext, result: { status: string }) {
	await ctx.kv.set(LAST_RUN_KEY, { at: new Date().toISOString(), result: result as LastRun["result"] } satisfies LastRun);
}

/** One run: carries the current page one or more steps further. */
export async function sync(ctx: PluginContext, budget = new Budget()): Promise<SyncResult> {
	// One call is kept for remembering the result.
	const work = new Budget(budget.limit - budget.used - 1);
	work.take();
	const settings = await readSettings(ctx);
	const missing = missingSettings(settings);
	let result: SyncResult;
	if (missing.length > 0 || !settings.databaseId) {
		result = { status: "not_configured", missing };
	} else {
		try {
			const run = await runOnce(
				ctx,
				{ notionToken: settings.notionToken, databaseId: settings.databaseId, publish: settings.publish },
				work,
			);
			if (run.status === "sent") {
				ctx.log.info("Sent a Notion page", { title: run.title, contentId: run.contentId, created: run.created });
			}
			result = { ...run, calls: work.used + 1 };
		} catch (error) {
			const refused = notionError(error);
			if (!refused) throw error;
			ctx.log.warn("Notion refused a request", { status: refused.httpStatus, code: refused.code, message: refused.message });
			result = refused;
		}
	}
	budget.used += work.used;
	budget.take(1, 0);
	await remember(ctx, result);
	return result;
}

/** Checks the token, the database and its properties, and counts the pages to send. */
export async function check(ctx: PluginContext, budget = new Budget()): Promise<CheckRouteResult> {
	const work = new Budget(budget.limit - budget.used - 1);
	work.take();
	const settings = await readSettings(ctx);
	const missing = missingSettings(settings);
	let result: CheckRouteResult;
	if (missing.length > 0 || !settings.databaseId) {
		result = { status: "not_configured", missing };
	} else {
		try {
			result = await checkNotion(
				ctx,
				{ notionToken: settings.notionToken, databaseId: settings.databaseId, publish: settings.publish },
				work,
			);
		} catch (error) {
			const refused = notionError(error);
			if (!refused) throw error;
			result = refused;
		}
	}
	budget.used += work.used;
	budget.take(1, 0);
	await remember(ctx, result);
	return result;
}

/* ---------- Admin page ---------- */

interface Interaction {
	type: "page_load" | "block_action" | "form_submit";
	action_id?: string;
	values?: Record<string, unknown>;
}

function parseInteraction(input: unknown): Interaction | null {
	if (!input || typeof input !== "object") return null;
	const value = input as Record<string, unknown>;
	if (value.type !== "page_load" && value.type !== "block_action" && value.type !== "form_submit") return null;
	return {
		type: value.type,
		action_id: typeof value.action_id === "string" ? value.action_id : undefined,
		values: value.values && typeof value.values === "object" ? (value.values as Record<string, unknown>) : undefined,
	};
}

/** Everything the page shows, in four calls. */
async function pageState(ctx: PluginContext): Promise<PageState> {
	const settings = await readSettings(ctx);
	const last = await ctx.kv.get<LastRun>(LAST_RUN_KEY);
	const job = await ctx.kv.get<Job>("state:job");
	const pages = await ctx.storage.pages!.query({ limit: 50 });
	return {
		settings: {
			hasToken: !!settings.notionToken,
			databaseId: settings.databaseInput,
			publish: settings.publish,
			schedule: settings.schedule,
		},
		last,
		job: job ? { title: job.article.title, phase: job.phase } : null,
		failed: pages.items
			.map((item) => ({ id: item.id, record: item.data as PageRecord }))
			.filter(({ record }) => !!record.failedEdit),
	};
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>, locale: string | undefined): Promise<BlockResponse["toast"]> {
	const t = textFor(locale);
	const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string).trim() : "");
	const database = text("databaseId");
	if (database && !parseNotionId(database)) return { type: "error", message: t.badDatabase };
	const schedule = text("schedule") || DEFAULT_SCHEDULE;
	try {
		await scheduleSync(ctx, schedule);
	} catch {
		return { type: "error", message: t.badSchedule };
	}

	const before = await readSettings(ctx);
	const token = text("notionToken");
	// An empty secret field means "unchanged": the admin never sends the saved value back.
	if (token) {
		try {
			await ctx.settings.set("notionToken", token);
		} catch (error) {
			if (String((error as Error).message).includes("EMDASH_ENCRYPTION_KEY")) return { type: "error", message: t.noKey };
			throw error;
		}
	}
	await ctx.settings.set("databaseId", database);
	await ctx.settings.set("mode", text("mode") === "draft" ? "draft" : "publish");
	await ctx.settings.set("schedule", schedule);
	if ((token && token !== before.notionToken) || parseNotionId(database) !== before.databaseId) {
		// Another integration or database: the cached IDs no longer apply.
		await forgetNotion(ctx);
	}
	return { type: "success", message: t.saved };
}

async function adminRoute(input: unknown, locale: string | undefined, ctx: PluginContext): Promise<BlockResponse> {
	const interaction = parseInteraction(input);
	if (!interaction) return { blocks: [] };
	const t = textFor(locale);
	let toast: BlockResponse["toast"];

	if (interaction.type === "form_submit" && interaction.action_id === "save") {
		toast = await saveSettings(ctx, interaction.values ?? {}, locale);
	} else if (interaction.type === "block_action") {
		switch (interaction.action_id) {
			case "check": {
				const result = await check(ctx, new Budget(RUN_BUDGET - PAGE_CALLS));
				if (result.status === "ok") toast = { type: "success", message: t.checkOk(result.toSend, result.waitingForEdit) };
				break;
			}
			case "run_now": {
				const result = await sync(ctx, new Budget(RUN_BUDGET - PAGE_CALLS));
				if (result.status === "sent") toast = { type: "success", message: t.sent(result.title) };
				break;
			}
			case "clear_token":
				await ctx.settings.delete("notionToken");
				await forgetNotion(ctx);
				toast = { type: "info", message: t.cleared };
				break;
		}
	}

	return renderPage(await pageState(ctx), locale, toast);
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
		// The admin page (Block Kit). Admin-only, like every private route.
		admin: {
			handler: async (routeCtx, ctx) => adminRoute(routeCtx.input, routeCtx.ui?.locale, ctx),
		},
		// Admin-only (the default `plugins:manage` permission): run once now.
		sync: {
			methods: ["POST"],
			handler: async (_routeCtx, ctx) => sync(ctx),
		},
		// Admin-only: check the token and the database without sending anything.
		check: {
			methods: ["POST"],
			handler: async (_routeCtx, ctx) => check(ctx),
		},
	},
};

export default plugin;
