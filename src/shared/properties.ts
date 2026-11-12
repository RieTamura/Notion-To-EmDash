/** Names of the Notion database properties this tool reads and writes. */
export interface PropertyNames {
	/** Checkbox. Only pages with it ticked are sent. */
	publish: string;
	/** Text. Part of the post URL; made from the title when empty. */
	slug: string;
	/** Text. The post excerpt. */
	excerpt: string;
	/** Select. The post category. */
	category: string;
	/** Multi-select. The post tags. */
	tags: string;
	/** Files. Used as the featured image when present. */
	featuredImage: string;
	/** URL. Written by this tool; empty means "not sent yet". */
	emdashUrl: string;
	/** Date. Written by this tool when the page is sent. */
	sentAt: string;
}

export const DEFAULT_PROPERTY_NAMES: PropertyNames = {
	publish: "公開",
	slug: "スラッグ",
	excerpt: "抜粋",
	category: "カテゴリ",
	tags: "タグ",
	featuredImage: "アイキャッチ",
	emdashUrl: "EmDash URL",
	sentAt: "送信日時",
};

/**
 * Accepts a bare ID (with or without dashes) or a Notion database link,
 * such as https://www.notion.so/workspace/My-posts-0123456789abcdef0123456789abcdef?v=…
 */
export function parseNotionId(value: string): string | null {
	let text = value.trim();
	try {
		text = new URL(text).pathname;
	} catch {
		// Not a link: use the text as it is.
	}
	const compact = text.replace(/-/g, "");
	const matches = compact.match(/[0-9a-f]{32}/gi);
	return matches ? matches[matches.length - 1]!.toLowerCase() : null;
}
