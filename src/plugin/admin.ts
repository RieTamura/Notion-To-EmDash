/**
 * The plugin's admin page: what happened on the last run, the settings
 * form, and buttons to check the connection or run now. Block Kit only; no
 * plugin code runs in the browser. Text is Japanese for a Japanese admin and
 * English otherwise.
 */

import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import type { PageRecord } from "./job.ts";

type Lang = "ja" | "en";

const TEXT = {
	ja: {
		title: "Notion To EmDash",
		intro: "Notion のデータベースで「公開」に印を付けたページを、記事として送ります。",
		notConfigured: "Notion のトークンとデータベースを入れて保存してください。",
		lastRun: "最後の実行",
		never: "まだ動いていません",
		result: "結果",
		working: "送っている途中",
		job: "送っている途中のページ",
		settings: "設定",
		token: "Notion のインテグレーションのトークン",
		tokenHelp: "notion.so/profile/integrations の「内部インテグレーションシークレット」。インテグレーションをデータベースに接続してください。",
		database: "Notion のデータベース（リンクか ID）",
		mode: "送り方",
		publish: "公開する",
		draft: "下書きにする",
		schedule: "見に行く間隔（cron の書き方）",
		save: "保存",
		saved: "保存しました",
		check: "接続を確かめる",
		runNow: "今すぐ送る",
		clearToken: "トークンを消す",
		clearTitle: "トークンを消しますか？",
		clearText: "消すと、新しいトークンを入れるまで送りません。",
		clearConfirm: "消す",
		cancel: "やめる",
		cleared: "トークンを消しました",
		badDatabase: "データベースのリンクか ID が読めません。",
		badSchedule: "間隔の書き方が違います。例：*/5 * * * *（5 分ごと）",
		noKey: "サイトに EMDASH_ENCRYPTION_KEY がないため、トークンを保存できません。サイトの管理者に設定を頼んでください（npx emdash secrets generate で作れます）。",
		failedPages: "送れなかったページ（Notion で直すと、もう一度送ります）",
		page: "ページ",
		reason: "理由",
		sent: (title: string) => `「${title}」を送りました`,
		checkOk: (toSend: number, waiting: number) =>
			`接続できました。次に送るページは ${toSend} 件です。` + (waiting ? `直されるのを待っているページが ${waiting} 件あります。` : ""),
		slugNote: "記事の URL（スラッグ）はタイトルから作られます。Notion の「スラッグ」は使いません（EmDash のプラグインからは指定できないため）。",
	},
	en: {
		title: "Notion To EmDash",
		intro: "Sends the pages ticked as published in a Notion database to this site as posts.",
		notConfigured: "Enter the Notion token and the database, then save.",
		lastRun: "Last run",
		never: "Not run yet",
		result: "Result",
		working: "Sending",
		job: "Page being sent",
		settings: "Settings",
		token: "Notion integration token",
		tokenHelp: "The internal integration secret from notion.so/profile/integrations. Connect the integration to the database.",
		database: "Notion database (link or ID)",
		mode: "Send pages as",
		publish: "Published posts",
		draft: "Drafts",
		schedule: "How often to check (cron expression)",
		save: "Save",
		saved: "Saved",
		check: "Check the connection",
		runNow: "Send now",
		clearToken: "Remove the token",
		clearTitle: "Remove the token?",
		clearText: "Nothing is sent until a new token is entered.",
		clearConfirm: "Remove",
		cancel: "Cancel",
		cleared: "The token was removed",
		badDatabase: "The database link or ID could not be read.",
		badSchedule: "The interval is not a valid cron expression. Example: */5 * * * * (every five minutes)",
		noKey: "The token cannot be saved because the site has no EMDASH_ENCRYPTION_KEY. Ask the site's developer to set one (npx emdash secrets generate makes one).",
		failedPages: "Pages that could not be sent (they are sent again once edited in Notion)",
		page: "Page",
		reason: "Reason",
		sent: (title: string) => `Sent "${title}"`,
		checkOk: (toSend: number, waiting: number) =>
			`Connected. ${toSend} page(s) to send next.` + (waiting ? ` ${waiting} page(s) wait for an edit.` : ""),
		slugNote: "Post URLs (slugs) are made from the title. The Notion slug property is not used, because EmDash plugins cannot set a slug.",
	},
} as const;

