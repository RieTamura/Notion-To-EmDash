import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./config.ts";
import { convertBlocks } from "./convert.ts";
import { EmDashApi, EmDashError } from "./emdash.ts";
import { ImageDownloadError } from "./media.ts";
import type { Block } from "./portable-text.ts";
import { checkSchema, missingOptional, NotionClient, NotionError, needsSending, parsePage } from "./notion.ts";
import { findPostId, PostNotFoundError } from "./publish.ts";
import { sendArticle } from "./send.ts";
import { UnknownCategoryError } from "./taxonomy.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	const notion = new NotionClient({ token: config.notionToken });

	const botUserId = await notion.getBotUserId();
	const source = await notion.getDataSourceId(config.notionDatabaseId);
	if (source.names.length > 1) {
		console.warn(`The database has ${source.names.length} tables (${source.names.join(", ")}); using "${source.names[0]}"`);
	}

	const dataSource = await notion.getDataSource(source.id);
	const problems = checkSchema(dataSource.properties, config.properties);
	if (problems.length > 0) {
		console.error("The Notion database is not ready:");
		for (const problem of problems) console.error(`- ${problem}`);
		process.exitCode = 1;
		return;
	}

	const unused = missingOptional(dataSource.properties, config.properties);
	if (unused.length > 0) {
		console.log(`Not in the database, so not used: ${unused.join(", ")} (rename with PROP_* settings if yours differ)`);
	}

	const pages = await notion.queryPublishedPages(source.id, config.properties.publish);
	const articles = pages.filter((page) => !page.in_trash).map((page) => parsePage(page, config.properties));
	const toSend = articles.filter((article) => needsSending(article, botUserId));
	const untitled = articles.filter((article) => !article.title);

	console.log(`${articles.length} page(s) marked to publish; ${toSend.length} to send`);
	const dump = process.argv.includes("--dump");
	// --send sends as drafts (for trying the tool); --publish publishes. Without either, nothing is sent
	const publish = process.argv.includes("--publish");
	const send = publish || process.argv.includes("--send");
	if (!send) console.log("Dry run: add --send (drafts) or --publish to send");
	const emdash = new EmDashApi({ siteUrl: config.emdashUrl, token: config.emdashToken });
	if (send) await emdash.checkConnection();
	for (const article of toSend.slice(0, config.maxPosts)) {
		const state = article.emdashUrl ? "update" : "new";
		console.log(`- [${state}] ${article.title} (${article.notionUrl})`);

		const tree = await notion.getBlockTree(article.pageId);
		const body = convertBlocks(tree);
		console.log(`  body: ${describeBlocks(body.blocks)}`);
		for (const skipped of body.skipped) {
			console.warn(`  left out a ${skipped.type} block: ${skipped.reason}`);
		}
		if (dump) {
			await mkdir("out", { recursive: true });
			const file = join("out", `${article.pageId}.json`);
			await writeFile(file, `${JSON.stringify(body.blocks, null, "\t")}\n`);
			console.log(`  saved to ${file}`);
		}
		if (!send) continue;

		let url: string;
		try {
			const postId = article.emdashUrl ? await findPostId(emdash, config.emdashUrl, article.emdashUrl) : undefined;
			const result = await sendArticle(emdash, article, body, { postId, publish });
			url = result.url;
			const how = result.published ? "published" : result.created ? "sent as a draft" : "updated as a draft";
			console.log(`  ${how}: ${result.url} (${result.imagesUploaded} image(s))`);
		} catch (error) {
			if (!isExpected(error)) throw error;
			console.error(`  not sent: ${(error as Error).message}`);
			process.exitCode = 1;
			continue;
		}

		try {
			await notion.writeBack(article.pageId, config.properties, url, new Date());
		} catch (error) {
			if (!(error instanceof NotionError)) throw error;
			// Without the mark, the next run would make the post again
			console.error(`  sent, but could not mark the page in Notion: ${error.message}`);
			console.error(`  put ${url} in its "${config.properties.emdashUrl}" by hand before the next run`);
			process.exitCode = 1;
		}
	}
	if (toSend.length > config.maxPosts) {
		console.log(`  ${toSend.length - config.maxPosts} more will be sent in later runs`);
	}
	for (const article of untitled) {
		console.warn(`Skipped a page with no title: ${article.notionUrl}`);
	}
	// Step 6 of the plan (thumbnail) comes here.
}

/** "3 normal, 1 h2, 2 bullet, 1 image" */
function describeBlocks(blocks: Block[]): string {
	const counts = new Map<string, number>();
	for (const block of blocks) {
		const kind = block._type === "block" ? (block.listItem ?? block.style) : block._type;
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	if (!counts.size) return "empty";
	return [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ");
}

/** Errors that are reported as a message; anything else is a bug and shows its stack. */
function isExpected(error: unknown): boolean {
	return error instanceof EmDashError || error instanceof ImageDownloadError || error instanceof UnknownCategoryError ||
		error instanceof NotionError || error instanceof PostNotFoundError;
}

main().catch((error: unknown) => {
	if (error instanceof ConfigError || isExpected(error)) {
		console.error((error as Error).message);
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
