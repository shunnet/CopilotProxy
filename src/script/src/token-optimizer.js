// ── Token Optimization ──
// Enriched from https://github.com/kitpilot/kit-pilot (delta context stripping, ~3× fewer tokens; tool-output compacting)
// Enriched from https://github.com/barrersoftware/copilot-plugin-mcp-server (67% token reduction)
// Enriched from https://github.com/diegosouzapw/OmniRoute (RTK+Caveman stacked compression up to ~95%)
// Enriched from https://github.com/JuliusBrussee/caveman (30+ regex rules for filler removal)
//
// Compression levels:
//   Off       (0%)    — No compression
//   Lite      (~15%)  — Whitespace collapse, dedup system prompts
//   Caveman   (~30%)  — 30+ regex rules: filler removal, context condensation, structural compression
//   Aggressive(~50%)  — All Caveman + progressive message aging + tool result summarization
//   Ultra     (~75%)  — All Aggressive + heuristic token pruning + stopword removal
//   RTK       (60-90%)— Command-aware filters for shell/test/build/git output
//   Stacked   (78-95%)— RTK first, then Caveman — best for mixed prompts with tool logs + prose
//   Delta     (60-90%)— Historical VS context stripping (KitPilot) + tool output compacting
//
// Also compresses tool descriptions, schemas, identity prompts, and tool instructions.
import { log, debug } from "./logger.js";
import { t } from "./i18n.js";
//
// Compression strategies:
//   1. Strip verbose prefixes ("This tool allows you to", "Use this function to")
//   2. Remove clause-level redundancy ("the following", "is not case sensitive")
//   3. Truncate to first sentence (max ~120 chars)
//   4. Strip property-level descriptions from tool schemas
//   5. Caveman: 30+ regex rules for filler removal, structural compression
//   6. RTK: command-aware output compression (shell, git, grep, test, build)
//   7. Stacked: RTK → Caveman chain for maximum savings
//   8. Delta: strip historical VS context blocks, compact consumed tool outputs

// ── Compression level enum ──
export const CompressionLevel = Object.freeze({
  OFF: "off",
  LITE: "lite",
  CAVEMAN: "caveman",
  STANDARD: "standard", // alias for caveman
  AGGRESSIVE: "aggressive",
  ULTRA: "ultra",
  RTK: "rtk",
  STACKED: "stacked",
  DELTA: "delta",
});

// ---- Compression thresholds ----
const LS_COMPRESS_THRESHOLD = 300;
const DIFF_COMPRESS_THRESHOLD = 1000;
const SUMMARY_CHARS = 500;
const HEURISTIC_PRUNE_MIN_LENGTH = 200;
const VS_BLOCK_HEURISTIC_LENGTH = 2000;
const CONSUMED_TOOL_OUTPUT_LENGTH = 500;
const CONSUMED_TOOL_SNIPPET = 200;

// ---- Common term substitutions ----
function _substitute(text) {
  return text
    .replace(/GitHub\s*Copilot\s*Chat/gi, "Copilot Chat")
    .replace(/directory/gi, "dir")
    .replace(/directories/gi, "dirs")
    .replace(/parameter\s+/gi, "param ")
    .replace(/parameters\s*/gi, "params ")
    .replace(/\s{2,}/g, " ");
}

// ═══════════════════════════════════════════════════
// Tool description compression (from copilot-plugin-mcp-server)
// ═══════════════════════════════════════════════════

export function compressDescription(desc) {
  if (!desc) return "";
  let compressed = desc
    .replace(/^(This tool|Use this tool|This function|Use this function)\s*(allows you to|enables you to|lets you|helps you|can be used to)?\s*/gi, "")
    .replace(/\s+(allows you to|enables you to|lets you|helps you to)\s+/gi, " ")
    .replace(/the\s+following\s+/gi, "")
    .replace(/\.?\s*You\s+must\s+have\s+.+?\s+access.+?\./gi, "")
    .replace(/\.?\s*The\s+.*?\s+is\s+not\s+case\s+sensitive\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (compressed.length > 120) {
    const first = compressed.match(/^[^.!?]+[.!?]/);
    compressed = first ? first[0] : compressed.slice(0, 120) + "...";
  }
  compressed = _substitute(compressed);

  return compressed;
}

export function compressToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;

  if (schema.default !== undefined) out.default = schema.default;
  if (schema.description) out.description = schema.description;

  if (schema.properties) {
    out.properties = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      out.properties[key] = compressToolSchema(prop);
    }
  }
  if (schema.items) out.items = compressToolSchema(schema.items);

  return out;
}

