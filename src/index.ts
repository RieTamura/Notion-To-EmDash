import { ConfigError, loadConfig } from "./config.ts";
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
	for (const article of toSend.slice(0, config.maxPosts)) {
		const state = article.emdashUrl ? "update" : "new";
		console.log(`- [${state}] ${article.title} (${article.notionUrl})`);
	}
	if (toSend.length > config.maxPosts) {
		console.log(`  ${toSend.length - config.maxPosts} more will be sent in later runs`);
	}
	for (const article of untitled) {
		console.warn(`Skipped a page with no title: ${article.notionUrl}`);
	}
	// Steps 4 to 7 of the plan (convert, upload, write back) come here.
}

main().catch((error: unknown) => {
	if (error instanceof ConfigError || error instanceof NotionError) {
		console.error(error.message);
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
