/**
 * Sends one Notion page to EmDash in small steps, so that each run stays
 * within the call budget. What is done so far is kept in KV and carried on
 * by the next run:
 *
 *   find   → choose the oldest page to send (only when there is no job)
 *   read   → read the page body, one block's children per call
 *   images → upload the images stored in Notion, one at a time
 *   terms  → find the category, find or create the tags
 *   save   → create or update the post, set its terms, publish it
 *   mark   → write the post's URL and the time back to the Notion page
 */

import type { PluginContext } from "emdash/plugin";

import { type ConvertResult, convertBlocks, type NotionBlock, type SkippedBlock } from "../shared/convert.ts";
import { imageFileName, shortUrl } from "../shared/image-name.ts";
import { type Article, checkSchema, NotionClient, NotionError, needsSending, parsePage } from "../shared/notion.ts";
import type { Block, ImageBlock } from "../shared/portable-text.ts";
import { DEFAULT_PROPERTY_NAMES, type PropertyNames } from "../shared/properties.ts";
import { type Budget, OutOfBudget } from "./budget.ts";

export const COLLECTION = "posts";
const JOB_KEY = "state:job";
const NOTION_KEY = "cache:notion";
/** How deep nested blocks are read, as in the GitHub Actions tool. */
const MAX_DEPTH = 8;
/** Notion's image links stop working after an hour. A job older than this reads the page again. */
const LINK_LIFETIME_MS = 50 * 60 * 1000;
/** Hosts where Notion keeps uploaded files. Images anywhere else stay as links. */
export const NOTION_FILE_HOSTS = ["prod-files-secure.s3.us-west-2.amazonaws.com"];
/** Posts looked through, 100 per call, to find one sent by the GitHub Actions tool. */
const FIND_PAGES = 3;

export interface Settings {
	notionToken: string;
	databaseId: string;
	publish: boolean;
	properties?: PropertyNames;
}

/** What the plugin remembers about a Notion page, keyed by page ID. */
export interface PageRecord {
	/** The page title when it was last sent or failed, for the admin page. */
	title?: string;
	contentId?: string;
	slug?: string;
	sentAt?: string;
	/** The page's last edit when sending it failed. It is tried again once the page is edited. */
	failedEdit?: string;
	error?: string;
}

interface NotionCache {
	databaseId: string;
	botUserId: string;
	dataSourceId: string;
}

export interface UploadedImage {
	kind: "uploaded";
	mediaId: string;
	url: string;
	storageKey: string;
	filename: string;
	mimeType: string;
	width?: number;
	height?: number;
	blurhash?: string;
	dominantColor?: string;
}

type ImageState = UploadedImage | { kind: "link" } | { kind: "dropped"; reason: string };

interface QueuedRead {
	/** The block whose children are read. For a synced copy, the original block. */
	fetchId: string;
	/** Where the children go in the tree. */
	key: string;
	depth: number;
}

export interface Job {
	pageId: string;
	article: Article;
	startedAt: string;
	/** The post this page was sent to before. Undefined until the post is made. */
	contentId?: string;
	created?: boolean;
	phase: "read" | "images" | "terms" | "save" | "mark";
	queue: QueuedRead[];
	children: Record<string, NotionBlock[]>;
	blocks?: Block[];
	skipped?: SkippedBlock[];
	images: Record<string, ImageState | null>;
	terms?: { category?: string[]; tag?: string[]; tagsDone?: boolean };
	/** What was saved, kept for writing the mark back to Notion. */
	sent?: SentResult;
}

export interface SentResult {
	status: "sent";
	pageId: string;
	title: string;
	contentId: string;
	slug: string | null;
	/** The post's URL, as written back to Notion. */
	url: string | null;
	created: boolean;
	published: boolean;
	images: { uploaded: number; links: number; dropped: string[] };
	skipped: SkippedBlock[];
	/**
	 * Whether the URL and the time were written back to Notion. When the page
	 * was edited while it was being sent, the mark is left off so the next
	 * run sends the edit too.
	 */
	marked: boolean;
	note?: string;
}

export type RunResult =
	| { status: "schema_invalid"; problems: string[] }
	| { status: "nothing_to_send" }
	| { status: "working"; pageId: string; title: string; phase: Job["phase"] }
	| { status: "failed"; pageId: string; title: string; reason: string }
	| SentResult;

/** A page that cannot be sent until someone edits it in Notion. */
class PageFailure extends Error {
	override name = "PageFailure";
}

/* ---------- One run ---------- */

