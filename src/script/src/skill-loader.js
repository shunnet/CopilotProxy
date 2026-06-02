// ── Skill Loader ──
// Loads Claude Code skills from C:\Users\vipls\.claude\skills\
// Parses YAML frontmatter from SKILL.md files and exposes prompt content
// as injectable system context for VS 2026 Copilot requests.
// Filters out domain-specific skills not relevant to coding.

import "./polyfill.js";
import { log, debug } from "./logger.js";
import { t } from "./i18n.js";

// Skills directory — project-local for portability
// Runtime path is always `<cwd>/src/skills` (source) or `<exeDir>/src/skills` (compiled)
function resolveSkillsDir() {
  // Env override takes priority
  if (typeof Bun !== "undefined" && Bun.env.SKILLS_DIR) return Bun.env.SKILLS_DIR;
  if (typeof process !== "undefined" && process.env.SKILLS_DIR) return process.env.SKILLS_DIR;

  // Bun compiled binary: import.meta.url → file://<dir>/snet, skills are at <dir>/src/skills
  if (typeof Bun !== "undefined" && Bun.main) {
    const exeDir = Bun.main.replace(/[/\\][^/\\]+$/, "");
    return `${exeDir}/src/skills`;
  }

  // Node.js / Bun source run: skills are in same dir as this file
  try {
    const url = new URL("./skills", import.meta.url);
    return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return (process?.cwd?.() || ".") + "/skills";
  }
}
const SKILLS_DIR = resolveSkillsDir();

// Non-coding skills to skip — truly domain-specific, not relevant to software development.
// Framework-specific coding skills (Perl, Kotlin, Dart, Laravel, Django, Spring, etc.)
// are now INCLUDED since they ARE coding-related and may match project context.
const SKIP_SKILLS = new Set([
  // Business ops (non-coding)
  "carrier-relationship-management",
  "customer-billing-ops",
  "customs-trade-compliance",
  "email-ops",
  "energy-procurement",
  "finance-billing-ops",
  "google-workspace-ops",
  "healthcare-phi-compliance",
  "hipaa-compliance",
  "inventory-demand-planning",
  "investor-materials",
  "investor-outreach",
  "lead-intelligence",
  "llm-trading-agent-security",
  "logistics-exception-management",
  "messages-ops",
  "nutrient-document-processing",
  "product-capability",
  "production-scheduling",
  "quality-nonconformance",
  "returns-reverse-logistics",
  "visa-doc-translate",
  "terminal-ops",
  "unified-notifications-ops",
  // Content creation (non-coding)
  "article-writing",
  "brand-voice",
  "crosspost",
  "manim-video",
  "remotion-video-creation",
  "videodb",
  "video-editing",
  // Marketing / research (non-coding)
  "social-graph-ranker",
  "market-research",
  "data-scraper-agent",
  "seo",
  // Crypto / Web3 (non-coding domain)
  "defi-amm-security",
  "evm-token-decimals",
  "nodejs-keccak256",
  // Non-coding ops
  "knowledge-ops",
  "iterative-retrieval",
  "research-ops",
  "clickhouse-io",
  "project-flow-ops",
  "team-builder",
  "ralphinho-rfc-pipeline",
  "regex-vs-llm-structured-text",
  "workspace-surface-audit",
]);

// ── Cache ──
let _skillsCache = null;
let _lastLoad = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── YAML frontmatter parser (minimal, no dependency) ──
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { frontmatter: {}, body: content };

  const fm = {};
  const lines = match[1].split("\n");
  let currentKey = null;
  let blockLiteral = false; // track YAML | blocks

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w\s-]*?)\s*:\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1].trim();
      let value = kvMatch[2].trim();
      // Handle YAML block scalar indicator |
      if (value === "|" || value === "|-" || value === ">-") {
        blockLiteral = true;
        fm[currentKey] = "";
      } else {
        blockLiteral = false;
        fm[currentKey] = value.replace(/^['"]|['"]$/g, "");
      }
    } else if (currentKey && line.trim()) {
      let val = line.trim();
      // Strip YAML list markers from indented lines
      if (val.startsWith("- ")) val = val.slice(2);
      if (blockLiteral) {
        fm[currentKey] += (fm[currentKey] ? " " : "") + val;
      } else {
        fm[currentKey] += " " + val;
      }
    }
  }

  return { frontmatter: fm, body: content.slice(match[0].length).trim() };
}

