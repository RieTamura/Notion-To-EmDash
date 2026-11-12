import { describe, expect, it } from "vitest";
import { summary, textFor } from "../../src/plugin/admin.ts";

// The admin page text is plain functions, so it is tested here without the plugin host.
describe("admin page result line", () => {
	const ja = textFor("ja");
	const en = textFor("en");

	it("puts every result into words, never the raw status", () => {
		const results = [
			{ status: "not_configured", missing: ["notionToken"] },
			{ status: "notion_error", httpStatus: 401 },
			{ status: "schema_invalid", problems: ["x"] },
			{ status: "failed", title: "記事", reason: "x" },
			{ status: "working", title: "記事", phase: "images" },
			{ status: "sent", title: "記事" },
			{ status: "nothing_to_send" },
			{ status: "ok", toSend: 1, waitingForEdit: 0 },
		];
		for (const result of results) {
			for (const [t, lang] of [[ja, "ja"], [en, "en"]] as const) {
				const line = summary(t, lang, result);
				expect(line).not.toContain(result.status);
				expect(line).not.toBe("");
			}
		}
		expect(summary(ja, "ja", { status: "not_configured" })).toBe("トークンかデータベースが保存されていません");
		expect(summary(ja, "ja", { status: "working", title: "記事", phase: "images" })).toBe("「記事」を送っている途中（画像を上げています）");
	});
});
