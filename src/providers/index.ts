import type { ProviderName } from "../config.ts";
import type { LLMProvider } from "./types.ts";
import { claudeProvider } from "./claude.ts";
import { auggieProvider } from "./auggie.ts";

export type { LLMProvider, LLMCallbacks } from "./types.ts";

export function getProvider(name: ProviderName): LLMProvider {
	switch (name) {
		case "claude":
			return claudeProvider;
		case "auggie":
			return auggieProvider;
		default:
			throw new Error(`Unknown provider: ${name}`);
	}
}
