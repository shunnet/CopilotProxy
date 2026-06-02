// ── Tool Call Extractor & Normalizer ──
// Extracted from server.js for maintainability.
// Handles: JSON tool blocks, XML function_calls, markdown file creation,
// inline JSON tool calls, and malformed JSON salvage.
//
// Fixes applied:
//   - Better XML pattern detection for stream disconnect prevention
//   - Fallback XML parsing for <tool_call> format (MiMo/DeepSeek text output)

import "./polyfill.js";
import { debug } from "./logger.js";
import { applyToolDefaults, isKnownTool } from "./tool-schemas.js";

const _normLog = (msg) => { debug(msg); };
const callId = () => `call_${crypto.randomUUID().slice(0, 8)}`;

// Fix JSON.parse damage on path fields: \n → \\n (newline), \t → \\t (tab), \r → \\r
export function _fixPathEscapes(s) {
  return s.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

// ── Check if text contains XML tool call patterns ──
// Used for early detection during streaming to prevent disconnect
export function hasXMLToolCalls(text) {
  if (!text || typeof text !== "string") return false;
  return /<tool_call>|<function_calls>|<\/function>|<\/tool_call>/i.test(text);
}

// ── Parse XML tool_call format (MiMo/DeepSeek text output) ──
// Handles: <tool_call> <function=name> <parameter=key>value</parameter> </function> </tool_call>
export function parseXMLToolCalls(text) {
  if (!text) return [];
  const calls = [];

  // Pattern 1: <tool_call> <function=name> <parameter=key>value</parameter> </function> </tool_call>
  const tcBlockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let tcMatch;
  while ((tcMatch = tcBlockRe.exec(text)) !== null) {
    const inner = tcMatch[1];
    const funcRe = /<function\s*=\s*([^\s>]+)\s*>\s*([\s\S]*?)\s*<\/function>/gi;
    let funcMatch;
    while ((funcMatch = funcRe.exec(inner)) !== null) {
      const fnName = funcMatch[1];
      const fnBody = funcMatch[2];
      const args = {};
      const paramRe = /<parameter\s*=\s*([^\s>]+)\s*>\s*([\s\S]*?)\s*<\/parameter>/gi;
      let paramMatch;
      while ((paramMatch = paramRe.exec(fnBody)) !== null) {
        args[paramMatch[1]] = paramMatch[2];
      }
      calls.push({
        id: callId(), type: "function",
        function: { name: fnName, arguments: JSON.stringify(args) },
      });
    }
  }

  // Pattern 2: <function_calls> <invoke name="..."><parameter name="...">value</parameter></invoke> </function_calls>
  const fcBlockRe = /<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/gi;
  let fcMatch;
  while ((fcMatch = fcBlockRe.exec(text)) !== null) {
    const inner = fcMatch[1];
    const invokeRe = /<invoke\s+name\s*=\s*"([^"]+)"\s*>\s*([\s\S]*?)\s*<\/invoke>/gi;
    let invMatch;
    while ((invMatch = invokeRe.exec(inner)) !== null) {
      const fnName = invMatch[1];
      const fnBody = invMatch[2];
      const args = {};
      const paramRe = /<parameter\s+name\s*=\s*"([^"]+)"\s*>\s*([\s\S]*?)\s*<\/parameter>/gi;
      let paramMatch;
      while ((paramMatch = paramRe.exec(fnBody)) !== null) {
        args[paramMatch[1]] = paramMatch[2];
      }
      calls.push({
        id: callId(), type: "function",
        function: { name: fnName, arguments: JSON.stringify(args) },
      });
    }
  }

  return calls;
}

