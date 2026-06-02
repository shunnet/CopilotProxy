---
name: "source-command-claude-flow-memory"
description: "Interact with Codex-Flow memory system"
---

# source-command-claude-flow-memory

Use this skill when the user asks to run the migrated source command `claude-flow-memory`.

## Command Template

# 🧠 Codex-Flow Memory System

The memory system provides persistent storage for cross-session and cross-agent collaboration with CRDT-based conflict resolution.

## Store Information
```bash
# Store with default namespace
./Codex-flow memory store "key" "value"

# Store with specific namespace
./Codex-flow memory store "architecture_decisions" "microservices with API gateway" --namespace arch
```

## Query Memory
```bash
# Search across all namespaces
./Codex-flow memory query "authentication"

# Search with filters
./Codex-flow memory query "API design" --namespace arch --limit 10
```

## Memory Statistics
```bash
# Show overall statistics
./Codex-flow memory stats

# Show namespace-specific stats
./Codex-flow memory stats --namespace project
```

## Export/Import
```bash
# Export all memory
./Codex-flow memory export full-backup.json

# Export specific namespace
./Codex-flow memory export project-backup.json --namespace project

# Import memory
./Codex-flow memory import backup.json
```

## Cleanup Operations
```bash
# Clean entries older than 30 days
./Codex-flow memory cleanup --days 30

# Clean specific namespace
./Codex-flow memory cleanup --namespace temp --days 7
```

## 🗂️ Namespaces
- **default** - General storage
- **agents** - Agent-specific data and state
- **tasks** - Task information and results
- **sessions** - Session history and context
- **swarm** - Swarm coordination and objectives
- **project** - Project-specific context
- **spec** - Requirements and specifications
- **arch** - Architecture decisions
- **impl** - Implementation notes
- **test** - Test results and coverage
- **debug** - Debug logs and fixes

## 🎯 Best Practices

### Naming Conventions
- Use descriptive, searchable keys
- Include timestamp for time-sensitive data
- Prefix with component name for clarity

### Organization
- Use namespaces to categorize data
- Store related data together
- Keep values concise but complete

### Maintenance
- Regular backups with export
- Clean old data periodically
- Monitor storage statistics
- Compress large values

## Examples

### Store SPARC context:
```bash
./Codex-flow memory store "spec_auth_requirements" "OAuth2 + JWT with refresh tokens" --namespace spec
./Codex-flow memory store "arch_api_design" "RESTful microservices with GraphQL gateway" --namespace arch
./Codex-flow memory store "test_coverage_auth" "95% coverage, all tests passing" --namespace test
```

### Query project decisions:
```bash
./Codex-flow memory query "authentication" --namespace arch --limit 5
./Codex-flow memory query "test results" --namespace test
```

### Backup project memory:
```bash
./Codex-flow memory export project-$(date +%Y%m%d).json --namespace project
```