export function compressToolDefinitions(tools) {
  if (!tools?.length) return tools;
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.function.name,
      description: compressDescription(t.function.description),
      parameters: compressToolSchema(t.function.parameters),
    },
  }));
}

// ═══════════════════════════════════════════════════
// Identity & instruction compression
// ═══════════════════════════════════════════════════

export function compactIdentity(model, thinking) {
  const thinkNote = thinking ? ` (${thinking.toLowerCase()} thinking mode)` : "";
  return t("identityOverride", model, thinkNote);
}

// ── Agent behavior core (from Copilot gpt-4.1 + Cursor Agent prompts) ──
// ~80 tokens — shared across all clients
function _agentCore() {
  return `You are an expert coding agent. Work autonomously until the task is resolved — don't ask permission, act. Gather context before changes; don't assume. Don't repeat yourself after tool calls. Prefer reading large file sections over multiple small reads — minimize tool calls. When starting a multi-step task, ALWAYS create a numbered step plan (1. 2. 3.) and persist it with the plan tool before acting. Steps must be concrete: each step names specific files, edits, or searches. Never leave steps empty or vague like "Analyze code" — instead write "Read X.cs to find Y pattern". After each step, mark it complete and show progress (e.g., [1/5] done). Before manual research (web search, codebase exploration), check any attached instructions/copilot-instructions (marked "# Copilot Instructions") in the conversation — that is your agents.md equivalent. Only proceed with manual research if those instructions lack sufficient detail.`;
}

// ── Tool usage rules (token-optimized from Copilot/Cursor patterns) ──
function _toolUsageCore() {
  return `TOOL RULES:
- FILE READING ORDER: ① First, read the ACTUAL source code files that contain the logic you need to review or change (the main .cs/.py/.js/.ts etc files, not config files). Use startLine:1 endLine:500. ② Only read project files (.csproj, package.json, pyproject.toml, etc.) if you need build settings or dependencies. ③ Skip auto-generated files (.Designer.cs, *.g.cs, __pycache__, node_modules, etc.) unless the task explicitly involves them.
- READ FILES ONCE and don't re-read what you already have in context.
- Use tools instead of printing codeblocks or terminal commands
- Call independent tools in parallel when possible
- Don't say tool names to the user — describe actions naturally
- After editing a file, validate the change (check for errors)
- If info is discoverable via tools, prefer that over asking the user
- Search first (grep/semantic) to locate code, then read the FULL file in one call
- You have full context of all prior tool results — don't re-read files you already read`;
}

// ── Edit file rules (from Copilot editFileInstructions) ──
// ~60 tokens
function _editFileRules() {
  return `EDIT RULES:
- Avoid repeating existing code — use "// ...existing code..." comments for unchanged regions
- Plan all edits mentally first, then apply in ONE edit per file — do NOT send multiple small edits
- Group changes by file; use the edit tool once per file for multiple changes
- Follow existing code style and conventions in the file`;
}

// ── VS-specific project file workflow ──
// ~80 tokens
function _vsProjectRules() {
  return `VS FILE CREATION WORKFLOW:
1. Output new file as: ## \`filename\` then \`\`\`lang code \`\`\`
2. Add to project: ## \`project.ext\` then \`\`\`xml <ItemGroup><Content Include="filename" /></ItemGroup> \`\`\`
If VS terminal unavailable, output command in \`\`\`powershell for user to paste.`;
}

// ── SQL Studio rules ──
// ~50 tokens
function _sqlRules() {
  return `You are a SQL/database expert. Help with queries, schema design, performance tuning, and migrations. Prefer safe, reversible operations. Always show the SQL before executing. Explain execution plans when relevant.`;
}

// ── Enriched tool instructions for VS/agent mode (native tool_calls) ──
export function compactToolInstructions(clientTag) {
  const parts = [_agentCore(), _toolUsageCore(), _editFileRules()];
  if (clientTag && clientTag !== "vscode" && clientTag !== "sql") {
    parts.push(_vsProjectRules());
  }
  if (clientTag === "sql") {
    parts.push(_sqlRules());
  }
  parts.push("Call task_complete() when the task is fully done.");
  parts.push(`PLAN TOOL — REQUIRED for any multi-step task.

When you call plan(), planMarkdown MUST be filled with the following template. Copy the structure and fill in every section:

---
# 🎯 [Task Title — a short, specific name for this plan]
**概述**: [One sentence summarizing the goal]

**进度**: 0% [░░░░░░░░░░]

## 📝 计划步骤
1. **[Step name]** — Read/Writes: _specific file paths_ — _What to check after_
2. **[Step name]** — Read/Writes: _specific file paths_ — _What to check after_
3. ...

## ⚠️ 注意事项
- [Risk or dependency]

## ✅ 验证标准
- [ ] [How to confirm the task is done]
---

Each step MUST name real file paths. Use \`manage_todo_list()\` to mark steps complete.`);
  parts.push(`PROGRESS: After each step, call manage_todo_list() with the updated todoList. Show progress like [2/5] done in your text response.`);
  return parts.join("\n\n");
}

