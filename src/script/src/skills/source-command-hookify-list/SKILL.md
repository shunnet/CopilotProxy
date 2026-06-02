---
name: "source-command-hookify-list"
description: "List all configured hookify rules"
---

# source-command-hookify-list

Use this skill when the user asks to run the migrated source command `hookify-list`.

## Command Template

Find and display all hookify rules in a formatted table.

## Steps

1. Find all `.Codex/hookify.*.local.md` files
2. Read each file's frontmatter:
   - `name`
   - `enabled`
   - `event`
   - `action`
   - `pattern`
3. Display them as a table:

| Rule | Enabled | Event | Pattern | File |
|------|---------|-------|---------|------|

4. Show the rule count and remind the user that `/hookify-configure` can change state later.
