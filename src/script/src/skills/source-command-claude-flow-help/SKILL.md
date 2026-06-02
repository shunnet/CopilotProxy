---
name: "source-command-claude-flow-help"
description: "Show Codex-Flow commands and usage"
---

# source-command-claude-flow-help

Use this skill when the user asks to run the migrated source command `claude-flow-help`.

## Command Template

# Codex-Flow Commands

## 🌊 Codex-Flow: Agent Orchestration Platform

Codex-Flow is the ultimate multi-terminal orchestration platform that revolutionizes how you work with Codex.

## Core Commands

### 🚀 System Management
- `./Codex-flow start` - Start orchestration system
- `./Codex-flow start --ui` - Start with interactive process management UI
- `./Codex-flow status` - Check system status
- `./Codex-flow monitor` - Real-time monitoring
- `./Codex-flow stop` - Stop orchestration

### 🤖 Agent Management
- `./Codex-flow agent spawn <type>` - Create new agent
- `./Codex-flow agent list` - List active agents
- `./Codex-flow agent info <id>` - Agent details
- `./Codex-flow agent terminate <id>` - Stop agent

### 📋 Task Management
- `./Codex-flow task create <type> "description"` - Create task
- `./Codex-flow task list` - List all tasks
- `./Codex-flow task status <id>` - Task status
- `./Codex-flow task cancel <id>` - Cancel task
- `./Codex-flow task workflow <file>` - Execute workflow

### 🧠 Memory Operations
- `./Codex-flow memory store "key" "value"` - Store data
- `./Codex-flow memory query "search"` - Search memory
- `./Codex-flow memory stats` - Memory statistics
- `./Codex-flow memory export <file>` - Export memory
- `./Codex-flow memory import <file>` - Import memory

### ⚡ SPARC Development
- `./Codex-flow sparc "task"` - Run SPARC orchestrator
- `./Codex-flow sparc modes` - List all 17+ SPARC modes
- `./Codex-flow sparc run <mode> "task"` - Run specific mode
- `./Codex-flow sparc tdd "feature"` - TDD workflow
- `./Codex-flow sparc info <mode>` - Mode details

### 🐝 Swarm Coordination
- `./Codex-flow swarm "task" --strategy <type>` - Start swarm
- `./Codex-flow swarm "task" --background` - Long-running swarm
- `./Codex-flow swarm "task" --monitor` - With monitoring
- `./Codex-flow swarm "task" --ui` - Interactive UI
- `./Codex-flow swarm "task" --distributed` - Distributed coordination

### 🌍 MCP Integration
- `./Codex-flow mcp status` - MCP server status
- `./Codex-flow mcp tools` - List available tools
- `./Codex-flow mcp config` - Show configuration
- `./Codex-flow mcp logs` - View MCP logs

### 🤖 Codex Integration
- `./Codex-flow Codex spawn "task"` - Spawn Codex with enhanced guidance
- `./Codex-flow Codex batch <file>` - Execute workflow configuration

## 🌟 Quick Examples

### Initialize with SPARC:
```bash
npx -y Codex-flow@latest init --sparc
```

### Start a development swarm:
```bash
./Codex-flow swarm "Build REST API" --strategy development --monitor --review
```

### Run TDD workflow:
```bash
./Codex-flow sparc tdd "user authentication"
```

### Store project context:
```bash
./Codex-flow memory store "project_requirements" "e-commerce platform specs" --namespace project
```

### Spawn specialized agents:
```bash
./Codex-flow agent spawn researcher --name "Senior Researcher" --priority 8
./Codex-flow agent spawn developer --name "Lead Developer" --priority 9
```

## 🎯 Best Practices
- Use `./Codex-flow` instead of `npx Codex-flow` after initialization
- Store important context in memory for cross-session persistence
- Use swarm mode for complex tasks requiring multiple agents
- Enable monitoring for real-time progress tracking
- Use background mode for tasks > 30 minutes

## 📚 Resources
- Documentation: https://github.com/ruvnet/Codex-flow/docs
- Examples: https://github.com/ruvnet/Codex-flow/examples
- Issues: https://github.com/ruvnet/Codex-flow/issues