// ── Enriched tool instructions for Ollama/VSCode endpoint ──
export function compactOllamaToolInstructions(tools, clientTag) {
  const toolList = tools.map(t =>
    `${t.function.name}: ${t.function.description ? compressDescription(t.function.description) : "(no desc)"}`
  ).join("\n");
  const parts = [_agentCore(), _toolUsageCore(), _editFileRules()];
  if (clientTag === "sql") parts.push(_sqlRules());
  parts.push(`Tools:\n${toolList}\nFormat: \`\`\`tool\n{"name":"...","arguments":{...}}\n\`\`\``);
  return parts.join("\n\n");
}

export function compactCodeCompletionPrompt() {
  return "Complete code. Return only the completion, no explanations.";
}

// ═══════════════════════════════════════════════════
// Lite compression (~15% savings)
// Whitespace collapse, dedup system prompts
// ═══════════════════════════════════════════════════

function _compressLite(text) {
  if (!text) return text;
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

// ═══════════════════════════════════════════════════
// Caveman compression (~30% savings)
// 30+ regex rules: filler removal, context condensation,
// structural compression, multi-turn dedup
// Inspired by https://github.com/JuliusBrussee/caveman
// ═══════════════════════════════════════════════════

const CAVEMAN_RULES = [
  // ── Filler / politeness removal ──
  { re: /^(ok(ay)?|sure|alright|got\s*it|understood|noted|sounds?\s*good|makes?\s*sense)[,.:;!]*\s*/gim, rep: "" },
  { re: /\b(I\s*hope\s+this\s+helps?|I\s*hope\s+this\s+is\s+helpful|hope\s+that\s+helps?)[.!]*\s*/gi, rep: "" },
  { re: /\b(please\s+let\s+me\s+know\s+if\s+(you\s+have\s+(any|further)\s+)?questions?|let\s+me\s+know\s+if\s+you\s+need\s+(anything|help|further|more)\s+else)[.!]*\s*/gi, rep: "" },
  { re: /\b(feel\s+free\s+to\s+(ask|reach\s+out)|don\x27t\s+hesitate\s+to\s+(ask|reach\s+out))[.!]*\s*/gi, rep: "" },
  { re: /\b(I(\x27m|\s+am)\s+(happy|glad)\s+to\s+help|happy\s+to\s+(assist|help|clarify))[.!]*\s*/gi, rep: "" },
  { re: /\b(you(\x27re|\s+are)\s+welcome|no\s+problem|my\s+pleasure)[.!]*\s*/gi, rep: "" },
  { re: /\bthanks?(\s*you)?(\s+so\s+much)?(\s+for\s+(asking|your\s+question|pointing|bringing))?[.!]*\s*/gi, rep: "" },
  { re: /\b(that(\x27s|\s+is)\s+a\s+(good|great|excellent|interesting|valid)\s+question)[,.\s]*/gi, rep: "" },
  { re: /\b(I\s+apologize|I(\x27m|\s+am)\s+sorry|sorry\s+(about|for)\s+that|my\s+(apologies|bad|mistake))[.!]*\s*/gi, rep: "" },

  // ── Redundant preamble / context reminders ──
  { re: /^(here(\x27s|\s+is)\s+(the\s+)?(an\s+)?(overview|summary|breakdown|explanation|update)\s*(of\s+the\s+)?(code|changes?|file|situation|problem)?[,:]*\s*)/gim, rep: "" },
  { re: /^(based\s+on\s+(the\s+|our\s+)?(above|previous|earlier|current|existing)\s+(discussion|conversation|context|analysis|code|information)[,:]*\s*)/gim, rep: "" },
  { re: /^(as\s+(I\s+)?(mentioned|discussed|explained|noted|stated)\s+(above|before|earlier|previously)[,:]*\s*)/gim, rep: "" },
  { re: /^(to\s+(answer|address|solve|respond\s+to)\s+your\s+question[,:]*\s*)/gim, rep: "" },
  { re: /^(looking\s+at\s+(the|your)\s+(code|file|project|setup|configuration)[,:]*\s*)/gim, rep: "" },
  { re: /^(from\s+the\s+(provided|given|attached)\s+(code|snippet|file|information|context)[,:]*\s*)/gim, rep: "" },

  // ── Verbose connector phrases ──
  { re: /\b(in\s+addition\s+to\s+(that|this)|furthermore|moreover|additionally|also\s+note\s+that|it(\x27s|\s+is)\s+worth\s+(noting|mentioning)|keep\s+in\s+mind\s+that)[,.\s]*/gi, rep: "" },
  { re: /\b(on\s+the\s+(other|flip)\s+side|conversely|alternatively|that\s+said|having\s+said\s+that)[,.\s]*/gi, rep: "" },
  { re: /\b(in\s+(summary|conclusion|short|essence|other\s+words)|to\s+(summarize|wrap\s+up|put\s+it\s+(all|simply)|be\s+(clear|specific|precise)))[,.\s]*/gi, rep: "" },
  { re: /\b(as\s+(a|an)\s+(result|consequence|side\s+note|example|reference|reminder|general\s+rule))[,.\s]*/gi, rep: "" },
  { re: /\b(for\s+(example|instance|reference|clarity|context|comparison|more\s+information|further\s+details))[,.\s]*/gi, rep: "" },

  // ── Code explanation condensation ──
  { re: /\b(this\s+(code|function|method|class|block|snippet|line|approach|solution|implementation|pattern)\s*(is|will|would|does|should|can|allows?)\s*)/gi, rep: "" },
  { re: /\b(the\s+(reason|issue|problem|bug|error|challenge)\s+(is|was|appears?\s+to\s+be|seems?\s+to\s+be|might\s+be)\s+that)/gi, rep: "" },
  { re: /\b((what|which)\s+(this|it)\s+does\s+is\s*)/gi, rep: "" },
  { re: /\b(this\s+will\s+(result\s+in|lead\s+to|cause|trigger|produce|generate|create|return)\s*)/gi, rep: "" },
  { re: /\b(you\s+(can|could|should|might\s+want\s+to|may\s+wish\s+to)\s+(use|try|consider|apply|implement|call|run))\s*/gi, rep: "use " },
  { re: /\b(what\s+you\s+need\s+(to\s+do|is)\s+is\s*)/gi, rep: "" },
  { re: /\b(you\x27ll|you\s+will)\s+need\s+to\s+/gi, rep: "" },
  { re: /\b(I\s+(would|will|\x27ll|can|could)\s+(recommend|suggest|advise|propose))\s*(you\s+)?/gi, rep: "" },

  // ── Structural compression ──
  { re: /^(###+\s+)/gm, rep: "## " },
  { re: /^(\*\s*){3,}$/gm, rep: "---" },
  { re: /^(\-{3,}|_{3,})$/gm, rep: "---" },

  // ── Multi-turn dedup: remove repeated lines ──
  // Handled separately in _dedupRepeatedLines()

  // ── Numbered list compression ──
  { re: /^(\d+)[.)]\s+/gm, rep: "$1) " },

  // ── Trailing cleanup ──
  { re: /[ \t]+$/gm, rep: "" },
  { re: /\n{3,}/g, rep: "\n\n" },
];

function _applyCaveman(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const rule of CAVEMAN_RULES) {
    result = result.replace(rule.re, rule.rep);
  }
  // Dedup repeated consecutive lines
  result = _dedupRepeatedLines(result);
  // Collapse multiple spaces
  result = result.replace(/\s{2,}/g, " ").replace(/^\s+|\s+$/gm, "").trim();
  return result;
}

function _dedupRepeatedLines(text) {
  const lines = text.split("\n");
  const deduped = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && i > 0 && trimmed === (lines[i - 1] || "").trim()) continue;
    // Also dedup headers that repeat
    if (trimmed.startsWith("## ") && i > 0) {
      const prevTrimmed = (lines[i - 1] || "").trim();
      if (prevTrimmed.startsWith("## ") && trimmed === prevTrimmed) continue;
    }
    deduped.push(lines[i]);
  }
  return deduped.join("\n");
}

