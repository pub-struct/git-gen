# git-gen

A Bun CLI that analyzes git changes and uses Claude to generate commit messages and PR bodies following your team's conventions.

## Setup

```bash
bun install
```

Requires Claude Code to be installed and authenticated.

## Usage

```bash
bun run index.ts           # default: runs generate
bun run index.ts generate  # same as above
bun run index.ts help      # show help
```

## Prompt Files

The CLI auto-detects your project by matching the current directory against prompt files in `src/prompt/`.

To add your team's conventions, create a markdown file:

```
src/prompt/<name>.md
```

The `<name>` should match a segment in your project path. For example, if you work in `/Users/you/work/acme/app`, create `src/prompt/acme.md`.

The prompt file should describe your commit message format, PR title/body conventions, and any relevant prefixes or templates. See `src/prompt/example.md` for a reference.
