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

export interface GenerateOptions {
	ticket?: string;
	summary?: string;
	yes?: boolean;
	draft?: boolean;
	dryRun?: boolean;
}

export async function generate(options: GenerateOptions = {}) {
	p.intro("git-gen");

	// Auto mode: run the whole flow (commit, push, PR) without any prompts.
	// Triggered by --yes, or implicitly when both ticket and summary are passed via args.
	const auto =
		options.yes === true ||
		(options.ticket !== undefined && options.summary !== undefined);

	const config = await getConfig();
	const provider = getProvider(config.provider);

	let company = await detectCompany();
	if (company) {
		p.log.info(`Detected project: ${company}`);
	} else {
		company = "default";
		p.log.info("No project-specific prompt matched; using the default prompt.");
	}

	const [diff, changedFiles] = await Promise.all([
		getGitDiff(),
		getChangedFiles(),
	]);

	if (!diff.trim() && !changedFiles.trim()) {
		p.log.error("No git changes detected. Stage or modify files first.");
		process.exit(1);
	}

	let ticket: string;
	if (options.ticket !== undefined) {
		ticket = options.ticket;
		if (ticket) p.log.info(`Ticket: ${ticket}`);
	} else if (auto) {
		ticket = "";
	} else {
		const answer = await p.text({
			message: "JIRA ticket number (or press enter to skip):",
			placeholder: "e.g. PROJ-123",
		});
		if (p.isCancel(answer)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}
		ticket = answer;
	}

	let summary: string;
	if (options.summary !== undefined) {
		summary = options.summary;
	} else if (auto) {
		summary = "";
	} else {
		p.log.step("Paste the JIRA ticket summary (press Enter twice to finish):");
		summary = await readMultiLine("");
	}

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

	let responseText: string;

	if (auto) {
		// Args/auto mode: keep it quiet — no thinking stream, just a simple indicator.
		const s = p.spinner();
		s.start("Processing...");
		try {
			responseText = await provider.generate(userPrompt, {});
			s.stop("Processed.");
		} catch (err) {
			s.stop("Generation failed.");
			p.log.error(String(err));
			process.exit(1);
		}
	} else {
		responseText = await generateInteractive(provider, userPrompt);
	}

	if (!responseText.trim()) {
		p.log.error(`Empty response from ${provider.name}.`);
		process.exit(1);
	}

	const parsed = parseResponse(responseText);

	// Show the generated output when interactive, or always on a dry run (the
	// whole point of a dry run is to preview it). Stay quiet on real auto runs.
	if (!auto || options.dryRun) {
		p.note(parsed.commitMessage, "Commit Message");
		p.note(parsed.prTitle, "PR Title");
		p.note(parsed.prBody, "PR Body");
	}

	if (options.dryRun) {
		p.outro("Dry run — nothing committed, pushed, or opened.");
		return;
	}

	// In auto mode we skip every confirmation; otherwise ask before each step.
	if (!auto && !(await confirmStep("Commit changes?"))) {
		p.outro("Done!");
		process.exit(0);
	}
	await runStep("Committing changes...", "Changes committed.", "Commit failed.", () =>
		gitCommit(parsed.commitMessage),
	);

	if (!auto && !(await confirmStep("Push to remote?"))) {
		p.outro("Done!");
		process.exit(0);
	}
	await runStep("Pushing...", "Pushed.", "Push failed.", () => gitPush());

	if (!auto && !(await confirmStep("Open PR?"))) {
		p.outro("Done!");
		process.exit(0);
	}
	await runStep(
		options.draft ? "Creating draft PR..." : "Creating PR...",
		options.draft ? "Draft PR created." : "PR created.",
		"PR creation failed.",
		() => gitCreatePR(parsed.prTitle, parsed.prBody, { draft: options.draft }),
	);

	p.outro("All done!");
}

// Interactive generation: streams the model's thinking to the terminal in real time.
async function generateInteractive(
	provider: ReturnType<typeof getProvider>,
	userPrompt: string,
): Promise<string> {
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

	if (!streamDone) {
		const s2 = p.spinner();
		s2.start("Writing response...");
		const responseText = await generatePromise;
		s2.stop("Generation complete.");
		return responseText;
	}

	const responseText = await generatePromise;
	s.stop("Generation complete.");
	return responseText;
}

async function confirmStep(message: string): Promise<boolean> {
	const answer = await p.confirm({ message });
	return !p.isCancel(answer) && answer === true;
}

async function runStep(
	startMsg: string,
	successMsg: string,
	failMsg: string,
	action: () => Promise<void>,
): Promise<void> {
	const spinner = p.spinner();
	spinner.start(startMsg);
	try {
		await action();
		spinner.stop(successMsg);
	} catch (err) {
		spinner.stop(failMsg);
		p.log.error(String(err));
		process.exit(1);
	}
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
