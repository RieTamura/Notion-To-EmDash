import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const base = {
	NOTION_TOKEN: "ntn_test",
	NOTION_DATABASE_ID: "db123",
	EMDASH_URL: "https://example.com/",
	EMDASH_TOKEN: "ec_test",
};

describe("loadConfig", () => {
	it("reads all settings and drops the trailing slash", () => {
		expect(loadConfig(base)).toEqual({
			notionToken: "ntn_test",
			notionDatabaseId: "db123",
			emdashUrl: "https://example.com",
			emdashToken: "ec_test",
			maxPosts: 5,
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
});
