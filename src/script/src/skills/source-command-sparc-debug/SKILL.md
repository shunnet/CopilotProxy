---
name: "source-command-sparc-debug"
description: "🪲 Debugger - You troubleshoot runtime bugs, logic errors, or integration failures by tracing, inspecting, and ..."
---

# source-command-sparc-debug

Use this skill when the user asks to run the migrated source command `sparc-debug`.

## Command Template

# 🪲 Debugger

## Role Definition
You troubleshoot runtime bugs, logic errors, or integration failures by tracing, inspecting, and analyzing behavior.

## Custom Instructions
Use logs, traces, and stack analysis to isolate bugs. Avoid changing env configuration directly. Keep fixes modular. Refactor if a file exceeds 500 lines. Use `new_task` to delegate targeted fixes and return your resolution via `attempt_completion`.

## Available Tools
- **read**: File reading and viewing
- **edit**: File modification and creation
- **browser**: Web browsing capabilities
- **mcp**: Model Context Protocol tools
- **command**: Command execution

## Usage

### Option 1: Using MCP Tools (Preferred in Codex)
```javascript
mcp__claude-flow__sparc_mode {
  mode: "debug",
  task_description: "fix memory leak in service",
  options: {
    namespace: "debug",
    non_interactive: false
  }
}
```

### Option 2: Using NPX CLI (Fallback when MCP not available)
```bash
# Use when running from terminal or MCP tools unavailable
npx Codex-flow sparc run debug "fix memory leak in service"

# For alpha features
npx Codex-flow@alpha sparc run debug "fix memory leak in service"

# With namespace
npx Codex-flow sparc run debug "your task" --namespace debug

# Non-interactive mode
npx Codex-flow sparc run debug "your task" --non-interactive
```

### Option 3: Local Installation
```bash
# If Codex-flow is installed locally
./Codex-flow sparc run debug "fix memory leak in service"
```

## Memory Integration

### Using MCP Tools (Preferred)
```javascript
// Store mode-specific context
mcp__claude-flow__memory_usage {
  action: "store",
  key: "debug_context",
  value: "important decisions",
  namespace: "debug"
}

// Query previous work
mcp__claude-flow__memory_search {
  pattern: "debug",
  namespace: "debug",
  limit: 5
}
```

### Using NPX CLI (Fallback)
```bash
# Store mode-specific context
npx Codex-flow memory store "debug_context" "important decisions" --namespace debug

# Query previous work
npx Codex-flow memory query "debug" --limit 5
```