// ═══════════════════════════════════════════════════
// RTK compression (60-90% savings)
// Command-aware filters for shell/test/build/git output
// Inspired by https://github.com/rtk-ai/rtk (RTK - Rust Token Killer)
// ═══════════════════════════════════════════════════

// Detect if text looks like command output
function _isCommandOutput(text) {
  if (!text) return false;
  const patterns = [
    /^(diff\s|index\s|@@\s|--+\s)/m, // git diff / patches
    /^(commit\s[\da-f]{7,}|Author:|Date:|Merge:)/m, // git log
    /^(On\sbranch\s|Your\sbranch\s|nothing\sto\scommit|Changes\s(not\sstaged|to\sbe\scommitted))/m, // git status
    /^(test\s|tests\s|failures|FAILED|PASSED)\s/m, // test output
    /^(error|warning|info|debug|trace)(\[|:|\s)/im, // log output
    /^(npm|yarn|pip|bun|node|cargo|go)\s/im, // package manager / CLI output
    /^(\s*\d+\s*(test|spec|suite)|Ran\s\d+|Finished\s)/m, // test runner output
    /^(Compiling|Building|Running|Generating|Transpiling|Bundling|Downloading|Installing)/m, // build output
    /^(?:\d+\s+)?(?:error|warn|warning|info|debug)(?:\s+\d+)?[:)]/im, // structured log
    /^(?:total\s+\d+|passed|failed|skipped|pending)/im, // test summary
    /^(?:Real\s+|User\s+|Sys\s+|CPU\s+)/m, // perf output
    /^(?:root|src|tests?|lib|node_modules)\//m, // file path lines
  ];
  return patterns.some(p => p.test(text));
}

