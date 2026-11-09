import { ConfigError, loadConfig } from "./config.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	// Steps 3 to 7 of the plan (read Notion, convert, upload, write back) come here.
	console.log(`Notion To EmDash: ready for ${config.emdashUrl} (up to ${config.maxPosts} pages per run)`);
}

main().catch((error: unknown) => {
	if (error instanceof ConfigError) {
		console.error(error.message);
	} else {
		console.error(error);
	}
	process.exitCode = 1;
});