export async function runOnce(ctx: PluginContext, settings: Settings, budget: Budget, now = new Date()): Promise<RunResult> {
	const names = settings.properties ?? DEFAULT_PROPERTY_NAMES;
	const notion = new NotionClient({
		token: settings.notionToken,
		fetch: (url, init) => {
			budget.take();
			return ctx.http!.fetch(url, init);
		},
	});

	budget.take();
	let job = await ctx.kv.get<Job>(JOB_KEY);
	let changed = false;
	try {
		if (job && (job.phase === "read" || job.phase === "images") && now.getTime() - Date.parse(job.startedAt) > LINK_LIFETIME_MS) {
			// The image links read with the page have expired: start the page again.
			job = null;
			changed = true;
		}
		if (!job) {
			const found = await findNextPage(ctx, notion, settings, names, budget, now);
			if (found.status !== "job") return found.result;
			job = found.job;
			changed = true;
		}

		const current = job;
		while (true) {
			const progress = await step(ctx, notion, current, settings, budget, now);
			if (progress === "waiting") return working(current);
			changed = true;
			if (typeof progress === "object") {
				job = null;
				return progress;
			}
		}
	} catch (error) {
		if (error instanceof OutOfBudget) return job ? working(job) : { status: "nothing_to_send" };
		if (error instanceof PageFailure && job) {
			const failed = job;
			try {
				const result = await failPage(ctx, failed, error.message, budget);
				job = null;
				changed = true;
				return result;
			} catch (inner) {
				// Not enough calls left to record the failure: the next run meets it again.
				if (inner instanceof OutOfBudget) return working(failed);
				throw inner;
			}
		}
		throw error;
	} finally {
		if (changed) {
			budget.take(1, 0);
			if (job) await ctx.kv.set(JOB_KEY, job);
			else await ctx.kv.delete(JOB_KEY);
		}
	}
}

function working(job: Job): RunResult {
	return { status: "working", pageId: job.pageId, title: job.article.title, phase: job.phase };
}

async function failPage(ctx: PluginContext, job: Job, reason: string, budget: Budget): Promise<RunResult> {
	ctx.log.warn("Could not send a Notion page", { pageId: job.pageId, title: job.article.title, reason });
	budget.take(2, 1);
	const pages = ctx.storage.pages!;
	const record = ((await pages.get(job.pageId)) ?? {}) as PageRecord;
	await pages.put(job.pageId, {
		...record,
		title: job.article.title,
		failedEdit: job.article.lastEditedTime,
		error: reason,
	} satisfies PageRecord);
	return { status: "failed", pageId: job.pageId, title: job.article.title, reason };
}

/** One unit of work. Returns "waiting" when the next unit does not fit in this run. */
async function step(
	ctx: PluginContext,
	notion: NotionClient,
	job: Job,
	settings: Settings,
	budget: Budget,
	now: Date,
): Promise<"done" | "waiting" | RunResult> {
	switch (job.phase) {
		case "read":
			return readStep(notion, job);
		case "images":
			return imageStep(ctx, job, budget);
		case "terms":
			return termsStep(ctx, job, budget);
		case "save":
			return saveStep(ctx, job, settings, budget, now);
		case "mark":
			return markStep(ctx, notion, job, settings, budget, now);
	}
}

/* ---------- check ---------- */

export type CheckResult =
	| { status: "ok"; toSend: number; waitingForEdit: number }
	| { status: "schema_invalid"; problems: string[] };

/**
 * Reads the database afresh (forgetting the cached IDs) and counts the pages
 * the next runs would send. Changes nothing but the cache.
 */
export async function checkNotion(ctx: PluginContext, settings: Settings, budget: Budget): Promise<CheckResult> {
	const names = settings.properties ?? DEFAULT_PROPERTY_NAMES;
	const notion = new NotionClient({
		token: settings.notionToken,
		fetch: (url, init) => {
			budget.take();
			return ctx.http!.fetch(url, init);
		},
	});
	budget.take();
	await ctx.kv.delete(NOTION_KEY);
	const ids = await notionIds(ctx, notion, settings, names, budget);
	if ("problems" in ids) return { status: "schema_invalid", problems: ids.problems };
	const pages = await notion.queryPublishedPages(ids.dataSourceId, names.publish);
	const candidates = pages
		.filter((page) => !page.in_trash)
		.map((page) => parsePage(page, names))
		.filter((article) => needsSending(article, ids.botUserId));
	if (candidates.length === 0) return { status: "ok", toSend: 0, waitingForEdit: 0 };
	budget.take();
	const records = (await ctx.storage.pages!.getMany(candidates.map((article) => article.pageId))) as Map<string, PageRecord>;
	const waiting = candidates.filter((article) => records.get(article.pageId)?.failedEdit === article.lastEditedTime).length;
	return { status: "ok", toSend: candidates.length - waiting, waitingForEdit: waiting };
}

