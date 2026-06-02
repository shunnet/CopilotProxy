---
name: "source-command-hookify-configure"
description: "Enable or disable hookify rules interactively"
---

# source-command-hookify-configure

Use this skill when the user asks to run the migrated source command `hookify-configure`.

## Command Template

Interactively enable or disable existing hookify rules.

## Steps

1. Find all `.Codex/hookify.*.local.md` files
2. Read the current state of each rule
3. Present the list with current enabled / disabled status
4. Ask which rules to toggle
5. Update the `enabled:` field in the selected rule files
6. Confirm the changes
