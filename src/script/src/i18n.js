// 国际化模块 — 支持中文（默认）和英文
// 启动时可通过 SNET_LANGUAGE 环境变量设置初始语言
// 覆盖范围: 服务状态、API错误、保活、Token日志、Windows服务、Plan模板、诊断消息

let _lang = (typeof Bun !== "undefined" ? Bun.env.SNET_LANGUAGE : process.env.SNET_LANGUAGE) || "zh";
if (_lang !== "zh" && _lang !== "en") _lang = "zh";

const messages = {
  // === 服务状态 (server.js / snet-handle.js) ===
  listening:        { zh: "正在监听",                              en: "listening on" },
  creatingEnv:      { zh: "已创建 .env",                            en: "Created .env" },
  modelLoaded:      { zh: "[status] DeepSeek 模型已加载",          en: "[status] DeepSeek models loaded" },
  mimoLoaded:       { zh: "[status] MiMo 模型已加载",              en: "[status] MiMo models loaded" },
  modelRefreshing:  { zh: "[model] 正在刷新…",                      en: "[model] Refreshing..." },

  // === 服务控制 (server.js) ===
  serviceStopping:  { zh: "服务正在停止…",                         en: "Service stopping..." },
  serviceRestarting:{ zh: "正在重启…",                             en: "Restarting..." },
  serviceUpdating:  { zh: "正在更新并重启…",                       en: "Updating and restarting..." },
  shutdownTimeout:  { zh: "[stop] 已发出关闭信号但未退出 — 强制退出", en: "[stop] shutdown signaled but did not exit — forcing exit" },

  // === API Key 变更检测 (server.js) ===
  dsKeySet:         { zh: "[key] 已检测到 DeepSeek API Key — 正在刷新模型",     en: "[key] DeepSeek key set — refreshing models" },
  dsKeyRemoved:     { zh: "[key] DeepSeek API Key 已移除 — 正在刷新",            en: "[key] DeepSeek key removed — refreshing" },
  dsKeyNoModels:    { zh: "[key] 已检测到 DeepSeek Key 但模型列表为空 — 正在刷新", en: "[key] DeepSeek key set but model list empty — refreshing" },
  mimoKeySet:       { zh: "[key] 已检测到 MiMo API Key — 正在刷新模型",          en: "[key] MiMo key set — refreshing models" },
  mimoKeyRemoved:   { zh: "[key] MiMo API Key 已移除 — 正在刷新",                en: "[key] MiMo key removed — refreshing" },
  mimoKeyNoModels:  { zh: "[key] 已检测到 MiMo Key 但模型列表为空 — 正在刷新",    en: "[key] MiMo key set but model list empty — refreshing" },

  // === API 错误 (server.js) ===
  apiError:         { zh: "API 错误",                               en: "API error" },
  apiKeyNotConfig:  { zh: "未配置 {0} API Key。",                  en: "{0} API Key not configured." },
  rateLimitExceeded:{ zh: "超出频率限制",                           en: "Rate limit exceeded." },
  rateLimitSession: { zh: "[rate-limit] 会话 {0} 被限制，{1}ms 后解除", en: "[rate-limit] session {0} rate-limited for {1}ms" },

  // === Token 日志 (server.js) ===
  tokenUsage:       { zh: "[token] 请求:{0} 响应:{1} 总计:{2}",     en: "[token] req:{0} resp:{1} total:{2}" },
  tokenNoData:      { zh: "[token] 无用量数据",                    en: "[token] no usage data" },
  tokenNoDataReason:{ zh: "[token] 无用量数据 ({0})",               en: "[token] no usage data ({0})" },

  // === 诊断/调试 (server.js) ===
  debugContext:     { zh: "[context] {0}ch: {1}...",                en: "[context] {0}ch: {1}..." },
  debugToggle:      { zh: "[debug] {0} debug — {1}x",              en: "[debug] {0} debug — {1}x" },
  debugOff:         { zh: "debug 已关闭",                            en: "debug off" },
  debugOn:          { zh: "debug 已开启",                            en: "debug on" },
  debugSrc:         { zh: "{0} src={1}",                            en: "{0} src={1}" },
  debugTextToVS:    { zh: "  {0} → {1} chars of text to VS",       en: "  {0} → {1} chars of text to VS" },
  debugToolsToVS:   { zh: "  {0} → {1} tool calls to VS",          en: "  {0} → {1} tool calls to VS" },
  healthNoAvailable:{ zh: "无可用模型（请配置 DEEPSEEK_API_KEY）",   en: "No available models (configure DEEPSEEK_API_KEY)" },
  healthNoModels:   { zh: "模型列表为空（请检查 API Key）",           en: "Model list empty (check API Key)" },
  healthCheckFailed:{ zh: "健康检查失败: {0}",                       en: "Health check failed: {0}" },
  pagingKept:       { zh: "[paging] 保留 {0} 条消息（丢弃 {1} 条）", en: "[paging] kept {0} messages (dropped {1})" },
  compressDropped:  { zh: "[compress] 丢弃 {0} 对旧工具输出",        en: "[compress] dropped {0} old tool pairs" },

  // === 服务控制 (server.js) ===
  portInUse:        { zh: "[port] {0} 端口被占用 — 尝试 {1}",        en: "[port] port {0} in use — trying {1}" },
  reqBodyTooLarge:  { zh: "请求体过大: {0} bytes (最多 {1} bytes)",  en: "Request body too large: {0} bytes (max {1} bytes)" },
  i18nSet:          { zh: "[i18n] 语言已设置为 {0}",                 en: "[i18n] language set to {0}" },

  // === Windows 服务 (win-service.js) ===
  winSvcNotWin:     { zh: "当前不是 Windows 环境 — 降级为前台运行",    en: "Not Windows — falling back to foreground" },
  winSvcNeedBun:    { zh: "需要 Bun 运行时 — 降级为前台运行",         en: "Bun runtime required — falling back to foreground" },
  winSvcImportFfi:  { zh: "winsvc: 正在导入 ffi…",                 en: "winsvc: importing ffi..." },
  winSvcFfiEntered: { zh: "[winsvc] _isBun={1} — 平台={0}",         en: "[winsvc] _isBun={1} — platform={0}" },
  winSvcCallingStart: { zh: "[winsvc] 正在调用 StartServiceCtrlDispatcherW…", en: "[winsvc] calling StartServiceCtrlDispatcherW..." },
  winSvcStartOk:    { zh: "[winsvc] StartServiceCtrlDispatcherW 正常返回", en: "[winsvc] StartServiceCtrlDispatcherW returned OK" },
  winSvcStopReceived:{ zh: "[winsvc] 已接收停止控制码: {0}",         en: "[winsvc] received stop control: {0}" },
  winSvcStopping:   { zh: "[winsvc] 正在等待服务停止…",              en: "[winsvc] waiting for service to stop..." },
  winSvcStopSignaled:{ zh: "[winsvc] 服务已停止 — 正在调用 onStop()", en: "[winsvc] service stopped — calling onStop()" },
  winSvcWaitingStop:{ zh: "[winsvc] 失败 — 正在等待 SCM 停止服务…",  en: "[winsvc] failure — waiting for SCM to stop service..." },
  winSvcFailureRecovery:{ zh: "[winsvc] 失败恢复 — 正在调用 onStop()", en: "[winsvc] failure recovery — calling onStop()" },
  winSvcNotScm:     { zh: "[winsvc] 不是 SCM 启动 — 降级为前台运行",  en: "[winsvc] not launched by SCM — falling back to foreground" },
  winSvcMainEntered:{ zh: "[winsvc] ServiceMain 已进入",             en: "[winsvc] ServiceMain entered" },
  winSvcHandlerOk:  { zh: "[winsvc] 已注册控制处理器",               en: "[winsvc] control handler registered" },
  winSvcHandlerFailed:{ zh: "[winsvc] 控制处理器注册失败: {0}",      en: "[winsvc] control handler registration failed: {0}" },
  winSvcStartFailed: { zh: "[winsvc] onStart() 调用失败: {0}",       en: "[winsvc] onStart() call failed: {0}" },
  winSvcReady:      { zh: "[winsvc] 服务已就绪",                     en: "[winsvc] service ready" },
  winSvcCreateFailed:{ zh: "[winsvc] 服务创建失败: {0}",              en: "[winsvc] service create failed: {0}" },
  winSvcCreated:     { zh: "[winsvc] 服务已创建: {0}",                en: "[winsvc] service created: {0}" },
  winSvcStopNote:    { zh: "[winsvc] 停止命令已发送 — 等待服务停止",    en: "[winsvc] stop command sent — waiting for service to stop" },
  winSvcDeleteFailed:{ zh: "[winsvc] 服务删除失败: {0}",              en: "[winsvc] service delete failed: {0}" },
  winSvcRemoved:     { zh: "[winsvc] 服务已移除: {0}",                en: "[winsvc] service removed: {0}" },
  winSvcEnteringDispatch:{ zh: "[winsvc] 正在进入 StartServiceCtrlDispatcherW…", en: "[winsvc] entering StartServiceCtrlDispatcherW..." },
  winSvcDispatchReturned:{ zh: "[winsvc] StartServiceCtrlDispatcherW 返回: {0}", en: "[winsvc] StartServiceCtrlDispatcherW returned: {0}" },

  // === 会话保活 (session-keepalive.js) ===
  keepaliveIdle:    { zh: "[保活] 会话 {0} 空闲 {1}秒 — 正在停止 (已 ping {2} 次)", en: "[keepalive] session {0} idle {1}s — stopping (pinged {2} times)" },
  keepaliveLifetime:{ zh: "[保活] 会话 {0} 生命周期 {1}小时已超 — 正在重置上游缓存", en: "[keepalive] session {0} lifetime {1}h exceeded — resetting upstream cache" },
  keepalivePingOk:  { zh: "[保活] 会话 {0} ping #{1} 成功 ({2}/{3}，空闲 {4}秒)", en: "[keepalive] session {0} ping #{1} OK ({2}/{3}, idle {4}s)" },
  keepalivePingFail:{ zh: "[保活] 会话 {0} ping 失败: {1} — 正在清理", en: "[keepalive] session {0} ping failed: {1} — cleaning up" },
  keepaliveShutdown:{ zh: "[保活] 关闭 — 清理了 {0} 个会话，共 {1} 次 ping", en: "[keepalive] shutdown — cleaned {0} sessions, {1} total pings" },

  // === 仪表盘 TUI (logger.js) ===
  dashIdle:         { zh: "  idle...",                              en: "  idle..." },
  dashLiveTail:     { zh: "─ live tail ({0} 条) ─ ↑↓ PgUp PgDn ─",  en: "─ live tail ({0} entries) ─ ↑↓ PgUp PgDn ─" },
  dashPageInfo:     { zh: "─ page {0}/{1} ─ {2} entries ─ any key = live tail ─", en: "─ page {0}/{1} ─ {2} entries ─ any key = live tail ─" },

  // === 系统提示词 (token-optimizer.js) ===
  identityOverride: { zh: "你是 Snet Copilot，基于 {0} {1} 的 AI 编程助手。", en: "You are Snet Copilot, an AI coding assistant powered by {0}{1}." },
  systemPrompt:     { zh: "你是由 Snet Copilot 托管的 AI 编程助手，运行在 {0} 模型 {1}{2}上。在单个回复中完成整个任务，无需等待用户继续。", en: "You are an AI coding assistant hosted by Snet Copilot, running on {0} model {1}{2}. Complete the entire task in a single response — don't wait for the user to continue." },

  // === Token 日志辅助 (server.js) ===
  workDoneToken:    { zh: "[token] {0} token {1}ms",               en: "[token] {0} token {1}ms" },

  // === 摘要 ===
  newSessionSummary: { zh: "简洁摘要 — {0} (模型: {1}，工作区: {2}，{3} 条消息)", en: "Brief summary — {0} (model: {1}, workspace: {2}, {3} messages)" },
};

// ── 模板函数：替换 {0} {1} ... 占位符 ──
export function t(key, ...args) {
  const entry = messages[key];
  if (!entry) return key; // 缺失翻译时返回 key 本身（降级）
  const template = entry[_lang] || entry["en"];
  return template.replace(/\{(\d+)\}/g, (_, idx) => {
    const val = args[parseInt(idx, 10)];
    return val !== undefined ? String(val) : `{${idx}}`;
  });
}

// ── 运行时语言切换 ──
export function setLanguage(lang) {
  if (lang === "zh" || lang === "en") _lang = lang;
}

export function getLanguage() {
  return _lang;
}
