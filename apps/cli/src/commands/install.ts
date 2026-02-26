/**
 * install command — system daemon installer for the ch4p gateway.
 *
 * Installs the ch4p gateway as a persistent background service so it
 * automatically starts on login/boot and restarts on failure.
 *
 * Supported platforms:
 *   - macOS  → launchd user agent  (~/Library/LaunchAgents/)
 *   - Linux  → systemd user service (~/.config/systemd/user/)
 *
 * Usage:
 *   ch4p install             Install and start the gateway daemon
 *   ch4p install --uninstall Remove the daemon service
 *   ch4p install --status    Show current service status
 *   ch4p install --logs      Tail live service logs
 *
 * Zero external dependencies — uses only node:fs, node:os, node:child_process,
 * and node:path from the Node.js standard library.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TEAL, RESET, BOLD, DIM, GREEN, YELLOW, RED } from '../ui.js';
import { getCh4pDir, getConfigPath, getLogsDir } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAUNCHD_LABEL = 'com.ch4p.gateway';
const SYSTEMD_UNIT = 'ch4p-gateway';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a shell command, returning stdout on success or null on failure. */
function run(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/** Run a command and throw a user-friendly error if it fails. */
function runOrThrow(cmd: string, errMsg: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${errMsg}\n  ${DIM}${detail}${RESET}`);
  }
}

/** Resolve the absolute path to the ch4p binary. */
function findBinary(): string {
  // Try `which ch4p` first — covers globally installed npm package.
  const which = run('which ch4p');
  if (which && which.length > 0) return which;

  // Fallback: resolve relative to this file (dist/commands/install.js → …/bin/ch4p)
  // In a compiled dist tree: apps/cli/dist/commands/install.js → apps/cli/dist/index.js
  // When invoked via `node dist/index.js`, process.argv[1] is the script.
  const script = process.argv[1];
  if (script) {
    const dir = script.replace(/[/\\][^/\\]+$/, '');
    const candidate = join(dir, 'index.js');
    if (existsSync(candidate)) {
      // Use process.execPath (the actual Node.js binary) rather than the bare
      // string "node" so the service file works with nvm / asdf / non-PATH installs.
      return `${process.execPath} ${candidate}`;
    }
  }

  // Last resort — assume it's on PATH.
  return 'ch4p';
}

// ---------------------------------------------------------------------------
// macOS launchd
// ---------------------------------------------------------------------------

function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function buildLaunchdPlist(binaryPath: string, ch4pDir: string, logsDir: string): string {
  // launchd doesn't natively support EnvironmentFile loading. We emit a minimal
  // environment dictionary that sets CH4P_CONFIG_DIR so ch4p can find its home,
  // and rely on ~/.ch4p/.env being auto-loaded by the binary at startup.
  //
  // For API keys and secrets that live in ~/.ch4p/.env, the binary's built-in
  // loadEnvFile() handles them — no need to enumerate them here.
  // If binaryPath contains a space it's "interpreter /path/to/script" — split it.
  const spaceIdx = binaryPath.indexOf(' ');
  const programArgs = spaceIdx !== -1
    ? [binaryPath.slice(0, spaceIdx), binaryPath.slice(spaceIdx + 1), 'gateway']
    : [binaryPath, 'gateway'];

  const programArgsXml = programArgs
    .map((a) => `\t\t<string>${a}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>

\t<key>ProgramArguments</key>
\t<array>
${programArgsXml}
\t</array>

\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${homedir()}</string>
\t\t<key>PATH</key>
\t\t<string>${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
\t</dict>

\t<key>WorkingDirectory</key>
\t<string>${ch4pDir}</string>

\t<key>RunAtLoad</key>
\t<true/>

\t<key>KeepAlive</key>
\t<true/>

\t<key>ThrottleInterval</key>
\t<integer>5</integer>

\t<key>StandardOutPath</key>
\t<string>${logsDir}/gateway-stdout.log</string>

\t<key>StandardErrorPath</key>
\t<string>${logsDir}/gateway-stderr.log</string>
</dict>
</plist>
`;
}

function installLaunchd(binaryPath: string): void {
  const ch4pDir = getCh4pDir();
  const logsDir = getLogsDir();
  const plistPath = launchdPlistPath();
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');

  // Ensure directories exist.
  mkdirSync(plistDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  // Write the plist.
  const plist = buildLaunchdPlist(binaryPath, ch4pDir, logsDir);
  writeFileSync(plistPath, plist, { mode: 0o644 });

  console.log(`  ${GREEN}✓${RESET} Wrote ${plistPath}`);

  // Unload any existing instance first (ignore errors).
  run(`launchctl unload "${plistPath}" 2>/dev/null`);

  // Load and start.
  runOrThrow(
    `launchctl load -w "${plistPath}"`,
    'Failed to load plist with launchctl.',
  );

  console.log(`  ${GREEN}✓${RESET} Service loaded and started`);
  console.log(`\n  ${DIM}Check status:  ${TEAL}ch4p install --status${RESET}`);
  console.log(`  ${DIM}Tail logs:     ${TEAL}ch4p install --logs${RESET}`);
  console.log(`  ${DIM}Remove:        ${TEAL}ch4p install --uninstall${RESET}`);
}

function uninstallLaunchd(): void {
  const plistPath = launchdPlistPath();

  if (!existsSync(plistPath)) {
    console.log(`  ${YELLOW}⚠ No service file found at${RESET} ${plistPath}`);
    return;
  }

  run(`launchctl unload -w "${plistPath}" 2>/dev/null`);
  rmSync(plistPath);
  console.log(`  ${GREEN}✓${RESET} Removed ${plistPath}`);
  console.log(`  ${GREEN}✓${RESET} Service unloaded`);
}

function statusLaunchd(): void {
  const plistPath = launchdPlistPath();

  if (!existsSync(plistPath)) {
    console.log(`  ${RED}✗ Not installed${RESET} — run ${TEAL}ch4p install${RESET}`);
    return;
  }

  console.log(`  ${DIM}Plist:${RESET}  ${plistPath}`);

  const listOutput = run(`launchctl list | grep "${LAUNCHD_LABEL}"`);
  if (listOutput) {
    // Output: PID ExitCode Label
    const parts = listOutput.trim().split(/\s+/);
    const pid = parts[0];
    const exitCode = parts[1];
    if (pid && pid !== '-') {
      console.log(`  ${GREEN}● Running${RESET}  PID ${pid}`);
    } else {
      const exitMsg = exitCode && exitCode !== '0' ? ` (last exit: ${exitCode})` : '';
      console.log(`  ${YELLOW}○ Stopped${RESET}${exitMsg}`);
    }
  } else {
    console.log(`  ${YELLOW}○ Not loaded${RESET}`);
  }
}

function logsLaunchd(): void {
  const logsDir = getLogsDir();
  const outLog = join(logsDir, 'gateway-stdout.log');
  const errLog = join(logsDir, 'gateway-stderr.log');
  const jsonLog = join(logsDir, 'gateway.jsonl');

  // Prefer structured JSONL if it exists.
  if (existsSync(jsonLog)) {
    console.log(`  ${DIM}Tailing ${jsonLog} — Ctrl-C to stop${RESET}\n`);
    try {
      execSync(`tail -f "${jsonLog}"`, { stdio: 'inherit' });
    } catch {
      // User hit Ctrl-C — exit cleanly.
    }
    return;
  }

  if (existsSync(errLog) || existsSync(outLog)) {
    const target = existsSync(errLog) ? errLog : outLog;
    console.log(`  ${DIM}Tailing ${target} — Ctrl-C to stop${RESET}\n`);
    try {
      execSync(`tail -f "${target}"`, { stdio: 'inherit' });
    } catch {
      // User hit Ctrl-C.
    }
    return;
  }

  console.log(`  ${YELLOW}⚠ No log files found yet.${RESET}`);
  console.log(`  ${DIM}Logs appear after the first gateway run.${RESET}`);
  console.log(`  ${DIM}Expected: ${outLog}${RESET}`);
}

// ---------------------------------------------------------------------------
// Linux systemd (user scope — no sudo required)
// ---------------------------------------------------------------------------

function systemdUnitPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'systemd', 'user', `${SYSTEMD_UNIT}.service`);
}

function buildSystemdUnit(binaryPath: string, ch4pDir: string, logsDir: string): string {
  // For systemd user units, EnvironmentFile supports paths directly.
  const envFile = join(ch4pDir, '.env');
  const envFileLine = existsSync(envFile)
    ? `EnvironmentFile=-${envFile}\n`
    : '';

  // binaryPath is either a direct binary path or "interpreter /path/to/script".
  // In both cases the full path is already absolute (from `which` or process.execPath),
  // so ExecStart can reference it directly without /usr/bin/env lookup.
  const execStart = `ExecStart=${binaryPath} gateway`;

  return `[Unit]
Description=ch4p Gateway — Personal AI Assistant
Documentation=https://github.com/ch4p/ch4p
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${envFileLine}Environment=HOME=${homedir()}
WorkingDirectory=${ch4pDir}
${execStart}
Restart=on-failure
RestartSec=5
TimeoutStopSec=40
KillMode=mixed

# Logs are written to the systemd journal and optionally to ${logsDir}.
# View with: journalctl --user -u ${SYSTEMD_UNIT} -f

[Install]
WantedBy=default.target
`;
}

function installSystemd(binaryPath: string): void {
  const ch4pDir = getCh4pDir();
  const logsDir = getLogsDir();
  const unitPath = systemdUnitPath();
  const unitDir = unitPath.replace(/\/[^/]+$/, '');

  mkdirSync(unitDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const unit = buildSystemdUnit(binaryPath, ch4pDir, logsDir);
  writeFileSync(unitPath, unit, { mode: 0o644 });

  console.log(`  ${GREEN}✓${RESET} Wrote ${unitPath}`);

  runOrThrow('systemctl --user daemon-reload', 'systemctl daemon-reload failed.');
  runOrThrow(`systemctl --user enable ${SYSTEMD_UNIT}`, 'systemctl enable failed.');
  runOrThrow(`systemctl --user start ${SYSTEMD_UNIT}`, 'systemctl start failed.');

  console.log(`  ${GREEN}✓${RESET} Service enabled and started`);
  console.log(`\n  ${DIM}Check status:  ${TEAL}ch4p install --status${RESET}`);
  console.log(`  ${DIM}Tail logs:     ${TEAL}ch4p install --logs${RESET}`);
  console.log(`  ${DIM}Remove:        ${TEAL}ch4p install --uninstall${RESET}`);
}

function uninstallSystemd(): void {
  const unitPath = systemdUnitPath();

  if (!existsSync(unitPath)) {
    console.log(`  ${YELLOW}⚠ No unit file found at${RESET} ${unitPath}`);
    return;
  }

  run(`systemctl --user stop ${SYSTEMD_UNIT} 2>/dev/null`);
  run(`systemctl --user disable ${SYSTEMD_UNIT} 2>/dev/null`);
  rmSync(unitPath);
  run('systemctl --user daemon-reload 2>/dev/null');
  console.log(`  ${GREEN}✓${RESET} Removed ${unitPath}`);
  console.log(`  ${GREEN}✓${RESET} Service stopped and disabled`);
}

function statusSystemd(): void {
  const unitPath = systemdUnitPath();

  if (!existsSync(unitPath)) {
    console.log(`  ${RED}✗ Not installed${RESET} — run ${TEAL}ch4p install${RESET}`);
    return;
  }

  console.log(`  ${DIM}Unit:${RESET}   ${unitPath}`);

  const output = run(`systemctl --user status ${SYSTEMD_UNIT} --no-pager -l`);
  if (output) {
    // Print indented status lines.
    for (const line of output.split('\n').slice(0, 8)) {
      console.log(`  ${DIM}${line}${RESET}`);
    }
  } else {
    console.log(`  ${YELLOW}○ Status unavailable${RESET}`);
  }
}

function logsSystemd(): void {
  console.log(`  ${DIM}Tailing journal for ${SYSTEMD_UNIT} — Ctrl-C to stop${RESET}\n`);
  try {
    execSync(`journalctl --user -u ${SYSTEMD_UNIT} -f --no-pager`, { stdio: 'inherit' });
  } catch {
    // User hit Ctrl-C.
  }
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

type Action = 'install' | 'uninstall' | 'status' | 'logs';

function printHelp(): void {
  console.log(`
  ${TEAL}${BOLD}ch4p install${RESET} — gateway daemon installer

  ${BOLD}Usage${RESET}
    ${GREEN}ch4p install${RESET}              Install and start the gateway daemon
    ${GREEN}ch4p install --uninstall${RESET}  Remove the daemon service
    ${GREEN}ch4p install --status${RESET}     Show current service status
    ${GREEN}ch4p install --logs${RESET}       Tail live service logs

  ${BOLD}Platforms${RESET}
    macOS   launchd user agent    ~/Library/LaunchAgents/com.ch4p.gateway.plist
    Linux   systemd user service  ~/.config/systemd/user/ch4p-gateway.service

  ${BOLD}Notes${RESET}
    ${DIM}• No sudo required — services run as your user.${RESET}
    ${DIM}• API keys and channel tokens are loaded from ~/.ch4p/.env automatically.${RESET}
    ${DIM}• The service restarts automatically on crash (5-second delay).${RESET}
    ${DIM}• Run ${TEAL}ch4p onboard${DIM} first if you have not set up ch4p yet.${RESET}
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function install(args: string[]): Promise<void> {
  // Parse flags.
  let action: Action = 'install';

  for (const arg of args) {
    switch (arg) {
      case '--uninstall':
      case 'uninstall':
        action = 'uninstall';
        break;
      case '--status':
      case 'status':
        action = 'status';
        break;
      case '--logs':
      case 'logs':
        action = 'logs';
        break;
      case '--help':
      case '-h':
        printHelp();
        return;
    }
  }

  const platform = process.platform;

  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`\n  ${RED}✗ Unsupported platform:${RESET} ${platform}`);
    console.error(`  ${DIM}ch4p install supports macOS (launchd) and Linux (systemd).${RESET}`);
    console.error(`  ${DIM}On Windows, see the Docker deployment guide: ${TEAL}ch4p gateway${DIM}.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  // For install, validate prerequisites.
  if (action === 'install') {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
      console.error(`\n  ${RED}✗ No config found${RESET} at ${configPath}`);
      console.error(`  ${DIM}Run ${TEAL}ch4p onboard${DIM} first to set up ch4p.${RESET}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const banner = {
    install: 'Installing gateway daemon',
    uninstall: 'Removing gateway daemon',
    status: 'Gateway daemon status',
    logs: 'Gateway daemon logs',
  }[action];

  console.log(`\n  ${TEAL}${BOLD}${banner}${RESET}`);
  console.log(`  ${'─'.repeat(40)}\n`);

  if (platform === 'darwin') {
    if (action === 'install') {
      const bin = findBinary();
      console.log(`  ${DIM}Binary:${RESET}  ${bin}`);
      console.log(`  ${DIM}Service:${RESET} launchd → ~/Library/LaunchAgents/com.ch4p.gateway.plist\n`);
      installLaunchd(bin);
    } else if (action === 'uninstall') {
      uninstallLaunchd();
    } else if (action === 'status') {
      statusLaunchd();
    } else {
      logsLaunchd();
    }
  } else {
    // Linux / systemd
    if (action === 'install') {
      const bin = findBinary();
      console.log(`  ${DIM}Binary:${RESET}  ${bin}`);
      console.log(`  ${DIM}Service:${RESET} systemd --user → ~/.config/systemd/user/ch4p-gateway.service\n`);
      installSystemd(bin);
    } else if (action === 'uninstall') {
      uninstallSystemd();
    } else if (action === 'status') {
      statusSystemd();
    } else {
      logsSystemd();
    }
  }

  console.log('');
}
