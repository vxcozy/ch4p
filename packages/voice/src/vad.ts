/**
 * Voice Activity Detection (VAD) — energy-based speech detection.
 *
 * Processes raw PCM Int16 audio samples and emits events when speech
 * starts and ends. Uses a simple energy threshold approach:
 *
 *   1. Compute RMS energy of each audio chunk.
 *   2. If energy exceeds `energyThreshold`, mark as speech.
 *   3. After `silenceDurationMs` of sub-threshold energy, mark speech end.
 *   4. Ignore utterances shorter than `minSpeechDurationMs`.
 *
 * Zero external dependencies — operates on raw Buffer data.
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VADConfig {
  /** RMS energy threshold to detect speech (default: 500). */
  energyThreshold?: number;
  /** Duration of silence (ms) before ending speech (default: 800). */
  silenceDurationMs?: number;
  /** Minimum speech duration (ms) to emit (default: 300). */
  minSpeechDurationMs?: number;
  /** Sample rate in Hz (default: 16000). */
  sampleRate?: number;
}

export interface VADEvents {
  speech_start: [];
  speech_end: [{ audio: Buffer; durationMs: number }];
}

// ---------------------------------------------------------------------------
// VoiceActivityDetector
// ---------------------------------------------------------------------------

export class VoiceActivityDetector extends EventEmitter<VADEvents> {
  private readonly energyThreshold: number;
  private readonly silenceDurationMs: number;
  private readonly minSpeechDurationMs: number;
  private isSpeaking = false;
  private speechStartTime = 0;
  private lastSpeechTime = 0;
  private speechBuffers: Buffer[] = [];
  private silenceCheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VADConfig = {}) {
    super();
    this.energyThreshold = config.energyThreshold ?? 500;
    this.silenceDurationMs = config.silenceDurationMs ?? 800;
    this.minSpeechDurationMs = config.minSpeechDurationMs ?? 300;
  }

  /**
   * Process a chunk of raw PCM Int16LE audio samples.
   *
   * Call this repeatedly with audio data from the microphone.
   * The VAD will emit `speech_start` and `speech_end` events as appropriate.
   */
  processSamples(pcmBuffer: Buffer): void {
    const energy = this.computeRMS(pcmBuffer);
    const now = Date.now();

    if (energy >= this.energyThreshold) {
      // Speech detected.
      this.lastSpeechTime = now;

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTime = now;
        this.speechBuffers = [];
        this.emit('speech_start');
      }

      this.speechBuffers.push(Buffer.from(pcmBuffer));
      this.scheduleSilenceCheck();
    } else if (this.isSpeaking) {
      // Below threshold but still in speech — keep buffering for potential
      // silence gap within an utterance.
      this.speechBuffers.push(Buffer.from(pcmBuffer));
      this.scheduleSilenceCheck();
    }
  }

  /** Reset internal state. Call when stopping the listener. */
  reset(): void {
    this.isSpeaking = false;
    this.speechStartTime = 0;
    this.lastSpeechTime = 0;
    this.speechBuffers = [];
    if (this.silenceCheckTimer) {
      clearTimeout(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Compute root mean square energy of Int16LE PCM samples. */
  private computeRMS(buffer: Buffer): number {
    const samples = buffer.length / 2; // 16-bit = 2 bytes per sample
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
  }

  /** Schedule a check for sustained silence after speech. */
  private scheduleSilenceCheck(): void {
    if (this.silenceCheckTimer) {
      clearTimeout(this.silenceCheckTimer);
    }

    this.silenceCheckTimer = setTimeout(() => {
      this.silenceCheckTimer = null;

      if (!this.isSpeaking) return;

      const elapsed = Date.now() - this.lastSpeechTime;
      if (elapsed >= this.silenceDurationMs) {
        this.endSpeech();
      }
    }, this.silenceDurationMs + 50); // Small buffer to avoid race conditions
  }

  /** Finalize a speech segment. */
  private endSpeech(): void {
    if (!this.isSpeaking) return;

    const durationMs = Date.now() - this.speechStartTime;
    this.isSpeaking = false;

    if (durationMs < this.minSpeechDurationMs) {
      // Too short — probably noise, discard.
      this.speechBuffers = [];
      return;
    }

    const audio = Buffer.concat(this.speechBuffers);
    this.speechBuffers = [];
    this.emit('speech_end', { audio, durationMs });
  }
}
