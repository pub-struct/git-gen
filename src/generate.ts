import * as p from "@clack/prompts";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getChangedFiles, getGitDiff, gitCommit, gitPushAndCreatePR } from "./git.ts";
import { readMultiLine } from "./input.ts";

import { Glob } from "bun";

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
	p.intro("git-gen");

	const company = await detectCompany();
	if (!company) {
		const available = await getAvailablePrompts();
		if (available.length) {
			p.log.error(`Could not detect project. Available prompts: ${available.join(", ")}`);
		} else {
			p.log.error("No prompt files found in src/prompt/. Add a <name>.md file.");
		}
		process.exit(1);
	}

	p.log.info(`Detected project: ${company}`);

	const [diff, changedFiles] = await Promise.all([
		getGitDiff(),
		getChangedFiles(),
	]);

	if (!diff.trim() && !changedFiles.trim()) {
		p.log.error("No git changes detected. Stage or modify files first.");
		process.exit(1);
	}

	const ticket = await p.text({
		message: "JIRA ticket number (or press enter to skip):",
		placeholder: "e.g. PROJ-123",
	});
	if (p.isCancel(ticket)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	p.log.step("Paste the JIRA ticket summary (press Enter twice to finish):");
	const summary = await readMultiLine("");

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

	const s = p.spinner();
	s.start("Generating with Claude...");

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
					const snippet = event.delta.thinking.replace(/\n/g, " ").slice(-60);
					s.message(`Thinking: ...${snippet}`);
				} else if (event.delta.type === "text_delta") {
					s.message("Writing response...");
					responseText += event.delta.text;
				}
			}
		} else if (message.type === "result") {
			if (message.subtype !== "success") {
				s.stop("Generation failed.");
				p.log.error(`Failed: ${message.subtype}`);
				process.exit(1);
			}
			break;
		}
	}

	s.stop("Generation complete.");

	if (!responseText.trim()) {
		p.log.error("Empty response from Claude.");
		process.exit(1);
	}

	const parsed = parseResponse(responseText);

	p.note(parsed.commitMessage, "Commit Message");
	p.note(parsed.prTitle, "PR Title");
	p.note(parsed.prBody, "PR Body");

	const shouldCommit = await p.confirm({
		message: "Commit and open PR?",
	});
	if (p.isCancel(shouldCommit) || !shouldCommit) {
		p.outro("Done!");
		process.exit(0);
	}

	const commitSpinner = p.spinner();
	commitSpinner.start("Committing changes...");
	try {
		await gitCommit(parsed.commitMessage);
		commitSpinner.stop("Changes committed.");
	} catch (err) {
		commitSpinner.stop("Commit failed.");
		p.log.error(String(err));
		process.exit(1);
	}

	const prSpinner = p.spinner();
	prSpinner.start("Pushing and creating PR...");
	try {
		await gitPushAndCreatePR(parsed.prTitle, parsed.prBody);
		prSpinner.stop("PR created.");
	} catch (err) {
		prSpinner.stop("PR creation failed.");
		p.log.warning("Commit already landed. Push/PR failed:");
		p.log.error(String(err));
		process.exit(1);
	}

	p.outro("All done!");
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