/** Forgets the IDs read from Notion, for when the token or the database changes. */
export async function forgetNotion(ctx: PluginContext): Promise<void> {
	await ctx.kv.delete(NOTION_KEY);
}

/* ---------- find ---------- */

async function notionIds(
	ctx: PluginContext,
	notion: NotionClient,
	settings: Settings,
	names: PropertyNames,
	budget: Budget,
): Promise<NotionCache | { problems: string[] }> {
	budget.take();
	const cached = await ctx.kv.get<NotionCache>(NOTION_KEY);
	if (cached?.databaseId === settings.databaseId) return cached;

	const botUserId = await notion.getBotUserId();
	const source = await notion.getDataSourceId(settings.databaseId);
	const dataSource = await notion.getDataSource(source.id);
	const problems = checkSchema(dataSource.properties, names);
	budget.take();
	const collection = await ctx.schema!.getCollection(COLLECTION);
	if (!collection) problems.push(`The site has no "${COLLECTION}" collection`);
	if (problems.length > 0) return { problems };

	const ids = { databaseId: settings.databaseId, botUserId, dataSourceId: source.id };
	budget.take();
	await ctx.kv.set(NOTION_KEY, ids);
	return ids;
}

async function findNextPage(
	ctx: PluginContext,
	notion: NotionClient,
	settings: Settings,
	names: PropertyNames,
	budget: Budget,
	now: Date,
): Promise<{ status: "job"; job: Job } | { status: "done"; result: RunResult }> {
	const ids = await notionIds(ctx, notion, settings, names, budget);
	if ("problems" in ids) return { status: "done", result: { status: "schema_invalid", problems: ids.problems } };

	const pages = await notion.queryPublishedPages(ids.dataSourceId, names.publish);
	const candidates = pages
		.filter((page) => !page.in_trash)
		.map((page) => parsePage(page, names))
		.filter((article) => needsSending(article, ids.botUserId));
	if (candidates.length === 0) return { status: "done", result: { status: "nothing_to_send" } };

	budget.take();
	const records = (await ctx.storage.pages!.getMany(candidates.map((article) => article.pageId))) as Map<string, PageRecord>;
	const article = candidates.find((candidate) => records.get(candidate.pageId)?.failedEdit !== candidate.lastEditedTime);
	if (!article) return { status: "done", result: { status: "nothing_to_send" } };

	const job: Job = {
		pageId: article.pageId,
		article,
		startedAt: now.toISOString(),
		phase: "read",
		queue: [{ fetchId: article.pageId, key: article.pageId, depth: 0 }],
		children: {},
		images: {},
	};
	try {
		job.contentId = records.get(article.pageId)?.contentId ?? (await findSentPost(ctx, article, budget));
	} catch (error) {
		if (error instanceof PageFailure) {
			return { status: "done", result: await failPage(ctx, job, error.message, budget) };
		}
		throw error;
	}
	return { status: "job", job };
}

/**
 * A page that has an EmDash URL but no record here was sent by the GitHub
 * Actions tool (or by an earlier install). Its post is found by the slug at
 * the end of the URL.
 */