// RTK compression rules for command output
const RTK_RULES = [
  // Git diff: compress @@ headers
  { re: /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/gm, rep: "@@ -$1 +$2 @@" },
  // Git diff: strip context lines that repeat
  { re: /^( {4}|\t)(.*)$/gm, rep: (m, ws, code) => (code || "").trim().length < 3 ? "" : m },
  // npm/yarn: strip timing and progress
  { re: /^.*?(?:added|removed|changed|audited)\s+\d+\s+packages?\s+in\s+\d+/gm, rep: (m) => m.replace(/in\s+\d+\.?\d*\s*[sm]/g, "").trim() },
  // Verbose log timestamps
  { re: /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\]\s*/gm, rep: "" },
  { re: /^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/gm, rep: "" },
  // Strip ANSI color codes
  { re: /\x1b\[[0-9;]*m/g, rep: "" },
  // Compression of repeated build output patterns
  { re: /^(?:\s+)(?:Compiling|Checking|Running|Scanning)/gm, rep: "  ..." },
  // Test output: compress dots
  { re: /\.{20,}/g, rep: (m) => `...(${m.length} tests)` },
  // Path abbreviation for deeply nested
  { re: /((?:\/[\w.-]+){4,})\//g, rep: (m) => "../" + m.split("/").filter(Boolean).slice(-2).join("/") + "/" },
  // Stack traces: keep only meaningful lines
  { re: /^\s+at\s+.+?\(.+?:\d+:\d+\)\s*$/gm, rep: "" },
  { re: /^\s+at\s+.+?:\d+:\d+\s*$/gm, rep: "" },
  // Strip blank lines in code blocks
  { re: /```[\s\S]*?```/g, rep: (m) => m.replace(/\n{3,}/g, "\n\n") },
];

function _applyRTK(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const rule of RTK_RULES) {
    result = result.replace(rule.re, rule.rep);
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

// ═══════════════════════════════════════════════════
// Aggressive compression (~50% savings)
// All Caveman + progressive message aging + tool result summarization
// ═══════════════════════════════════════════════════

const TOOL_SUMMARIZERS = {
  grepResults(text) {
    const lines = text.split("\n").filter(Boolean);
    const fileMatch = lines[0].match(/^([\w.\/\-]+):(\d+):/);
    if (fileMatch) {
      const file = fileMatch[1].split("/").pop() || fileMatch[1];
      return `[${file}+${lines.length} matches in ${lines[0].split(":")[0]}]`;
    }
    return null;
  },
  readSnippet(text) {
    const head = text.slice(0, 300).replace(/\r\n/g, " ").trim();
    return `[read snippet: ${head}... (${text.length} chars total)]`;
  },
  listFiles(text) {
    const count = (text.match(/\r\n/g) || []).length + 1;
    return `[${count} files/dirs]`;
  },
  gitDiffSummary(text) {
    const fileMatches = text.match(/^diff --git\s+a\/(.+?)\s+b\//gm);
    const files = fileMatches ? fileMatches.map(m => m.match(/a\/(.+?)\s/)?.[1] || "").filter(Boolean) : [];
    if (files.length) return `[diff: ${files.join(" ")}]`;
    return null;
  },
};

function _summarizeToolResult(text, toolName) {
  if (!text) return text;
  // For grep results: detect by pattern, not by tool name
  if (/^([\w.\/\-]+):(\d+):/.test(text) && text.length > SUMMARY_CHARS) {
    const result = TOOL_SUMMARIZERS.grepResults(text);
    if (result) return result;
  }
  // For file reads: show first ~500 chars
  if (toolName === "read" && text.length > SUMMARY_CHARS) {
    return TOOL_SUMMARIZERS.readSnippet(text);
  }
  // For ls/dir: compress long listings
  if ((toolName === "ls" || toolName === "dir" || toolName === "list_files") && text.length > LS_COMPRESS_THRESHOLD) {
    return TOOL_SUMMARIZERS.listFiles(text);
  }
  // For git diff: summarise
  if (toolName === "git diff" && text.length > DIFF_COMPRESS_THRESHOLD) {
    const result = TOOL_SUMMARIZERS.gitDiffSummary(text);
    if (result) return result;
    return text.slice(0, 200) + "...";
  }
  return text;
}

// ═══════════════════════════════════════════════════
// Ultra compression (~75% savings)
// All Aggressive + heuristic token pruning + stopword removal
// ═══════════════════════════════════════════════════

const ULTRA_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "of", "in", "to", "for", "with", "on", "at", "by", "from", "as", "into",
  "above", "below", "between", "under",
  "again", "further", "then", "once", "here", "there", "when", "where",
  "why", "how", "all", "both", "each", "few", "more", "most", "other",
  "some", "such", "same", "so", "than", "too", "very", "just",
  "about", "now", "also", "still",
]);

function _heuristicPrune(text) {
  if (!text || text.length < HEURISTIC_PRUNE_MIN_LENGTH) return text;
  const lines = text.split("\n");
  if (lines.length <= 10) return text;

  const totalLines = lines.length;
  const alwaysKeepFirst = Math.max(1, Math.floor(totalLines * 0.2));
  const alwaysKeepLast = Math.max(1, Math.floor(totalLines * 0.1));

  // Score each line based on content value
  const scored = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return { line, score: -1 };
    let score = trimmed.length;
    if (/[{}();<>=]/.test(trimmed)) score += 20;
    if (/\d/.test(trimmed)) score += 10;
    if (/[/\\]/.test(trimmed)) score += 5;
    if (/^[A-Z][a-z]+\s/.test(trimmed)) score += 3;
    return { line, score };
  });

  const keep = new Set();

  // Always keep first ~20% and last ~10% of lines (preserves headers, conclusions)
  for (let i = 0; i < totalLines; i++) {
    if (i < alwaysKeepFirst || i >= totalLines - alwaysKeepLast) {
      keep.add(i);
    } else if (scored[i].score < 0) {
      keep.add(i); // always keep blank lines
    }
  }

  // For the middle 70% section, keep the highest-scoring lines without reordering
  const middleStart = alwaysKeepFirst;
  const middleEnd = totalLines - alwaysKeepLast;

  if (middleStart < middleEnd) {
    const middleEntries = [];
    for (let i = middleStart; i < middleEnd; i++) {
      if (scored[i].score >= 0) {
        middleEntries.push({ idx: i, score: scored[i].score });
      }
    }
    // Keep the top ~70% of middle entries by score (preserving original order)
    middleEntries.sort((a, b) => b.score - a.score);
    const keepCount = Math.floor(middleEntries.length * 0.7);
    for (let j = 0; j < keepCount; j++) {
      keep.add(middleEntries[j].idx);
    }
  }

  return lines.filter((_, i) => keep.has(i)).join("\n");
}

