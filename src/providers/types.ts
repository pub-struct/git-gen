export interface LLMCallbacks {
	onThinkingStart?: () => void;
	onThinkingChunk?: (chunk: string) => void;
	onThinkingEnd?: () => void;
	onGenerating?: () => void;
}

export interface LLMProvider {
	name: string;
	generate(prompt: string, callbacks: LLMCallbacks): Promise<string>;
}
