import { $ } from "bun";

export async function getGitDiff(): Promise<string> {
	const staged = await $`git diff --cached`.text();
	if (staged.trim()) return staged;

	const unstaged = await $`git diff`.text();
	return unstaged;
}

export async function getChangedFiles(): Promise<string> {
	return await $`git status --short`.text();
}

export async function gitCommit(message: string): Promise<void> {
	await $`git add -A`;
	await $`git commit -m ${message}`;
}

export async function gitPush(): Promise<void> {
	await $`git push -u origin HEAD`;
}

export interface CreatePROptions {
	draft?: boolean;
}

export async function gitCreatePR(
	title: string,
	body: string,
	options: CreatePROptions = {},
): Promise<void> {
	if (options.draft) {
		// Create the draft PR directly (no manual confirmation), then open it.
		await $`gh pr create --draft --title ${title} --body ${body}`;
		await $`gh pr view --web`;
		return;
	}

	// Default: open the pre-filled compare page in the browser to confirm.
	await $`gh pr create --title ${title} --body ${body} --web`;
}