async function findSentPost(ctx: PluginContext, article: Article, budget: Budget): Promise<string | undefined> {
	if (!article.emdashUrl) return undefined;
	let url: URL;
	try {
		url = new URL(article.emdashUrl);
	} catch {
		throw new PageFailure(`"${article.emdashUrl}" in Notion is not a URL. Empty it to send the page as a new post`);
	}
	if (url.origin !== new URL(ctx.site.url).origin) {
		throw new PageFailure(`${article.emdashUrl} is not on ${ctx.site.url}. Empty the EmDash URL in Notion to send the page as a new post`);
	}
	const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
	let slug = last;
	try {
		slug = decodeURIComponent(last);
	} catch {
		// Keep the slug as it is.
	}

	let cursor: string | undefined;
	for (let i = 0; i < FIND_PAGES; i++) {
		budget.take();
		const page = await ctx.content!.list(COLLECTION, { limit: 100, cursor });
		const post = page.items.find((item) => item.slug === slug);
		if (post) return post.id;
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	throw new PageFailure(
		`The post ${article.emdashUrl} is not on the site (deleted, or its slug was changed in the admin). ` +
			"Put its current URL in the EmDash URL in Notion, or empty it to send the page as a new post",
	);
}

/* ---------- read ---------- */

async function readStep(notion: NotionClient, job: Job): Promise<"done"> {
	const next = job.queue[0];
	if (next) {
		const children = await notion.getBlockChildren(next.fetchId);
		job.children[next.key] = children;
		job.queue.shift();
		if (next.depth < MAX_DEPTH) {
			for (const block of children) {
				if (!block.has_children || block.type === "child_page" || block.type === "child_database") continue;
				const synced =
					block.type === "synced_block"
						? (block.synced_block as { synced_from?: { block_id?: string } | null } | undefined)?.synced_from?.block_id
						: undefined;
				job.queue.push({ fetchId: synced ?? block.id, key: block.id, depth: next.depth + 1 });
			}
		}
		if (job.queue.length > 0) return "done";
	}

	const body = convertBlocks(buildTree(job.children, job.pageId));
	job.blocks = body.blocks;
	job.skipped = body.skipped;
	job.children = {};
	for (const url of imageUrls(job.article, body)) job.images[url] = null;
	job.phase = "images";
	return "done";
}

function buildTree(children: Record<string, NotionBlock[]>, key: string): NotionBlock[] {
	return (children[key] ?? []).map((block) => (children[block.id] ? { ...block, children: buildTree(children, block.id) } : block));
}

function imageUrls(article: Article, body: ConvertResult): string[] {
	const urls = body.images.map((image) => image.asset.url).filter((url): url is string => !!url);
	if (article.featuredImage) urls.push(article.featuredImage.url);
	return [...new Set(urls)];
}

/* ---------- images ---------- */

/** Calls for one image: read it, upload it, read its size back. */
const IMAGE_CALLS = 3;

async function imageStep(ctx: PluginContext, job: Job, budget: Budget): Promise<"done" | "waiting"> {
	const url = Object.keys(job.images).find((key) => job.images[key] === null);
	if (!url) {
		job.phase = "terms";
		return "done";
	}
	if (!NOTION_FILE_HOSTS.includes(new URL(url).hostname)) {
		job.images[url] = { kind: "link" };
		return "done";
	}
	if (!budget.has(IMAGE_CALLS)) return "waiting";

	budget.take();
	let response: Response;
	try {
		response = await ctx.http!.fetch(url);
	} catch (error) {
		job.images[url] = { kind: "dropped", reason: `${shortUrl(url)}: ${(error as Error).message}` };
		return "done";
	}
	const file = imageFileName(url, response.headers.get("Content-Type"));
	if (!response.ok || !file) {
		job.images[url] = { kind: "dropped", reason: `${shortUrl(url)}: ${response.ok ? "not an image" : `HTTP ${response.status}`}` };
		return "done";
	}
	const bytes = await response.arrayBuffer();
	budget.take(2, 1);
	const uploaded = await ctx.media!.upload!(file.name, file.type, bytes);
	const media = await ctx.media!.get(uploaded.mediaId);
	job.images[url] = {
		kind: "uploaded",
		mediaId: uploaded.mediaId,
		url: media?.url ?? uploaded.url,
		storageKey: uploaded.storageKey,
		filename: media?.filename ?? file.name,
		mimeType: media?.mimeType ?? file.type,
		...(media?.width ? { width: media.width } : {}),
		...(media?.height ? { height: media.height } : {}),
		...(media?.blurhash ? { blurhash: media.blurhash } : {}),
		...(media?.dominantColor ? { dominantColor: media.dominantColor } : {}),
	};
	return "done";
}

/* ---------- terms ---------- */

const normalize = (value: string) => value.trim().toLowerCase();

async function termsStep(ctx: PluginContext, job: Job, budget: Budget): Promise<"done" | "waiting"> {
	const taxonomies = ctx.taxonomies!;
	const { category, tags } = job.article;
	job.terms ??= {};

	if (category && !job.terms.category) {
		budget.take();
		const terms = await taxonomies.getTerms("category");
		const term = terms.find((t) => normalize(t.label) === normalize(category)) ?? terms.find((t) => normalize(t.slug) === normalize(category));
		if (!term) {
			throw new PageFailure(`The category "${category}" is not on the site (it has: ${terms.map((t) => t.label).join(", ") || "none"})`);
		}
		job.terms.category = [term.id];
		return "done";
	}

	if (tags.length > 0 && !job.terms.tagsDone) {
		// The tags are read again before any is created, so a tag is never made twice.
		if (!budget.has(2)) return "waiting";
		budget.take();
		const terms = await taxonomies.getTerms("tag");
		const ids: string[] = [];
		let done = true;
		for (const tag of tags) {
			const term = terms.find((t) => normalize(t.label) === normalize(tag)) ?? terms.find((t) => normalize(t.slug) === normalize(tag));
			if (term) {
				if (!ids.includes(term.id)) ids.push(term.id);
				continue;
			}
			if (!budget.has(1)) {
				done = false;
				break;
			}
			budget.take();
			const created = await (taxonomies as Required<typeof taxonomies>).createTerm!("tag", { label: tag });
			ids.push(created.id);
			terms.push(created);
		}
		job.terms.tag = ids;
		job.terms.tagsDone = done;
		return done ? "done" : "waiting";
	}

	job.phase = "save";
	return "done";
}

/* ---------- save ---------- */

/** Calls for saving: write the post, set two taxonomies (3 each), publish (2), remember the page. */
const SAVE_CALLS = 1 + 6 + 2 + 1;

async function saveStep(ctx: PluginContext, job: Job, settings: Settings, budget: Budget, now: Date): Promise<"done" | "waiting"> {
	if (!budget.has(SAVE_CALLS)) return "waiting";
	const content = ctx.content!;
	const { article } = job;

	const blocks = fillImages(job.blocks ?? [], job.images);
	const data: Record<string, unknown> = { title: article.title, content: blocks };
	if (article.excerpt) data.excerpt = article.excerpt;
	const featured = featuredImage(job, blocks);
	if (featured) data.featured_image = featured;

	budget.take();
	let item;
	if (job.contentId) {
		try {
			item = await content.update!(COLLECTION, job.contentId, data);
		} catch (error) {
			if (/not found/i.test((error as Error).message)) {
				throw new PageFailure("The post this page was sent to is no longer on the site. Empty the EmDash URL in Notion to send it as a new post");
			}
			throw error;
		}
		job.created ??= false;
	} else {
		item = await content.create!(COLLECTION, data);
		job.contentId = item.id;
		job.created = true;
	}

	for (const taxonomy of ["category", "tag"] as const) {
		await setTerms(ctx, job.contentId, taxonomy, job.terms?.[taxonomy] ?? [], job.created, budget);
	}

	let slug = item.slug;
	if (settings.publish) {
		budget.take(2, 1);
		const versioned = await content.getVersioned!(COLLECTION, job.contentId);
		if (versioned) {
			const published = await content.publish!(COLLECTION, job.contentId, { _rev: versioned._rev });
			slug = published.item.slug;
		}
	}

	budget.take(1, 1);
	await ctx.storage.pages!.put(job.pageId, {
		title: article.title,
		contentId: job.contentId,
		slug: slug ?? undefined,
		sentAt: now.toISOString(),
	} satisfies PageRecord);

	const states = Object.values(job.images);
	job.sent = {
		status: "sent",
		pageId: job.pageId,
		title: article.title,
		contentId: job.contentId,
		slug,
		url: slug ? postUrl(ctx.site.url, slug) : null,
		created: job.created,
		published: settings.publish,
		images: {
			uploaded: states.filter((s) => s?.kind === "uploaded").length,
			links: states.filter((s) => s?.kind === "link").length,
			dropped: states.flatMap((s) => (s?.kind === "dropped" ? [s.reason] : [])),
		},
		skipped: job.skipped ?? [],
		marked: false,
	};
	// Saving the job between here and the mark keeps a retry from sending the post twice.
	job.blocks = undefined;
	job.images = {};
	job.phase = "mark";
	return "done";
}

/** The post's page URL, the same as the GitHub Actions tool writes. */
export function postUrl(siteUrl: string, slug: string): string {
	return `${siteUrl.replace(/\/+$/, "")}/${COLLECTION}/${slug}`;
}

/* ---------- mark ---------- */

/** Calls for the mark: read the page, write the mark, and maybe record a failure. */
const MARK_CALLS = 3;

/**
 * Writes the post's URL and the time back to Notion. This makes the plugin
 * the page's last editor, which is how a later edit by a person is told
 * apart (see needsSending).
 */
async function markStep(
	ctx: PluginContext,
	notion: NotionClient,
	job: Job,
	settings: Settings,
	budget: Budget,
	now: Date,
): Promise<"waiting" | RunResult> {
	const sent = job.sent!;
	if (!sent.url) return { ...sent, note: "The post has no slug, so nothing was written back to Notion" };
	if (!budget.has(MARK_CALLS)) return "waiting";

	const names = settings.properties ?? DEFAULT_PROPERTY_NAMES;
	try {
		const page = await notion.getPage(job.pageId);
		const edited =
			page.last_edited_time !== job.article.lastEditedTime || page.last_edited_by?.id !== job.article.lastEditedBy;
		if (edited) {
			// Marking it now would hide the newer edit. Without the mark, the next run sends the page again.
			return { ...sent, note: "The page was edited while it was being sent; the next run sends the edit" };
		}
		await notion.writeBack(job.pageId, names, sent.url, now);
		return { ...sent, marked: true };
	} catch (error) {
		if (!(error instanceof NotionError)) throw error;
		// Without the mark the page would be sent again on every run, so it waits until someone edits it.
		const reason = `Sent, but could not write the URL back to Notion (${error.message}). Put ${sent.url} in "${names.emdashUrl}" by hand`;
		ctx.log.warn("Could not mark a Notion page as sent", { pageId: job.pageId, status: error.status, message: error.message });
		budget.take(1, 0);
		const pages = ctx.storage.pages!;
		await pages.put(job.pageId, {
			title: sent.title,
			contentId: sent.contentId,
			slug: sent.slug ?? undefined,
			sentAt: now.toISOString(),
			failedEdit: job.article.lastEditedTime,
			error: reason,
		} satisfies PageRecord);
		return { ...sent, note: reason };
	}
}

/** Makes the post's terms in one taxonomy the ones from Notion. A taxonomy left empty in Notion is not touched. */
async function setTerms(ctx: PluginContext, contentId: string, taxonomy: string, ids: string[], created: boolean, budget: Budget) {
	if (ids.length === 0) return;
	const taxonomies = ctx.taxonomies as Required<NonNullable<PluginContext["taxonomies"]>>;
	let current: string[] = [];
	if (!created) {
		budget.take(1, 1);
		current = (await taxonomies.getEntryTerms(COLLECTION, contentId, { taxonomy })).map((term) => term.id);
		const remove = current.filter((id) => !ids.includes(id));
		if (remove.length > 0) {
			budget.take(1, 1);
			await taxonomies.removeEntryTerms(COLLECTION, contentId, taxonomy, remove);
		}
	}
	const add = ids.filter((id) => !current.includes(id));
	if (add.length > 0) {
		budget.take(1, 1);
		await taxonomies.addEntryTerms(COLLECTION, contentId, taxonomy, add);
	}
}

/** Puts the uploaded images into the body. Images that could not be read are left out. */
export function fillImages(blocks: Block[], images: Record<string, ImageState | null>): Block[] {
	return blocks.flatMap((block): Block[] => {
		if (block._type !== "image") return [block];
		const image = block as ImageBlock;
		const state = image.asset.url ? images[image.asset.url] : undefined;
		if (!state || state.kind === "link") return [image];
		if (state.kind === "dropped") return [];
		const filled: ImageBlock = { ...image, asset: { _ref: state.mediaId, url: state.url, provider: "local" } };
		if (state.width) filled.width = state.width;
		if (state.height) filled.height = state.height;
		if (state.blurhash) filled.blurhash = state.blurhash;
		if (state.dominantColor) filled.dominantColor = state.dominantColor;
		return [filled];
	});
}

/**
 * The featured image is the one set in Notion, or else the first body image.
 * Without either, the site's featured image is left as it is (the GitHub
 * Actions tool may draw a thumbnail for it).
 */
function featuredImage(job: Job, blocks: Block[]) {
	const { article } = job;
	let state: ImageState | null | undefined;
	let alt = article.title;
	if (article.featuredImage) {
		state = job.images[article.featuredImage.url];
	} else {
		const first = blocks.find((block): block is ImageBlock => block._type === "image" && block.asset.provider === "local");
		if (first?.asset.url) {
			state = Object.values(job.images).find((s) => s?.kind === "uploaded" && s.mediaId === first.asset._ref);
			alt = first.alt || article.title;
		}
	}
	if (state?.kind !== "uploaded") return undefined;
	return {
		provider: "local",
		id: state.mediaId,
		alt,
		mimeType: state.mimeType,
		filename: state.filename,
		meta: { storageKey: state.storageKey },
		...(state.width ? { width: state.width } : {}),
		...(state.height ? { height: state.height } : {}),
	};
}
