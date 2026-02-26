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

export async function gitCreatePR(title: string, body: string): Promise<void> {
	await $`gh pr create --title ${title} --body ${body} --web`;
}