export type Text = (typeof TEXT)[Lang];

export function textFor(locale: string | undefined): Text {
	return locale?.toLowerCase().startsWith("ja") ? TEXT.ja : TEXT.en;
}

/** What the admin page shows about the last run. Stored in KV by each run. */
export interface LastRun {
	at: string;
	result: { status: string } & Record<string, unknown>;
}

export interface PageState {
	settings: { hasToken: boolean; databaseId: string; publish: boolean; schedule: string };
	last: LastRun | null;
	job: { title: string; phase: string } | null;
	failed: Array<{ id: string; record: PageRecord }>;
}

/** Turns a run or check result into a banner, or null when there is nothing to warn about. */
export function resultBanner(t: Text, lang: Lang, result: LastRun["result"] | null): BlockResponse["blocks"][number] | null {
	if (!result) return null;
	const ja = lang === "ja";
	switch (result.status) {
		case "not_configured":
			return { type: "banner", variant: "alert", description: t.notConfigured };
		case "notion_error":
			return { type: "banner", variant: "error", title: ja ? "Notion に断られました" : "Notion refused the request", description: notionErrorText(lang, result) };
		case "schema_invalid":
			return {
				type: "banner",
				variant: "error",
				title: ja ? "データベースの準備ができていません" : "The database is not ready",
				description: (result.problems as string[]).join(" / "),
			};
		case "failed":
			return { type: "banner", variant: "alert", title: String(result.title), description: String(result.reason) };
		default:
			if (typeof result.note === "string") return { type: "banner", variant: "alert", description: result.note };
			return null;
	}
}

function notionErrorText(lang: Lang, result: Record<string, unknown>): string {
	const ja = lang === "ja";
	const status = Number(result.httpStatus);
	const code = String(result.code ?? "");
	if (status === 401 || code === "unauthorized") {
		return ja ? "トークンが違います。Notion のインテグレーションのページで確かめて、入れ直してください。" : "The token is wrong. Check it on the Notion integration page and enter it again.";
	}
	if (status === 404 || code === "object_not_found") {
		return ja
			? "データベースが見つかりません。リンクが合っているか、データベースの「接続」にインテグレーションを足したかを確かめてください。"
			: "The database was not found. Check the link, and that the integration is added under the database's Connections.";
	}
	if (status === 403 || code === "restricted_resource") {
		return ja
			? "インテグレーションに権限がありません。「コンテンツを読み取る」「コンテンツを更新」を有効にしてください。"
			: "The integration lacks permission. Turn on Read content and Update content for it.";
	}
	if (status === 429) return ja ? "Notion が混んでいます。次の回にもう一度試します。" : "Notion is busy. The next run tries again.";
	return String(result.message ?? "");
}

const PHASES = {
	ja: { read: "本文を読んでいます", images: "画像を上げています", terms: "カテゴリとタグ", save: "記事を保存します", mark: "Notion に印を付けます" },
	en: { read: "reading the page", images: "uploading images", terms: "categories and tags", save: "saving the post", mark: "marking the page in Notion" },
} as const;

export function phaseLabel(lang: Lang, phase: unknown): string {
	return (PHASES[lang] as Record<string, string>)[String(phase)] ?? String(phase);
}

