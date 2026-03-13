import * as p from "@clack/prompts";
import { homedir } from "os";
import { join } from "path";

export type ProviderName = "claude" | "auggie";

export interface Config {
	provider: ProviderName;
}

const CONFIG_DIR = join(homedir(), ".config", "git-gen");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export async function loadConfig(): Promise<Config | null> {
	const file = Bun.file(CONFIG_PATH);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as Config;
	} catch {
		return null;
	}
}

export async function saveConfig(config: Config): Promise<void> {
	await Bun.$`mkdir -p ${CONFIG_DIR}`.quiet();
	await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export async function setupProvider(): Promise<Config> {
	const provider = await p.select({
		message: "Which AI provider would you like to use?",
		options: [
			{ value: "claude", label: "Claude (Anthropic)", hint: "requires Claude Code CLI" },
			{ value: "auggie", label: "Auggie (Augment)", hint: "requires auggie CLI" },
		],
	});

	if (p.isCancel(provider)) {
		p.cancel("Setup cancelled.");
		process.exit(0);
	}

	const config: Config = { provider: provider as ProviderName };
	await saveConfig(config);
	p.log.success(`Provider set to ${provider}. Config saved to ${CONFIG_PATH}`);
	return config;
}

export async function getConfig(): Promise<Config> {
	const existing = await loadConfig();
	if (existing) return existing;
	return setupProvider();
}
