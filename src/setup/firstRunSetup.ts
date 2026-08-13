import fs from 'fs';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { AuthService } from '../auth/AuthService.js';
import {
  isPlayerHistoryPathConfigured,
  normalizePlayerHistoryPath,
  writeConfigField,
  type RuntimeConfig,
} from '../config.js';

export interface FirstRunSetupResult {
  ok: boolean;
  playerHistoryPath?: string;
  eventRetentionDays?: number;
  port?: number;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function questionHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);

    if (!input.isTTY) {
      reject(new Error('Cannot read password: not a TTY'));
      return;
    }

    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';

    const cleanup = (): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };

    const submit = (): void => {
      cleanup();
      output.write('\n');
      resolve(value);
    };

    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      for (const ch of text) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          submit();
          return;
        }

        if (ch === '\u0003') {
          cleanup();
          output.write('\n');
          process.exit(130);
          return;
        }

        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }

        if (ch < ' ' || ch > '~') {
          continue;
        }

        value += ch;
        if (process.platform === 'win32') {
          output.write('\b*');
        } else {
          output.write('*');
        }
      }
    };

    input.on('data', onData);
  });
}

function printSetupBanner(): void {
  console.log('');
  console.log('==================================================');
  console.log('  Player History Server — First-time setup');
  console.log('==================================================');
  console.log('Configure this server and create your owner');
  console.log('account (used to sign in to the admin client).');
  console.log('');
}

async function promptPlayerHistoryPath(
  rl: readline.Interface,
  appRoot: string
): Promise<string> {
  console.log('Enter the full path to PlayerHistory on your DayZ server.');
  console.log('This is usually:  <DayZServer>\\profiles\\PlayerHistory');
  console.log('Example: D:\\DayZServer\\profiles\\PlayerHistory');
  console.log('');

  let resolved = '';
  while (!resolved) {
    const raw = (await rl.question('PlayerHistory path: ')).trim();
    if (!raw) {
      console.log('Path is required.');
      continue;
    }

    resolved = normalizePlayerHistoryPath(raw, appRoot);
    if (!resolved) {
      console.log('Path is required.');
      continue;
    }

    if (!fs.existsSync(resolved)) {
      console.log(`Note: folder does not exist yet (${resolved})`);
      console.log('It will be created when the PlayerHistory mod runs on your server.');
      const confirm = (await rl.question('Use this path anyway? [Y/n]: ')).trim().toLowerCase();
      if (confirm === 'n' || confirm === 'no') {
        resolved = '';
      }
    }
  }

  return resolved;
}

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_PORT = 3847;

async function promptPort(rl: readline.Interface, currentPort: number): Promise<number> {
  console.log('Which port should this Player History server listen on?');
  console.log('Use a different port for each DayZ server instance on the same machine.');
  console.log('');

  while (true) {
    const raw = (await rl.question(`HTTP port [${currentPort || DEFAULT_PORT}]: `)).trim();
    if (!raw) {
      return currentPort || DEFAULT_PORT;
    }

    const value = parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 1 || value > 65535 || !Number.isInteger(value)) {
      console.log('Enter a valid port number (1–65535).');
      continue;
    }

    return value;
  }
}

async function promptEventRetentionDays(rl: readline.Interface): Promise<number> {
  console.log('How many days of event history should be kept?');
  console.log('Events and daily log files older than this are deleted automatically.');
  console.log('Enter 0 to disable automatic purge.');
  console.log('');

  while (true) {
    const raw = (await rl.question(`Retention period in days [${DEFAULT_RETENTION_DAYS}]: `)).trim();
    if (!raw) {
      return DEFAULT_RETENTION_DAYS;
    }

    const value = parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      console.log('Enter a whole number of days (0 or greater).');
      continue;
    }

    return value;
  }
}

/**
 * First-start wizard: PlayerHistory path + retention + owner account.
 */
export async function runFirstRunSetup(
  authService: AuthService,
  config: Pick<RuntimeConfig, 'configPath' | 'projectRoot' | 'playerHistoryPath' | 'port'>
): Promise<FirstRunSetupResult> {
  const needsAccount = !authService.hasUsers();
  const needsPath = !isPlayerHistoryPathConfigured(config.playerHistoryPath);

  if (!needsAccount && !needsPath) {
    return { ok: true, playerHistoryPath: config.playerHistoryPath || undefined };
  }

  if (needsPath && !needsAccount) {
    console.error('');
    console.error('[PlayerHistory Server] playerHistoryPath is missing or invalid in config.json.');
    console.error('[PlayerHistory Server] Set "playerHistoryPath" to your DayZ profiles/PlayerHistory folder.');
    if (config.playerHistoryPath?.trim()) {
      console.error(`[PlayerHistory Server] Current value: ${config.playerHistoryPath}`);
    }
    console.error('');
    return { ok: false };
  }

  if (!isInteractiveTerminal()) {
    console.error('');
    console.error('[PlayerHistory Server] First run — complete setup in a console window,');
    console.error('[PlayerHistory Server] or set playerHistoryPath in config.json and POST /api/setup/owner.');
    console.error('');
    return { ok: false };
  }

  printSetupBanner();

  const rl = readline.createInterface({ input, output });
  let savedPath = config.playerHistoryPath;

  try {
    if (needsPath) {
      savedPath = await promptPlayerHistoryPath(rl, config.projectRoot);
      writeConfigField(config.configPath, 'playerHistoryPath', savedPath);
      console.log('');
      console.log(`Saved playerHistoryPath to config.json`);
      console.log('');
    }

    if (!needsAccount) {
      return { ok: true, playerHistoryPath: savedPath || undefined };
    }

    const retentionDays = await promptEventRetentionDays(rl);
    writeConfigField(config.configPath, 'eventRetentionDays', retentionDays);
    console.log('');
    console.log(
      retentionDays > 0
        ? `Saved event retention: ${retentionDays} days`
        : 'Saved event retention: disabled (no automatic purge)'
    );
    console.log('');

    const port = await promptPort(rl, config.port || DEFAULT_PORT);
    writeConfigField(config.configPath, 'port', port);
    writeConfigField(config.configPath, 'publicBaseUrl', `http://localhost:${port}`);
    console.log('');
    console.log(`Saved port: ${port}`);
    console.log('If clients connect remotely, edit publicBaseUrl in config.json (IP/domain + port).');
    console.log('');

    let username = '';
    while (!username.trim()) {
      username = (await rl.question('Username: ')).trim();
      if (!username) {
        console.log('Username is required.');
      }
    }

    let password = '';
    while (password.length < 8) {
      password = await questionHidden('Password (min 8 characters): ');
      if (password.length < 8) {
        console.log('Password must be at least 8 characters.');
      }
    }

    let confirm = '';
    while (confirm !== password) {
      confirm = await questionHidden('Confirm password: ');
      if (confirm !== password) {
        console.log('Passwords do not match. Try again.');
      }
    }

    const user = await authService.createOwner(username, password);
    console.log('');
    console.log(`Owner account "${user.username}" created successfully.`);
    console.log('==================================================');
    console.log('');
    return {
      ok: true,
      playerHistoryPath: savedPath || undefined,
      eventRetentionDays: retentionDays,
      port,
    };
  } catch (err) {
    console.error('');
    console.error('[PlayerHistory Server] Setup failed:', err instanceof Error ? err.message : err);
    console.error('');
    return { ok: false };
  } finally {
    rl.close();
  }
}
