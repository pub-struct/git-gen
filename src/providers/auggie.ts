import type { LLMProvider, LLMCallbacks } from "./types.ts";

export const auggieProvider: LLMProvider = {
	name: "Auggie",

	async generate(prompt: string, callbacks: LLMCallbacks): Promise<string> {
		callbacks.onGenerating?.();

		const result =
			await Bun.$`auggie --print --quiet --instruction ${prompt} --max-turns 1`.text();

		if (!result.trim()) {
			throw new Error("Empty response from Auggie.");
		}

		return result;
	},
};
