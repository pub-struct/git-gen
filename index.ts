#!/usr/bin/env bun

import { generate } from "./src/generate.ts";

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
	console.log("git-gen cli v0.0.1");
	console.log("\nUsage: git-gen [command] [options]\n");
	console.log("Commands:");
	console.log("  generate  Analyze git changes and generate commit/PR messages (default)");
	console.log("  setup     Configure AI provider (Claude or Auggie)");
	console.log("  help      Show this help message");
	console.log("\nOptions (for generate):");
	console.log("  -t, --ticket <id>       JIRA ticket number (e.g. PROJ-123)");
	console.log("  -m, --message <text>    Ticket summary / description");
	console.log("  -y, --yes               Run the full flow (commit, push, PR) without prompts");
	console.log("  -D, --draft             Create the PR directly as a draft, then open it in the browser");
	console.log("  -n, --dry-run           Generate and print the commit/PR only — no commit, push, or PR");
	console.log("\nExamples:");
	console.log('  git-gen -t PROJ-123 -m "Add login button" -y');
	console.log('  git-gen generate --ticket PROJ-123 --message "Fix crash on startup"');
}

interface ParsedArgs {
	ticket?: string;
	summary?: string;
	yes: boolean;
	draft: boolean;
	dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = { yes: false, draft: false, dryRun: false };

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-t":
			case "--ticket":
				parsed.ticket = argv[++i];
				break;
			case "-m":
			case "--message":
			case "--summary":
			case "-d":
			case "--description":
				parsed.summary = argv[++i];
				break;
			case "-y":
			case "--yes":
				parsed.yes = true;
				break;
			case "-D":
			case "--draft":
				parsed.draft = true;
				break;
			case "-n":
			case "--dry-run":
				parsed.dryRun = true;
				break;
			default:
				console.log(`Unknown option: ${arg}`);
				process.exit(1);
		}
	}

	return parsed;
}

if (command === "help" || command === "--help" || command === "-h") {
	showHelp();
	process.exit(0);
}

if (command === "setup") {
	const { setupProvider } = await import("./src/config.ts");
	const { intro, outro } = await import("@clack/prompts");
	intro("git-gen setup");
	await setupProvider();
	outro("Setup complete!");
	process.exit(0);
}

// `generate` is the default command. Options may be passed with or without it.
const isGenerate = !command || command === "generate" || command.startsWith("-");
if (isGenerate) {
	const optionArgs = command === "generate" ? args.slice(1) : args;
	const { ticket, summary, yes, draft, dryRun } = parseArgs(optionArgs);
	await generate({ ticket, summary, yes, draft, dryRun });
} else {
	console.log(`Unknown command: ${command}`);
	process.exit(1);
}
