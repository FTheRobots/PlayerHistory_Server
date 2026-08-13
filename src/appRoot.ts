import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const WIN32_SKIP_EXE = new Set([
  'node.exe',
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'conhost.exe',
  'windowsterminal.exe',
  'openconsole.exe',
  'wt.exe',
  'explorer.exe',
]);

function normalizeWinPath(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

function isCaxaPath(value: string): boolean {
  const lower = normalizeWinPath(value);
  return lower.includes('\\temp\\caxa\\') || lower.includes('\\tmp\\caxa\\');
}

function isCaxaExtractedRuntime(): boolean {
  return isCaxaPath(path.resolve(__dirname));
}

function isSuspiciousWindowsCwd(cwd: string): boolean {
  const lower = normalizeWinPath(cwd);
  return lower.includes('\\windows\\') || lower.endsWith('\\system32') || isCaxaPath(cwd);
}

function isHostPortableExe(exePath: string): boolean {
  const name = path.basename(exePath).toLowerCase();
  const exeLower = normalizeWinPath(exePath);

  if (WIN32_SKIP_EXE.has(name)) return false;
  if (exeLower.includes('\\windows\\')) return false;
  if (isCaxaPath(exeLower)) return false;

  return name.endsWith('.exe');
}

function queryProcessWin32PowerShell(pid: number): { exe: string; ppid: number } | null {
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){Write-Output $p.ExecutablePath; Write-Output $p.ParentProcessId}"`,
      {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const lines = out
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines[0]) return null;

    const ppid = lines[1] ? Number.parseInt(lines[1], 10) : 0;
    return {
      exe: lines[0],
      ppid: Number.isFinite(ppid) ? ppid : 0,
    };
  } catch {
    return null;
  }
}

function queryProcessWin32Wmic(pid: number): { exe: string; ppid: number } | null {
  try {
    const out = execSync(
      `wmic process where "ProcessId=${pid}" get ExecutablePath,ParentProcessId /format:list`,
      {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const exeMatch = out.match(/ExecutablePath=(.+)/i);
    const ppidMatch = out.match(/ParentProcessId=(\d+)/i);
    const exe = exeMatch?.[1]?.trim();
    if (!exe) return null;

    return {
      exe,
      ppid: ppidMatch ? Number.parseInt(ppidMatch[1], 10) : 0,
    };
  } catch {
    return null;
  }
}

function queryProcessWin32(pid: number): { exe: string; ppid: number } | null {
  return queryProcessWin32PowerShell(pid) ?? queryProcessWin32Wmic(pid);
}

/** Walk the process tree to find the folder containing the portable .exe (not caxa's temp extract). */
function getPortableHostExeDirFromProcessTree(): string | null {
  let pid = process.pid;

  for (let depth = 0; depth < 25; depth++) {
    const info = queryProcessWin32(pid);
    if (!info) break;

    if (isHostPortableExe(info.exe)) {
      return path.dirname(info.exe);
    }

    if (!info.ppid || info.ppid === pid) break;
    pid = info.ppid;
  }

  return null;
}

function getPortableHostExeDirUnix(): string | null {
  try {
    const script = [
      'p=$PPID',
      'while [ -n "$p" ] && [ "$p" -gt 1 ]; do',
      '  path=$(readlink -f "/proc/$p/exe" 2>/dev/null || true)',
      '  if [ -n "$path" ] && ! echo "$path" | grep -q "/tmp/caxa/"; then',
      '    case "$path" in *node) ;; *) dirname "$path"; exit 0 ;; esac',
      '  fi',
      '  p=$(ps -p "$p" -o ppid= 2>/dev/null | tr -d " ")',
      'done',
    ].join(' ');

    const dir = execSync(`sh -c '${script}'`, {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return dir || null;
  } catch {
    return null;
  }
}

function getPortableHostExeDir(): string | null {
  if (process.env.PH_APP_ROOT?.trim()) {
    return path.resolve(process.env.PH_APP_ROOT.trim());
  }

  if (process.platform === 'win32') {
    if (isCaxaExtractedRuntime()) {
      return getPortableHostExeDirFromProcessTree();
    }

    const cwd = process.cwd();
    if (!isSuspiciousWindowsCwd(cwd)) {
      return cwd;
    }

    return getPortableHostExeDirFromProcessTree();
  }

  return getPortableHostExeDirUnix();
}

export function isPackaged(): boolean {
  if ('pkg' in process) return true;
  return isCaxaExtractedRuntime();
}

/** Directory for config.json, data/, and portable deployment files. */
export function getAppRoot(): string {
  if (process.env.PH_APP_ROOT?.trim()) {
    return path.resolve(process.env.PH_APP_ROOT.trim());
  }

  if ('pkg' in process) {
    return path.dirname(process.execPath);
  }

  if (isCaxaExtractedRuntime()) {
    const hostDir = getPortableHostExeDirFromProcessTree();
    if (hostDir) return hostDir;

    console.error('');
    console.error('[PlayerHistory Server] Could not find the folder containing the server .exe.');
    console.error('[PlayerHistory Server] config.json and data/ must live beside the .exe, not in Temp.');
    console.error('[PlayerHistory Server] Fix: launch via Start-Server.bat, or set PH_APP_ROOT to the exe folder.');
    console.error('');
  } else {
    const portableDir = getPortableHostExeDir();
    if (portableDir) return portableDir;
  }

  const argv0 = process.argv[0] ? path.resolve(process.argv[0]) : '';
  const argvBase = path.basename(argv0).toLowerCase();
  if (argv0 && argvBase.endsWith('.exe') && argvBase !== 'node.exe' && !isCaxaPath(argv0)) {
    return path.dirname(argv0);
  }

  return path.resolve(__dirname, '..');
}

export function resolveAppPath(value: string, appRoot: string): string {
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(appRoot, value);
}

export function ensureConfigFromExample(appRoot: string, configPath: string): void {
  if (fs.existsSync(configPath)) return;

  const examplePath = path.join(appRoot, 'config.example.json');
  if (!fs.existsSync(examplePath)) return;

  fs.copyFileSync(examplePath, configPath);
  console.log(`[PlayerHistory Server] Created ${configPath} from config.example.json — edit playerHistoryPath before use.`);
}
