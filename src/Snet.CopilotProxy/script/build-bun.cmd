@echo off
setlocal enabledelayedexpansion

echo [INFO] Bun found, building standalone exe...
echo.

if not exist node_modules (
    echo [INFO] Installing dependencies...
    call bun install
    if !ERRORLEVEL! neq 0 (
        echo [ERROR] Failed to install dependencies
        endlocal
        exit /b 1
    )
)

if not exist .dist mkdir .dist

REM ── Step 1: Build Bun standalone, drop .exe extension ──
bun build --compile --target bun-windows-x64 src/server.js --outfile .dist\snet.exe
if !ERRORLEVEL! neq 0 (
    echo [WARN] Baseline target failed, retrying with modern...
    bun build --compile --target bun-windows-x64-modern src/server.js --outfile .dist\snet.exe
)

if not exist .dist\snet.exe (
    echo [ERROR] Bun build failed.
    endlocal
    exit /b 1
)

move /y .dist\snet.exe .dist\snet >nul

if exist .env if not exist .dist\.env copy /y .env .dist\ >nul
if exist .version copy /y .version .dist\ >nul

REM ── Step 2: Create start.cmd (simple one-shot launcher) ──
echo [INFO] Creating start.cmd...
(
echo @echo off
echo "%%~dp0service.exe"
) > .dist\start.cmd

REM ── Step 3: Compile C# service launcher (service.exe) ──
echo.
echo [INFO] Compiling service.exe (C# launcher)...

powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); try{Add-Type -TypeDefinition $cs -OutputAssembly '.dist\service.exe' -OutputType ConsoleApplication -ReferencedAssemblies 'System.Core.dll','System.ServiceProcess.dll' -ErrorAction Stop; Write-Host '[INFO] compiled (PowerShell Add-Type)'}catch{Write-Host $_.Exception.Message; exit 1}"
if !ERRORLEVEL! equ 0 goto :skip_compile

REM -- fallback: dotnet publish
if not exist .buildtmp mkdir .buildtmp

powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); $csproj='<Project Sdk=''Microsoft.NET.Sdk''><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable><AssemblyName>service</AssemblyName></PropertyGroup><ItemGroup><PackageReference Include=''System.ServiceProcess.ServiceController'' Version=''9.0.0'' /></ItemGroup></Project>'; [IO.File]::WriteAllText('.buildtmp\service.csproj',$csproj); [IO.File]::WriteAllText('.buildtmp\service.cs',$cs)"

dotnet --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    dotnet publish .buildtmp\service.csproj -c Release -r win-x64 --self-contained false -p:DebugType=none -o .dist
    if !ERRORLEVEL! equ 0 (
        del /q .dist\service.pdb 2>nul
    )
    for %%F in (".dist\service.exe") do if %%~zF gtr 102400 (
        echo [INFO]   ^> service.exe compiled successfully ^(dotnet publish^)
        goto :cleanup_compile
    )
    echo [WARN]   ^> dotnet publish produced no valid exe, falling back...
    del /q .dist\service.exe 2>nul
)

REM -- last resort: .NET Framework csc.exe
for %%v in ("%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319" "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319") do (
    if exist "%%~v\csc.exe" (
        "%%~v\csc.exe" /nologo /target:exe /platform:x64 /out:.dist\service.exe .buildtmp\service.cs >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            echo [INFO]   ^> service.exe compiled successfully ^(csc.exe^)
        ) else (
            echo [WARN]   ^> csc.exe failed, service.exe not created
        )
        goto :cleanup_compile
    )
)
echo [WARN]   ^> no C# compiler available, service.exe not created

:cleanup_compile
rmdir /s /q .buildtmp 2>nul
:skip_compile

echo.
echo ================================================
echo  Build successful
echo ================================================
echo.
echo   Output: .dist\
echo     service.exe            C# service/console launcher (~100 KB)
echo     snet                  Bun standalone server (~112 MB)
echo     start.cmd              One-shot launcher
echo.
echo   Run: .dist\start.cmd   OR   .dist\service.exe
echo.
echo   ^>^>^> Windows Service ^<^<^<
echo.
echo   Install:  sc create snet binPath= "\"%%CD%%\.dist\service.exe\"" start= auto
echo   Start:    sc start snet
echo   Stop:     sc stop snet
echo   Uninstall:sc delete snet
echo.
echo   Or rename service.exe and the service name auto-matches.
echo ================================================

REM -- Clean lock files
del /q bun.lock 2>nul
del /q bun.lockb 2>nul

endlocal
exit /b 0

REM -- Everything below is embedded C# source (not parsed by batch) --

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
            int serverPort;
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
        string snetPath = Path.Combine(baseDir, "snet");
        if (File.Exists(snetPath))
        {
            if (interactive) Log("[INFO] Runtime: Bun (standalone)");
            if (interactive) Log("");
            return RunProcessTracked(snetPath, "", baseDir);
        }

        if (interactive)
        {
            LogErr("[ERROR] snet not found in " + baseDir);
            LogErr("       Expected: snet next to service.exe");
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
