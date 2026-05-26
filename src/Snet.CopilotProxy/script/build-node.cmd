@echo off
setlocal enabledelayedexpansion

for /f "tokens=*" %%i in ('node --version') do set NODEVER=%%i
echo [INFO] Node !NODEVER! found
echo.

if not exist .dist mkdir .dist

echo [INFO] Copying source files...
xcopy /s /i /q /y src .dist\src >nul
copy /y package.json .dist\ >nul

echo [INFO] Installing production dependencies...
pushd .dist
call npm install --omit=dev --no-audit --no-fund --loglevel=error
popd

set NODEPATH=
for /f "tokens=*" %%i in ('where node 2^>nul') do (
    if "!NODEPATH!"=="" set NODEPATH=%%i
)
if exist "!NODEPATH!" (
    echo [INFO] Copying node ^(no extension^) ...
    copy /y "!NODEPATH!" .dist\node >nul
)

if exist .env if not exist .dist\.env (
    echo [INFO] Copying .env...
    copy /y .env .dist\ >nul
)
if exist .version copy /y .version .dist\ >nul

echo [INFO] Creating start.cmd...
(
echo @echo off
echo "%%~dp0service.exe"
) > .dist\start.cmd

echo.
echo [INFO] Compiling service.exe (C# wrapper)...

REM -- extract C# from this file + compile in-memory via PowerShell Add-Type
powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); try{Add-Type -TypeDefinition $cs -OutputAssembly '.dist\service.exe' -OutputType ConsoleApplication -ReferencedAssemblies 'System.Core.dll','System.ServiceProcess.dll' -ErrorAction Stop; Write-Host '[INFO] compiled (PowerShell Add-Type)'}catch{Write-Host $_.Exception.Message; exit 1}"
if !ERRORLEVEL! equ 0 goto :skip_startexe

REM -- fallback: extract C# to temp .cs, write .csproj, compile with dotnet publish
if not exist .buildtmp mkdir .buildtmp

powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); $csproj='<Project Sdk=''Microsoft.NET.Sdk''><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable><AssemblyName>service</AssemblyName></PropertyGroup></Project>'; [IO.File]::WriteAllText('.buildtmp\service.csproj',$csproj); [IO.File]::WriteAllText('.buildtmp\service.cs',$cs)"

dotnet --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    dotnet publish .buildtmp\service.csproj -c Release -r win-x64 --self-contained false -p:DebugType=none -o .dist
    if !ERRORLEVEL! equ 0 (
        del /q .dist\start.pdb 2>nul
    )
    for %%F in (".dist\service.exe") do if %%~zF gtr 102400 (
        echo [INFO]   ^> .dist\service.exe compiled successfully ^(dotnet publish^)
        goto :cleanup_startexe
    )
    echo [WARN]   ^> dotnet publish produced no valid exe, falling back...
    del /q .dist\service.exe 2>nul
)

REM -- last resort: .NET Framework csc.exe
for %%v in ("%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319" "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319") do (
    if exist "%%~v\csc.exe" (
        "%%~v\csc.exe" /nologo /target:exe /platform:x64 /out:.dist\service.exe .buildtmp\service.cs >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            echo [INFO]   ^> .dist\service.exe compiled successfully ^(csc.exe^)
        ) else (
            echo [WARN]   ^> csc.exe failed, service.exe not created
        )
        goto :cleanup_startexe
    )
)
echo [WARN]   ^> no C# compiler available, service.exe not created

:cleanup_startexe
rmdir /s /q .buildtmp 2>nul
:skip_startexe

echo.
echo ================================================
echo  Build successful
echo ================================================
echo.
echo   Output: .dist\  (portable folder)
echo   Type:   Node.js portable distribution
echo   OS:     Any Windows (Server 2016+)
echo   Run:    .dist\service.exe   OR   .dist\start.cmd
echo.
echo   Service: sc create snet binPath= "\"%%CD%%\.dist\service.exe\"" start= auto
echo            sc start snet
echo            Or rename service.exe and the service name auto-matches.
echo ================================================

REM -- Clean lock files
del /q package-lock.json 2>nul
if exist .dist\package-lock.json del /q .dist\package-lock.json 2>nul

endlocal
exit /b 0

REM ── Everything below is embedded C# source (not parsed by batch) ──

===CS_START===
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Threading;

class StartWrapper
{
    public static volatile bool stopping;
    static Process currentProc;
    static int serverPort;
    static string appId;

