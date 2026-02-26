import * as p from "@clack/prompts";
import { query } from "@anthropic-ai/claude-agent-sdk";
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

	// Queue-based async iterable for streaming thinking chunks to p.stream
	let thinkingResolve: ((value: IteratorResult<string>) => void) | null = null;
	const thinkingQueue: string[] = [];
	let thinkingDone = false;

	function pushThinking(chunk: string) {
		if (thinkingResolve) {
			const resolve = thinkingResolve;
			thinkingResolve = null;
			resolve({ value: chunk, done: false });
		} else {
			thinkingQueue.push(chunk);
		}
	}

	function endThinking() {
		thinkingDone = true;
		if (thinkingResolve) {
			const resolve = thinkingResolve;
			thinkingResolve = null;
			resolve({ value: undefined as any, done: true });
		}
	}

	const thinkingIterable: AsyncIterable<string> = {
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (thinkingQueue.length > 0) {
						return Promise.resolve({ value: thinkingQueue.shift()!, done: false });
					}
					if (thinkingDone) {
						return Promise.resolve({ value: undefined as any, done: true });
					}
					return new Promise(resolve => { thinkingResolve = resolve; });
				},
			};
		},
	};

	// Start streaming thinking to the UI in parallel with consuming the SDK stream
	let thinkingStarted = false;
	let streamDone = false;
	let streamError: string | null = null;

	const consumeStream = (async () => {
		for await (const message of stream) {
			if (message.type === "stream_event") {
				const event = message.event;
				if (event.type === "content_block_delta") {
					const delta = event.delta as any;
					if (delta.type === "thinking_delta") {
						if (!thinkingStarted) {
							thinkingStarted = true;
							s.stop("Claude is thinking...");
						}
						pushThinking(delta.thinking);
					} else if (delta.type === "text_delta") {
						responseText += delta.text;
					}
				} else if (event.type === "content_block_stop") {
					// A block ended — if thinking was active, close the thinking stream
					if (thinkingStarted && !thinkingDone) {
						endThinking();
					}
				}
			} else if (message.type === "result") {
				if ((message as any).subtype !== "success") {
					streamError = (message as any).subtype;
				}
				break;
			}
		}
		if (!thinkingDone) endThinking();
		streamDone = true;
	})();

	// Stream thinking to the terminal in real-time
	await p.stream.step(thinkingIterable);

	// Wait for the full stream to finish (text_delta accumulation)
	if (!streamDone) {
		const s2 = p.spinner();
		s2.start("Writing response...");
		await consumeStream;
		s2.stop("Generation complete.");
	} else {
		await consumeStream;
	}

	if (streamError) {
		p.log.error(`Generation failed: ${streamError}`);
		process.exit(1);
	}

	if (!responseText.trim()) {
		p.log.error("Empty response from Claude.");
		process.exit(1);
	}

	const parsed = parseResponse(responseText);

	p.note(parsed.commitMessage, "Commit Message");
	p.note(parsed.prTitle, "PR Title");
	p.note(parsed.prBody, "PR Body");

	const shouldCommit = await p.confirm({
		message: "Commit changes?",
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

	const shouldPR = await p.confirm({
		message: "Push and open PR?",
	});
	if (p.isCancel(shouldPR) || !shouldPR) {
		p.outro("Done!");
		process.exit(0);
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
