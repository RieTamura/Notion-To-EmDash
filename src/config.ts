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

/** Environment variable that renames each property. */
const PROPERTY_ENV: Record<keyof PropertyNames, string> = {
	publish: "PROP_PUBLISH",
	slug: "PROP_SLUG",
	excerpt: "PROP_EXCERPT",
	category: "PROP_CATEGORY",
	tags: "PROP_TAGS",
	featuredImage: "PROP_FEATURED_IMAGE",
	emdashUrl: "PROP_EMDASH_URL",
	sentAt: "PROP_SENT_AT",
};

/** Settings read from environment variables (GitHub Actions secrets and variables). */
export interface Config {
	notionToken: string;
	/** Database ID in 32 hex digits, without dashes. */
	notionDatabaseId: string;
	/** Site origin without a trailing slash, e.g. https://example.com */
	emdashUrl: string;
	emdashToken: string;
	/** Most pages sent in one run. Failed pages are tried again in the next run. */
	maxPosts: number;
	properties: PropertyNames;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

const REQUIRED = ["NOTION_TOKEN", "NOTION_DATABASE_ID", "EMDASH_URL", "EMDASH_TOKEN"] as const;

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

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const missing = REQUIRED.filter((name) => !env[name]?.trim());
	if (missing.length > 0) {
		throw new ConfigError(`Missing settings: ${missing.join(", ")}`);
	}

	const databaseId = parseNotionId(env.NOTION_DATABASE_ID!);
	if (!databaseId) {
		throw new ConfigError("NOTION_DATABASE_ID must be a database ID (32 letters and digits) or a database link");
	}

	let url: URL;
	try {
		url = new URL(env.EMDASH_URL!.trim());
	} catch {
		throw new ConfigError("EMDASH_URL is not a valid URL");
	}
	if (url.protocol !== "https:" && url.hostname !== "localhost") {
		throw new ConfigError("EMDASH_URL must start with https://");
	}

	const rawMax = env.MAX_POSTS?.trim() || "5";
	const maxPosts = Number(rawMax);
	if (!Number.isInteger(maxPosts) || maxPosts < 1) {
		throw new ConfigError("MAX_POSTS must be a whole number of 1 or more");
	}

	const properties = { ...DEFAULT_PROPERTY_NAMES };
	for (const key of Object.keys(PROPERTY_ENV) as (keyof PropertyNames)[]) {
		const custom = env[PROPERTY_ENV[key]]?.trim();
		if (custom) properties[key] = custom;
	}

	return {
		notionToken: env.NOTION_TOKEN!.trim(),
		notionDatabaseId: databaseId,
		emdashUrl: url.origin,
		emdashToken: env.EMDASH_TOKEN!.trim(),
		maxPosts,
		properties,
	};
}