// ── Load a single skill ──
async function loadSkill(dirPath, name) {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const skillFile = path.join(dirPath, name, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      debug(`[skills] ${name}: SKILL.md not found`);
      return null;
    }

    const content = fs.readFileSync(skillFile, "utf8");
    const { frontmatter, body } = parseFrontmatter(content);

    return {
      name: frontmatter.name || name,
      description: frontmatter.description || "",
      origin: frontmatter.origin || "unknown",
      prompt: body,
    };
  } catch (e) {
    debug(t("skillsLoadFail", name, e.message));
    return null;
  }
}

// ── Load all skills (skip only domain-specific ones) ──
let _loadingPromise = null;

export async function loadSkills(force = false) {
  const now = Date.now();
  if (!force && _skillsCache && now - _lastLoad < CACHE_TTL) {
    return _skillsCache;
  }
  // Return in-flight promise to avoid concurrent scans
  if (!force && _loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    const skills = [];
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      if (!fs.existsSync(SKILLS_DIR)) {
        debug(t("skillsDirNotFound", SKILLS_DIR));
        _skillsCache = [];
        _lastLoad = Date.now();
        return [];
      }

      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      let loaded = 0;
      let skipped = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_SKILLS.has(entry.name)) {
          skipped++;
          continue;
        }

        const skill = await loadSkill(SKILLS_DIR, entry.name);
        if (skill) {
          skills.push(skill);
          loaded++;
        }
      }

      log(t("skillsLoaded", loaded, skipped));
    } catch (e) {
      debug(t("skillsScanError", e.message));
    }

    return skills;
  })();

  try {
    const skills = await _loadingPromise;
    _skillsCache = skills;
    _lastLoad = Date.now();
    return skills;
  } finally {
    _loadingPromise = null;
  }
}

// ── Get system prompt augmentation from loaded skills ──
export function buildSkillSystemPrompt(skills) {
  if (!skills?.length) return "";

  const parts = ["\n## Available Coding Skills\n"];

  for (const skill of skills) {
    parts.push(`### ${skill.name}: ${skill.description}`);
    // Only include prompt content for the most relevant skills to save tokens
    if (skill.name === "agentic-engineering" || skill.name === "search-first" || skill.name === "security-review") {
      parts.push(skill.prompt.slice(0, 500) + "...");
    }
  }

  parts.push("\nUse these skill patterns when relevant to the current task.");

  return parts.join("\n");
}

// ── Get specific skill by name ──
export function getSkill(name) {
  return _skillsCache?.find(s => s.name === name) || null;
}

// ── Refresh skills cache ──
export async function refreshSkills() {
  _skillsCache = null;
  return loadSkills(true);
}

