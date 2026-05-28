// 工具参数 schema 定义（从 VS 2026 / VS Code / SQL Studio live dump 提取）
// 当 LLM 生成的 JSON 参数有误时，normalizeToolCall 使用此 schema 自动修复
//
// 来源：SKILL.md — 从 VS Copilot body.tools dump 提取的权威 schema
// 用法：normalizeToolCall → 查找 schema → 按 schema 校正参数

export const TOOL_SCHEMAS = {
  // ── File & Code Operations ──
  get_file:             { required: ["filename", "startLine", "endLine"], optional: ["includeLineNumbers"] },
  read_file:            { required: ["filePath", "startLine", "endLine"], optional: [] },
  create_file:          { required: ["filePath", "content"], optional: [] },
  replace_string_in_file: { required: ["filePath", "oldString", "newString"], optional: [] },
  multi_replace_string_in_file: { required: ["replacements", "explanation"], optional: [] },
  remove_file:          { required: ["filePath"], optional: [] },
  delete_file:          { required: ["filePath"], optional: [] },
  delete_files:         { required: ["filePath"], optional: [] },

  // ── Search ──
  grep_search:          { required: ["query", "isRegexp", "includePattern", "maxResults"], optional: [] },
  search_content:       { required: ["query", "isRegexp", "includePattern", "maxResults"], optional: [] },
  search_file:          { required: ["query", "isRegexp", "includePattern", "maxResults"], optional: [] },
  semantic_search:      { required: ["query"], optional: [] },
  code_search:          { required: ["searchQueries"], optional: [] },
  file_search:          { required: ["queries"], optional: ["maxResults"] },
  find_files:           { required: ["queries"], optional: ["maxResults"] },
  glob_search:          { required: ["queries"], optional: ["maxResults"] },
  list_files:           { required: ["queries"], optional: ["maxResults"] },

  // ── Symbol Lookup ──
  find_symbol:          { required: ["symbolName", "navigationType", "filepath", "lineText"], optional: [] },
  search_symbol:        { required: ["symbolName", "navigationType", "filepath", "lineText"], optional: [] },

  // ── Terminal ──
  run_command_in_terminal: { required: ["command", "summary", "background"], optional: ["id", "explanation", "goal", "mode", "isBackground", "timeout", "waitForOutput"] },
  execute_command:      { required: ["command", "summary", "background"], optional: ["id", "explanation", "goal", "mode", "isBackground", "timeout", "waitForOutput"] },
  get_background_terminal_output: { required: ["terminal_id", "headLines", "tailLines", "stop", "waitMs"], optional: [] },
  get_terminal_output:  { required: ["id"], optional: [] },
  kill_terminal:        { required: ["id"], optional: [] },
  run_in_terminal:      { required: ["command"], optional: ["id", "explanation"] },
  send_to_terminal:     { required: ["command"], optional: ["id", "explanation"] },

  // ── Web ──
  fetch_webpage:        { required: ["urls", "query"], optional: [] },
  open_browser_page:    { required: ["url"], optional: [] },
  read_page:            { required: [], optional: [] },
  navigate_page:        { required: ["url"], optional: [] },
  click_element:        { required: ["selector"], optional: [] },
  type_in_page:         { required: ["selector", "text"], optional: [] },
  hover_element:        { required: ["selector"], optional: [] },
  drag_element:         { required: ["selector", "target"], optional: [] },
  handle_dialog:        { required: ["action"], optional: ["text"] },
  screenshot_page:      { required: [], optional: [] },
  run_playwright_code:  { required: ["code"], optional: [] },

  // ── Planning / Task ──
  task_complete:        { required: [], optional: [] },
  plan:                 { required: ["planMarkdown"], optional: [] },
  manage_todo_list:     { required: ["todoList"], optional: [] },
  create_and_run_task:  { required: ["steps", "plan", "task", "workspaceFolder"], optional: [] },
  start_modernization:  { required: [], optional: [] },

  // ── Memory ──
  memory:               { required: ["command"], optional: ["path", "file_text", "old_str", "new_str", "insert_line", "insert_text", "view_range", "old_path", "new_path"] },

  // ── GitHub ──
  github_text_search:   { required: ["scope", "query"], optional: ["maxResults"] },
  github_repo:          { required: ["repo", "query"], optional: [] },

  // ── VS Code Specific ──
  vscode_listCodeUsages: { required: ["symbol", "lineContent"], optional: ["uri", "filePath"] },
  vscode_renameSymbol:  { required: ["symbol", "newName", "lineContent"], optional: ["uri", "filePath"] },
  vscode_askQuestions:  { required: ["questions"], optional: [] },
  run_vscode_command:   { required: ["commandId", "name"], optional: ["args", "skipCheck"] },
  lookup_vs:            { required: ["terms"], optional: [] },
  run_tests:            { required: ["filterTypes", "filterValues"], optional: [] },
  execute_tests:        { required: ["filterTypes", "filterValues"], optional: [] },
  insert_edit_into_file: { required: ["filePath", "code"], optional: [] },
  runSubagent:          { required: ["prompt", "description"], optional: ["agentName", "model"] },
};

/**
 * 根据 schema 填充缺失的必填参数默认值
 * @param {string} toolName
 * @param {object} args - 当前参数
 * @returns {object} - 补全后的参数
 */
export function applyToolDefaults(toolName, args) {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) return args;

  const result = { ...args };
  for (const field of schema.required) {
    if (result[field] === undefined || result[field] === null) {
      // 根据字段名推断默认值
      if (field === "isRegexp") result[field] = false;
      else if (field === "background") result[field] = false;
      else if (field === "maxResults") result[field] = 20;
      else if (field === "startLine") result[field] = 1;
      else if (field === "endLine") result[field] = 999999;
      else if (field === "navigationType") result[field] = 1;
      else if (field === "headLines" || field === "tailLines") result[field] = 0;
      else if (field === "stop") result[field] = false;
      else if (field === "waitMs") result[field] = 0;
      else if (Array.isArray(schema.properties?.[field]) || field.endsWith("s") || field === "queries") result[field] = [];
      else result[field] = "";
    }
  }
  return result;
}

/**
 * 检查工具是否在 schema 中注册
 * @param {string} toolName
 * @returns {boolean}
 */
export function isKnownTool(toolName) {
  return toolName in TOOL_SCHEMAS;
}

/**
 * VS 专用 custom 类型工具列表（来源：session-events.schema.json）
 * 这些工具以 type:"custom" 格式发送，需要转换为标准 type:"function" 格式
 */
export const VS_CUSTOM_TOOLS = new Set([
  "task",           // 子任务执行器
  "explore",        // 探索 Agent
  "research",       // 研究 Agent
  "code_review",    // 代码审查 Agent
  "configure",      // Copilot 配置
]);

/**
 * 将 VS custom 类型工具调用转换为标准 function 格式
 * VS 发送：{ type: "custom", custom: { name, input } }
 * 标准格式：{ type: "function", function: { name, arguments } }
 *
 * @param {object} tc — 工具调用对象
 * @returns {object} — 转换后的标准格式工具调用
 */
export function normalizeToolType(tc) {
  if (tc?.type === "custom" && tc.custom) {
    return {
      id: tc.id,
      type: "function",
      function: {
        name: tc.custom.name || tc.name || "unknown",
        arguments: typeof tc.custom.input === "string" ? tc.custom.input : JSON.stringify(tc.custom.input || {}),
      },
    };
  }
  return tc;
}
