import { describe, expect, it } from "vitest";
import { codeLanguage, convertBlocks, type NotionBlock, type RichTextItem } from "../../src/shared/convert.ts";
import type { TableBlock, TextBlock } from "../../src/shared/portable-text.ts";

function rt(text: string, options: Partial<RichTextItem> & { link?: string } = {}): RichTextItem {
	const { link, ...rest } = options;
	return {
		type: "text",
		plain_text: text,
		href: link ?? null,
		text: { content: text, link: link ? { url: link } : null },
		...rest,
	};
}

let id = 0;
function block(type: string, content: Record<string, unknown> = {}, children?: NotionBlock[]): NotionBlock {
	return { id: `b${id++}`, type, [type]: content, has_children: !!children?.length, ...(children ? { children } : {}) };
}

function text(type: string, value: string, children?: NotionBlock[], extra: Record<string, unknown> = {}): NotionBlock {
	return block(type, { rich_text: [rt(value)], ...extra }, children);
}

/** Blocks without keys, so the expectations stay short. */
function strip(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (k, v) => (k === "_key" ? undefined : v)));
}

describe("convertBlocks", () => {
	it("turns paragraphs and headings into blocks, with Notion's heading 1 as h2", () => {
		const { blocks } = convertBlocks([
			text("heading_1", "大見出し"),
			text("heading_2", "中見出し"),
			text("heading_3", "小見出し"),
			text("heading_4", "さらに小さい見出し"),
			text("paragraph", "本文です。\n2行目です。"),
		]);
		expect(blocks.map((b) => (b as TextBlock).style)).toEqual(["h2", "h3", "h4", "h5", "normal"]);
		expect(strip(blocks[4])).toEqual({
			_type: "block",
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", text: "本文です。\n2行目です。", marks: [] }],
		});
	});

	it("leaves out empty paragraphs (Notion's blank lines)", () => {
		const { blocks } = convertBlocks([text("paragraph", "a"), block("paragraph", { rich_text: [] }), text("paragraph", "b")]);
		expect(blocks).toHaveLength(2);
	});

	it("gives keys that are unique in the article", () => {
		const { blocks } = convertBlocks([text("paragraph", "a"), text("paragraph", "b")]);
		const keys = JSON.stringify(blocks).match(/"_key":"[^"]+"/g)!;
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("maps text styles to marks and joins pieces with the same marks", () => {
		const { blocks } = convertBlocks([
			block("paragraph", {
				rich_text: [
					rt("普通"),
					rt("と"),
					rt("太字", { annotations: { bold: true } }),
					rt("斜体", { annotations: { italic: true } }),
					rt("下線", { annotations: { underline: true } }),
					rt("取り消し", { annotations: { strikethrough: true } }),
					rt("code", { annotations: { code: true } }),
					rt("全部", { annotations: { bold: true, italic: true, underline: true, strikethrough: true, code: true } }),
				],
			}),
		]);
		const spans = (blocks[0] as TextBlock).children.map((s) => [s.text, s.marks]);
		expect(spans).toEqual([
			["普通と", []],
			["太字", ["strong"]],
			["斜体", ["em"]],
			["下線", ["underline"]],
			["取り消し", ["strike-through"]],
			["code", ["code"]],
			["全部", ["strong", "em", "underline", "strike-through", "code"]],
		]);
	});

	it("keeps one link when Notion splits it into pieces", () => {
		const { blocks } = convertBlocks([
			block("paragraph", {
				rich_text: [
					rt("リンク", { link: "https://example.com/" }),
					rt("の太字", { link: "https://example.com/", annotations: { bold: true } }),
					rt(" と "),
					rt("別のリンク", { link: "https://example.org/" }),
				],
			}),
		]);
		const b = blocks[0] as TextBlock;
		expect(b.markDefs.map((d) => d.href)).toEqual(["https://example.com/", "https://example.org/"]);
		const [first, second] = b.markDefs;
		expect(b.children.map((s) => [s.text, s.marks])).toEqual([
			["リンク", [first!._key]],
			["の太字", ["strong", first!._key]],
			[" と ", []],
			["別のリンク", [second!._key]],
		]);
	});

	it("drops links into Notion unless the page has an EmDash URL", () => {
		const pageId = "414be19e-fc98-80b6-955f-f0acf8de9a7e";
		const items = [
			rt("内部リンク", { link: "/414be19efc9880b6955ff0acf8de9a7e" }),
			rt("共有リンク", { link: "https://www.notion.so/Test-414be19efc9880b6955ff0acf8de9a7e" }),
			{ type: "mention", plain_text: "メンション", href: "https://www.notion.so/414be19efc9880b6955ff0acf8de9a7e", mention: { type: "page", page: { id: pageId } } } as RichTextItem,
		];
		const without = convertBlocks([block("paragraph", { rich_text: items })]).blocks[0] as TextBlock;
		expect(without.markDefs).toEqual([]);
		expect(without.children.map((s) => s.text)).toEqual(["内部リンク共有リンクメンション"]);

		const resolved = convertBlocks([block("paragraph", { rich_text: items })], {
			resolvePageLink: (pid) => (pid === pageId ? "https://rietamura.com/posts/test" : null),
		}).blocks[0] as TextBlock;
		expect(resolved.markDefs.map((d) => d.href)).toEqual(["https://rietamura.com/posts/test"]);
	});

	it("shows inline equations and date mentions as text", () => {
		const { blocks } = convertBlocks([
			block("paragraph", {
				rich_text: [
					{ type: "equation", plain_text: "E=mc^2", href: null, equation: { expression: "E=mc^2" } },
					{ type: "mention", plain_text: "2026年11月10日", href: null, mention: { type: "date" } },
				],
			}),
		]);
		expect((blocks[0] as TextBlock).children.map((s) => [s.text, s.marks])).toEqual([
			["E=mc^2", ["code"]],
			["2026年11月10日", []],
		]);
	});

	it("nests lists by level and turns to-dos into check marks", () => {
		const { blocks } = convertBlocks([
			text("bulleted_list_item", "項目1", [
				text("bulleted_list_item", "項目1-1", [text("numbered_list_item", "番号付き")]),
			]),
			text("numbered_list_item", "番号1"),
			block("to_do", { rich_text: [rt("済み")], checked: true }),
			block("to_do", { rich_text: [rt("まだ")], checked: false }),
		]);
		expect(blocks.map((b) => {
			const t = b as TextBlock;
			return [t.listItem, t.level, t.children.map((s) => s.text).join("")];
		})).toEqual([
			["bullet", 1, "項目1"],
			["bullet", 2, "項目1-1"],
			["number", 3, "番号付き"],
			["number", 1, "番号1"],
			["bullet", 1, "☑ 済み"],
			["bullet", 1, "☐ まだ"],
		]);
	});

	it("puts a paragraph under a list item after it, as a normal paragraph", () => {
		const { blocks } = convertBlocks([text("bulleted_list_item", "項目", [text("paragraph", "補足")])]);
		expect(blocks.map((b) => [(b as TextBlock).listItem, (b as TextBlock).style])).toEqual([
			["bullet", "normal"],
			[undefined, "normal"],
		]);
	});

	it("turns quotes and callouts into blockquotes, with the callout's emoji", () => {
		const { blocks } = convertBlocks([
			text("quote", "引用", [text("paragraph", "引用の続き")]),
			text("callout", "注意", undefined, { icon: { type: "emoji", emoji: "💡" } }),
		]);
		expect(blocks.map((b) => [(b as TextBlock).style, (b as TextBlock).children.map((s) => s.text).join("")])).toEqual([
			["blockquote", "引用"],
			["blockquote", "引用の続き"],
			["blockquote", "💡 注意"],
		]);
	});

	it("opens toggles and toggle headings", () => {
		const { blocks } = convertBlocks([
			text("toggle", "開く", [text("paragraph", "中身")]),
			text("heading_2", "見出し", [text("paragraph", "見出しの中身")], { is_toggleable: true }),
		]);
		expect(blocks.map((b) => (b as TextBlock).children[0]!.text)).toEqual(["開く", "中身", "見出し", "見出しの中身"]);
	});

	it("turns code, equations and dividers into their blocks", () => {
		const { blocks } = convertBlocks([
			block("code", { rich_text: [rt("const a = 1;\n"), rt("a + 1;")], language: "typescript" }),
			block("code", { rich_text: [rt("text")], language: "plain text" }),
			block("equation", { expression: "\\frac{1}{2}" }),
			block("divider"),
		]);
		expect(strip(blocks)).toEqual([
			{ _type: "code", code: "const a = 1;\na + 1;", language: "typescript" },
			{ _type: "code", code: "text" },
			{ _type: "code", code: "\\frac{1}{2}", language: "latex" },
			{ _type: "break", style: "line" },
		]);
	});

	it("maps Notion's code language names", () => {
		expect(codeLanguage("C++")).toBe("cpp");
		expect(codeLanguage("c#")).toBe("csharp");
		expect(codeLanguage("java/c/c++/c#")).toBeUndefined();
		expect(codeLanguage("objective-c")).toBe("objective-c");
		expect(codeLanguage("visual basic")).toBe("vb");
		expect(codeLanguage("shell")).toBe("shell");
		expect(codeLanguage(undefined)).toBeUndefined();
	});

	it("collects images with their caption as alt text", () => {
		const result = convertBlocks([
			block("image", { type: "file", file: { url: "https://files.notion.so/a.png?sig=1" }, caption: [rt("説明")] }),
			block("image", { type: "external", external: { url: "https://example.com/b.jpg" }, caption: [] }),
		]);
		expect(strip(result.blocks)).toEqual([
			{ _type: "image", alt: "説明", asset: { url: "https://files.notion.so/a.png?sig=1" } },
			{ _type: "image", alt: "", asset: { url: "https://example.com/b.jpg" } },
		]);
		expect(result.images).toHaveLength(2);
		expect(result.images[0]).toBe(result.blocks[0]);
	});

	it("turns tables into table blocks with header row and header column", () => {
		const { blocks } = convertBlocks([
			block("table", { table_width: 2, has_column_header: true, has_row_header: true }, [
				block("table_row", { cells: [[rt("項目")], [rt("値")]] }),
				block("table_row", { cells: [[rt("名前")], [rt("太字", { annotations: { bold: true } })]] }),
			]),
		]);
		const table = blocks[0] as TableBlock;
		expect(table.hasHeaderRow).toBe(true);
		expect(table.rows.map((row) => row.cells.map((c) => [c.content.map((s) => s.text).join(""), c.isHeader ?? false]))).toEqual([
			[["項目", true], ["値", true]],
			[["名前", true], ["太字", false]],
		]);
		expect(table.rows[1]!.cells[1]!.content[0]!.marks).toEqual(["strong"]);
	});

	it("turns bookmarks, embeds and external files into links, and skips files kept in Notion", () => {
		const result = convertBlocks([
			block("bookmark", { url: "https://example.com/", caption: [] }),
			block("embed", { url: "https://www.youtube.com/watch?v=x", caption: [rt("動画")] }),
			block("video", { type: "external", external: { url: "https://youtu.be/x" }, caption: [] }),
			block("file", { type: "file", file: { url: "https://files.notion.so/x.pdf" }, name: "x.pdf", caption: [] }),
		]);
		const links = result.blocks.map((b) => {
			const t = b as TextBlock;
			return [t.children.map((s) => s.text).join(""), t.markDefs[0]?.href];
		});
		expect(links).toEqual([
			["https://example.com/", "https://example.com/"],
			["動画", "https://www.youtube.com/watch?v=x"],
			["https://youtu.be/x", "https://youtu.be/x"],
		]);
		expect(result.skipped).toEqual([{ type: "file", reason: expect.stringContaining("Notion") }]);
	});

	it("reads through columns and synced blocks", () => {
		const { blocks } = convertBlocks([
			block("column_list", {}, [
				block("column", {}, [text("paragraph", "左")]),
				block("column", {}, [text("paragraph", "右")]),
			]),
			block("synced_block", { synced_from: null }, [text("paragraph", "同期")]),
		]);
		expect(blocks.map((b) => (b as TextBlock).children[0]!.text)).toEqual(["左", "右", "同期"]);
	});

	it("reports blocks it leaves out", () => {
		const result = convertBlocks([
			block("child_page", { title: "子ページ" }),
			block("table_of_contents", {}),
			block("unsupported", { block_type: "form" }),
			block("something_new", {}),
		]);
		expect(result.blocks).toEqual([]);
		expect(result.skipped.map((s) => s.type)).toEqual(["child_page", "table_of_contents", "unsupported", "something_new"]);
	});
});
