import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./config.ts";
import { convertBlocks } from "./convert.ts";
import type { Block } from "./portable-text.ts";
import { checkSchema, NotionClient, NotionError, needsSending, parsePage } from "./notion.ts";

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

	const pages = await notion.queryPublishedPages(source.id, config.properties.publish);
	const articles = pages.filter((page) => !page.in_trash).map((page) => parsePage(page, config.properties));
	const toSend = articles.filter((article) => needsSending(article, botUserId));
	const untitled = articles.filter((article) => !article.title);

	console.log(`${articles.length} page(s) marked to publish; ${toSend.length} to send`);
	const dump = process.argv.includes("--dump");
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
	}
	if (toSend.length > config.maxPosts) {
		console.log(`  ${toSend.length - config.maxPosts} more will be sent in later runs`);
	}
	for (const article of untitled) {
		console.warn(`Skipped a page with no title: ${article.notionUrl}`);
	}
	// Steps 5 to 7 of the plan (upload, send, write back) come here.
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

main().catch((error: unknown) => {
	if (error instanceof ConfigError || error instanceof NotionError) {
		console.error(error.message);
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
