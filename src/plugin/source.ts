import type { PluginContext } from "emdash/plugin";

import { type ConvertResult, convertBlocks } from "../shared/convert.ts";
import { type Article, checkSchema, NotionClient, needsSending, parsePage } from "../shared/notion.ts";
import { DEFAULT_PROPERTY_NAMES, type PropertyNames } from "../shared/properties.ts";

/**
 * A Notion client that goes through the plugin bridge. Only hosts listed in
 * `allowedHosts` can be reached, and every request counts as a subrequest.
 */
export function notionClient(ctx: PluginContext, token: string): NotionClient {
	const http = ctx.http;
	if (!http) throw new Error("The network:request capability is missing");
	return new NotionClient({ token, fetch: (url, init) => http.fetch(url, init) });
}

export type NextPage =
	| { status: "schema_invalid"; problems: string[] }
	| { status: "nothing_to_send" }
	| { status: "ready"; article: Article; body: ConvertResult; waiting: number };

/**
 * Finds the oldest page that needs sending and converts its body.
 * Reading a page's body takes one request per block that has children.
 */
export async function readNextPage(
	notion: NotionClient,
	databaseId: string,
	names: PropertyNames = DEFAULT_PROPERTY_NAMES,
): Promise<NextPage> {
	const botUserId = await notion.getBotUserId();
	const source = await notion.getDataSourceId(databaseId);
	const dataSource = await notion.getDataSource(source.id);
	const problems = checkSchema(dataSource.properties, names);
	if (problems.length > 0) return { status: "schema_invalid", problems };

	const pages = await notion.queryPublishedPages(source.id, names.publish);
	const toSend = pages
		.filter((page) => !page.in_trash)
		.map((page) => parsePage(page, names))
		.filter((article) => needsSending(article, botUserId));
	const article = toSend[0];
	if (!article) return { status: "nothing_to_send" };

	const tree = await notion.getBlockTree(article.pageId);
	return { status: "ready", article, body: convertBlocks(tree), waiting: toSend.length - 1 };
}