// ── MainnormalizeToolCall ──
export function normalizeToolCall(tc) {
  // NOTE: This ~180-line function handles many tool types; refactoring would improve maintainability but is deferred.
  const name = tc.function?.name || "";
  try {
    const raw = tc.function.arguments || "{}";
    let json = raw;
    // Fix invalid escape sequences
    json = json.replace(/(?<!\\)\\([^"\\\/bfnrtu])/g, '\\\\$1');
    // "queries": foo → "queries":["foo"]
    json = json.replace(/"queries"\s*:\s*([^\[",}\s][^,}]*)/g, (_, v) => {
      const t = v.trim();
      if (/^(?:null|true|false|-?\d)/.test(t)) return `"queries":${t}`;
      return `"queries":["${t}"]`;
    });
    // "includePattern": *.cs → "includePattern":"*.cs"
    json = json.replace(/"includePattern"\s*:\s*([^",}\s]+)(?=\s*[,}]|$)/g, (_, v) => {
      if (/^(?:null|true|false|-?\d)/.test(v)) return `"includePattern":${v}`;
      return `"includePattern":"${v}"`;
    });
    // "query": frontpage → "query":"frontpage"
    json = json.replace(/"query"\s*:\s*([^",}\s]+)(?=\s*[,}]|$)/g, (_, v) => {
      if (/^(?:null|true|false|-?\d)/.test(v)) return `"query":${v}`;
      return `"query":"${v}"`;
    });
    // Multi-word unquoted string values
    json = json.replace(/"(summary|description|details|agentName|memory|reason|prompt)\s*"\s*:\s*([^,}]+?)(?=\s*,\s*"|\s*}$|$)/g, (_, field, val) => {
      const t = val.trim();
      if (!t || /^(?:null|true|false|-?\d)/.test(t)) return `"${field}":${val}`;
      return `"${field}":"${t}"`;
    });
    const rawArgs = JSON.parse(json);
    const args = applyToolDefaults(name, rawArgs);
    const safe = {};

    // ── Tool-specific normalization ──
    if (/^get_file$/i.test(name)) {
      safe.filename = _fixPathEscapes(String(args.filename ?? args.filePath ?? args.path ?? args.uri ?? args.resource ?? ""));
      safe.startLine = (typeof args.startLine === "number" && args.startLine >= 1) ? args.startLine : 1;
      safe.endLine = (typeof args.endLine === "number" && args.endLine >= 1) ? args.endLine : 0;
      if (typeof args.includeLineNumbers === "boolean") safe.includeLineNumbers = args.includeLineNumbers;
    } else if (/^read_file$/i.test(name)) {
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.filename ?? args.path ?? args.uri ?? ""));
      safe.startLine = (typeof args.startLine === "number" && args.startLine >= 1) ? args.startLine : 1;
      safe.endLine = (typeof args.endLine === "number" && args.endLine >= 1) ? args.endLine : 0;
    } else if (/^(grep_search|search_content|search_file)$/i.test(name)) {
      safe.query = String(args.query ?? args.pattern ?? args.search ?? args.searchTerm ?? "");
      safe.isRegexp = (typeof args.isRegexp === "boolean") ? args.isRegexp : (typeof args.regex === "boolean" ? args.regex : false);
      safe.includePattern = args.includePattern ?? args.include ?? args.fileTypes ?? args.glob ?? null;
      if (safe.includePattern !== null) safe.includePattern = _fixPathEscapes(String(safe.includePattern));
      safe.maxResults = (typeof args.maxResults === "number" && args.maxResults >= 1) ? args.maxResults : 20;
    } else if (/^replace_string_in_file$/i.test(name)) {
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.path ?? args.filename ?? args.file ?? ""));
      safe.oldString = String(args.oldString ?? args.old_string ?? args.old_str ?? args.search ?? args.old_text ?? "");
      safe.newString = String(args.newString ?? args.new_string ?? args.new_str ?? args.replace ?? args.new_text ?? "");
    } else if (/^multi_replace_string_in_file$/i.test(name)) {
      const list = args.replacements ?? args.edits ?? args.changes ?? args.patches ?? args.operations ?? args.diffs;
      if (Array.isArray(list)) {
        safe.replacements = list.map(r => {
          const e = {};
          e.filePath = _fixPathEscapes(String(r.filePath ?? r.filepath ?? r.path ?? r.filename ?? r.file ?? ""));
          e.oldString = String(r.oldString ?? r.old_str ?? r.search ?? r.old_text ?? r.find ?? r.from ?? "");
          e.newString = String(r.newString ?? r.new_str ?? r.replace ?? r.new_text ?? r.to ?? "");
          return e;
        });
      } else {
        const so = String(args.oldString ?? args.old_str ?? args.search ?? args.old_text ?? "");
        const sn = String(args.newString ?? args.new_str ?? args.replace ?? args.new_text ?? "");
        if (so || sn) safe.replacements = [{ filePath: "", oldString: so, newString: sn }];
      }
      safe.explanation = String(args.explanation ?? "");
    } else if (/^create_file$/i.test(name)) {
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.file_path ?? args.path ?? args.filename ?? "")).replace(/\\/g, "/");
      safe.content = String(args.content ?? args.contents ?? args.text ?? args.code ?? "");
      for (const k of Object.keys(args)) {
        if (!(k in safe) && k !== "__proto__" && k !== "constructor" && k !== "prototype") safe[k] = args[k];
      }
    } else if (/^(?:remove_file|delete_files?)$/i.test(name)) {
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.path ?? args.filename ?? ""));
    } else if (/^(?:run_command_in_terminal|execute_command)$/i.test(name)) {
      safe.command = String(args.command ?? args.cmd ?? "");
      safe.summary = String(args.summary ?? args.description ?? "");
      safe.background = (typeof args.background === "boolean") ? args.background : (typeof args.runInBackground === "boolean" ? args.runInBackground : false);
    } else if (/^get_background_terminal_output$/i.test(name)) {
      safe.terminal_id = _fixPathEscapes(String(args.terminal_id ?? args.terminalId ?? args.terminal ?? ""));
      safe.headLines = (typeof args.headLines === "number") ? args.headLines : 0;
      safe.tailLines = (typeof args.tailLines === "number") ? args.tailLines : 0;
      safe.stop = (typeof args.stop === "boolean") ? args.stop : false;
      safe.waitMs = (typeof args.waitMs === "number") ? args.waitMs : (typeof args.timeout === "number" ? args.timeout : 0);
    } else if (/^(run_in_terminal|send_to_terminal)$/i.test(name)) {
      safe.command = String(args.command ?? args.cmd ?? "");
      if (args.id != null) safe.id = String(args.id);
      if (args.explanation != null) safe.explanation = String(args.explanation);
      if (args.goal != null) safe.goal = String(args.goal);
      if (args.mode != null) safe.mode = String(args.mode);
      if (typeof args.isBackground === "boolean") safe.isBackground = args.isBackground;
      if (typeof args.timeout === "number") safe.timeout = args.timeout;
      if (typeof args.waitForOutput === "boolean") safe.waitForOutput = args.waitForOutput;
    } else if (/^get_terminal_output$/i.test(name)) {
      safe.id = String(args.id ?? args.terminal_id ?? "");
    } else if (/^kill_terminal$/i.test(name)) {
      safe.id = String(args.id ?? args.terminal_id ?? "");
    } else if (/^semantic_search$/i.test(name)) {
      safe.query = String(args.query ?? args.search ?? "");
    } else if (/^fetch_webpage$/i.test(name)) {
      safe.urls = args.urls ?? args.url ?? [];
      if (!Array.isArray(safe.urls)) safe.urls = [String(safe.urls ?? "")];
      safe.query = String(args.query ?? "");
    } else if (/^runSubagent$/i.test(name)) {
      safe.prompt = String(args.prompt ?? args.task ?? "");
      safe.description = String(args.description ?? args.desc ?? "");
      if (args.agentName != null) safe.agentName = String(args.agentName);
      if (args.model != null) safe.model = String(args.model);
    } else if (/^manage_todo_list$/i.test(name)) {
      safe.todoList = args.todoList ?? args.todos ?? [];
      if (!Array.isArray(safe.todoList)) safe.todoList = [safe.todoList];
    } else if (/^memory$/i.test(name)) {
      safe.command = String(args.command ?? "");
      if (args.path != null) safe.path = _fixPathEscapes(String(args.path));
      if (args.file_text != null) safe.file_text = String(args.file_text);
      if (args.old_str != null) safe.old_str = String(args.old_str);
      if (args.new_str != null) safe.new_str = String(args.new_str);
      if (typeof args.insert_line === "number") safe.insert_line = args.insert_line;
      if (args.insert_text != null) safe.insert_text = String(args.insert_text);
      if (args.view_range != null) safe.view_range = args.view_range;
      if (args.old_path != null) safe.old_path = String(args.old_path);
      if (args.new_path != null) safe.new_path = String(args.new_path);
    } else if (/^vscode_listCodeUsages$/i.test(name)) {
      safe.symbol = String(args.symbol ?? args.symbolName ?? args.query ?? "");
      safe.lineContent = String(args.lineContent ?? args.line ?? "");
      if (args.filePath != null) safe.filePath = _fixPathEscapes(String(args.filePath));
      if (args.uri != null) safe.uri = String(args.uri);
    } else if (/^vscode_renameSymbol$/i.test(name)) {
      safe.symbol = String(args.symbol ?? "");
      safe.newName = String(args.newName ?? args.new_name ?? "");
      safe.lineContent = String(args.lineContent ?? args.line ?? "");
      if (args.filePath != null) safe.filePath = _fixPathEscapes(String(args.filePath));
      if (args.uri != null) safe.uri = String(args.uri);
    } else if (/^vscode_askQuestions$/i.test(name)) {
      safe.questions = args.questions ?? args.question ?? [];
      if (!Array.isArray(safe.questions)) safe.questions = [String(safe.questions ?? "")];
    } else if (/^run_vscode_command$/i.test(name)) {
      safe.commandId = String(args.commandId ?? args.command ?? "");
      safe.name = String(args.name ?? "");
      if (args.args != null) safe.args = args.args;
      if (typeof args.skipCheck === "boolean") safe.skipCheck = args.skipCheck;
    } else if (/^(create_and_run_task)$/i.test(name)) {
      for (const [k, v] of Object.entries(args)) {
        if (v != null) safe[k] = v;
      }
    } else if (/^github_text_search$/i.test(name)) {
      safe.scope = String(args.scope ?? "repo");
      safe.query = String(args.query ?? args.search ?? "");
      if (typeof args.maxResults === "number") safe.maxResults = args.maxResults;
    } else if (/^github_repo$/i.test(name)) {
      safe.repo = String(args.repo ?? "");
      safe.query = String(args.query ?? "");
    } else if (/^(open_browser_page|read_page|navigate_page|click_element|type_in_page|hover_element|drag_element|handle_dialog|screenshot_page|run_playwright_code)$/i.test(name)) {
      for (const [k, v] of Object.entries(args)) {
        if (v != null) safe[k] = v;
      }
    } else if (/^lookup_vs$/i.test(name)) {
      const rawTerms = args.terms ?? args.query ?? args.queries ?? args.search ?? args.searchTerms ?? "";
      safe.terms = Array.isArray(rawTerms) ? rawTerms.map(String) : [String(rawTerms)];
    } else {
      // Apply basic normalization for known tools without specific handlers
      if (isKnownTool(name)) {
        const fixed = _fixPathEscapes(JSON.stringify(args));
        try {
          const parsed = JSON.parse(fixed);
          const withDefaults = applyToolDefaults(name, parsed);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(withDefaults) } };
        } catch { return tc; }
      }
      return tc;
    }

    const fixed = JSON.stringify(safe);
    if (name) _normLog(`\x1b[35m[normalize] ${name} RAW: ${raw} → ${fixed}\x1b[0m`);
    return { ...tc, function: { ...tc.function, arguments: fixed } };
  } catch (e) {
    debug(`\x1b[33m[normalize] ${name} JSON parse failed: ${e.message?.slice(0, 100)}\x1b[0m`);
    const raw2 = tc.function?.arguments;
    if (!raw2) return null;
    // ── Salvage malformed JSON for common tools ──
    const salvaged = salvageToolCall(name, raw2);
    if (salvaged) return salvaged;
  }
  _normLog(`\x1b[31m[drop] ${name}: JSON parse failed, salvage unsuccessful — discarding\x1b[0m`);
  return null;
}

