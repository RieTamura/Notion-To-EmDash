# Notion To EmDash

Posts pages from a Notion database to an [EmDash](https://emdashcms.com) site as posts (`posts`). It runs on GitHub Actions on a schedule, so nothing is installed on your site. Pages without an image get a thumbnail drawn with the site's [Auto Thumbnail Design](https://github.com/RieTamura/Auto-Thumbnail) settings.

[日本語](README_JA.md)

## What it does

- Publishes the Notion pages whose "公開" (publish) box is ticked.
- When you edit a page in Notion after it was sent, the next run updates the post.
- Copies body images from Notion into the EmDash media library (Notion's image links stop working after about an hour).
- Picks the featured image in this order: the Notion "アイキャッチ" (featured image) file, else the first body image, else an automatic thumbnail. A featured image chosen in the admin is never replaced.
- Writes the post URL and the time it was sent back to the Notion page, so one page never makes two posts.

Deleting a page in Notion, or unticking it, leaves the post on the site. Delete posts in the EmDash admin.

## What you need

- An EmDash site with a `posts` collection
- A Notion account
- A GitHub account
- For automatic thumbnails, the Auto Thumbnail Design plugin on the site. Without it, posts with no image are sent without a featured image

## Setup

### 1. Make the Notion database

Add these properties. The names can be changed with the `PROP_*` [settings](#settings).

| Property | Type | | Use |
| --- | --- | --- | --- |
| (title) | Title | required | The post title. Any name works |
| 公開 | Checkbox | required | Only ticked pages are sent |
| EmDash URL | URL | required | Written by the tool. Empty means "not sent yet" |
| 送信日時 | Date | required | Written by the tool |
| スラッグ | Text | | Part of the post URL. When empty, it is made from the title (a Japanese title gives a Japanese URL) |
| 抜粋 | Text | | The post excerpt, used in search results and share cards |
| カテゴリ | Select | | Must match a category on the site; a page with an unknown category is not sent |
| タグ | Multi-select | | Tags missing on the site are created |
| アイキャッチ | Files | | The first image becomes the featured image |

Do not edit "EmDash URL" or "送信日時" by hand. To send a page again as a new post (for example, one sent to another site), empty both.

### 2. Make a Notion integration

1. In [Notion integrations](https://www.notion.so/profile/integrations), make a new internal integration.
2. Give it "Read content" and "Update content" (it writes back what it sent).
3. Copy its token (`ntn_…`).
4. Open the database page, then "…" → "Connections", and add the integration.

### 3. Make an EmDash API token

In the admin, go to Users → API tokens and make a token with `content:read`, `content:write` and `media:write`. The token (`ec_pat_…`) is shown only once, so copy it right away.

### 4. Put this repository on your GitHub

Fork this repository. GitHub Actions is off in a fork, so open the fork's "Actions" tab and turn it on.

### 5. Add the secrets

In the fork, open Settings → Secrets and variables → Actions → Secrets, and add these four:

| Name | Value |
| --- | --- |
| `NOTION_TOKEN` | The token from step 2 |
| `NOTION_DATABASE_ID` | The database link (the URL in the address bar) or its ID |
| `EMDASH_URL` | The site address, e.g. `https://example.com` |
| `EMDASH_TOKEN` | The token from step 3 |

With the [GitHub CLI](https://cli.github.com/), `gh secret set NOTION_TOKEN -R <you>/Notion-To-EmDash` asks for the value without showing it.

Until all four are set, scheduled runs end without doing anything.

### 6. Try it

1. In the "Actions" tab, choose "Notion To EmDash", then "Run workflow" with `dry-run`. It lists what it would send and sends nothing. Missing database properties are reported here.
2. Tick a test page and run with `draft`. A draft appears on the site, and "EmDash URL" is filled in Notion.
3. After checking the draft in the admin, delete the test post and untick the page in Notion.

From then on it runs every 30 minutes and publishes ticked pages.

## Settings

Set these under Settings → Secrets and variables → Actions → Variables. All are optional.

| Name | Default | Meaning |
| --- | --- | --- |
| `MAX_POSTS` | `5` | Most pages sent in one run. The rest go in later runs |
| `AUTO_THUMBNAIL` | `true` | `false` turns off automatic thumbnails |
| `TZ` | `Asia/Tokyo` | Time zone of the date drawn on the thumbnail |
| `PROP_PUBLISH` | `公開` | Property name |
| `PROP_SLUG` | `スラッグ` | Property name |
| `PROP_EXCERPT` | `抜粋` | Property name |
| `PROP_CATEGORY` | `カテゴリ` | Property name |
| `PROP_TAGS` | `タグ` | Property name |
| `PROP_FEATURED_IMAGE` | `アイキャッチ` | Property name |
| `PROP_EMDASH_URL` | `EmDash URL` | Property name |
| `PROP_SENT_AT` | `送信日時` | Property name |

To change how often it runs, edit the `cron` line in `.github/workflows/notion-to-emdash.yml`. The default is every 30 minutes.

## How the body is converted

| Notion | Site |
| --- | --- |
| Heading 1–4 | Heading 2–5 (the post title is the heading 1) |
| Paragraph, bulleted and numbered lists, quote, code, divider, table | As is |
| Bold, italic, strikethrough, underline, inline code, links | As is |
| To-do | Bulleted list starting with ☐ or ☑ |
| Callout | Quote (an emoji icon goes in front) |
| Toggle, columns | Their content, laid out in order |
| Equation | LaTeX code |
| Image | Uploaded to the media library |
| Bookmark, embed, video or file at an outside URL | A link |
| Sub-page, database, file stored in Notion | Not sent (noted in the Actions log) |
| Link to another Notion page | Its text only |

## Things to know

- **Runs are not on time.** GitHub may start a scheduled run several minutes late when it is busy.
- **Schedules stop after 60 days.** In a public repository with no commits for 60 days, GitHub turns off scheduled runs. Turn them back on in the "Actions" tab.
- **Free minutes:** free for public repositories. Private repositories get 2,000 minutes a month; every 30 minutes fits, every 15 minutes does not.
- **Posts in the trash** keep their slugs, so a new post cannot use the same slug. Empty the trash or change the slug.
- **Tokens** belong in secrets only, never in files or logs. If one leaks, make a new token in Notion or EmDash and replace the secret.

## Running it on your computer

Needs Node.js 24 or later. Copy `.env.example` to `.env` and fill it in.

```bash
npm install
npm start                 # list only, send nothing
npm start -- --send       # send as drafts
npm start -- --publish    # publish
npm start -- --dump       # save the converted body to out/
npm test
```

## License

MIT