// ── Keyword mapping: user message → skill names ──
const SKILL_KEYWORD_MAP = [
  // ── Testing & Quality ──
  { keywords: ["test", "testing", "测试", "unit test", "单元测试", "integration test", "集成测试", "e2e", "end-to-end", "coverage", "覆盖率", "mock", "模拟", "assert", "断言", "tdd", "test-driven", "测试驱动", "red-green", "红绿"], skillNames: ["code-testing-agent", "code-testing-extensions", "assertion-quality", "tdd-workflow", "coverage-analysis", "test-smell-detection", "test-gap-analysis", "test-anti-patterns", "test-tagging", "e2e-testing", "csharp-testing", "cpp-testing", "golang-testing", "python-testing", "rust-testing", "kotlin-testing", "writing-mstest-tests", "run-tests", "exp-test-maintainability", "exp-mock-usage-analysis", "test-analysis-extensions", "create-skill-test", "ai-regression-testing", "mtp-hot-reload", "generate-testability-wrappers", "perl-testing", "source-command-cpp-test", "source-command-flutter-test", "source-command-kotlin-test", "source-command-test-coverage", "django-tdd", "laravel-tdd", "springboot-tdd"] },

  // ── Security ──
  { keywords: ["security", "安全", "vulnerability", "漏洞", "exploit", "cve", "owasp", "xss", "csrf", "sql injection", "auth", "认证", "授权", "authorization", "authentication", "permission", "权限"], skillNames: ["security-review", "security-scan", "security-bounty-hunter", "django-security", "laravel-security", "perl-security", "springboot-security", "configure-auth", "source-command-sparc-security-review"] },

  // ── Code Review ──
  { keywords: ["code review", "代码审查", "review code", "审查代码", "pull request", "pr review", "评审", "review feedback", "review suggestions", "review my code"], skillNames: ["code-review-excellence", "receiving-code-review", "requesting-code-review", "source-command-cpp-review", "source-command-flutter-review", "source-command-go-review", "source-command-python-review", "source-command-rust-review", "source-command-review-pr"] },

  // ── Frontend & UI ──
  { keywords: ["frontend", "前端", "ui", "界面", "component", "组件", "react", "vue", "css", "html", "tailwind", "liquid", "glass"], skillNames: ["frontend-design", "frontend-patterns", "frontend-slides", "plan-ui-change", "ui-demo", "liquid-glass-design", "author-component"] },

  // ── Blazor & WebAssembly ──
  { keywords: ["blazor", "wasm", "webassembly", "blazor server", "blazor webassembly", "razor"], skillNames: ["create-blazor-project", "convert-blazor-server-to-webapp", "support-prerendering", "use-js-interop"] },

  // ── Backend & API ──
  { keywords: ["backend", "后端", "api", "endpoint", "rest", "graphql", "webapi", "web api", "server", "服务端", "connector"], skillNames: ["api-design", "api-connector-builder", "backend-patterns", "dotnet-webapi", "minimal-api-file-upload", "fetch-and-send-data"] },

  // ── Database & Storage ──
  { keywords: ["database", "数据库", "sql", "postgres", "postgresql", "mysql", "query", "查询", "orm", "ef core", "entity framework", "migration", "数据迁移", "binlog", "二进制日志", "exposed"], skillNames: ["database-migrations", "postgres-patterns", "jpa-patterns", "optimizing-ef-core-queries", "kotlin-exposed-patterns", "binlog-failure-analysis", "binlog-generation", "laravel-plugin-discovery"] },

  // ── DevOps & CI/CD ──
  { keywords: ["docker", "部署", "deploy", "deployment", "container", "容器", "kubernetes", "k8s", "ci/cd", "pipeline", "流水线", "devops"], skillNames: ["docker-patterns", "deployment-patterns", "dmux-workflows", "source-command-promote", "source-command-setup-pm", "source-command-auto-update", "automation-audit-ops"] },

  // ── Git & Version Control ──
  { keywords: ["git", "commit", "branch", "merge", "push", "pull", "rebase", "版本控制", "version control", "worktree", "working tree", "finish branch"], skillNames: ["github-ops", "using-git-worktrees", "finishing-a-development-branch", "source-command-review-pr"] },

  // ── Performance & Optimization ──
  { keywords: ["performance", "性能", "optimize", "优化", "slow", "bottleneck", "瓶颈", "latency", "延迟", "profiling", "profile", "benchmark", "基准", "benchmarking", "simd", "vectorization", "向量化"], skillNames: ["analyzing-dotnet-performance", "eval-performance", "build-perf-baseline", "build-perf-diagnostics", "microbenchmarking", "build-parallelism", "exp-simd-vectorization"] },

  // ── Python ──
  { keywords: ["python", "django", "flask", "fastapi", "pytest", "python3", "pip"], skillNames: ["python-patterns", "python-testing", "django-patterns", "django-tdd", "django-security", "django-verification", "source-command-python-review"] },

  // ── Go / Golang ──
  { keywords: ["golang", "go", "go test", "go build", "goroutine", "gofmt", "golangci"], skillNames: ["golang-patterns", "golang-testing", "source-command-go-build", "source-command-go-review"] },

  // ── Rust ──
  { keywords: ["rust", "cargo", "rustc", "rustfmt", "clippy", "crates"], skillNames: ["rust-patterns", "rust-testing", "source-command-rust-build", "source-command-rust-review"] },

  // ── C# / .NET ──
  { keywords: ["csharp", "c#", "c sharp", "dotnet", ".net", "asp.net", "net core", "net framework", "clr", "common language runtime"], skillNames: ["csharp-scripts", "dotnet-patterns", "dotnet-webapi", "csharp-testing", "dotnet-aot-compat", "dotnet-pinvoke", "dotnet-test-frameworks", "dotnet-trace-collect", "clr-activation-debugging", "system-text-json-net11", "thread-abort-migration", "analyzing-dotnet-performance", "mcp-csharp-create", "mcp-csharp-debug", "mcp-csharp-publish", "mcp-csharp-test"] },

  // ── .NET MAUI ──
  { keywords: ["maui", "dotnet maui", "net maui", "移动ui", "cross-platform ui", "xamarin"], skillNames: ["maui-app-lifecycle", "maui-collectionview", "maui-data-binding", "maui-dependency-injection", "maui-safe-area", "maui-shell-navigation", "maui-theming", "dotnet-maui-doctor"] },

  // ── MSBuild / Build System ──
  { keywords: ["msbuild", "构建系统", "build system", "directory.build.props", "project reference", "项目引用", "binlog msbuild"], skillNames: ["msbuild-antipatterns", "msbuild-modernization", "msbuild-server", "directory-build-organization", "resolve-project-references", "detect-static-dependencies", "check-bin-obj-clash", "incremental-build", "mtp-hot-reload"] },

  // ── NuGet ──
  { keywords: ["nuget", "package", "包管理", "包", "nuget package", "依赖管理", "dependency management"], skillNames: ["nuget-trusted-publishing"] },

  // ── Java / Spring ──
  { keywords: ["java", "spring", "spring boot", "springboot", "jpa", "hibernate", "maven", "gradle", "junit", "java标准", "java coding"], skillNames: ["java-coding-standards", "springboot-patterns", "springboot-security", "springboot-tdd", "springboot-verification", "jpa-patterns", "source-command-gradle-build"] },

  // ── Kotlin / Android ──
  { keywords: ["kotlin", "android", "ktor", "jetpack compose", "compose multiplatform", "kmp", "coroutines", "协程", "kotlin coroutines", "exposed", "kotlin flows"], skillNames: ["kotlin-patterns", "kotlin-testing", "kotlin-coroutines-flows", "kotlin-exposed-patterns", "kotlin-ktor-patterns", "android-clean-architecture", "android-tombstone-symbolication", "compose-multiplatform-patterns", "source-command-kotlin-build", "source-command-kotlin-test"] },

  // ── Swift / iOS ──
  { keywords: ["swift", "ios", "swiftui", "apple", "xcode", "iphone", "ipad", "macos", "uikit", "swift concurrency", "swift actor"], skillNames: ["swiftui-patterns", "swift-concurrency-6-2", "swift-actor-persistence", "swift-protocol-di-testing", "apple-crash-symbolication"] },

  // ── Dart / Flutter ──
  { keywords: ["dart", "flutter", "跨平台", "移动开发", "material design"], skillNames: ["dart-flutter-patterns", "source-command-flutter-build", "source-command-flutter-review", "source-command-flutter-test"] },

  // ── PHP / Laravel ──
  { keywords: ["php", "laravel", "eloquent", "artisan", "composer", "phpunit"], skillNames: ["laravel-patterns", "laravel-plugin-discovery", "laravel-security", "laravel-tdd", "laravel-verification"] },

  // ── Perl ──
  { keywords: ["perl", "cpan", "perl script", "perl5"], skillNames: ["perl-patterns", "perl-security", "perl-testing"] },

  // ── JavaScript / TypeScript / Node ──
  { keywords: ["javascript", "typescript", "node", "node.js", "nodejs", "nestjs", "express", "js", "ts", "ecmascript"], skillNames: ["nestjs-patterns", "use-js-interop"] },

  // ── C / C++ ──
  { keywords: ["c++", "cpp", "c plus plus", "cmake", "gcc", "g++", "clang", "c语言", "c++ 编程", "c++标准"], skillNames: ["cpp-coding-standards", "cpp-testing", "source-command-cpp-build", "source-command-cpp-review", "source-command-cpp-test", "crap-score"] },

  // ── Debugging & Troubleshooting ──
  { keywords: ["debug", "调试", "error", "错误", "fix", "修复", "bug", "崩溃", "crash", "dump", "转储", "trace", "跟踪", "exception", "异常", "troubleshoot", "investigate", "调查", "堆栈", "stack trace", "tombstone", "symbolication"], skillNames: ["systematic-debugging", "dump-collect", "android-tombstone-symbolication", "apple-crash-symbolication", "clr-activation-debugging", "dotnet-trace-collect", "binlog-failure-analysis", "source-command-sparc-debug", "source-command-build-fix", "nanoclaw-repl"] },

  // ── Refactoring & Cleanup ──
  { keywords: ["refactor", "重构", "clean", "清理", "cleanup", "restructure", "重组", "technical debt", "技术债务", "simplify", "简化"], skillNames: ["source-command-refactor-clean", "migrate-static-to-wrapper"] },

  // ── Documentation ──
  { keywords: ["documentation", "文档", "docs", "readme", "codemap", "代码映射", "comment", "注释", "update docs", "更新文档"], skillNames: ["source-command-update-docs", "source-command-update-codemaps", "source-command-sparc-docs-writer"] },

  // ── Build & Compilation ──
  { keywords: ["build", "构建", "compile", "编译", "build error", "构建错误", "compilation", "编译器", "build system"], skillNames: ["build-parallelism", "incremental-build", "dotnet-aot-compat", "source-command-build-fix", "source-command-cpp-build", "source-command-flutter-build", "source-command-go-build", "source-command-gradle-build", "source-command-kotlin-build", "source-command-rust-build"] },

  // ── Planning & Design ──
  { keywords: ["plan", "规划", "design", "设计", "architecture", "架构", "spec", "specification", "blueprint", "蓝图", "before coding", "system design", "系统设计", "plan ui"], skillNames: ["writing-plans", "blueprint", "brainstorming", "executing-plans", "plan-ui-change", "technology-selection", "source-command-plan", "source-command-feature-dev", "android-clean-architecture", "strategic-compact", "source-command-sparc-spec-pseudocode"] },

  // ── AI / LLM / Agent ──
  { keywords: ["agent", "ai", "llm", "智能体", "prompt", "提示词", "token", "令牌", "model", "模型", "claude", "anthropic", "copilot", "reasoning", "推理", "大模型", "council", "harness"], skillNames: ["agentic-engineering", "agent-harness-construction", "agent-introspection-debugging", "agent-sort", "ai-first-engineering", "claude-api", "claude-devfleet", "enterprise-agent-ops", "cost-aware-llm-pipeline", "continuous-agent-loop", "autonomous-loops", "dispatching-parallel-agents", "subagent-driven-development", "token-budget-advisor", "prompt-optimizer", "council", "search-first", "source-command-claude-flow-help", "source-command-claude-flow-memory", "source-command-claude-flow-swarm", "source-command-evolve", "source-command-sparc-sparc", "create-custom-agent"] },

  // ── MCP / Plugin / Extension ──
  { keywords: ["mcp", "model context protocol", "plugin", "插件", "extension", "扩展", "hook", "钩子"], skillNames: ["mcp-server-patterns", "mcp-csharp-create", "mcp-csharp-debug", "mcp-csharp-publish", "mcp-csharp-test", "extension-points", "source-command-sparc-mcp"] },

  // ── Migration & Upgrade ──
  { keywords: ["migrate", "迁移", "upgrade", "升级", "version upgrade", "版本升级", "migration", "数据迁移", "convert", "转换"], skillNames: ["migrate-dotnet10-to-dotnet11", "migrate-dotnet8-to-dotnet9", "migrate-dotnet9-to-dotnet10", "migrate-mstest-v1v2-to-v3", "migrate-mstest-v3-to-v4", "migrate-nullable-references", "migrate-static-to-wrapper", "migrate-vstest-to-mtp", "migrate-xunit-to-xunit-v3", "thread-abort-migration", "convert-blazor-server-to-webapp", "database-migrations"] },

  // ── CLI / Terminal / Shell ──
  { keywords: ["bash", "shell", "终端", "terminal", "cli", "command", "命令行", "console", "控制台", "aside", "filter syntax"], skillNames: ["source-command-aside", "filter-syntax", "collect-user-input", "nanoclaw-repl"] },

  // ── GitHub / Jira / Project Management ──
  { keywords: ["github", "jira", "issue", "项目管理", "project", "ticket", "linear", "任务", "task", "item", "manage"], skillNames: ["github-ops", "jira-integration", "source-command-jira", "source-command-projects", "item-management"] },

  // ── Caching / Content ──
  { keywords: ["cache", "缓存", "hash", "content hash", "content", "内容", "caching"], skillNames: ["content-hash-cache-pattern", "content-engine"] },

  // ── Verification & Validation ──
  { keywords: ["verify", "验证", "verification", "check", "确认", "prove", "complete", "done", "完成", "validate", "校验", "validation", "verification loop"], skillNames: ["verification-before-completion", "verification-loop", "template-validation", "django-verification", "laravel-verification", "springboot-verification"] },

  // ── Meta-Skills (Skills about skills) ──
  { keywords: ["skill", "技能", "learn", "学习", "instinct", "直觉", "stocktake", "audit", "审计", "prune", "skill health"], skillNames: ["writing-skills", "create-skill", "create-skill-test", "skill-stocktake", "source-command-skill-create", "source-command-skill-health", "source-command-prune", "source-command-learn", "source-command-learn-eval", "source-command-instinct-export", "source-command-instinct-import", "source-command-instinct-status", "continuous-learning", "continuous-learning-v2"] },

  // ── Video / Media / Social ──
  { keywords: ["video", "视频", "media", "媒体", "image", "图片", "social", "social media", "社交媒体", "x api", "twitter", "linkedin", "content creation", "内容创作", "fal", "ai media"], skillNames: ["fal-ai-media", "x-api"] },

  // ── Research / Search ──
  { keywords: ["research", "研究", "search", "搜索", "exa", "检索", "deep research", "深入研究", "investigate"], skillNames: ["deep-research", "exa-search", "search-first"] },

  // ── Session / Workspace ──
  { keywords: ["session", "会话", "resume", "恢复", "save", "保存", "workspace", "工作区", "context", "上下文"], skillNames: ["source-command-resume-session", "source-command-save-session"] },

  // ── SPARC Methodology ──
  { keywords: ["sparc", "架构师模式", "sparc ask", "sparc code", "sparc debug", "sparc devops", "sparc tutorial"], skillNames: ["source-command-sparc-ask", "source-command-sparc-code", "source-command-sparc-debug", "source-command-sparc-devops", "source-command-sparc-docs-writer", "source-command-sparc-integration", "source-command-sparc-mcp", "source-command-sparc-post-deployment-monitoring-mode", "source-command-sparc-refinement-optimization-mode", "source-command-sparc-security-review", "source-command-sparc-sparc", "source-command-sparc-spec-pseudocode", "source-command-sparc-tutorial"] },

  // ── Hookify ──
  { keywords: ["hookify", "钩子", "git hook", "pre-commit", "pre-push", "post-commit", "git hooks"], skillNames: ["hookify-rules", "source-command-hookify", "source-command-hookify-configure", "source-command-hookify-help", "source-command-hookify-list"] },

  // ── Template / Scaffolding ──
  { keywords: ["template", "模板", "scaffolding", "脚手架", "authoring", "author", "编写", "target", "targeting"], skillNames: ["template-authoring", "template-discovery", "template-instantiation", "template-validation", "target-authoring", "author-component"] },

  // ── i18n / Localization ──
  { keywords: ["i18n", "国际化", "localization", "本地化", "translation", "翻译", "locale", "语言"], skillNames: [] },

  // ── OpenTelemetry ──
  { keywords: ["opentelemetry", "otel", "遥测", "telemetry", "tracing", "链路追踪", "observability", "可观测性"], skillNames: ["configuring-opentelemetry-dotnet"] },

  // ── Evaluation / Eval ──
  { keywords: ["eval", "evaluate", "评估", "harness", "测试框架"], skillNames: ["eval-harness", "eval-performance", "source-command-learn-eval"] },

  // ── Code Quality / Standards ──
  { keywords: ["code quality", "代码质量", "coding standards", "编码规范", "coding standard", "lint", "linter", "静态分析", "static analysis", "property pattern"], skillNames: ["coding-standards", "cpp-coding-standards", "java-coding-standards", "plankton-code-quality", "crap-score", "property-patterns", "code-tour"] },

  // ── Automation / Autonomous ──
  { keywords: ["automation", "自动化", "autonomous", "自动", "loop", "循环", "continuous", "持续"], skillNames: ["automation-audit-ops", "autonomous-loops", "continuous-agent-loop", "continuous-learning", "continuous-learning-v2"] },

  // ── Coordinate / Component Collaboration ──
  { keywords: ["coordinate", "协调", "component", "cpm", "组件协作", "component model", "协作"], skillNames: ["coordinate-components", "convert-to-cpm"] },

  // ── Connections / Network ──
  { keywords: ["connections", "连接", "connect", "network", "网络", "optimizer"], skillNames: ["connections-optimizer"] },

  // ── Cost Management ──
  { keywords: ["cost", "成本", "budget", "预算", "token budget", "token limit", "令牌预算", "spend", "消费", "ecc tools"], skillNames: ["cost-aware-llm-pipeline", "ecc-tools-cost-audit", "token-budget-advisor"] },

  // ── Platform Detection ──
  { keywords: ["platform", "平台", "detect", "检测", "os", "操作系统", "runtime", "运行时", "cross-platform"], skillNames: ["platform-detection"] },

  // ── Prerendering / SSR ──
  { keywords: ["prerender", "prerendering", "ssr", "server-side rendering", "服务端渲染", "预渲染"], skillNames: ["support-prerendering"] },

  // ── Configure ECC / Settings ──
  { keywords: ["ecc", "configure", "配置", "settings", "setup", "设置", "初始化"], skillNames: ["configure-ecc", "ecc-tools-cost-audit", "extension-points", "source-command-setup-pm"] },

  // ── NanoClaw REPL ──
  { keywords: ["nanoclaw", "repl", "交互式", "interactive", "read-eval-print"], skillNames: ["nanoclaw-repl"] },

  // ── Code Tour ──
  { keywords: ["code tour", "代码导览", "walkthrough", "引导", "onboarding", "入职", "codebase tour"], skillNames: ["code-tour"] },

  // ── Including Generated Files ──
  { keywords: ["generated files", "生成文件", "include generated", "auto-generated", "自动生成"], skillNames: ["including-generated-files"] },

  // ── Fetch and Send Data ──
  { keywords: ["fetch", "获取", "send", "发送", "data transfer", "数据传输", "http request", "http 请求"], skillNames: ["fetch-and-send-data"] },

  // ── Collect User Input ──
  { keywords: ["user input", "用户输入", "collect", "收集", "prompt user", "交互输入"], skillNames: ["collect-user-input"] },

  // ── JS Interop ──
  { keywords: ["js interop", "javascript interop", "互操作", "js互调", "wasm interop"], skillNames: ["use-js-interop"] },

  // ── Minimal API / File Upload ──
  { keywords: ["minimal api", "最小api", "file upload", "文件上传", "minimal", "简洁api"], skillNames: ["minimal-api-file-upload"] },

  // ── Technology Selection ──
  { keywords: ["technology selection", "技术选型", "tech stack", "技术栈", "choose technology", "选型"], skillNames: ["technology-selection"] },

  // ── Strategic Compact ──
  { keywords: ["strategic", "战略", "compact", "contract", "协议", "strategy"], skillNames: ["strategic-compact"] },

  // ── Plankton / Code Analysis ──
  { keywords: ["plankton", "代码分析", "code analysis", "crap score", "crap"], skillNames: ["plankton-code-quality", "crap-score"] },

  // ── Generate Testability Wrappers ──
  { keywords: ["testability", "可测试性", "wrapper", "包装", "test wrapper", "test double"], skillNames: ["generate-testability-wrappers"] },

  // ── Auto Update ──
  { keywords: ["auto update", "自动更新", "update check", "检查更新"], skillNames: ["source-command-auto-update"] },

  // ── Claude Flow Commands ──
  { keywords: ["claude flow", "claude flow help", "claude flow memory", "claude flow swarm"], skillNames: ["source-command-claude-flow-help", "source-command-claude-flow-memory", "source-command-claude-flow-swarm"] },

  // ── Feature Dev ──
  { keywords: ["feature dev", "功能开发", "feature development", "新功能"], skillNames: ["source-command-feature-dev"] },

  // ── Evolve ──
  { keywords: ["evolve", "进化", "evolution", "skills evolve"], skillNames: ["source-command-evolve"] },

  // ── Promote ──
  { keywords: ["promote", "提升", "promotion", "promote skill"], skillNames: ["source-command-promote"] },

  // ── Projects / Jira ──
  { keywords: ["projects", "项目", "project management", "jira"], skillNames: ["source-command-projects", "source-command-jira"] },

  // ── Migrate VSTest / MTP ──
  { keywords: ["vstest", "mtp", "microsoft test platform", "test platform", "测试平台"], skillNames: ["migrate-vstest-to-mtp", "mtp-hot-reload"] },

  // ── Dotnet Trace Collect ──
  { keywords: ["dotnet trace", "dotnet 跟踪", "eventpipe", "diagnostic", "诊断"], skillNames: ["dotnet-trace-collect"] },

  // ── Thread Abort Migration ──
  { keywords: ["thread abort", "线程中止", "threading", "多线程", "abort"], skillNames: ["thread-abort-migration"] },

  // ── System.Text.Json ──
  { keywords: ["system.text.json", "system text json", "json serialization", "json 序列化", "json serializer", "json.net", "json"], skillNames: ["system-text-json-net11"] },

  // ── Resolve Project References ──
  { keywords: ["project reference", "项目引用", "project dependency", "项目依赖", "reference resolution"], skillNames: ["resolve-project-references"] },

  // ── Detect Static Dependencies ──
  { keywords: ["static dependency", "静态依赖", "dependency detection", "依赖检测"], skillNames: ["detect-static-dependencies"] },

  // ── Check Bin/Obj Clash ──
  { keywords: ["bin obj", "bin/obj", "output clash", "输出冲突", "build output"], skillNames: ["check-bin-obj-clash"] },

  // ── Incremental Build ──
  { keywords: ["incremental build", "增量构建", "增量编译"], skillNames: ["incremental-build"] },

  // ── MTP Hot Reload ──
  { keywords: ["hot reload", "热重载", "hot reload test", "test hot reload"], skillNames: ["mtp-hot-reload"] },

  // ── Laravel Plugin Discovery ──
  { keywords: ["laravel plugin", "laravel package", "package discovery", "插件发现"], skillNames: ["laravel-plugin-discovery"] },
];

