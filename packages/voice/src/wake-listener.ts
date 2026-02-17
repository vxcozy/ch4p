/**
 * WakeListener — always-on voice wake orchestrator.
 *
 * Integrates microphone capture, voice activity detection, and speech-to-text
 * into a continuous listening pipeline. When speech is detected and transcribed,
 * emits a `wake` event with the transcribed text.
 *
 * Optional wake word filtering: if configured, only passes through utterances
 * that start with the specified wake word (e.g. "hey chappie").
 *
 * Architecture:
 *   MicCapture → VoiceActivityDetector → STT → wake event
 *
 * Zero npm dependencies.
 */

import { EventEmitter } from 'node:events';
import { MicCapture } from './mic.js';
import { VoiceActivityDetector } from './vad.js';
import { AudioPlayback } from './playback.js';
import type { STTProvider, TTSProvider } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WakeListenerConfig {
  /** Whether wake listening is active. */
  enabled: boolean;
  /** Optional wake word (e.g. "hey chappie"). Omit for push-to-talk style. */
  wakeWord?: string;
  /** VAD energy threshold (default: 500). */
  energyThreshold?: number;
  /** Duration of silence before ending speech (ms, default: 800). */
  silenceDurationMs?: number;
  /** Minimum speech duration to process (ms, default: 300). */
  minSpeechDurationMs?: number;
  /** Microphone device identifier (optional). */
  device?: string;
}

export interface WakeEvent {
  /** Transcribed text from the utterance. */
  text: string;
  /** Duration of the speech segment in ms. */
  durationMs: number;
  /** Whether the wake word was stripped from the text. */
  wakeWordStripped: boolean;
}

export interface WakeListenerEvents {
  wake: [WakeEvent];
  listening: [];
  error: [Error];
  stopped: [];
}

// ---------------------------------------------------------------------------
// WakeListener
// ---------------------------------------------------------------------------

export class WakeListener extends EventEmitter<WakeListenerEvents> {
  private readonly stt: STTProvider;
  private readonly tts?: TTSProvider;
  private readonly playback: AudioPlayback;
  private readonly config: WakeListenerConfig;

  private mic: MicCapture | null = null;
  private vad: VoiceActivityDetector | null = null;
  private running = false;
  private processing = false;

  constructor(opts: {
    stt: STTProvider;
    tts?: TTSProvider;
    config: WakeListenerConfig;
  }) {
    super();
    this.stt = opts.stt;
    this.tts = opts.tts;
    this.config = opts.config;
    this.playback = new AudioPlayback();
  }

  /**
   * Start listening for voice input.
   *
   * Opens the system microphone, runs VAD, and transcribes detected speech.
   * Emits `wake` events when speech is successfully transcribed.
   *
   * @throws If microphone capture is not available (SoX not installed).
   */
  start(): void {
    if (this.running) return;

    if (!MicCapture.isAvailable()) {
      throw new Error(
        'Voice wake requires SoX for microphone capture. ' +
        'Install: macOS `brew install sox`, Linux `apt install sox`.',
      );
    }

    this.running = true;

    // Initialize VAD.
    this.vad = new VoiceActivityDetector({
      energyThreshold: this.config.energyThreshold,
      silenceDurationMs: this.config.silenceDurationMs,
      minSpeechDurationMs: this.config.minSpeechDurationMs,
    });

    // Initialize microphone.
    this.mic = new MicCapture({
      device: this.config.device,
    });

    // Wire up: mic → VAD.
    this.mic.on('data', (chunk) => {
      if (this.vad && !this.processing) {
        this.vad.processSamples(chunk);
      }
    });

    this.mic.on('error', (err) => {
      this.emit('error', err);
    });

    // Wire up: VAD → STT.
    this.vad.on('speech_end', (segment) => {
      void this.handleSpeechSegment(segment.audio, segment.durationMs);
    });

    // Start capturing.
    this.mic.start();
    this.emit('listening');
  }

  /**
   * Stop listening.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.mic) {
      this.mic.stop();
      this.mic.removeAllListeners();
      this.mic = null;
    }

    if (this.vad) {
      this.vad.reset();
      this.vad.removeAllListeners();
      this.vad = null;
    }

    this.emit('stopped');
  }

  /**
   * Speak a text response through the system speakers.
   *
   * Uses the configured TTS provider to synthesize audio, then plays it
   * via the platform-native playback command. If no TTS is configured,
   * this is a no-op.
   */
  async speak(text: string): Promise<void> {
    if (!this.tts || !text) return;

    try {
      const { audio, mimeType } = await this.tts.synthesize(text);
      await this.playback.play(audio, mimeType);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Whether the listener is currently active. */
  get isListening(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Process a completed speech segment: transcribe and optionally filter by
   * wake word.
   */
  private async handleSpeechSegment(audio: Buffer, durationMs: number): Promise<void> {
    if (!this.running) return;

    this.processing = true;

    try {
      // Transcribe via the configured STT provider.
      // The audio is raw PCM Int16LE 16kHz mono — wrap as WAV for providers
      // that need a proper audio container.
      const wavBuffer = this.wrapPCMAsWAV(audio);
      const transcript = await this.stt.transcribe(wavBuffer, 'audio/wav');

      if (!transcript || transcript.trim().length === 0) {
        return;
      }

      const text = transcript.trim();

      // Wake word filtering.
      if (this.config.wakeWord) {
        const wakeWord = this.config.wakeWord.toLowerCase();
        const lowerText = text.toLowerCase();

        if (!lowerText.startsWith(wakeWord)) {
          // Utterance doesn't match wake word — ignore.
          return;
        }

        // Strip the wake word from the text.
        const strippedText = text.slice(wakeWord.length).trim();
        if (strippedText.length === 0) {
          // Just the wake word with no command — ignore.
          return;
        }

        this.emit('wake', {
          text: strippedText,
          durationMs,
          wakeWordStripped: true,
        });
      } else {
        // No wake word filter — pass everything through.
        this.emit('wake', {
          text,
          durationMs,
          wakeWordStripped: false,
        });
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.processing = false;
    }
  }

  /**
   * Wrap raw PCM Int16LE data in a WAV container.
   *
   * STT providers (Whisper, Deepgram) expect audio in a recognized format.
   * This creates a minimal WAV header for the raw PCM data.
   */
  private wrapPCMAsWAV(pcm: Buffer): Buffer {
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcm.length;

    const header = Buffer.alloc(44);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt subchunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);           // Subchunk1Size (PCM = 16)
    header.writeUInt16LE(1, 20);            // AudioFormat (PCM = 1)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data subchunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }
}
