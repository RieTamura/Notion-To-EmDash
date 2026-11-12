import { DEFAULT_PROPERTY_NAMES, parseNotionId, type PropertyNames } from "../shared/properties.ts";

export { DEFAULT_PROPERTY_NAMES, parseNotionId, type PropertyNames };

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
	/** Draw a thumbnail for a post with no featured image and no body image (AUTO_THUMBNAIL, on unless "false"). */
	autoThumbnail: boolean;
	properties: PropertyNames;
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

const REQUIRED = ["NOTION_TOKEN", "NOTION_DATABASE_ID", "EMDASH_URL", "EMDASH_TOKEN"] as const;


export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const missing = REQUIRED.filter((name) => !env[name]?.trim());
	if (missing.length > 0) {
		throw new ConfigError(`Missing settings: ${missing.join(", ")}`);
	}

	const databaseId = parseNotionId(env.NOTION_DATABASE_ID!);
	if (!databaseId) {
		throw new ConfigError("NOTION_DATABASE_ID must be a database ID (32 letters and digits) or a database link");
	}

	const url = siteUrl(env);
	const maxPosts = readMaxPosts(env);

	const rawThumbnail = env.AUTO_THUMBNAIL?.trim().toLowerCase() || "true";
	if (rawThumbnail !== "true" && rawThumbnail !== "false") {
		throw new ConfigError("AUTO_THUMBNAIL must be true or false");
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
		autoThumbnail: rawThumbnail === "true",
		properties,
	};
}

function siteUrl(env: Record<string, string | undefined>): URL {
	let url: URL;
	try {
		url = new URL(env.EMDASH_URL!.trim());
	} catch {
		throw new ConfigError("EMDASH_URL is not a valid URL");
	}
	if (url.protocol !== "https:" && url.hostname !== "localhost") {
		throw new ConfigError("EMDASH_URL must start with https://");
	}
	return url;
}

function readMaxPosts(env: Record<string, string | undefined>): number {
	const rawMax = env.MAX_POSTS?.trim() || "5";
	const maxPosts = Number(rawMax);
	if (!Number.isInteger(maxPosts) || maxPosts < 1) {
		throw new ConfigError("MAX_POSTS must be a whole number of 1 or more");
	}
	return maxPosts;
}

/** Settings for --thumbnails, which only talks to EmDash: no Notion settings are needed. */
export interface ThumbnailConfig {
	emdashUrl: string;
	emdashToken: string;
	/** Most thumbnails drawn in one run. */
	maxPosts: number;
	/** Slug beginnings (THUMBNAIL_SKIP, comma separated) of posts that are left without a thumbnail. */
	skip: string[];
}

export function loadThumbnailConfig(env: Record<string, string | undefined> = process.env): ThumbnailConfig {
	const missing = (["EMDASH_URL", "EMDASH_TOKEN"] as const).filter((name) => !env[name]?.trim());
	if (missing.length > 0) {
		throw new ConfigError(`Missing settings: ${missing.join(", ")}`);
	}
	return {
		emdashUrl: siteUrl(env).origin,
		emdashToken: env.EMDASH_TOKEN!.trim(),
		maxPosts: readMaxPosts(env),
		skip: (env.THUMBNAIL_SKIP ?? "").split(",").map((prefix) => prefix.trim()).filter(Boolean),
	};
}
