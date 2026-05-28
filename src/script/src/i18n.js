// 国际化模块 — 支持中文（默认）和英文
// 启动时可通过 SNET_LANGUAGE 环境变量设置初始语言
let _lang = (typeof Bun !== "undefined" ? Bun.env.SNET_LANGUAGE : process.env.SNET_LANGUAGE) || "zh";
if (_lang !== "zh" && _lang !== "en") _lang = "zh";

const messages = {
  // === 服务状态 ===
  listening:        { zh: "正在监听",                              en: "listening on" },
  modelProcessing:  { zh: "[model] 处理中…",                      en: "[model] Processing..." },
  modelRefreshed:   { zh: "[model] 已刷新",                        en: "[model] Refreshed" },
  modelLoaded:      { zh: "[status] DeepSeek 模型已加载",          en: "[status] DeepSeek models loaded" },
  mimoLoaded:       { zh: "[status] MiMo 模型已加载",              en: "[status] MiMo models loaded" },
  creatingEnv:      { zh: "已创建 .env",                            en: "Created .env" },
  startupPid:       { zh: "[Snet] 启动 pid={0} argv={1}",         en: "[Snet] startup pid={0} argv={1}" },

  // === 会话 ===
  newSession:       { zh: "新会话 {0}",                             en: "new session {0}" },
  continuedSession: { zh: "继续会话 {0}",                           en: "continued session {0}" },
  sessionReuse:     { zh: "继续会话 {0} (同一客户端，活跃会话复用)",  en: "continued session {0} (same client, active session reused)" },
  workspaceInherit: { zh: "[session] 从会话 {0} 继承工作区 \"{1}\"", en: "[session] inherited workspace \"{1}\" from session {0}" },
  sessionNewConv:   { zh: "[session] NEW convId={0} wsRoot={1}",   en: "[session] NEW convId={0} wsRoot={1}" },
  sessionReuseConv: { zh: "[session] REUSE convId={0} sessionId={1}", en: "[session] REUSE convId={0} sessionId={1}" },

  // === 保活 ===
  keepaliveIdle:    { zh: "[保活] 会话 {0} 空闲 {1}秒 — 正在停止 (已 ping {2} 次)", en: "[keepalive] session {0} idle {1}s — stopping (pinged {2} times)" },
  keepaliveLifetime:{ zh: "[保活] 会话 {0} 生命周期 {1}小时已超 — 正在重置上游缓存", en: "[keepalive] session {0} lifetime {1}h exceeded — resetting upstream cache" },
  keepalivePingOk:  { zh: "[保活] 会话 {0} ping #{1} 成功 ({2}/{3}，空闲 {4}秒)", en: "[keepalive] session {0} ping #{1} OK ({2}/{3}, idle {4}s)" },
  keepalivePingFail:{ zh: "[保活] 会话 {0} ping 失败: {1} — 正在清理", en: "[keepalive] session {0} ping failed: {1} — cleaning up" },
  keepaliveShutdown:{ zh: "[保活] 关闭 — 清理了 {0} 个会话，共 {1} 次 ping", en: "[keepalive] shutdown — cleaned {0} sessions, {1} total pings" },

  // === 服务控制 ===
  serviceStopping:  { zh: "服务正在停止…",                         en: "Service stopping..." },
  serviceRestarting:{ zh: "正在重启…",                             en: "Restarting..." },

  // === API 错误 ===
  apiKeyNotConfig:  { zh: "未配置 {0} API Key。",                  en: "{0} API Key not configured." },
  apiError:         { zh: "API 错误",                               en: "API error" },
  apiRetry429:      { zh: "[model] 429 重试 {0}/{1}，{2}ms 后",    en: "[model] 429 retry {0}/{1} in {2}ms" },
  apiRetry5xx:      { zh: "[model] {0} 重试 {1}/{2}，{3}ms 后",    en: "[model] {0} retry {1}/{2} in {3}ms" },
  errorServiceBusy: { zh: "服务繁忙",                               en: "Service is too busy" },
  rateLimitExceeded:{ zh: "超出频率限制",                           en: "Rate limit exceeded." },

  // === 模型 ===
  dsKeyChanged:     { zh: "[deepseek] Key 已变更 — 刷新模型列表",   en: "[deepseek] Key changed — refreshing models" },
  dsKeySetNoModels: { zh: "[deepseek] Key 已设置但无模型 — 刷新中", en: "[deepseek] Key set but no models — refreshing" },
  mimoKeyChanged:   { zh: "[mimo] Key 已变更 — 刷新模型列表",       en: "[mimo] Key changed — refreshing models" },
  mimoKeySetNoModels:{ zh: "[mimo] Key 已设置但无模型 — 刷新中",    en: "[mimo] Key set but no models — refreshing" },
  modelRefreshing:  { zh: "[model] 正在刷新…",                      en: "[model] Refreshing..." },

  // === 工具/调试 ===
  toolStripping:    { zh: "[tool] 剥离了 {0} 个孤立工具调用: {1}",  en: "[tool] stripping {0} orphaned tool calls: {1}" },
  toolStrippedMsgs: { zh: "[tool] 剥离了 {0} 个孤立工具消息",       en: "[tool] stripped {0} orphaned tool messages" },
  toolStrippedTotal:{ zh: "[tool] 共剥离了 {0} 个孤立工具调用/消息", en: "[tool] stripped orphaned tool calls/messages from {0} total" },
  normalizeDrop:    { zh: "[normalize] {0}: JSON 解析失败，丢弃",   en: "[normalize] {0}: JSON parse failed, discarding" },
  normalizeJsonErr: { zh: "[normalize] {0} JSON 解析错误: {1}",     en: "[normalize] {0} JSON parse error: {1}" },
  normalizeRaw:     { zh: "[normalize] {0} RAW: {1} → {2}",        en: "[normalize] {0} RAW: {1} → {2}" },
  salvageCreateFile:{ zh: "[create_file] 挽救 path={0} contentLen={1}", en: "[create_file] salvaged path={0} contentLen={1}" },
  salvageGetFile:   { zh: "[get_file] 挽救 filename={0}",           en: "[get_file] salvaged filename={0}" },
  salvageReplace:   { zh: "[replace_string_in_file] 挽救 path={0}", en: "[replace_string_in_file] salvaged path={0}" },
  schemalog:        { zh: "[schema] {0}",                           en: "[schema] {0}" },
  extractInlineErr: { zh: "[extract-inline] create_file JSON 解析失败: {0}", en: "[extract-inline] create_file JSON parse failed: {0}" },

  // === 流式输出 ===
  streamDone:       { zh: "流已完成 ({0} 块)",                      en: "stream done ({0} chunks)" },
  streamError:      { zh: "[stream] {0}",                           en: "[stream] {0}" },
  deepseekReasoningErr: { zh: "[deepseek] reasoning_content 错误，正在无思考重试", en: "[deepseek] reasoning_content error, retrying without thinking" },
  deepseekRetryFail:{ zh: "[deepseek] 重试也失败: {0}",             en: "[deepseek] retry also failed: {0}" },

  // === 健康检查 ===
  healthNoModels:   { zh: "没有模型已加载 — 后台获取可能仍在进行中", en: "No models loaded — background fetch may still be in progress" },
  healthNoAvailable:{ zh: "没有模型可用",                           en: "No models available" },
  healthCheckFailed:{ zh: "健康检查失败: {0}",                      en: "Health check failed: {0}" },

  // === 端点日志 ===
  apiTagsCount:     { zh: "/api/tags → {0} 个模型",                 en: "/api/tags → {0} models" },
  apiTagsDividers:  { zh: " (+{0} 个分隔符)",                       en: " (+{0} dividers)" },

  // === 压缩 ===
  compressDropped:  { zh: "[compress] 丢弃了 {0} 个旧的工具对 (保留了最后 {1} 个)", en: "[compress] dropped {0} old tool pairs (kept last {1})" },
  deltaSaved:       { zh: "[delta] 历史压缩节省了约 {0}% ({1} → {2} 字符)", en: "[delta] history compression saved ~{0}% ({1} → {2} chars)" },

  // === 并发/重试 ===
  retryAttempt:     { zh: "重试 {0}/{1}，{2}ms 后 ({3})",          en: "Retry {0}/{1} after {2}ms ({3})" },

  // === banner ===
  bannerTitle:      { zh: "[ Shunnet.top ] Copilot Proxy",          en: "[ Shunnet.top ] Copilot Proxy" },
  bannerPort:       { zh: "端口",                                   en: "port" },
  bannerDefault:    { zh: "(默认)",                                 en: "(default)" },
  bannerCommands:   { zh: "命令: s/stop  r/restart  u/update  d/debug  ←→ 折叠  ↑↓PgUp/PgDn", en: "Commands: s/stop  r/restart  u/update  d/debug  ←→ collapse  ↑↓PgUp/PgDn" },
  bannerName:       { zh: "名称",                                   en: "Name" },
  bannerId:         { zh: "ID",                                     en: "ID" },
  bannerContext:    { zh: "上下文",                                 en: "Context" },

  // === 仪表盘 ===
  dashLiveTail:     { zh: "─ live tail ({0} 条) ─ ↑↓ PgUp PgDn ─", en: "─ live tail ({0} entries) ─ ↑↓ PgUp PgDn ─" },
  dashIdle:         { zh: "  idle...",                              en: "  idle..." },
  dashPageInfo:     { zh: "─ 页 {0}/{1} ─ {2} 条 ─ 任意键 = 实时跟踪 ─", en: "─ page {0}/{1} ─ {2} entries ─ any key = live tail ─" },

  // === 调试 ===
  debugOn:          { zh: "开",                                     en: "ON" },
  debugOff:         { zh: "关",                                     en: "OFF" },
  debugSrc:         { zh: "[debug] src={0}",                        en: "[debug] src={0}" },

  // === Win Service ===
  winSvcCreated:    { zh: '[win-svc] 已创建服务 "{0}"',             en: '[win-svc] Created service "{0}"' },
  winSvcFailureRecovery: { zh: "[win-svc] 已配置故障恢复: 3 次重启，每日重置", en: "[win-svc] Failure recovery configured: 3 restarts, daily reset" },
  winSvcReady:      { zh: '[win-svc] 服务 "{0}" 就绪。使用 `sc start {0}` 启动。', en: '[win-svc] Service "{0}" ready. Use `sc start {0}` to start.' },
  winSvcStopping:   { zh: '[win-svc] 正在停止服务 "{0}"…',          en: '[win-svc] Stopping service "{0}"...' },
  winSvcStopNote:   { zh: "[win-svc] sc stop 提示: {0}",           en: "[win-svc] sc stop note: {0}" },
  winSvcRemoved:    { zh: '[win-svc] 服务 "{0}" 已移除。',          en: '[win-svc] Service "{0}" removed.' },
  winSvcDeleteFailed:{ zh: "[win-svc] sc delete 失败: {0}",         en: "[win-svc] sc delete failed: {0}" },
  winSvcCreateFailed:{ zh: "[win-svc] sc create 失败: {0}",         en: "[win-svc] sc create failed: {0}" },
  winSvcFfiEntered: { zh: "[win-svc] runAsService 已进入, platform={0}, isBun={1}", en: "[win-svc] runAsService entered, platform={0}, isBun={1}" },
  winSvcNotWin:     { zh: "[win-svc] Windows 服务模式仅支持 Windows。", en: "[win-svc] Windows Service mode is only supported on Windows." },
  winSvcNeedBun:    { zh: "[win-svc] SCM 集成需要 bun:ffi。未在 Bun 下运行。回退到控制台模式。", en: "[win-svc] bun:ffi required for SCM integration. Not running under Bun. Falling back to console mode." },
  winSvcImportFfi:  { zh: "[win-svc] 正在导入 bun:ffi…",            en: "[win-svc] importing bun:ffi..." },
  winSvcFfiImported:{ zh: "[win-svc] bun:ffi 已导入",               en: "[win-svc] bun:ffi imported" },
  winSvcMainEntered:{ zh: "[win-svc] _svcMain 已进入",              en: "[win-svc] _svcMain entered" },
  winSvcHandlerFailed:{ zh: "[win-svc] RegisterServiceCtrlHandlerExW 失败", en: "[win-svc] RegisterServiceCtrlHandlerExW failed" },
  winSvcHandlerOk:  { zh: "[win-svc] 处理器已注册，正在报告 START_PENDING", en: "[win-svc] handler registered, reporting START_PENDING" },
  winSvcCallingStart:{ zh: "[win-svc] 正在调用 onStart…",            en: "[win-svc] calling onStart..." },
  winSvcStartFailed:{ zh: "[win-svc] onStart 失败: {0}",             en: "[win-svc] onStart failed: {0}" },
  winSvcStartOk:    { zh: "[win-svc] onStart 已返回，正在报告 RUNNING", en: "[win-svc] onStart returned, reporting RUNNING" },
  winSvcWaitingStop:{ zh: "[win-svc] 正在等待停止事件…",             en: "[win-svc] waiting on stop event..." },
  winSvcStopSignaled:{ zh: "[win-svc] 停止事件已触发，正在报告 STOPPED", en: "[win-svc] stop event signaled, reporting STOPPED" },
  winSvcEnteringDispatch:{ zh: "[win-svc] 正在调用 StartServiceCtrlDispatcherW, svcName={0}", en: "[win-svc] calling StartServiceCtrlDispatcherW, svcName={0}" },
  winSvcDispatchReturned:{ zh: "[win-svc] StartServiceCtrlDispatcherW 返回 {0}", en: "[win-svc] StartServiceCtrlDispatcherW returned {0}" },
  winSvcNotScm:     { zh: "[win-svc] 非 SCM 启动。回退到控制台模式。", en: "[win-svc] Not started by SCM. Falling back to console mode." },
  winSvcStopReceived:{ zh: "[win-svc] 收到 STOP/SHUTDOWN control={0}", en: "[win-svc] received STOP/SHUTDOWN control={0}" },

  // === 系统提示词 ===
  systemPrompt:     { zh: "你是运行在 VS Code / Visual Studio 中的 Copilot 编码助手，由 {0} {1}{2} 驱动。精确、高效，直接解决问题——不要加废话和猜测。使用工具进行文件操作、代码搜索和终端命令。修改文件前先读取。修改后验证正确性。如果任务不明确，只问一个澄清问题，不要猜测。",
                      en: "You are an expert coding assistant powered by {0} {1}{2}. You work inside VS Code / Visual Studio as a Copilot agent. Be precise, efficient, and solve the problem directly — never add fluff or speculation. Use tools for file operations, code search, and terminal commands. Read files before editing them. After making changes, verify correctness. If a task is unclear, ask one clarifying question instead of guessing." },

  // === 身份 ===
  identityOverride: { zh: "身份覆盖：你不是 GitHub Copilot。你是 \"Copilot (Snet)\"，运行在 {0}{1} 的编码助手。被问及身份时，说：\"我是 Copilot (Snet)，运行在 {0}{1}。\"永远不要自称 GitHub Copilot。",
                      en: "IDENTITY OVERRIDE: You are NOT GitHub Copilot. You are \"Copilot (Snet)\", a coding assistant running {0}{1}. When asked who you are, say: \"I am Copilot (Snet) running {0}{1}.\" Never claim to be GitHub Copilot." },

  // === i18n ===
  i18nSet:          { zh: "[i18n] 语言已设置为中文",                 en: "[i18n] language set to English" },
};

/**
 * 获取指定 key 的翻译文本
 */
export function t(key, ...args) {
  const entry = messages[key];
  let text = entry ? (entry[_lang] || entry.zh || key) : key;
  for (let i = 0; i < args.length; i++) {
    text = text.replace(`{${i}}`, String(args[i]));
  }
  return text;
}

export function setLanguage(lang) {
  if (lang === "zh" || lang === "en") _lang = lang;
}

export function getLanguage() {
  return _lang;
}
