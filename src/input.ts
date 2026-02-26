import { createInterface } from "node:readline";

export function readMultiLine(message: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stderr,
		});

		console.error(`${message} (press Enter twice to finish)`);

		const lines: string[] = [];

		rl.on("line", (line) => {
			if (line === "" && lines.length > 0) {
				rl.close();
				return;
			}
			lines.push(line);
		});

		rl.on("close", () => {
			resolve(lines.join("\n").trim());
		});
	});
}
