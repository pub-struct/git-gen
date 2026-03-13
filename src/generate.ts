import * as p from "@clack/prompts";
import { getChangedFiles, getGitDiff, gitCommit, gitPush, gitCreatePR } from "./git.ts";
import { readMultiLine } from "./input.ts";
import { getConfig } from "./config.ts";
import { getProvider } from "./providers/index.ts";

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

	const config = await getConfig();
	const provider = getProvider(config.provider);

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
	s.start(`Generating with ${provider.name}...`);

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

	let thinkingStarted = false;
	let streamDone = false;

	const generatePromise = (async () => {
		try {
			const responseText = await provider.generate(userPrompt, {
				onThinkingStart() {
					thinkingStarted = true;
					s.stop(`${provider.name} is thinking...`);
				},
				onThinkingChunk(chunk) {
					pushThinking(chunk);
				},
				onThinkingEnd() {
					endThinking();
				},
				onGenerating() {
					// For providers without thinking (like Auggie), just keep the spinner going
				},
			});
			streamDone = true;
			return responseText;
		} catch (err) {
			streamDone = true;
			if (!thinkingDone) endThinking();
			throw err;
		} finally {
			if (!thinkingDone) endThinking();
		}
	})();

	// Stream thinking to the terminal in real-time (only shows if provider emits thinking)
	if (thinkingStarted || !streamDone) {
		await p.stream.step(thinkingIterable);
	}

	let responseText: string;
	if (!streamDone) {
		const s2 = p.spinner();
		s2.start("Writing response...");
		responseText = await generatePromise;
		s2.stop("Generation complete.");
	} else {
		responseText = await generatePromise;
		s.stop("Generation complete.");
	}

	if (!responseText.trim()) {
		p.log.error(`Empty response from ${provider.name}.`);
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

	const shouldPush = await p.confirm({
		message: "Push to remote?",
	});
	if (p.isCancel(shouldPush) || !shouldPush) {
		p.outro("Done!");
		process.exit(0);
	}

	const pushSpinner = p.spinner();
	pushSpinner.start("Pushing...");
	try {
		await gitPush();
		pushSpinner.stop("Pushed.");
	} catch (err) {
		pushSpinner.stop("Push failed.");
		p.log.error(String(err));
		process.exit(1);
	}

	const shouldPR = await p.confirm({
		message: "Open PR?",
	});
	if (p.isCancel(shouldPR) || !shouldPR) {
		p.outro("Done!");
		process.exit(0);
	}

	const prSpinner = p.spinner();
	prSpinner.start("Creating PR...");
	try {
		await gitCreatePR(parsed.prTitle, parsed.prBody);
		prSpinner.stop("PR created.");
	} catch (err) {
		prSpinner.stop("PR creation failed.");
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
