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
