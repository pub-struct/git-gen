# git-gen

A Bun CLI that analyzes git changes and uses Claude to generate commit messages and PR bodies following your team's conventions.

## Setup

```bash
bun install
```

Requires Claude Code to be installed and authenticated.

## Usage

```bash
bun run index.ts           # default: runs generate (interactive)
bun run index.ts generate  # same as above
bun run index.ts help      # show help
```

### Non-interactive (args)

Pass the ticket and description as flags to skip the prompts. When both a
ticket and a message are provided (or you pass `-y`), git-gen runs the entire
flow — commit, push, and open the PR — without asking anything:

```bash
bun run index.ts -t PROJ-123 -m "Add login button"        # full auto flow
bun run index.ts -t PROJ-123 -m "Fix startup crash" -y     # explicit
```

Options (for `generate`):

| Flag | Alias | Description |
| --- | --- | --- |
| `--ticket` | `-t` | JIRA ticket number (e.g. `PROJ-123`) |
| `--message` | `-m`, `--summary`, `-d`, `--description` | Ticket summary / description |
| `--yes` | `-y` | Run the full flow (commit, push, PR) without prompts |
| `--draft` | `-D` | Create the PR directly as a draft, then open it in the browser |

## Prompt Files

The CLI auto-detects your project by matching the current directory against prompt files in `src/prompt/`.

To add your team's conventions, create a markdown file:

```
src/prompt/<name>.md
```

The `<name>` should match a segment in your project path. For example, if you work in `/Users/you/work/acme/app`, create `src/prompt/acme.md`.

The prompt file should describe your commit message format, PR title/body conventions, and any relevant prefixes or templates. See `src/prompt/example.md` for a reference.
