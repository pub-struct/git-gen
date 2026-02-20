# git-gen CLI

Bun-based CLI tool. No compilation — run directly with `bun run index.ts`.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package>` instead of `npx <package>`
- Bun automatically loads .env, so don't use dotenv.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- `Bun.$\`cmd\`` instead of execa.

## Testing

Use `bun test` to run tests.

## Important

- **Do NOT commit or push** — only generate commit messages, PR titles, and PR bodies when asked. The user handles git operations themselves.
