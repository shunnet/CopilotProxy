// ── Stream Handler ──
// SSE stream simulation, tool call reconstruction, XML detection during streaming.
// Extracted from server.js.
//
// Fixes applied:
//   - XML tool call detection during streaming (prevents disconnect)
//   - Post-stream XML extraction before [DONE] (correct finish_reason)
//   - Finish-reason-based tool call flushing (from deepseek-v4-for-copilot core.ts)

import "./polyfill.js";
import { hasXMLToolCalls, extractToolCalls, normalizeToolCall } from "./tool-extractor.js";

// ── Thinking display helpers ──
const _displayReasoning = (process.env.DISPLAY_REASONING || "false").toLowerCase() === "true";
const _collapsibleReasoning = (process.env.COLLAPSIBLE_REASONING || "true").toLowerCase() !== "false";
const _THINKING_BLOCK_START = _collapsibleReasoning ? "<details>\n<summary>snet Thinking</summary>\n\n" : "<!-- snet-thinking -->\n";
const _THINKING_BLOCK_END = _collapsibleReasoning ? "\n</details>\n\n" : "\n<!-- /snet-thinking -->\n\n";

export function _foldReasoningIntoContent(reasoningText, existingContent) {
  if (!reasoningText) return existingContent || "";
  return _THINKING_BLOCK_START + reasoningText + _THINKING_BLOCK_END + (existingContent || "");
}

export function addReasoningAliases(delta, reasoningText) {
  if (!reasoningText) return delta;
  if (_displayReasoning) return delta;
  delta.reasoning = reasoningText;
  delta.reasoning_content = reasoningText;
  delta.reasoning_text = reasoningText;
  delta.thinking = reasoningText;
  return delta;
}

// ── Stream simulation (non-streaming -> SSE chunks) ──
export async function _simStream(w, base, hasTools, toolCalls, text, reasoningContent) {
  if (reasoningContent) {
    if (_displayReasoning) {
      const folded = _foldReasoningIntoContent(reasoningContent, "");
      await w({ ...base, choices: [{ index: 0, delta: { content: folded }, finish_reason: null }] });
    } else {
      let dr = { content: "" };
      addReasoningAliases(dr, reasoningContent);
      await w({ ...base, choices: [{ index: 0, delta: dr, finish_reason: null }] });
    }
  }
  if (hasTools) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      await w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id || "call_" + crypto.randomUUID().slice(0, 8), type: tc.type || "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] });
    }
    await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  } else {
    const CHUNK_SIZE_THRESHOLD = 200; // flush buffer when approaching this char count
    const lines = (text || "").split("\n");
    let buffer = "";
    for (const line of lines) {
      if (buffer.length + line.length + 1 > CHUNK_SIZE_THRESHOLD && buffer) {
        await w({ ...base, choices: [{ index: 0, delta: { content: buffer + "\n" }, finish_reason: null }] });
        buffer = line;
      } else {
        buffer += (buffer ? "\n" : "") + line;
      }
    }
    if (buffer) await w({ ...base, choices: [{ index: 0, delta: { content: buffer }, finish_reason: null }] });
    await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }
}

// ── Reconstruct tool calls from stream deltas ──
export function reconstructToolCalls(deltas) {
  let fullText = "";
  let reasoningContent = null;
  const tcBuilders = new Map();

  for (const d of deltas) {
    if (d.content) fullText += d.content;
    if (d.reasoning_content) reasoningContent = d.reasoning_content;
    if (d.reasoning) reasoningContent = d.reasoning;
    if (d.tool_calls?.length) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        let b = tcBuilders.get(idx);
        if (!b) {
          b = { id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`, type: tc.type || "function", function: { name: "", arguments: "" } };
          tcBuilders.set(idx, b);
        }
        if (tc.id) b.id = tc.id;
        if (tc.type) b.type = tc.type;
        if (tc.function?.name) b.function.name = tc.function.name;
        if (tc.function?.arguments) b.function.arguments += tc.function.arguments;
      }
    }
  }

  const allToolCalls = [...tcBuilders.values()].map(normalizeToolCall).filter(Boolean);
  return { fullText, reasoningContent, allToolCalls };
}

// ── XML-aware streaming content accumulator ──
// Detects XML tool call patterns in real-time during streaming to prevent disconnect.
// Returns { emit, toolCallsDetected, xmlBuffer } state.
export function createXMLAwareStreamAccumulator(w, base, vsTools, workspaceRoot, messages) {
  let fullText = "";
  let xmlToolCallsDetected = false;
  let xmlBuffer = "";
  let emittedXml = false;

  return {
    get fullText() { return fullText; },
    get xmlDetected() { return xmlToolCallsDetected; },
    get xmlEmitted() { return emittedXml; },

    // Add content and check for XML patterns
    async addContent(content) {
      if (xmlToolCallsDetected) {
        xmlBuffer += content;
        return; // Buffer XML, don't emit as content
      }

      fullText += content;

      // Check if we've accumulated enough to detect XML tool calls
      if (hasXMLToolCalls(fullText)) {
        xmlToolCallsDetected = true;
        // The text before the XML pattern should have been emitted already
        // Now buffer the rest
        const xmlStart = fullText.search(/<tool_call>|<function_calls>/i);
        if (xmlStart > 0) {
          // Text before XML was already emitted by the caller
          xmlBuffer = fullText.slice(xmlStart);
          fullText = fullText.slice(0, xmlStart);
        } else {
          xmlBuffer = fullText;
          fullText = "";
        }
      }
    },

    // Extract and emit XML tool calls as structured deltas
    async emitXMLTools() {
      if (!xmlToolCallsDetected || !xmlBuffer || emittedXml) return { found: false };

      const extracted = extractToolCalls(xmlBuffer, workspaceRoot, messages);
      if (extracted.toolCalls.length) {
        // Emit tool calls as structured deltas
        for (let i = 0; i < extracted.toolCalls.length; i++) {
          const tc = extracted.toolCalls[i];
          await w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] });
        }
        emittedXml = true;
        return { found: true, toolCalls: extracted.toolCalls, content: extracted.content };
      }
      return { found: false };
    },
  };
}
