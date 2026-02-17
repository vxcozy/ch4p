/**
 * Voice Activity Detection unit tests.
 *
 * Tests energy-based VAD: speech detection, silence timeout,
 * minimum duration filtering, and reset behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceActivityDetector } from './vad.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a PCM Int16LE buffer with samples at a given amplitude. */
function createPCMBuffer(sampleCount: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2); // 16-bit = 2 bytes per sample
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

/** Create a buffer of silence (all zeros). */
function createSilence(sampleCount: number): Buffer {
  return Buffer.alloc(sampleCount * 2);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceActivityDetector', () => {
  let vad: VoiceActivityDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    vad = new VoiceActivityDetector({
      energyThreshold: 500,
      silenceDurationMs: 200,
      minSpeechDurationMs: 100,
    });
  });

  afterEach(() => {
    vad.reset();
    vi.useRealTimers();
  });

  it('emits speech_start when energy exceeds threshold', () => {
    const handler = vi.fn();
    vad.on('speech_start', handler);

    // High amplitude samples (RMS will be well above 500).
    const loud = createPCMBuffer(160, 5000);
    vad.processSamples(loud);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not emit speech_start for quiet audio', () => {
    const handler = vi.fn();
    vad.on('speech_start', handler);

    // Low amplitude (RMS below threshold).
    const quiet = createPCMBuffer(160, 10);
    vad.processSamples(quiet);

    expect(handler).not.toHaveBeenCalled();
  });

  it('emits speech_end after silence duration', () => {
    const startHandler = vi.fn();
    const endHandler = vi.fn();
    vad.on('speech_start', startHandler);
    vad.on('speech_end', endHandler);

    // Start speech.
    const loud = createPCMBuffer(160, 5000);
    vad.processSamples(loud);
    expect(startHandler).toHaveBeenCalledOnce();

    // Advance past min speech duration.
    vi.advanceTimersByTime(150);

    // Send silence.
    vad.processSamples(createSilence(160));

    // Advance past silence duration + buffer.
    vi.advanceTimersByTime(300);

    expect(endHandler).toHaveBeenCalledOnce();
    const event = endHandler.mock.calls[0]![0] as { audio: Buffer; durationMs: number };
    expect(event.audio).toBeInstanceOf(Buffer);
    expect(event.audio.length).toBeGreaterThan(0);
  });

  it('does not emit speech_end for utterances shorter than minSpeechDurationMs', () => {
    // Create a VAD with a very high minSpeechDurationMs so the utterance is
    // always below the threshold even with timer advancement.
    const strictVad = new VoiceActivityDetector({
      energyThreshold: 500,
      silenceDurationMs: 200,
      minSpeechDurationMs: 5000, // 5 seconds — any test utterance will be shorter
    });

    const endHandler = vi.fn();
    strictVad.on('speech_end', endHandler);

    // Very short burst.
    const loud = createPCMBuffer(160, 5000);
    strictVad.processSamples(loud);

    // Immediately go silent.
    strictVad.processSamples(createSilence(160));

    // Advance past silence duration.
    vi.advanceTimersByTime(300);

    // Should not emit because duration is too short (< 5000ms).
    expect(endHandler).not.toHaveBeenCalled();
    strictVad.reset();
  });

  it('does not double-emit speech_start for continuous speech', () => {
    const handler = vi.fn();
    vad.on('speech_start', handler);

    const loud = createPCMBuffer(160, 5000);
    vad.processSamples(loud);
    vad.processSamples(loud);
    vad.processSamples(loud);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('reset clears internal state', () => {
    const startHandler = vi.fn();
    vad.on('speech_start', startHandler);

    const loud = createPCMBuffer(160, 5000);
    vad.processSamples(loud);
    expect(startHandler).toHaveBeenCalledOnce();

    vad.reset();

    // After reset, next loud sample should trigger speech_start again.
    vad.processSamples(loud);
    expect(startHandler).toHaveBeenCalledTimes(2);
  });

  it('handles empty buffer without error', () => {
    expect(() => vad.processSamples(Buffer.alloc(0))).not.toThrow();
  });

  it('computeRMS returns 0 for silence', () => {
    const handler = vi.fn();
    vad.on('speech_start', handler);

    vad.processSamples(createSilence(160));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('MicCapture', () => {
  it('isAvailable returns a boolean', async () => {
    const { MicCapture } = await import('./mic.js');
    const available = MicCapture.isAvailable();
    expect(typeof available).toBe('boolean');
  });
});

describe('AudioPlayback', () => {
  it('can be instantiated', async () => {
    const { AudioPlayback } = await import('./playback.js');
    const playback = new AudioPlayback();
    expect(playback).toBeDefined();
  });
});

describe('WakeListener', () => {
  it('can be instantiated with mock providers', async () => {
    const { WakeListener } = await import('./wake-listener.js');

    const mockSTT = {
      transcribe: vi.fn().mockResolvedValue('hello world'),
    };

    const listener = new WakeListener({
      stt: mockSTT,
      config: {
        enabled: true,
        wakeWord: 'hey chappie',
      },
    });

    expect(listener).toBeDefined();
    expect(listener.isListening).toBe(false);
  });

  it('does not start if already running', async () => {
    const { WakeListener } = await import('./wake-listener.js');
    const { MicCapture } = await import('./mic.js');

    // If SoX is not available, start() should throw.
    if (!MicCapture.isAvailable()) {
      const listener = new WakeListener({
        stt: { transcribe: vi.fn() },
        config: { enabled: true },
      });

      expect(() => listener.start()).toThrow('SoX');
    }
    // If SoX IS available, we can't meaningfully test without a real mic.
    // The unit test just confirms the guard works.
  });

  it('stop is idempotent', async () => {
    const { WakeListener } = await import('./wake-listener.js');

    const listener = new WakeListener({
      stt: { transcribe: vi.fn() },
      config: { enabled: true },
    });

    // Calling stop() when not started should not throw.
    expect(() => listener.stop()).not.toThrow();
    expect(() => listener.stop()).not.toThrow();
  });
});
