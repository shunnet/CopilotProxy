// ── Session Tracker ──
// Session registry, workspace continuity, task completion summary, nag detection.
// Extracted from server.js.

import { log, debug } from "./logger.js";
import "./polyfill.js";

// Session tracking — detect and number distinct conversation contexts
export const _sessionRegistry = new Map();
export const _workspaceSessions = new Map();
export const _workspaceSummaries = new Map();
export const _taskCompletedSessions = new Map();
export const _recentlyCompleted = new Map();
export const _rateLimitedSessions = new Map();
export let _sessionCounter = 0;

export function setSessionCounter(n) { _sessionCounter = n; }

// Periodic cleanup of expired session entries (24h TTL)
const _SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - _SESSION_MAX_AGE_MS;
  for (const [k, v] of _sessionRegistry) {
    if (new Date(v.createdAt).getTime() < cutoff) _sessionRegistry.delete(k);
  }
  for (const [k, v] of _workspaceSessions) {
    if (new Date(v.lastSeen).getTime() < cutoff) _workspaceSessions.delete(k);
  }
  for (const [k, v] of _workspaceSummaries) {
    if (new Date(v.timestamp).getTime() < cutoff) _workspaceSummaries.delete(k);
  }
  for (const [k, v] of _recentlyCompleted) {
    if (v < cutoff) _recentlyCompleted.delete(k);
  }
  for (const [k, v] of _rateLimitedSessions) {
    if (v.at < cutoff) _rateLimitedSessions.delete(k);
  }
}, 10 * 60 * 1000).unref();

export function sessionLog(prefix, msg) {
  log(`${prefix} ${msg}`);
}

// ── Task completion summary ──
export function _summarizeCompletedTask(messages) {
  // TODO: split into _extractModifiedFiles, _extractReadFiles, _extractFindings helpers
  const findings = [];
  const filesModified = new Set();
  const filesRead = new Set();
  let lastAssistantText = "";

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      const tcs = m.tool_calls || [];
      for (const tc of tcs) {
        const fn = tc.function || {};
        const name = fn.name || "";
        let args = {};
        try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch {}
        if (/^(?:create_file|write_to_file|write_file)$/i.test(name)) {
          if (args.filePath || args.path || args.filename) filesModified.add(args.filePath || args.path || args.filename);
        } else if (/^(?:replace_in_file|replace_string_in_file|multi_replace_string_in_file)$/i.test(name)) {
          if (args.filePath || args.path) filesModified.add(args.filePath || args.path);
        } else if (/^(?:remove_file|delete_file)$/i.test(name)) {
          if (args.filePath || args.path) filesModified.add(args.filePath || args.path);
        } else if (/^(?:read_file|get_file|open_file)$/i.test(name)) {
          if (args.filePath || args.path || args.filename) filesRead.add(args.filePath || args.path || args.filename);
        } else if (/^(?:grep_search|search_content|file_search)$/i.test(name)) {
          const q = args.query || args.pattern || args.search || "";
          if (q) findings.push(`searched for "${q.slice(0, 80)}"`);
        } else if (/^(?:find_symbol|search_symbol)$/i.test(name)) {
          const sym = args.symbolName || args.name || "";
          if (sym) findings.push(`looked up symbol "${sym}"`);
        } else if (/^(?:run_command_in_terminal|execute_command)$/i.test(name)) {
          const cmd = args.command || args.cmd || "";
          if (cmd) findings.push(`ran: ${cmd.slice(0, 100)}`);
        } else if (!/^(?:task_complete|start_modernization)$/i.test(name)) {
          findings.push(`used ${name}()`);
        }
      }
      if (typeof m.content === "string" && m.content.trim()) {
        lastAssistantText = m.content.trim().split("\n").filter(l => l.trim()).slice(0, 3).join(" ");
      }
    } else if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;
      const pathRe = /([\w./\\-]+\.(?:js|ts|tsx|jsx|cs|py|java|go|rs|cpp|c|h|hpp|css|html|json|xml|yaml|yml|md|sql|sh|bat|cmd|ps1))/gi;
      let match;
      while ((match = pathRe.exec(content)) !== null) {
        filesRead.add(match[1]);
      }
      const errRe = /Error[:\s]+([^\n]{10,120})/g;
      while ((match = errRe.exec(content)) !== null) {
        findings.push(`error: ${match[1].trim().slice(0, 120)}`);
      }
    }
  }

  const parts = [];
  if (filesModified.size > 0) parts.push(`Modified: ${[...filesModified].join(", ")}`);
  if (filesRead.size > 0) parts.push(`Read: ${[...filesRead].slice(0, 8).join(", ")}${filesRead.size > 8 ? ` (+${filesRead.size - 8} more)` : ""}`);
  if (findings.length > 0) parts.push(`Actions: ${findings.join("; ")}`);
  if (lastAssistantText) parts.push(`Conclusion: ${lastAssistantText.slice(0, 300)}`);

  return parts.length > 0 ? parts.join(". ") : "";
}