    static int Main(string[] args)
    {
        Environment.SetEnvironmentVariable("SNET_WRAPPED", "1");
        appId = GetAppId();

        if (!Environment.UserInteractive)
        {
            ServiceBase.Run(new Gc2ocService());
            return 0;
        }

        SafeSetTitle(appId);

        StopExistingService(appId);

        return RunServerLoop(interactive: true);
    }

    public static string GetAppId()
    {
        string name = Environment.GetEnvironmentVariable("SNET_SERVICE_NAME");
        if (!string.IsNullOrEmpty(name)) return name;
        try
        {
            return Path.GetFileNameWithoutExtension(
                Assembly.GetEntryAssembly().Location);
        }
        catch { return "snet"; }
    }

    static void StopExistingService(string svcName)
    {
        // 1. Try ServiceController with derived name + "snet" fallback
        string[] names = { svcName, "snet" };
        foreach (string name in names)
        {
            try
            {
                using (var sc = new ServiceController(name))
                {
                    if (sc.Status != ServiceControllerStatus.Running &&
                        sc.Status != ServiceControllerStatus.StartPending)
                        continue;

                    Log("[INFO] Stopping service '" + name + "'...");
                    sc.Stop();
                    sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                    Log("[INFO] Service stopped.");
                }
            }
            catch (InvalidOperationException) { }
            catch (Exception ex) { Log("[WARN] " + ex.Message); }
        }

        // 2. Kill any other process running this exe (service or orphan)
        try
        {
            var me = Process.GetCurrentProcess();
            string myName = me.ProcessName;
            foreach (var p in Process.GetProcessesByName(myName))
            {
                if (p.Id == me.Id) continue;
                try
                {
                    if (!p.HasExited)
                    {
                        Log("[INFO] Killing existing instance (pid " + p.Id + ")...");
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                }
                catch { }
            }
        }
        catch { }

        // 3. Kill anything on the port, retry until free
        try
        {
            string ps = Environment.GetEnvironmentVariable("SERVER_PORT") ?? "11434";
            int port;
            if (int.TryParse(ps, out port) && port > 0)
            {
                for (int i = 0; i < 4; i++)
                {
                    KillPortProcess(port);
                    Thread.Sleep(1000);
                }
            }
        }
        catch { }
    }

    public static int RunServerLoop(bool interactive)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        stopping = false;

        while (!stopping)
        {
            if (interactive) SafeClear();

            LoadEnv(baseDir);

            string portStr = Environment.GetEnvironmentVariable("SERVER_PORT") ?? "11434";
            if (!int.TryParse(portStr, out serverPort) || serverPort <= 0)
                serverPort = 11434;
            Environment.SetEnvironmentVariable("SERVER_PORT", serverPort.ToString());

            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("UV_THREADPOOL_SIZE")))
                Environment.SetEnvironmentVariable("UV_THREADPOOL_SIZE", "8");

            KillPortProcess(serverPort);

            int exitCode = TryLaunchServer(baseDir, interactive);

            if (stopping) break;

            if (exitCode == 43)
            {
                if (interactive) Log("[UPDATE] Running updater...");
                RunCmdScript("update.cmd", baseDir);
            }
            if (exitCode == 43 || exitCode == 42)
                continue;

            if (exitCode == 0 || exitCode == -1)
                return exitCode;

