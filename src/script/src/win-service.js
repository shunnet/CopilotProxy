/**
 * Windows Service integration via bun:ffi + sc.exe.
 */
import "./polyfill.js";
import { t } from "./i18n.js";

let _isBun = false;
try { _isBun = typeof Bun !== 'undefined'; } catch {}

const SERVICE_NAME = process.env.SNET_SERVICE_NAME || "snet";
const DISPLAY_NAME = process.env.SNET_SERVICE_DISPLAY || "Snet Proxy";
const DESCRIPTION  = process.env.SNET_SERVICE_DESC  || "Ollama-compatible proxy connecting GitHub Copilot to OpenCode models";
const START_TYPE   = process.env.SNET_SERVICE_START || "auto";
const EXTRA_ARGS   = process.env.SNET_SERVICE_ARGS  || "";

const SERVICE_WIN32_OWN_PROCESS = 0x00000010;
const SERVICE_RUNNING           = 0x00000004;
const SERVICE_STOPPED           = 0x00000001;
const SERVICE_START_PENDING     = 0x00000002;
const SERVICE_STOP_PENDING      = 0x00000003;
const SERVICE_ACCEPT_STOP       = 0x00000001;
const SERVICE_ACCEPT_SHUTDOWN   = 0x00000004;
const SERVICE_CONTROL_STOP      = 0x00000001;
const SERVICE_CONTROL_SHUTDOWN  = 0x00000005;
const SERVICE_CONTROL_INTERROGATE = 0x00000004;
const NO_ERROR = 0;

import { exec as _execProcess } from "child_process";

function _exec(cmd) {
  return new Promise((resolve) => {
    try {
      _execProcess(cmd, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout||""), stderr: String(stderr||"") });
      });
    } catch (e) {
      resolve({ err: e, stdout: "", stderr: String(e) });
    }
  });
}