// ── Salvage malformed JSON for common tools ──
function salvageToolCall(name, raw2) {
  if (/^create_file$/i.test(name)) {
    try {
      const safe = {};
      const fpMatch = raw2.match(/"(?:filePath|file_path|path|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/)
                   || raw2.match(/"(?:filePath|file_path|path|filename)"\s*:\s*`([^`]*)`/);
      safe.filePath = fpMatch ? fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
      let btContent = null;
      const btMatch = raw2.match(/"content"\s*:\s*`([\s\S]*?)`/);
      if (btMatch) { btContent = btMatch[1]; }
      const ctMatch = !btContent ? raw2.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)/) : null;
      safe.content = btContent || (ctMatch ? ctMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "");
      if (safe.filePath && safe.content.length > 0) {
        _normLog(`\x1b[33m[create_file] salvaged path=${safe.filePath} contentLen=${safe.content.length}\x1b[0m`);
        const fixed = JSON.stringify(safe);
        return { id: callId(), type: "function", function: { name, arguments: fixed } };
      }
    } catch {}
  }
  if (/^(get_file|read_file)$/i.test(name)) {
    try {
      const safe = {};
      let fnMatch = raw2.match(/"(?:filename|filePath|filepath|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!fnMatch) fnMatch = raw2.match(/"(?:filename|filePath|filepath|path)"\s*:\s*"((?:[^"\\]|\\.)*)/);
      const fpKey = name === "get_file" ? "filename" : "filePath";
      safe[fpKey] = fnMatch ? fnMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
      const slMatch = raw2.match(/"startLine"\s*:\s*(\d+)/);
      safe.startLine = slMatch ? parseInt(slMatch[1], 10) : undefined;
      const elMatch = raw2.match(/"endLine"\s*:\s*(\d+)/);
      safe.endLine = elMatch ? parseInt(elMatch[1], 10) : 0;
      if (safe[fpKey]) {
        _normLog(`\x1b[33m[${name}] salvaged ${fpKey}=${safe[fpKey]} startLine=${safe.startLine} endLine=${safe.endLine}\x1b[0m`);
        return { id: callId(), type: "function", function: { name, arguments: JSON.stringify(safe) } };
      }
    } catch {}
  }
  if (/^replace_string_in_file$/i.test(name)) {
    try {
      const safe = {};
      const fpMatch = raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)/) || raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      safe.filePath = fpMatch ? fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
      const osMatch = raw2.match(/"(?:oldString|old_string|old_str|old|search)"\s*:\s*"((?:[^"\\]|\\.)*)/);
      safe.oldString = osMatch ? osMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
      const nsMatch = raw2.match(/"(?:newString|new_string|new_str|new|replace)"\s*:\s*"((?:[^"\\]|\\.)*)/);
      safe.newString = nsMatch ? nsMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
      if (safe.filePath && (safe.oldString || safe.newString)) {
        _normLog(`\x1b[33m[replace_string_in_file] salvaged path=${safe.filePath}\x1b[0m`);
        return { id: callId(), type: "function", function: { name, arguments: JSON.stringify(safe) } };
      }
    } catch {}
  }
  if (/^(run_command_in_terminal|execute_command)$/i.test(name)) {
    try {
      const safe = {};
      const cmdMatch = raw2.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"command"\s*:\s*([^,}]+?)(?=\s*,\s*"|\s*}$|$)/);
      safe.command = cmdMatch ? cmdMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim() : "";
      const sumMatch = raw2.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"summary"\s*:\s*([^,}]+?)(?=\s*,\s*"|\s*}$|$)/);
      safe.summary = sumMatch ? sumMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim() : "";
      safe.background = /"background"\s*:\s*true/i.test(raw2);
      if (safe.command) {
        _normLog(`\x1b[33m[${name}] salvaged command="${safe.command.slice(0,60)}"\x1b[0m`);
        return { id: callId(), type: "function", function: { name, arguments: JSON.stringify(safe) } };
      }
    } catch {}
  }
  if (/^(grep_search|search_content|search_file)$/i.test(name)) {
    try {
      const safe = {};
      const qMatch = raw2.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"query"\s*:\s*([^,}\s]+)/);
      safe.query = qMatch ? qMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
      safe.isRegexp = /"isRegexp"\s*:\s*true/i.test(raw2);
      const ipMatch = raw2.match(/"includePattern"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (ipMatch) {
        safe.includePattern = ipMatch[1];
      } else {
        const unq = raw2.match(/"includePattern"\s*:\s*([^,}\s]+)/);
        safe.includePattern = (unq && unq[1] !== 'null') ? unq[1] : null;
      }
      const mrMatch = raw2.match(/"maxResults"\s*:\s*(\d+)/);
      safe.maxResults = mrMatch ? parseInt(mrMatch[1], 10) : 20;
      if (safe.query || safe.includePattern) {
        _normLog(`\x1b[33m[${name}] salvaged query="${safe.query}"\x1b[0m`);
        return { id: callId(), type: "function", function: { name, arguments: JSON.stringify(safe) } };
      }
    } catch {}
  }
  return null;
}

// ── VS Context extraction ──
export function getWorkspaceRoot(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    const m2 = c.match(/workspace root path is:\s*(\S+)/i);
    if (m2) return m2[1].replace(/\\+$/, "").replace(/\\/g, "/");
    const m3 = c.match(/path to (the )?workspace root:?\s*(\S+)/i);
    if (m3) return (m3[2] || m3[1] || "").replace(/\\+$/, "").replace(/\\/g, "/");
    const m4 = c.match(/<CurrentWorkingDirectory>\s*([^<]+)\s*<\/CurrentWorkingDirectory>/i);
    if (m4) return m4[1].trim().replace(/\\/g, "/");
    const m5 = c.match(/^([A-Za-z]:[\\/][^\n]+?)(?:\n|$)/);
    if (m5 && (m5[1].includes("\\") || m5[1].includes("/"))) {
      const p = m5[1].replace(/\\/g, "/");
      const dir = p.lastIndexOf("/");
      if (dir > 2) return p.substring(0, dir); // >2 ensures we have at least C:/something
    }
  }
  return "";
}

export function extractVSContext(messages) {
  return {
    workspace_root: getWorkspaceRoot(messages),
    active_file: (() => {
      for (const m of messages) {
        const c = typeof m.content === "string" ? m.content : "";
        const m2 = c.match(/currently opened file:?\s*(\S+)/i);
        if (m2) return m2[1].replace(/\\/g, "/");
        const m3 = c.match(/active file:?\s*(\S+)/i);
        if (m3) return m3[1].replace(/\\/g, "/");
      }
      return "";
    })(),
    selected_code: (() => {
      for (const m of messages) {
        const c = typeof m.content === "string" ? m.content : "";
        const m2 = c.match(/selected (?:code|text):?\s*\n?```[\w-]*\n?([\s\S]*?)```/i);
        if (m2) return m2[1].trim();
        const m3 = c.match(/<SelectedCode>([\s\S]*?)<\/SelectedCode>/i);
        if (m3) return m3[1].trim();
      }
      return "";
    })(),
  };
}

// ── Main extractor ──
export function extractToolCalls(text, workspaceRoot = "", messages = []) {
  if (!text) return { content: text || "", toolCalls: [] };
  const calls = [];
  let remaining = text;

  const vsCtx = workspaceRoot ? { workspace_root: workspaceRoot } : extractVSContext(messages);

  // 0. Parse XML tool_call format (MiMo/DeepSeek text output)
  // FIXED: Added early XML detection for stream disconnect prevention
  const xmlCalls = parseXMLToolCalls(text);
  for (const tc of xmlCalls) {
    const normalized = normalizeToolCall(tc);
    if (normalized) calls.push(normalized);
  }
  if (xmlCalls.length > 0) {
    // Remove parsed XML blocks from remaining text
    remaining = remaining.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
    remaining = remaining.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "");
  }

  // 1. Explicit ```tool blocks — brace-counted
  const toolBlockStartRe = /```tool\n\{/gi;
  let tb;
  while ((tb = toolBlockStartRe.exec(text)) !== null) {
    const jsonStart = tb.index + tb[0].length - 1;
    let depth = 1, endPos = -1, inStr = false, esc = false;
    for (let i = jsonStart + 1; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { endPos = i; break; } }
    }
    if (endPos < 0) continue;
    toolBlockStartRe.lastIndex = endPos + 1;
    const jsonStr = text.slice(jsonStart, endPos + 1);
    const fullMatch = text.slice(tb.index, endPos + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      const tc = normalizeToolCall({
        id: callId(), type: "function",
        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
      });
      if (tc) calls.push(tc);
      remaining = remaining.replace(fullMatch, "");
    } catch {}
  }

  // 2. ```json tool call blocks — brace-counted
  const jsonBlockStartRe = /```json\s*\n\{/gi;
  let jb;
  while ((jb = jsonBlockStartRe.exec(text)) !== null) {
    const jsonStart = jb.index + jb[0].length - 1;
    let depth = 1, endPos = -1, inStr = false, esc = false;
    for (let i = jsonStart + 1; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { endPos = i; break; } }
    }
    if (endPos < 0) continue;
    jsonBlockStartRe.lastIndex = endPos + 1;
    const jsonStr = text.slice(jsonStart, endPos + 1);
    const fullMatch = text.slice(jb.index, endPos + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.name && parsed.arguments) {
        const tc = normalizeToolCall({
          id: callId(), type: "function",
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
        });
        if (tc) { calls.push(tc); remaining = remaining.replace(fullMatch, ""); }
      }
    } catch {}
  }

  // 3. Inline JSON tool calls — brace-counted
  const inlineJsonHeadRe = /\{\s*"name"\s*:\s*"(create_file|replace_string_in_file|multi_replace_string_in_file|remove_file|get_file|read_file|grep_search|file_search|find_symbol|search_symbol|run_command_in_terminal|execute_command|replace_in_file|task_complete|start_modernization)"\s*,\s*"arguments"\s*:\s*\{/gi;
  let ij;
  while ((ij = inlineJsonHeadRe.exec(text)) !== null) {
    const fnName = ij[1];
    const startPos = ij.index;
    const braceStart = ij.index + ij[0].length - 1;
    let depth = 1, endPos = -1, inString = false, escape = false;
    for (let i = braceStart + 1; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { endPos = i; break; }
      }
    }
    if (endPos < 0) continue;
    inlineJsonHeadRe.lastIndex = endPos + 1;
    const fullJson = text.slice(startPos, endPos + 1);
    try {
      const parsed = JSON.parse(fullJson);
      if (parsed.name && parsed.arguments) {
        const tc = normalizeToolCall({
          id: callId(), type: "function",
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
        });
        if (tc) { calls.push(tc); remaining = remaining.replace(fullJson, ""); }
      }
    } catch {}
  }

  // 4. Markdown file creation: ## `path` ```lang\ncontent\n```
  const createRe = /(?:^|\n)(?:##\s*)?`([^`\n]+\.\w+)`\s*\n```[\w-]*\n([\s\S]*?)```/gi;
  let m;
  while ((m = createRe.exec(text)) !== null) {
    let fp = m[1].replace(/\\/g, "/").trim();
    const codeContent = m[2].trim();
    if (!fp || codeContent.length < 3 || codeContent.length > 200000) continue;
    if (/\.(csproj|vbproj|fsproj|jsproj|sln|xproj|dcproj|vcxproj|wsproj|njsproj)$/i.test(fp)) continue;
    if (vsCtx.workspace_root && !/^[A-Za-z]:[/\\]/.test(fp)) {
      fp = vsCtx.workspace_root.replace(/\/$/, "") + "/" + fp;
    }
    const tc = normalizeToolCall({
      id: callId(), type: "function",
      function: { name: "create_file", arguments: JSON.stringify({ filePath: fp, content: codeContent }) },
    });
    if (tc) calls.push(tc);
  }

  if (calls.length === 0) return { content: text, toolCalls: [] };
  return { content: remaining.replace(/\n{3,}/g, "\n\n").trim(), toolCalls: calls };
}