            return exitCode;
        }
        return 0;
    }

    static int TryLaunchServer(string baseDir, bool interactive)
    {
        string bunExe = FindExe("bun");
        if (bunExe != null)
        {
            if (interactive) Log("[INFO] Runtime: Bun");

            string nodeModules = Path.Combine(baseDir, "node_modules");
            if (!Directory.Exists(nodeModules))
            {
                if (interactive) Log("[INFO] Installing dependencies...");
                RunProcess(bunExe, "install", baseDir);
            }

            if (interactive) Log("");
            return RunProcessTracked(bunExe, "--smol run src/server.js", baseDir);
        }

        string nodeExe = FindExe("node");
        if (nodeExe == null)
        {
            string bundled = Path.Combine(baseDir, "node");
            if (File.Exists(bundled))
                nodeExe = bundled;
        }

        if (nodeExe != null)
        {
            if (interactive) Log("[INFO] Runtime: Node.js");

            string lockFile = Path.Combine(baseDir, "node_modules", ".package-lock.json");
            if (!File.Exists(lockFile))
            {
                if (interactive) Log("[INFO] Installing dependencies...");
                string npmExe = FindExe("npm");
                if (npmExe != null)
                    RunProcess(npmExe, "install hono undici --no-bin-links", baseDir);
            }

            if (interactive) Log("");
            return RunProcessTracked(nodeExe, "--expose-gc --max-old-space-size=4096 src/server.js", baseDir);
        }

        if (interactive)
        {
            LogErr("[ERROR] Neither Bun nor Node.js found in PATH.");
            LogErr("       Install Bun: https://bun.sh");
            LogErr("       Install Node: https://nodejs.org");
            Log("Press any key to exit...");
            try { Console.ReadKey(true); } catch { }
        }
        return -1;
    }

    static int RunProcessTracked(string exe, string args, string workDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            WorkingDirectory = workDir,
            UseShellExecute = false,
        };
        currentProc = Process.Start(psi);
        currentProc.WaitForExit();
        int code = currentProc.ExitCode;
        currentProc = null;
        return code;
    }

    public static void KillServerProcess()
    {
        try
        {
            if (currentProc != null && !currentProc.HasExited)
            {
                currentProc.Kill();
                currentProc.WaitForExit(5000);
            }
        }
        catch { }
    }

    static void SafeClear() { try { Console.Clear(); } catch { } }
    static void SafeSetTitle(string t) { try { Console.Title = t; } catch { } }
    static void Log(string msg) { try { Console.WriteLine(msg); } catch { } }
    static void LogErr(string msg) { try { Console.Error.WriteLine(msg); } catch { } }

    static int RunProcess(string exe, string args, string workDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            WorkingDirectory = workDir,
            UseShellExecute = false,
        };
        var proc = Process.Start(psi);
        proc.WaitForExit();
        return proc.ExitCode;
    }

    static void RunCmdScript(string script, string workDir)
    {
        RunProcess("cmd.exe", "/c \"\"" + script + "\"\"", workDir);
    }

    static void LoadEnv(string baseDir)
    {
        string envPath = Path.Combine(baseDir, ".env");
        if (!File.Exists(envPath)) return;
        foreach (string rawLine in File.ReadAllLines(envPath))
        {
            string line = rawLine.Trim();
            if (string.IsNullOrEmpty(line) || line.StartsWith("#"))
                continue;
            int eqIdx = line.IndexOf('=');
            if (eqIdx > 0)
            {
                string key = line.Substring(0, eqIdx).Trim();
                string value = line.Substring(eqIdx + 1).Trim();
                Environment.SetEnvironmentVariable(key, value);
            }
        }
    }

    static string FindExe(string name)
    {
        string pathExt = Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT";
        string[] paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
        string[] exts = pathExt.Split(';');

        foreach (string dir in paths)
        {
            string d = dir.Trim();
            if (string.IsNullOrEmpty(d)) continue;

            foreach (string ext in exts)
            {
                string e = ext.Trim();
                if (string.IsNullOrEmpty(e)) continue;

                string full = Path.Combine(d, name + e);
                if (File.Exists(full))
                    return full;
            }
        }
        return null;
    }

    static void KillPortProcess(int port)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c netstat -ano | findstr \":" + port + " \" | findstr \"LISTENING\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            var proc = Process.Start(psi);
            string output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();

            if (string.IsNullOrWhiteSpace(output))
                return;

            var seenPids = new HashSet<int>();
            foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 5)
                {
                    int pid;
                    if (int.TryParse(parts[parts.Length - 1], out pid) && pid > 0)
                    {
                        if (seenPids.Add(pid))
                        {
                            try
                            {
                                var killPsi = new ProcessStartInfo
                                {
                                    FileName = "taskkill.exe",
                                    Arguments = "/pid " + pid + " /f",
                                    UseShellExecute = false,
                                    RedirectStandardOutput = true,
                                    RedirectStandardError = true,
                                    CreateNoWindow = true,
                                };
                                var killProc = Process.Start(killPsi);
                                killProc.WaitForExit();
                            }
                            catch { }
                        }
                    }
                }
            }
        }
        catch { }
    }
}

class Gc2ocService : ServiceBase
{
    private Thread serverThread;

    public Gc2ocService()
    {
        ServiceName = StartWrapper.GetAppId();
        CanStop = true;
        CanPauseAndContinue = false;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        serverThread = new Thread(() => StartWrapper.RunServerLoop(interactive: false));
        serverThread.IsBackground = true;
        serverThread.Start();
    }

    protected override void OnStop()
    {
        StartWrapper.stopping = true;
        StartWrapper.KillServerProcess();
        if (serverThread != null && serverThread.IsAlive)
            serverThread.Join(15000);
    }
}
===CS_END===