/** One line about a run or check, for the "Result" field. */
export function summary(t: Text, lang: Lang, result: LastRun["result"]): string {
	const ja = lang === "ja";
	switch (result.status) {
		case "sent":
			return t.sent(String(result.title));
		case "working":
			return ja
				? `「${result.title}」を送っている途中（${phaseLabel(lang, result.phase)}）`
				: `Sending "${result.title}" (${phaseLabel(lang, result.phase)})`;
		case "nothing_to_send":
			return ja ? "送るページはありませんでした" : "Nothing to send";
		case "ok":
			return t.checkOk(Number(result.toSend), Number(result.waitingForEdit));
		case "not_configured":
			return ja ? "トークンかデータベースが保存されていません" : "The token or the database is not saved";
		case "notion_error":
			return ja ? "Notion に断られました" : "Notion refused the request";
		case "schema_invalid":
			return ja ? "データベースの項目が足りません" : "The database is missing properties";
		case "failed":
			return ja ? `「${result.title}」を送れませんでした` : `Could not send "${result.title}"`;
		default:
			return ja ? "不明な結果" : "Unknown result";
	}
}

export function renderPage(state: PageState, locale: string | undefined, toast?: BlockResponse["toast"]): BlockResponse {
	const t = textFor(locale);
	const lang: Lang = t === TEXT.ja ? "ja" : "en";
	const blocks: BlockResponse["blocks"] = [
		{ type: "header", text: t.title },
		{ type: "context", text: t.intro },
	];

	const configured = state.settings.hasToken && !!state.settings.databaseId;
	if (!configured) blocks.push({ type: "banner", variant: "alert", description: t.notConfigured });
	else {
		const banner = resultBanner(t, lang, state.last?.result ?? null);
		if (banner) blocks.push(banner);
	}

	const fields: Array<{ label: string; value: string }> = [
		{
			label: t.lastRun,
			value: state.last ? new Date(state.last.at).toLocaleString(lang === "ja" ? "ja-JP" : "en-US", { timeZone: lang === "ja" ? "Asia/Tokyo" : "UTC", timeZoneName: "short" }) : t.never,
		},
	];
	if (state.last) fields.push({ label: t.result, value: summary(t, lang, state.last.result) });
	if (state.job) fields.push({ label: t.job, value: `${state.job.title}（${phaseLabel(lang, state.job.phase)}）` });
	blocks.push({ type: "fields", fields });

	if (state.failed.length > 0) {
		blocks.push({ type: "header", text: t.failedPages });
		blocks.push({
			type: "table",
			columns: [
				{ key: "title", label: t.page },
				{ key: "reason", label: t.reason },
			],
			rows: state.failed.map(({ id, record }) => ({ title: record.title ?? id, reason: record.error ?? "" })),
			page_action_id: "failed_page",
		});
	}

	blocks.push({
		type: "actions",
		elements: [
			{ type: "button", action_id: "check", label: t.check, style: "primary" },
			{ type: "button", action_id: "run_now", label: t.runNow },
		],
	});

	blocks.push({ type: "divider" });
	blocks.push({ type: "header", text: t.settings });
	blocks.push({
		type: "form",
		block_id: "settings",
		fields: [
			{ type: "secret_input", action_id: "notionToken", label: t.token, has_value: state.settings.hasToken },
			{ type: "text_input", action_id: "databaseId", label: t.database, initial_value: state.settings.databaseId },
			{
				type: "select",
				action_id: "mode",
				label: t.mode,
				options: [
					{ value: "publish", label: t.publish },
					{ value: "draft", label: t.draft },
				],
				initial_value: state.settings.publish ? "publish" : "draft",
			},
			{ type: "text_input", action_id: "schedule", label: t.schedule, initial_value: state.settings.schedule },
		],
		submit: { action_id: "save", label: t.save },
	});
	blocks.push({ type: "context", text: t.tokenHelp });
	blocks.push({ type: "context", text: t.slugNote });
	if (state.settings.hasToken) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "clear_token",
					label: t.clearToken,
					style: "danger",
					confirm: { title: t.clearTitle, text: t.clearText, confirm: t.clearConfirm, deny: t.cancel, style: "danger" },
				},
			],
		});
	}

	return toast ? { blocks, toast } : { blocks };
}
