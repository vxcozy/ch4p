/**
 * AudioPlayback — play audio buffers through system speakers.
 *
 * Uses platform-native playback commands:
 *   - macOS: `afplay` (built-in)
 *   - Linux: `play` (SoX) or `aplay` (ALSA)
 *
 * Zero npm dependencies — uses `node:child_process` and `node:fs`.
 */

import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// MIME → file extension map
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'audio/webm': '.webm',
};

// ---------------------------------------------------------------------------
// AudioPlayback
// ---------------------------------------------------------------------------

export class AudioPlayback {
  private tempDir: string | null = null;

  /**
   * Play an audio buffer through the system speakers.
   *
   * Writes the buffer to a temp file, invokes the platform player,
   * and cleans up after playback completes.
   *
   * @param audio - Raw audio data.
   * @param mimeType - MIME type of the audio (e.g. 'audio/mpeg').
   * @throws If no suitable playback command is available.
   */
  async play(audio: Buffer, mimeType: string): Promise<void> {
    if (!this.tempDir) {
      this.tempDir = mkdtempSync(join(tmpdir(), 'ch4p-audio-'));
    }

    const ext = EXTENSION_MAP[mimeType] ?? '.mp3';
    const tempFile = join(this.tempDir, `playback-${Date.now()}${ext}`);

    try {
      writeFileSync(tempFile, audio);

      if (process.platform === 'darwin') {
        // macOS: afplay is always available.
        await execFile('afplay', [tempFile]);
      } else {
        // Linux: try `play` (SoX) first, fall back to `aplay` for wav.
        try {
          await execFile('play', ['-q', tempFile]);
        } catch {
          if (ext === '.wav') {
            await execFile('aplay', ['-q', tempFile]);
          } else {
            throw new Error(
              'No audio playback command found. Install SoX (`apt install sox`) ' +
              'or use WAV format with ALSA (`aplay`).',
            );
          }
        }
      }
    } finally {
      // Clean up temp file.
      try {
        unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}
