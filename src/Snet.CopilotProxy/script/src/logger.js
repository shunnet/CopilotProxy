const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });

let _bannerCollapsed = [];
let _bannerExpanded = [];
let _banner = [];
let _collapsed = false;
let _activeReqs = 0;
let _buffer = [];
let _scrollOffset = 0;
let _scrollMode = false;
let _dashboard = false;
let _stdinBuf = "";
let _rawMode = false;

const VISIBLE_LINES = 10;
let _boxW = 78;
const setBoxWidth = (w) => { _boxW = w; };
const _visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function _debugOn() { return Bun.env.DEBUG === "1" || Bun.env.DEBUG === "true" || Bun.env.DEBUG === "yes"; }
function _visibleBuffer() { return _debugOn() ? _buffer : _buffer.filter(e => !e.debug); }

function enableDashboard(collapsedLines, expandedLines) {
  _bannerCollapsed = collapsedLines;
  _bannerExpanded = expandedLines;
  _banner = expandedLines;
  _collapsed = false;
  _activeReqs = 0;
  _buffer = [];
  _scrollOffset = 0;
  _scrollMode = false;
  _dashboard = true;
  _startKeys();
  _redraw();
}

function disableDashboard() {
  _dashboard = false;
  _banner = [];
  _buffer = [];
  _scrollOffset = 0;
  _scrollMode = false;
  _stopKeys();
}

// ── keyboard scroll support ──

function _startKeys() {
  if (!process.stdin.isTTY || _rawMode) return;
  try {
    process.stdin.setRawMode(true);
    _rawMode = true;
    process.stdin.resume();
    process.stdin.on("data", _onKey);
  } catch {}
}

function _stopKeys() {
  if (!_rawMode) return;
  try {
    process.stdin.removeListener("data", _onKey);
    process.stdin.setRawMode(false);
    _rawMode = false;
  } catch {}
}

function _onKey(buf) {
  // Handle mouse events (raw mode gives Buffer/Uint8Array)
  if ((Buffer.isBuffer(buf) || buf instanceof Uint8Array) && buf.length >= 6 && buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x4d) {
    const btn = buf[3] - 32;
    const vis = _visibleBuffer();
    if (btn === 64) {
      const maxOff = Math.max(0, vis.length - VISIBLE_LINES);
      _scrollOffset = Math.min(maxOff, _scrollOffset + VISIBLE_LINES);
      _scrollMode = true;
      _redraw();
    } else if (btn === 65) {
      _scrollOffset = Math.max(0, _scrollOffset - VISIBLE_LINES);
      _scrollMode = true;
      _redraw();
    }
    return;
  }
  const s = typeof buf === "string" ? buf : buf.toString();
  const vis = _visibleBuffer();
  if (s === "\x1b[A" || s === "\x1bOA") {
    if (_scrollOffset < vis.length - VISIBLE_LINES) _scrollOffset++;
    _scrollMode = true;
    _redraw();
    return;
  }
  if (s === "\x1b[B" || s === "\x1bOB") {
    if (_scrollOffset > 0) _scrollOffset--;
    _scrollMode = true;
    _redraw();
    return;
  }
  if (s === "\x1b[5~") {
    _scrollOffset = Math.min(Math.max(0, vis.length - VISIBLE_LINES), _scrollOffset + VISIBLE_LINES);
    _scrollMode = true;
    _redraw();
    return;
  }
  if (s === "\x1b[6~") {
    _scrollOffset = Math.max(0, _scrollOffset - VISIBLE_LINES);
    _scrollMode = true;
    _redraw();
    return;
  }
  if (s === "\x1b[C" || s === "\x1bOC") {        // Right arrow = expand models (exit ASB, show scrollbar)
    if (_collapsed) { process.stdout.write("\x1b[?1049l"); _collapsed = false; _banner = _bannerExpanded; _scrollMode = false; _scrollOffset = 0; _redraw(); }
    return;
  }
  if (s === "\x1b[D" || s === "\x1bOD") {        // Left arrow = collapse models (enter ASB, hide scrollbar)
    if (!_collapsed) { process.stdout.write("\x1b[?1049h"); _collapsed = true; _banner = _bannerCollapsed; _scrollMode = false; _scrollOffset = 0; _redraw(); }
    return;
  }
  if (_scrollMode) { _scrollMode = false; _scrollOffset = 0; _redraw(); }
  // Accumulate regular chars until Enter
  if (s === "\r" || s === "\n") {
    const cmd = _stdinBuf.trim().toLowerCase();
    _stdinBuf = "";
    process.stdout.write("\n");
    if (cmd === "stop" || cmd === "s" || cmd === "exit" || cmd === "e" || cmd === "quit" || cmd === "q") {
      _emitCmd("stop");
    } else if (cmd === "restart" || cmd === "r") {
      _emitCmd("restart");
    } else if (cmd === "update" || cmd === "u") {
      _emitCmd("update");
    } else if (cmd === "clear" || cmd === "c") {
      _buffer = [];
      _scrollOffset = 0;
      _scrollMode = false;
      _redraw();
    } else if (cmd === "debug" || cmd === "d") {
      _emitCmd("debug");
    }
  } else if (s === "\x03") {
    process.stdout.write("^C\n");
    _emitCmd("stop");
  } else if (s === "\x7f" || s === "\b") {
    if (_stdinBuf.length > 0) {
      _stdinBuf = _stdinBuf.slice(0, -1);
      process.stdout.write("\b \b");
    }
  } else if (s.length === 1 && s >= " ") {
    _stdinBuf += s;
    process.stdout.write(s);
  }
}

