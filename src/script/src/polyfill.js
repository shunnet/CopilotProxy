// 跨运行时兼容性 polyfill
// 确保 Bun 全局 API 在 Node.js 环境下也能使用
if (typeof Bun === 'undefined') {
  globalThis.Bun = { env: process.env };
}
