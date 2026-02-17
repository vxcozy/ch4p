/**
 * MicCapture — system microphone capture via SoX `rec` command.
 *
 * Spawns `rec` as a child process and streams raw PCM audio (16-bit
 * signed LE, 16 kHz, mono) to an event emitter. Works on macOS and
 * Linux where SoX is installed.
 *
 * Zero npm dependencies — uses only `node:child_process`.
 *
 * Install SoX:
 *   macOS:  brew install sox
 *   Linux:  apt install sox  (or yum install sox)
 */

import { EventEmitter } from 'node:events';
import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MicCaptureConfig {
  /** Sample rate in Hz (default: 16000). */
  sampleRate?: number;
  /** Number of audio channels (default: 1 — mono). */
  channels?: number;
  /** Bit depth (default: 16). */
  bitDepth?: number;
  /** Device identifier override (default: system default mic). */
  device?: string;
}

export interface MicCaptureEvents {
  data: [Buffer];
  error: [Error];
  close: [];
}

// ---------------------------------------------------------------------------
// MicCapture
// ---------------------------------------------------------------------------

export class MicCapture extends EventEmitter<MicCaptureEvents> {
  private process: ChildProcess | null = null;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly bitDepth: number;
  private readonly device?: string;

  constructor(config: MicCaptureConfig = {}) {
    super();
    this.sampleRate = config.sampleRate ?? 16000;
    this.channels = config.channels ?? 1;
    this.bitDepth = config.bitDepth ?? 16;
    this.device = config.device;
  }

  /**
   * Check whether `rec` (SoX) is available on PATH.
   */
  static isAvailable(): boolean {
    try {
      const cmd = process.platform === 'win32' ? 'where rec' : 'which rec';
      execSync(cmd, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start capturing audio from the system microphone.
   *
   * Emits `data` events with raw PCM Int16LE buffers.
   * Call `stop()` to terminate the capture.
   *
   * @throws If `rec` is not available or the process fails to start.
   */
  start(): void {
    if (this.process) {
      throw new Error('MicCapture is already running. Call stop() first.');
    }

    if (!MicCapture.isAvailable()) {
      throw new Error(
        'SoX `rec` command not found on PATH. ' +
        'Install SoX: macOS `brew install sox`, Linux `apt install sox`.',
      );
    }

    // Build the `rec` command arguments.
    // Output format: raw signed-integer little-endian PCM to stdout.
    const args: string[] = [
      '-q',                            // Quiet — suppress progress output
      '-t', 'raw',                     // Output raw PCM
      '-b', String(this.bitDepth),     // Bit depth
      '-r', String(this.sampleRate),   // Sample rate
      '-c', String(this.channels),     // Channels
      '-e', 'signed-integer',          // Encoding
      '-L',                            // Little-endian byte order
      '-',                             // Output to stdout
    ];

    // Optional: specify input device.
    const env = { ...process.env };
    if (this.device) {
      env['AUDIODEV'] = this.device;
    }

    this.process = spawn('rec', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
      this.process = null;
    });

    this.process.on('close', () => {
      this.process = null;
      this.emit('close');
    });
  }

  /**
   * Stop the microphone capture.
   */
  stop(): void {
    if (!this.process) return;

    try {
      this.process.kill('SIGTERM');
    } catch {
      // Process may have already exited.
    }

    this.process = null;
  }

  /**
   * Whether the microphone is currently capturing.
   */
  get isRunning(): boolean {
    return this.process !== null;
  }
}