// ── Match skills to conversation context ──
export function matchSkills(skills, userMessage) {
  if (!skills?.length || !userMessage) return [];
  const msg = userMessage.toLowerCase();
  const matched = new Set();

  for (const group of SKILL_KEYWORD_MAP) {
    for (const kw of group.keywords) {
      if (msg.includes(kw)) {
        // Log which keyword triggered which skills
        for (const skillName of group.skillNames) {
          if (skills.some(s => s.name === skillName)) {
            matched.add(skillName);
          }
        }
        if (group.skillNames.length === 0) {
          debug(t("skillsAutoMatch", kw, "(no matching skill)"));
        }
        break; // One keyword match per group is enough
      }
    }
  }

  const result = Array.from(matched);
  if (result.length > 0) {
    log(t("skillsActivated", result.join(", ")));
  }
  return result;
}

// ── Build system prompt injection for matched skills ──
export function buildSkillActivationPrompt(matchedSkills, skills, maxSkills = 3) {
  if (!matchedSkills?.length) return "";
  const matched = skills.filter(s => matchedSkills.includes(s.name));
  if (!matched.length) return "";

  // Limit to top N matches to control token usage
  const top = matched.slice(0, maxSkills);

  const parts = ["\n## Activated Skills for Current Task\n"];
  parts.push("The following skills have been auto-matched. Apply their best practices and patterns:\n");

  for (const skill of top) {
    parts.push(`- **${skill.name}**: ${skill.description}`);
    // Only include content excerpt for the first (most relevant) skill
    if (skill === top[0] && skill.prompt) {
      const excerpt = skill.prompt.slice(0, 300); // keep it brief
      parts.push(`  Key patterns from ${skill.name}:\n  ${excerpt.split('\n').slice(0, 8).join('\n  ')}`);
    }
  }

  if (matched.length > maxSkills) {
    parts.push(`\n(${matched.length - maxSkills} additional matched skills not shown to save context)`);
  }

  return parts.join("\n");
}