function _stripStopwords(text) {
  // Limit stopword removal to 30 words per call to preserve readability
  const MAX_STOPWORDS_REMOVED = 30;
  const words = text.split(/(\s+)/);
  const kept = [];
  let skipCount = 0;
  for (const word of words) {
    if (ULTRA_STOPWORDS.has(word.toLowerCase()) && skipCount < MAX_STOPWORDS_REMOVED) {
      skipCount++;
      continue;
    }
    kept.push(word);
  }
  return kept.join("");
}

// ═══════════════════════════════════════════════════
// Delta compression (~60-90% savings)
// KitPilot-inspired: strip historical VS context blocks, compact consumed tool outputs
// Key insight from KitPilot: VS sends the same ~16KB+ environment block every turn.
// In a 10-turn conversation, that's 160KB of redundant context.
// Stripping historical copies and keeping only the current turn's block saves ~3× tokens.
// ═══════════════════════════════════════════════════

// ── VS context block detection patterns ──
const VS_CONTEXT_PATTERNS = [
  /\n*#+\s*Context:[\s\S]{200,}?(?=\n#+\s|\n*$)/gi,
  /\n*<context>[\s\S]*?<\/context>\n*/gi,
  /\n*<environment_details>[\s\S]*?<\/environment_details>\n*/gi,
  /\n*<CurrentWorkingDirectory>[\s\S]*?<\/CurrentWorkingDirectory>\n*/gi,
  /\n*<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>\n*/gi,
  /\n*<attached_files>[\s\S]*?<\/attached_files>\n*/gi,
  /\n*<project_layout>[\s\S]*?<\/project_layout>\n*/gi,
];