function _quote(s) { return "\"" + s.replace(/"/g, '\\"') + "\""; }

export async function installService(exePath) {
  const binPath = `${_quote(exePath)} --service ${EXTRA_ARGS}`.trim();
  const createCmd = `sc create ${SERVICE_NAME} binPath= ${binPath} start= ${START_TYPE} DisplayName= ${_quote(DISPLAY_NAME)}`;
  const { err, stdout, stderr } = await _exec(createCmd);
  if (err) {
  process.stderr.write(t("winSvcCreateFailed", err.message || stderr) + "\n");
    return false;
  }
  process.stdout.write(t("winSvcCreated", SERVICE_NAME) + "\n");

  const descCmd = `sc description ${SERVICE_NAME} ${_quote(DESCRIPTION)}`;
  await _exec(descCmd);

  const failCmd = `sc failure ${SERVICE_NAME} reset= 86400 actions= restart/5000/restart/10000/restart/30000`;
  await _exec(failCmd);
  process.stdout.write(t("winSvcFailureRecovery") + "\n");
  process.stdout.write(t("winSvcReady", SERVICE_NAME) + "\n");
  return true;
}

export async function uninstallService() {
  process.stdout.write(t("winSvcStopping", SERVICE_NAME) + "\n");

  const stopCmd = `sc stop ${SERVICE_NAME}`;
  const { err: stopErr } = await _exec(stopCmd);
  if (stopErr) {
  process.stderr.write(t("winSvcStopNote", stopErr.message || "already stopped") + "\n");
  }

  await new Promise(r => setTimeout(r, 2000));

  const delCmd = `sc delete ${SERVICE_NAME}`;
  const { err: delErr, stderr: delStderr } = await _exec(delCmd);
  if (delErr) {
  process.stderr.write(t("winSvcDeleteFailed", delStderr || delErr.message) + "\n");
    return false;
  }
  process.stdout.write(t("winSvcRemoved", SERVICE_NAME) + "\n");
  return true;
}

export async function handleServiceCommand(argv) {
  if (process.platform !== "win32") return { handled: false, exitCode: 0 };
  if (argv.includes("--install-service")) {
    const ok = await installService(process.execPath);
    return { handled: true, exitCode: ok ? 0 : 1 };
  }
  if (argv.includes("--uninstall-service")) {
    const ok = await uninstallService();
    return { handled: true, exitCode: ok ? 0 : 1 };
  }
  return { handled: false, exitCode: 0 };
}

// FFI callback buffers must be kept alive to prevent GC. Bun's FFI uses
// JSCallback objects that are GC-rooted only while referenced from JS.
// We maintain a bounded array (cap 1000) to prevent OOM in long-running
// services. Under normal operation (install/start/stop), only ~10 callbacks
// are created. If this ever becomes a bottleneck, switch to FinalizationRegistry.
let _keepAlive = [];
const _KEEPALIVE_MAX = 1000; // prevent OOM in long-running services
function _keep(buf) { if (_keepAlive.length < _KEEPALIVE_MAX) { _keepAlive.push(buf); } return buf; }

function _toWideBuf(str) {
  const n = str.length;
  const buf = Buffer.alloc((n + 1) * 2);
  for (let i = 0; i < n; i++) buf.writeUInt16LE(str.charCodeAt(i), i * 2);
  buf.writeUInt16LE(0, n * 2);
  return buf;
}

async function _initFfiBindings() {
  const { dlopen, FFIType, JSCallback, ptr } = await import("bun:ffi");
  const advapi32 = dlopen("advapi32.dll", {
    StartServiceCtrlDispatcherW: { args: [FFIType.ptr], returns: FFIType.i32 },
    RegisterServiceCtrlHandlerExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetServiceStatus: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const kernel32 = dlopen("kernel32.dll", {
    CreateEventW: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    SetEvent: { args: [FFIType.ptr], returns: FFIType.i32 },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  return { dlopen, FFIType, JSCallback, ptr, advapi32, kernel32 };
}

function _createStatusBuffer() {
  const buf = _keep(new ArrayBuffer(28));
  const view = new DataView(buf);
  return { buf, view };
}

export async function runAsService({ onStart, onStop }) {
  // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcFfiEntered", process.platform, _isBun) + "\r\n");
  if (process.platform !== "win32") {
  process.stderr.write(t("winSvcNotWin") + "\n");
    await onStart();
    return;
  }
  if (!_isBun) {
  process.stderr.write(t("winSvcNeedBun") + "\n");
    await onStart();
    return;
  }

  // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcImportFfi") + "\r\n");
  const ffi = await _initFfiBindings();
  const { advapi32, kernel32, FFIType, JSCallback, ptr } = ffi;

  let _statusHandle = null;
  let _stopEvent = null;
  const svcStatusBuf = _createStatusBuffer();
  const _stView = svcStatusBuf.view;

  function _reportStatus(state, exitCode = 0, waitHint = 0) {
    if (!_statusHandle) return;
    const controls = state === SERVICE_RUNNING
      ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN) : 0;
    _stView.setUint32(0,  SERVICE_WIN32_OWN_PROCESS, true);
    _stView.setUint32(4,  state, true);
    _stView.setUint32(8,  controls, true);
    _stView.setUint32(12, exitCode, true);
    _stView.setUint32(16, 0, true);
    _stView.setUint32(20, 0, true);
    _stView.setUint32(24, waitHint, true);
    advapi32.symbols.SetServiceStatus(_statusHandle, ptr(svcStatusBuf.buf));
  }

  function _reportStopped(exitCode = 0) { _reportStatus(SERVICE_STOPPED, exitCode, 0); }

  function _ctrlHandler(dwControl) {
    switch (dwControl) {
      case SERVICE_CONTROL_INTERROGATE: return NO_ERROR;
      case SERVICE_CONTROL_STOP:
      case SERVICE_CONTROL_SHUTDOWN:
        // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcStopReceived", dwControl) + "\r\n");
        _reportStatus(SERVICE_STOP_PENDING, NO_ERROR, 30000);
        try { onStop(); } catch (e) {
          // stderr/diagnostic writes intentionally ignored during shutdown
          try { process.stderr.write("[win-service] onStop error: " + (e?.message ?? e) + "\r\n"); } catch {}
        }
        if (_stopEvent) kernel32.symbols.SetEvent(_stopEvent);
        return NO_ERROR;
      default: return NO_ERROR;
    }
  }

  function _svcMain() {
    // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcMainEntered") + "\r\n");
    const ctrlCb = _keep(new JSCallback(_ctrlHandler, {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32,
    }));
    const nameWide = _keep(_toWideBuf(SERVICE_NAME));
    _statusHandle = advapi32.symbols.RegisterServiceCtrlHandlerExW(ptr(nameWide), ctrlCb.ptr, null);
    if (!_statusHandle) { process.stderr.write(t("winSvcHandlerFailed") + "\n"); return; }
    // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcHandlerOk") + "\r\n");
    _reportStatus(SERVICE_START_PENDING, NO_ERROR, 5000);
    // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcCallingStart") + "\r\n");
    try { onStart(); } catch (e) { process.stderr.write(t("winSvcStartFailed", e) + "\n"); _reportStopped(1); return; }
    // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcStartOk") + "\r\n");
    _reportStatus(SERVICE_RUNNING);
    // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcWaitingStop") + "\r\n");
    kernel32.symbols.WaitForSingleObject(_stopEvent, 0xFFFFFFFF);
    // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcStopSignaled") + "\r\n");
    _reportStopped();
  }

  _stopEvent = kernel32.symbols.CreateEventW(null, 1, 0, null);

  const svcMainCb = _keep(new JSCallback(_svcMain, { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void }));
  const nameWide = _keep(_toWideBuf(SERVICE_NAME));
  const namePtrBig = BigInt(ptr(nameWide));
  const cbPtrBig    = BigInt(svcMainCb.ptr);

  const tableBuf = _keep(new ArrayBuffer(32));
  const tableView = new DataView(tableBuf);
  tableView.setBigUint64(0, namePtrBig, true);
  tableView.setBigUint64(8, cbPtrBig, true);
  tableView.setBigUint64(16, 0n, true);
  tableView.setBigUint64(24, 0n, true);

  // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcEnteringDispatch", SERVICE_NAME) + "\r\n");
  const dispatched = advapi32.symbols.StartServiceCtrlDispatcherW(ptr(tableBuf));
  // stderr write intentionally ignored — may be unavailable
  process.stderr.write(t("winSvcDispatchReturned", dispatched) + "\r\n");
  if (dispatched === 0) {
  process.stderr.write(t("winSvcNotScm") + "\n");
    await onStart();
    return;
  }

  if (_stopEvent) kernel32.symbols.CloseHandle(_stopEvent);
  _reportStopped();
  process.exit(0);
}
