// ── Message Pipeline ──
// Message validation, orphan stripping, merging, and processing.
// Extracted from server.js for maintainability.
//
// Fixes applied:
//   - Universal orphan tool message detection (was LP-only)
//   - tool_call_id validation in orphan checks
//   - Fixed index tracking in second-pass filter
//   - Relaxed break condition for tool message matching

import { log, debug } from "./logger.js";
import "./polyfill.js";

// ── Helper ──
export function _stripAllToolCalls(messages) {
  if (!messages?.length) return messages || [];
  return messages.map(m => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return { ...m, content: m.content || "", tool_calls: undefined };
    }
    return m;
  });
}

// ── Tool names extraction ──
export function _toolNames(messages) {
  const names = [];
  for (const m of messages || []) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        const n = tc?.function?.name || tc?.name;
        if (n && !names.includes(n)) names.push(String(n));
      }
    }
  }
  return names.join(", ") || "(none)";
}

// ── Strip orphaned tool_calls and tool messages ──
// Prevents DeepSeek/MiMo validation errors in both directions.
// FIXED: Uses explicit index tracking instead of result.indexOf(m)
// FIXED: Relaxed break condition for tool message matching
function _findMatchingAssistant(messages, idx) {
  for (let j = idx - 1; j >= 0; j--) {
    const prev = messages[j];
    if (prev.role === "assistant" && prev.tool_calls?.length) {
      if (prev.tool_calls.some(tc => tc.id === messages[idx].tool_call_id)) {
        return true;
      }
      return false;
    }
    if (prev.role === "user" || prev.role === "system") break;
  }
  return false;
}

function _stripOrphanedAssistantToolCalls(messages) {
  let stripped = 0;
  const result = messages.map(m => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;

    const callIds = m.tool_calls.map(tc => tc.id);
    const matched = new Set();
    const asstIdx = messages.indexOf(m);
    for (let j = asstIdx + 1; j < messages.length; j++) {
      const t = messages[j];
      if (t.role === "tool" && t.tool_call_id && callIds.some(cid => cid === t.tool_call_id)) {
        matched.add(t.tool_call_id);
      }
    }

    if (matched.size === 0) {
      stripped++;
      const { tool_calls, ...rest } = m;
      return { ...rest, content: m.content || "" };
    } else if (matched.size < callIds.length) {
      stripped++;
      const names = m.tool_calls.filter(tc => !matched.has(tc.id)).map(tc => tc.function?.name || "?");
      log(`  [tool] stripping ${callIds.length - matched.size} orphaned tool calls: ${names.join(", ")}`);
      return { ...m, tool_calls: m.tool_calls.filter(tc => matched.has(tc.id)) };
    }

    return m;
  });
  return { result, stripped };
}

function _stripOrphanedToolMessages(result) {
  const before = result.length;
  const filtered = [];
  let stripped = 0;
  for (let idx = 0; idx < result.length; idx++) {
    const m = result[idx];
    if (m.role !== "tool") {
      filtered.push(m);
      continue;
    }
    if (_findMatchingAssistant(result, idx)) {
      filtered.push(m);
    } else {
      stripped++;
    }
  }
  const orphanedTools = before - filtered.length;
  if (orphanedTools) debug(`  [tool] stripped ${orphanedTools} orphaned tool message${orphanedTools !== 1 ? "s" : ""}`);
  return { result: filtered, stripped };
}

export function _stripOrphanedToolCalls(messages) {
  if (!messages?.length) return { messages, stripped: 0 };
  let stripped = 0;

  // First pass: strip orphaned assistant tool calls
  const firstPass = _stripOrphanedAssistantToolCalls(messages);
  let result = firstPass.result;
  stripped += firstPass.stripped;

  // Second pass: strip orphaned tool messages
  const secondPass = _stripOrphanedToolMessages(result);
  result = secondPass.result;
  stripped += secondPass.stripped;

  if (stripped) debug(`  [tool] stripped orphaned tool calls/messages from ${stripped} total`);
  return { messages: result, stripped };
}

// ── Universal orphan tool message check ──
// Previously LP-only; now applies to ALL clients.
// Also validates tool_call_id matches preceding assistant's tool_calls.
export function checkOrphanToolMessage(userMsgs, m, clientTag) {
  if (userMsgs.length === 0) {
    log(`  [${clientTag || "?"}] dropping orphan tool message (no preceding messages)`);
    return { drop: true, reason: "no_preceding_messages" };
  }

  // Walk back to find the most recent assistant with tool_calls
  // (tool messages can be consecutive: assistant→tool→tool→…)
  let lastAssistant = null;
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const prev = userMsgs[i];
    if (prev.role === "assistant" && prev.tool_calls?.length) {
      lastAssistant = prev;
      break;
    }
    if (prev.role === "user" || prev.role === "system") break;
  }

  if (!lastAssistant) {
    return { drop: true, reason: "no_preceding_tool_calls" };
  }

  // Validate the tool_call_id actually matches
  const prevToolCallIds = new Set(lastAssistant.tool_calls.map(tc => tc.id));
  if (m.tool_call_id && !prevToolCallIds.has(m.tool_call_id)) {
    return { drop: true, reason: "tool_call_id_mismatch" };
  }

  return { drop: false };
}

