/** Settings read from environment variables (GitHub Actions secrets and variables). */
export interface Config {
	notionToken: string;
	notionDatabaseId: string;
	/** Site origin without a trailing slash, e.g. https://example.com */
	emdashUrl: string;
	emdashToken: string;
	/** Most pages sent in one run. Failed pages are tried again in the next run. */
	maxPosts: number;
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

	return {
		notionToken: env.NOTION_TOKEN!.trim(),
		notionDatabaseId: env.NOTION_DATABASE_ID!.trim(),
		emdashUrl: url.origin,
		emdashToken: env.EMDASH_TOKEN!.trim(),
		maxPosts,
	};
}
