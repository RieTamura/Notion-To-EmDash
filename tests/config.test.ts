import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PROPERTY_NAMES, loadConfig, parseNotionId } from "../src/config.ts";

const ID = "0123456789abcdef0123456789abcdef";

const base = {
	NOTION_TOKEN: "ntn_test",
	NOTION_DATABASE_ID: ID,
	EMDASH_URL: "https://example.com/",
	EMDASH_TOKEN: "ec_test",
};

describe("loadConfig", () => {
	it("reads all settings and drops the trailing slash", () => {
		expect(loadConfig(base)).toEqual({
			notionToken: "ntn_test",
			notionDatabaseId: ID,
			emdashUrl: "https://example.com",
			emdashToken: "ec_test",
			maxPosts: 5,
			properties: DEFAULT_PROPERTY_NAMES,
		});
	});

	it("names every missing setting", () => {
		expect(() => loadConfig({ NOTION_TOKEN: "x", EMDASH_TOKEN: " " })).toThrow(
			"Missing settings: NOTION_DATABASE_ID, EMDASH_URL, EMDASH_TOKEN",
		);
	});

	it("rejects http except on localhost", () => {
		expect(() => loadConfig({ ...base, EMDASH_URL: "http://example.com" })).toThrow(ConfigError);
		expect(loadConfig({ ...base, EMDASH_URL: "http://localhost:4321" }).emdashUrl).toBe("http://localhost:4321");
	});

	it("rejects a URL that cannot be read", () => {
		expect(() => loadConfig({ ...base, EMDASH_URL: "example.com" })).toThrow("EMDASH_URL is not a valid URL");
	});

	it("reads MAX_POSTS and rejects bad values", () => {
		expect(loadConfig({ ...base, MAX_POSTS: "3" }).maxPosts).toBe(3);
		expect(() => loadConfig({ ...base, MAX_POSTS: "0" })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, MAX_POSTS: "2.5" })).toThrow(ConfigError);
	});

	it("rejects a database ID that holds no ID", () => {
		expect(() => loadConfig({ ...base, NOTION_DATABASE_ID: "my database" })).toThrow(ConfigError);
	});

	it("uses the planned property names unless renamed", () => {
		const config = loadConfig({ ...base, PROP_PUBLISH: "Publish", PROP_TAGS: " Tags " });
		expect(config.properties.publish).toBe("Publish");
		expect(config.properties.tags).toBe("Tags");
		expect(config.properties.sentAt).toBe("送信日時");
	});
});

describe("parseNotionId", () => {
	it("accepts a bare ID, an ID with dashes, and a database link", () => {
		expect(parseNotionId(ID)).toBe(ID);
		expect(parseNotionId("01234567-89AB-cdef-0123-456789abcdef")).toBe(ID);
		expect(
			parseNotionId(`https://www.notion.so/myspace/My-posts-${ID}?v=fedcba9876543210fedcba9876543210`),
		).toBe(ID);
	});

	it("returns null when there is no ID", () => {
		expect(parseNotionId("https://www.notion.so/")).toBeNull();
	});
});
