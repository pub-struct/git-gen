import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getChangedFiles, getGitDiff } from "./git.ts";
import { readMultiLine } from "./input.ts";

import { Glob } from "bun";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function getAvailablePrompts(): Promise<string[]> {
	const promptDir = `${import.meta.dir}/prompt`;
	const glob = new Glob("*.md");
	const names: string[] = [];
	for await (const file of glob.scan(promptDir)) {
		names.push(file.replace(/\.md$/, ""));
	}
	return names;
}

async function detectCompany(): Promise<string | null> {
	const cwd = process.cwd();
	const prompts = await getAvailablePrompts();
	for (const name of prompts) {
		if (cwd.includes(`/${name}/`)) return name;
	}
	return null;
}

export async function generate() {
	const company = await detectCompany();
	if (!company) {
		const available = await getAvailablePrompts();
		console.error("Could not detect project from current directory.");
		if (available.length) {
			console.error(`Available prompts: ${available.join(", ")}`);
		} else {
			console.error("No prompt files found in src/prompt/. Add a <name>.md file.");
		}
		process.exit(1);
	}

	console.log(`Detected project: ${company}\n`);

	const [diff, changedFiles] = await Promise.all([
		getGitDiff(),
		getChangedFiles(),
	]);

	if (!diff.trim() && !changedFiles.trim()) {
		console.error("No git changes detected. Stage or modify files first.");
		process.exit(1);
	}

	const ticket = prompt("JIRA ticket number (or press enter to skip):") ?? "";
	const summary = await readMultiLine("Paste the JIRA ticket summary:");

	const companyPrompt = await Bun.file(
		`${import.meta.dir}/prompt/${company}.md`,
	).text();

	const ticketContext = ticket
		? `JIRA Ticket: ${ticket}\nTicket Summary: ${summary}`
		: summary
			? `Context: ${summary}`
			: "No ticket provided.";

	const userPrompt = `${companyPrompt}

## Git Diff
\`\`\`
${diff}
\`\`\`

## Changed Files
\`\`\`
${changedFiles}
\`\`\`

## Ticket Info
${ticketContext}

## Instructions
1. Determine the appropriate type/prefix based on the changes.
2. Generate a commit message following the format above.${ticket ? ` Include ticket ${ticket} in the scope/parenthetical.` : " Omit the parenthetical/scope if no ticket."}
3. The PR title should match the commit message format.
4. The PR body should follow the template above.

Respond in EXACTLY this format (no extra text outside the sections):

COMMIT_MESSAGE
<the commit message>

PR_TITLE
<the PR title>

PR_BODY
<the PR body in markdown>`;

	console.log("\nGenerating with Claude...\n");

	const stream = query({
		prompt: userPrompt,
		options: {
			model: "claude-sonnet-4-6",
			maxTurns: 1,
			thinking: { type: "enabled", budgetTokens: 10000 },
			includePartialMessages: true,
			tools: [],
		},
	});

	let responseText = "";

	for await (const message of stream) {
		if (message.type === "stream_event") {
			const event = message.event;
			if (event.type === "content_block_delta") {
				if (event.delta.type === "thinking_delta") {
					process.stderr.write(`${DIM}${event.delta.thinking}${RESET}`);
				} else if (event.delta.type === "text_delta") {
					responseText += event.delta.text;
				}
			}
		} else if (message.type === "result") {
			if (message.subtype !== "success") {
				console.error("Generation failed:", message.subtype);
				process.exit(1);
			}
			break;
		}
	}

	process.stderr.write("\n");

	if (!responseText.trim()) {
		console.error("Empty response from Claude.");
		process.exit(1);
	}

	const parsed = parseResponse(responseText);

	console.log("── Commit Message ──");
	console.log(parsed.commitMessage);
	console.log("\n── PR Title ──");
	console.log(parsed.prTitle);
	console.log("\n── PR Body ──");
	console.log(parsed.prBody);
}

interface ParsedResponse {
	commitMessage: string;
	prTitle: string;
	prBody: string;
}

function parseResponse(text: string): ParsedResponse {
	const commitMatch = text.match(/COMMIT_MESSAGE\n([\s\S]*?)(?=\nPR_TITLE\n)/);
	const prTitleMatch = text.match(/PR_TITLE\n([\s\S]*?)(?=\nPR_BODY\n)/);
	const prBodyMatch = text.match(/PR_BODY\n([\s\S]*)/);

	return {
		commitMessage: commitMatch?.[1]?.trim() ?? text,
		prTitle: prTitleMatch?.[1]?.trim() ?? "",
		prBody: prBodyMatch?.[1]?.trim() ?? "",
	};
}