function _detectVSBlock(content) {
  if (!content || typeof content !== "string") return { hasBlock: false };
  for (const p of VS_CONTEXT_PATTERNS) {
    const m = content.match(p);
    if (m && m.some(s => (s.match(/\n/g) || []).length >= 3)) {
      return { hasBlock: true };
    }
  }
  // Heuristic: long first user message (>2KB) with VS version or workspace root patterns
  if (content.length > VS_BLOCK_HEURISTIC_LENGTH) {
    if (/visual\s+studio\s+\d{4}/i.test(content) ||
        /workspace root/i.test(content) ||
        /currently opened file/i.test(content) ||
        /active file/i.test(content) ||
        /open tabs/i.test(content)) {
      return { hasBlock: true, heuristic: true };
    }
  }
  return { hasBlock: false };
}

function _extractContextSummary(content) {
  const parts = [];
  const wsMatch = content.match(/(?:workspace root|path to (?:the )?workspace root):?\s*(\S+)/i);
  if (wsMatch) {
    const segments = wsMatch[1].split(/[/\\]/);
    const name = segments.filter(Boolean).pop() || wsMatch[1];
    parts.push(`ws:${name}`);
  }
  const afMatch = content.match(/(?:currently opened|active) file:?\s*(\S+)/i);
  if (afMatch) {
    const segments = afMatch[1].split(/[/\\]/);
    const name = segments.filter(Boolean).pop() || afMatch[1];
    parts.push(`file:${name}`);
  }
  const vsMatch = content.match(/visual\s+studio\s+(enterprise|professional|community)?\s*(\d{4})\s*\((\d+\.\d+\.\d+)(-insiders)?\)/i);
  if (vsMatch) parts.push(`VS${vsMatch[3]}`);
  const tabCount = (content.match(/open tabs/i) ? (content.match(/^[ \t]*[^\n]+\.(cs|ts|js|py|go|rs|java|cpp|c|h|json|xml|yaml|yml|md|sql)/gim) || []).length : 0);
  if (tabCount > 0) parts.push(`${tabCount} tabs`);
  return parts.length ? `[snet: prior turn snapshot — ${parts.join(", ")}]` : "[snet: prior turn snapshot]";
}

function _stripHistoricalVSContext(messages, isVSClient) {
  if (!messages?.length || !isVSClient) return messages;
  if (messages.length <= 2) return messages;

  const result = [];
  let lastUserIdx = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return messages;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i === lastUserIdx || m.role !== "user") {
      result.push(m);
      continue;
    }

    const content = typeof m.content === "string" ? m.content : "";
    const { hasBlock } = _detectVSBlock(content);

    if (hasBlock) {
      const summary = _extractContextSummary(content);
      result.push({ ...m, content: summary });
      log(`[delta] stripped VS context block (${content.length} → ${summary.length} chars) at message[${i}]`);
    } else {
      result.push(m);
    }
  }
  return result;
}