let _cmdHandler = null;
function onCommand(fn) { _cmdHandler = fn; }
function _emitCmd(cmd) {
  if (_cmdHandler) _cmdHandler(cmd);
  else {
    if (cmd === "stop") process.exit(0);
  }
}

// ── partial redraw: update only the page count line (scroll mode, new entries) ──

function _updatePageCount() {
  if (!_scrollMode || !_dashboard) return;
  const vis = _visibleBuffer();
  const total = vis.length;
  const pages = Math.max(1, Math.ceil(total / VISIBLE_LINES));
  const page = Math.ceil((total - _scrollOffset) / VISIBLE_LINES);
  const line = `\x1b[90m\u2500 page ${page}/${pages} \u2500 ${total} entries \u2500 any key = live tail \u2500\x1b[0m`;
  const row = _banner.length + 1;
  process.stdout.write(`\x1b7\x1b[${row};1H\x1b[K${line}\x1b8`);
}

// ── redraw: full repaint — alternate screen buffer makes flicker negligible ──

function _redraw() {
  const vis = _visibleBuffer();
  const total = vis.length;
  const pages = Math.max(1, Math.ceil(total / VISIBLE_LINES));

  // Clamp scroll offset when visible buffer shrinks (e.g. debug toggled off)
  const maxOff = Math.max(0, total - VISIBLE_LINES);
  if (_scrollOffset > maxOff) _scrollOffset = maxOff;

  // Move to home, clear visible area only (preserves scrollback history)
  let out = "\x1b[H\x1b[J";
  for (const line of _banner) out += line + "\n";

  if (_scrollMode) {
    const start = Math.max(0, total - VISIBLE_LINES - _scrollOffset);
    const end = Math.min(total, start + VISIBLE_LINES);
    const page = Math.ceil((total - _scrollOffset) / VISIBLE_LINES);
    out += "\x1b[90m\u2500 page " + page + "/" + pages + " \u2500 " + total + " entries \u2500 any key = live tail \u2500\x1b[0m\n";
    for (let i = start; i < end; i++) {
      out += "\x1b[90m" + (vis[i].ts || ts()) + "\x1b[0m " + vis[i].text + "\n";
    }
  } else {
    const start = Math.max(0, total - VISIBLE_LINES);
    for (let i = start; i < total; i++) {
      out += "\x1b[90m" + (vis[i].ts || ts()) + "\x1b[0m " + vis[i].text + "\n";
    }
    if (total === 0) out += "\x1b[90m  idle...\x1b[0m\n";
    else out += "\x1b[90m\u2500 live tail (" + total + " entries) \u2500 \u2191\u2193 PgUp PgDn \u2500\x1b[0m\n";
  }
  process.stdout.write(out);
}

// ── logging ──

