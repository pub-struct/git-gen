import { query } from "@anthropic-ai/claude-agent-sdk";
import type { LLMProvider, LLMCallbacks } from "./types.ts";

export const claudeProvider: LLMProvider = {
	name: "Claude",

	async generate(prompt: string, callbacks: LLMCallbacks): Promise<string> {
		const stream = query({
			prompt,
			options: {
				model: "claude-sonnet-4-6",
				maxTurns: 1,
				thinking: { type: "enabled", budgetTokens: 10000 },
				includePartialMessages: true,
				tools: [],
			},
		});

		let responseText = "";
		let thinkingStarted = false;

		for await (const message of stream) {
			if (message.type === "stream_event") {
				const event = message.event;
				if (event.type === "content_block_delta") {
					const delta = event.delta as any;
					if (delta.type === "thinking_delta") {
						if (!thinkingStarted) {
							thinkingStarted = true;
							callbacks.onThinkingStart?.();
						}
						callbacks.onThinkingChunk?.(delta.thinking);
					} else if (delta.type === "text_delta") {
						responseText += delta.text;
					}
				} else if (event.type === "content_block_stop") {
					if (thinkingStarted) {
						callbacks.onThinkingEnd?.();
						thinkingStarted = false;
					}
				}
			} else if (message.type === "result") {
				if ((message as any).subtype !== "success") {
					throw new Error(`Generation failed: ${(message as any).subtype}`);
				}
				break;
			}
		}

		// Ensure thinking stream is closed
		if (thinkingStarted) {
			callbacks.onThinkingEnd?.();
		}

		return responseText;
	},
};