function _compactHistoricalToolOutputs(messages) {
  if (!messages?.length || messages.length <= 2) return messages;

  // Walk forward from each assistant: all tool results following its tool_calls
  // are "consumed" if another assistant message appears after them.
  const consumedToolIndices = new Set();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;

    // Collect all consecutive tool messages that belong to this assistant's tool_calls
    const toolIds = new Set(m.tool_calls.map(tc => tc.id));
    const toolResultIndices = [];

    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "tool" && toolIds.has(messages[j].tool_call_id)) {
        toolResultIndices.push(j);
      } else if (messages[j].role !== "tool") {
        break;
      }
    }

    if (toolResultIndices.length === 0) continue;

    // Check if any subsequent assistant message exists after the tool results
    const lastToolIdx = toolResultIndices[toolResultIndices.length - 1];
    let hasSubsequentAssistant = false;
    for (let j = lastToolIdx + 1; j < messages.length; j++) {
      if (messages[j].role === "assistant") {
        hasSubsequentAssistant = true;
        break;
      }
    }

    if (hasSubsequentAssistant) {
      for (const ti of toolResultIndices) {
        consumedToolIndices.add(ti);
      }
    }
  }

  const result = [];
  for (let i = 0; i < messages.length; i++) {
    if (consumedToolIndices.has(i)) {
      const m = messages[i];
      const content = typeof m.content === "string" ? m.content : "";
      if (content.length > CONSUMED_TOOL_OUTPUT_LENGTH) {
        const head = content.slice(0, CONSUMED_TOOL_SNIPPET).replace(/\r\n/g, " ").trim();
        const compact = "[snet: consumed tool output - " + head + "... (" + content.length + " chars)]";
        result.push({ ...m, content: compact });
        debug("[delta] compacted consumed tool output (" + content.length + " -> " + compact.length + " chars) at message[" + i + "]");
      } else {
        result.push(m);
      }
    } else {
      result.push(messages[i]);
    }
  }
  return result;
}

export function compressHistory(messages, isVSClient = true) {
  if (!messages?.length) return messages;
  let msgs = messages;
  if (isVSClient) {
    msgs = _stripHistoricalVSContext(msgs, true);
  }
  msgs = _compactHistoricalToolOutputs(msgs);
  return msgs;
}

// ═══════════════════════════════════════════════════
// Main compression pipeline
// ═══════════════════════════════════════════════════

/**
 * Apply token optimization to message content based on compression level.
 * @param {string} content - The message content to compress
 * @param {'off'|'lite'|'caveman'|'standard'|'aggressive'|'ultra'|'rtk'|'stacked'} level - Compression level
 * @param {string} [toolName] - Optional tool name for tool-result compression
 * @returns {string} Compressed content
 */
// ---- Compression step routing ----
const COMPRESSION_PIPELINE = Object.freeze({
  lite: ["compressLite"],
  caveman: ["compressLite", "applyCaveman"],
  standard: ["compressLite", "applyCaveman"],
  aggressive: ["compressLite", "applyCaveman", "summarizeToolResult"],
  ultra: ["compressLite", "applyCaveman", "summarizeToolResult", "heuristicPrune", "stripStopwords"],
  rtk: ["compressLite", "applyCommandAwareRTK"],
  stacked: ["compressLite", "applyCommandAwareRTK", "applyCaveman"],
});

function _runCompressionStep(stepName, text, toolName) {
  switch (stepName) {
    case "compressLite": return _compressLite(text);
    case "applyCaveman": return _applyCaveman(text);
    case "applyCommandAwareRTK": return _isCommandOutput(text) ? _applyRTK(text) : text;
    case "summarizeToolResult": return toolName ? _summarizeToolResult(text, toolName) : text;
    case "heuristicPrune": return _heuristicPrune(text);
    case "stripStopwords": return _stripStopwords(text);
    default: return text;
  }
}

export function compressContent(content, level = "stacked", toolName = "") {
  if (!content || typeof content !== "string") return content || "";
  if (level === "off") return content;

  // Preserve code blocks from compression (use __TOKC_CB_/__TOKC_IC_ markers to avoid collision)
  const codeBlocks = [];
  const preserved = content.replace(/```[\s\S]*?```/g, function(match) {
    codeBlocks.push(match);
    return "__TOKC_CB_" + (codeBlocks.length - 1) + "__";
  });

  // Also preserve inline code
  const inlineCodes = [];
  const preserved2 = preserved.replace(/`[^`]+`/g, function(match) {
    inlineCodes.push(match);
    return "__TOKC_IC_" + (inlineCodes.length - 1) + "__";
  });

  // Run pipeline steps
  const steps = COMPRESSION_PIPELINE[level] || COMPRESSION_PIPELINE.stacked;
  let result = preserved2;
  for (const step of steps) {
    result = _runCompressionStep(step, result, toolName);
  }

  // Restore code blocks and inline code
  result = result.replace(/__TOKC_CB_(\d+)__/g, function(_, i) { return codeBlocks[parseInt(i)] || ""; });
  result = result.replace(/__TOKC_IC_(\d+)__/g, function(_, i) { return inlineCodes[parseInt(i)] || ""; });

  return result;
}
/**
 * Apply the best compression (Stacked: RTK → Caveman, ~89% average savings on eligible payloads).
 * Shortcut for compressContent(content, "stacked").
 */
export function compressBest(content, toolName) {
  return compressContent(content, "stacked", toolName);
}


