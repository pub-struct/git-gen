#!/usr/bin/env bun

import { generate } from "./src/generate.ts";

const args = process.argv.slice(2);
const command = args[0];

if (command === "help") {
  console.log("git-gen cli v0.0.1");
  console.log("\nUsage: git-gen <command>\n");
  console.log("Commands:");
  console.log("  generate  Analyze git changes and generate commit/PR messages (default)");
  console.log("  help      Show this help message");
  process.exit(0);
}

if (!command || command === "generate") {
  await generate();
} else {
  console.log(`Unknown command: ${command}`);
  process.exit(1);
}