function log(msg) {
  if (_dashboard) {
    const vb = _visibleBuffer();
    const oldLen = vb.length;
    _buffer.push({ text: msg, debug: false, ts: ts() });
    if (_scrollMode) {
      _scrollOffset += _visibleBuffer().length - oldLen;
      _updatePageCount();
    } else { _scrollOffset = 0; _redraw(); }
  } else {
    process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${msg}\n`);
  }
}

function warn(msg) {
  if (_dashboard) {
    const vb = _visibleBuffer();
    const oldLen = vb.length;
    _buffer.push({ text: "\x1b[33m" + msg + "\x1b[0m", debug: false, ts: ts() });
    if (_scrollMode) {
      _scrollOffset += _visibleBuffer().length - oldLen;
      _updatePageCount();
    } else { _scrollOffset = 0; _redraw(); }
  } else {
    process.stderr.write(`\x1b[90m${ts()}\x1b[0m \x1b[33m${msg}\x1b[0m\n`);
  }
}

function error(msg) {
  if (_dashboard) {
    const vb = _visibleBuffer();
    const oldLen = vb.length;
    _buffer.push({ text: "\x1b[31m" + msg + "\x1b[0m", debug: false, ts: ts() });
    if (_scrollMode) {
      _scrollOffset += _visibleBuffer().length - oldLen;
      _updatePageCount();
    } else { _scrollOffset = 0; _redraw(); }
  } else {
    process.stderr.write(`\x1b[90m${ts()}\x1b[0m \x1b[31m${msg}\x1b[0m\n`);
  }
}

function debug(msg) {
  if (_debugOn()) process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${msg}\n`);
  if (_dashboard) {
    const vb = _visibleBuffer();
    const oldLen = vb.length;
    _buffer.push({ text: msg, debug: true, ts: ts() });
    if (_scrollMode) {
      _scrollOffset += _visibleBuffer().length - oldLen;
      _updatePageCount();
    } else { _scrollOffset = 0; _redraw(); }
  }
}

function reqLog({ tag, provider, model, preview, thinking, elapsed, sessionId }) {
  const tagPart = tag ? `[\x1b[35m${tag}\x1b[0m]` : "";
  const sessionPart = sessionId ? `[\x1b[36m${sessionId}\x1b[0m]` : "";
  const thinkPart = thinking ? `[\x1b[36m${thinking}\x1b[0m]` : "";
  const provModel = `[\x1b[0m${provider}/\x1b[1m${model || "?"}\x1b[0m]`;
  const prefix = `${tagPart}${sessionPart}>${thinkPart}${provModel}`;
  const prefixLen = _visLen(prefix);

  // Max suffix length: " → [XXXXXms]" — reserve worst-case space
  const maxSuffixLen = 14;
  const maxTrailLen = _boxW - 4 - prefixLen - maxSuffixLen;

  let trail = "";
  if (preview) {
    if (_debugOn()) {
      trail = ` — ${JSON.stringify(preview)}`;
    } else {
      const sep = " — ";
      const rawTrail = sep + JSON.stringify(preview);
      if (_visLen(rawTrail) <= maxTrailLen) {
        trail = rawTrail;
      } else {
        let maxChunk = Math.max(1, maxTrailLen - sep.length - 3);
        let chunk = preview.slice(0, maxChunk);
        while (chunk.length > 0 && _visLen(sep + JSON.stringify(chunk + "\u2026")) > maxTrailLen) {
          chunk = chunk.slice(0, -1);
        }
        trail = chunk ? sep + JSON.stringify(chunk + "\u2026") : "";
      }
    }
  }

  if (elapsed != null) {
    const msg = `${prefix}${trail} \x1b[32m→\x1b[0m [${elapsed}ms]`;
    if (_dashboard) {
      const vb = _visibleBuffer();
      const oldLen = vb.length;
      _buffer.push({ text: msg, debug: false, ts: ts() });
      if (_scrollMode) {
        _scrollOffset += _visibleBuffer().length - oldLen;
        _updatePageCount();
      } else { _scrollOffset = 0; _redraw(); }
    }
    else { process.stdout.write(`\x1b[90m${ts()}\x1b[0m ${msg}\n`); }
    return;
  }

  const initSuffix = "\u2014 \u2026 ";
  const initLine = `\x1b[90m${ts()}\x1b[0m ${prefix}${trail}${initSuffix}`;
  if (!_dashboard) process.stdout.write(initLine);

  return (elapsed) => {
    const msg = `${prefix}${trail} \x1b[32m→\x1b[0m [${elapsed}ms]`;
    if (_dashboard) {
      const vb = _visibleBuffer();
      const oldLen = vb.length;
      _buffer.push({ text: msg, debug: false, ts: ts() });
      if (_scrollMode) {
        _scrollOffset += _visibleBuffer().length - oldLen;
        _updatePageCount();
      } else { _scrollOffset = 0; _redraw(); }
    }
    else { process.stdout.write(`\r${initLine}\x1b[32m→\x1b[0m [${elapsed}ms]\n`); }
  };
}

function redrawBanner() { if (_dashboard) _redraw(); }
export { ts, log, warn, error, debug, reqLog, enableDashboard, disableDashboard, onCommand, redrawBanner, setBoxWidth };

function collapseBanner() {
  if (!_dashboard || _collapsed) return;
  process.stdout.write("\x1b[?1049h");
  _collapsed = true;
  _banner = _bannerCollapsed;
  _scrollMode = false;
  _scrollOffset = 0;
  _redraw();
}

function expandBanner() {
  if (!_dashboard || !_collapsed) return;
  process.stdout.write("\x1b[?1049l");
  _collapsed = false;
  _banner = _bannerExpanded;
  _scrollMode = false;
  _scrollOffset = 0;
  _redraw();
}

export { collapseBanner, expandBanner };
