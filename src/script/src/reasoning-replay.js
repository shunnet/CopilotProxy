// ── Reasoning Replay ──
// Vizards-style replay marker encoding/decoding.
// Uses identical payload format: {"t": <reasoning_text>}
// Encoded as base64url JSON marker in assistant content (text-based equivalent of MIME part).
// VS preserves it in conversation history → persistent across restarts.

import { debug } from "./logger.js";

const MARKER_PREFIX = "deepseek-copilot";

// Base64url encode (like Vizards markers.ts:71-74)
function base64url(data) {
  return Buffer.from(data, "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Base64url decode
function base64urlDecode(str) {
  if (!str || !/^[A-Za-z0-9\-_]+$/.test(str)) return "";
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf-8");
}

// ── Embed reasoning for replay (Vizards markers.ts:52-63 equivalent) ──
export function embedReasoning(assistantContent, reasoningText) {
  if (!reasoningText) return assistantContent || "";
  const payload = { t: reasoningText };
  const encoded = "json:" + base64url(JSON.stringify(payload));
  // Embed as XML comment marker — VS preserves this in conversation history
  const marker = "<!--" + MARKER_PREFIX + "=" + encoded + "-->";
  return marker + (assistantContent || "");
}

// ── Extract replayed reasoning from messages (Vizards markers.ts:65-117 equivalent) ──
export function extractReplayedReasoning(messages) {
  if (!messages?.length) return { messages, reasoning: null };

  const markerRe = new RegExp("<!--" + MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=(json:[^>]+)-->");
  let reasoning = null;

  const result = messages.map(m => {
    if (m.role !== "assistant" || typeof m.content !== "string" || !m.content) return m;

    const match = m.content.match(markerRe);
    if (match) {
      try {
        const encoded = match[1]; // "json:..."
        const jsonStr = base64urlDecode(encoded.slice(5)); // strip "json:" prefix
        const payload = JSON.parse(jsonStr);
        if (payload.t) reasoning = payload.t;
        return { ...m, content: m.content.replace(match[0], "").trim(), reasoning_content: reasoning || undefined };
      } catch { debug(`[reasoning-replay] marker decode failed`); }
    }
    return m;
  });

  return { messages: result, reasoning };
}