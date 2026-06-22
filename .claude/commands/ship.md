---
description: Commit current changes, push, and open a PR via git-gen
---
Run the git-gen non-interactive flow to commit, push, and open a PR.

Usage: `/ship <ticket> <description>`
  - First argument is the JIRA ticket number (e.g. PROJ-123)
  - Everything after is the ticket description/summary

Execute:

```bash
bun run index.ts -t "$1" -m "${@:2}" -y -D
```

If no ticket is given, run with just the description and `-y`. Report the
generated commit message, PR title, and PR URL back to me when done.
