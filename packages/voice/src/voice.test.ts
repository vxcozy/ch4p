/**
 * Voice package tests.
 *
 * Tests for WhisperSTT, DeepgramSTT, ElevenLabsTTS, and VoiceProcessor.
 * Network-dependent providers are tested via mock fetch() to avoid
 * requiring real API tokens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhisperSTT } from './stt-whisper.js';
import { DeepgramSTT } from './stt-deepgram.js';
import { ElevenLabsTTS } from './tts-elevenlabs.js';
import { VoiceProcessor } from './processor.js';
import type { STTProvider, TTSProvider, VoiceConfig } from './types.js';
import type { InboundMessage, OutboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch that returns configurable responses. */
function createMockFetch(responses: Array<{ ok: boolean; data: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex % responses.length]!;
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.ok ? 200 : 400,
      json: async () => resp.data,
      text: async () => JSON.stringify(resp.data),
      arrayBuffer: async () => {
        // For TTS responses that return binary audio data
        const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
        return bytes.buffer;
      },
    };
  });
}

/** Build a minimal InboundMessage for testing. */
function makeInbound(
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    id: 'msg-1',
    channelId: 'test',
    from: { channelId: 'test', userId: 'user-1' },
    text: '',
    timestamp: new Date(),
    ...overrides,
  };
}

/** Build a minimal OutboundMessage for testing. */
function makeOutbound(
  overrides: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    text: '',
    ...overrides,
  };
}

/** Default enabled VoiceConfig. */
function makeConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    stt: { provider: 'whisper' },
    tts: { provider: 'elevenlabs' },
    ...overrides,
  };
}

// ===========================================================================
// WhisperSTT
// ===========================================================================

describe('WhisperSTT', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('transcribes audio via OpenAI API', async () => {
    const mockFetch = createMockFetch([
      { ok: true, data: { text: 'Hello, world!' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const stt = new WhisperSTT({ apiKey: 'test-key' });
    const result = await stt.transcribe(Buffer.from('fake-audio'), 'audio/webm');

    expect(result).toBe('Hello, world!');
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-key');
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('handles API errors gracefully', async () => {
    const mockFetch = createMockFetch([
      { ok: false, data: { error: 'Unauthorized' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const stt = new WhisperSTT({ apiKey: 'bad-key' });
    await expect(
      stt.transcribe(Buffer.from('fake-audio'), 'audio/webm'),
    ).rejects.toThrow('Whisper STT failed (400)');
  });

  it('uses correct file extension based on MIME type', async () => {
    const calls: FormData[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, opts: { body: FormData }) => {
      calls.push(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'ok' }),
        text: async () => '{"text":"ok"}',
      };
    }) as unknown as typeof fetch;

    const stt = new WhisperSTT({ apiKey: 'test-key' });

    // Test mp3 MIME type
    await stt.transcribe(Buffer.from('data'), 'audio/mp3');
    const fileField = calls[0]!.get('file') as File;
    expect(fileField.name).toBe('audio.mp3');

    // Test wav MIME type
    await stt.transcribe(Buffer.from('data'), 'audio/wav');
    const wavField = calls[1]!.get('file') as File;
    expect(wavField.name).toBe('audio.wav');

    // Test ogg MIME type
    await stt.transcribe(Buffer.from('data'), 'audio/ogg');
    const oggField = calls[2]!.get('file') as File;
    expect(oggField.name).toBe('audio.ogg');

    // Test unknown MIME type falls back to webm
    await stt.transcribe(Buffer.from('data'), 'audio/unknown');
    const fallbackField = calls[3]!.get('file') as File;
    expect(fallbackField.name).toBe('audio.webm');
  });
});

// ===========================================================================
// DeepgramSTT
// ===========================================================================

describe('DeepgramSTT', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('transcribes audio via Deepgram API', async () => {
    const deepgramResponse = {
      results: {
        channels: [
          { alternatives: [{ transcript: 'Transcribed text here' }] },
        ],
      },
    };
    const mockFetch = createMockFetch([
      { ok: true, data: deepgramResponse },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const stt = new DeepgramSTT({ apiKey: 'dg-test-key' });
    const result = await stt.transcribe(
      Buffer.from('fake-audio'),
      'audio/webm',
    );

    expect(result).toBe('Transcribed text here');
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.deepgram.com/v1/listen?model=nova-3');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Token dg-test-key');
    expect(opts.headers['Content-Type']).toBe('audio/webm');
  });

  it('handles API errors', async () => {
    const mockFetch = createMockFetch([
      { ok: false, data: { error: 'Bad request' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const stt = new DeepgramSTT({ apiKey: 'bad-key' });
    await expect(
      stt.transcribe(Buffer.from('fake-audio'), 'audio/webm'),
    ).rejects.toThrow('Deepgram STT failed (400)');
  });
});

// ===========================================================================
// ElevenLabsTTS
// ===========================================================================

describe('ElevenLabsTTS', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('synthesizes text to audio', async () => {
    const mockFetch = createMockFetch([{ ok: true, data: {} }]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tts = new ElevenLabsTTS({
      apiKey: 'el-test-key',
      voiceId: 'custom-voice',
    });
    const result = await tts.synthesize('Hello there');

    expect(result.mimeType).toBe('audio/mpeg');
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect(result.audio.length).toBeGreaterThan(0);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/custom-voice',
    );
    expect(opts.method).toBe('POST');
    expect(opts.headers['xi-api-key']).toBe('el-test-key');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers.Accept).toBe('audio/mpeg');

    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe('Hello there');
    expect(body.model_id).toBe('eleven_flash_v2_5');
  });

  it('uses default voice ID when none provided', async () => {
    const mockFetch = createMockFetch([{ ok: true, data: {} }]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tts = new ElevenLabsTTS({ apiKey: 'el-test-key' });
    await tts.synthesize('Test');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM',
    );
  });

  it('handles API errors', async () => {
    const mockFetch = createMockFetch([
      { ok: false, data: { detail: 'Invalid API key' } },
    ]);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const tts = new ElevenLabsTTS({ apiKey: 'bad-key' });
    await expect(tts.synthesize('Hello')).rejects.toThrow(
      'ElevenLabs TTS failed (400)',
    );
  });
});

// ===========================================================================
// VoiceProcessor
// ===========================================================================

describe('VoiceProcessor', () => {
  let mockSTT: STTProvider;
  let mockTTS: TTSProvider;

  beforeEach(() => {
    mockSTT = {
      transcribe: vi.fn(async () => 'Transcribed speech'),
    };
    mockTTS = {
      synthesize: vi.fn(async () => ({
        audio: Buffer.from('synth-audio'),
        mimeType: 'audio/mpeg',
      })),
    };
  });

  // -------------------------------------------------------------------------
  // processInbound
  // -------------------------------------------------------------------------

  describe('processInbound', () => {
    it('transcribes audio attachments and prepends "[Voice message]" to text', async () => {
      const processor = new VoiceProcessor({
        stt: mockSTT,
        config: makeConfig(),
      });

      const msg = makeInbound({
        text: 'existing text',
        attachments: [
          {
            type: 'audio',
            data: Buffer.from('audio-data'),
            mimeType: 'audio/webm',
          },
        ],
      });

      const result = await processor.processInbound(msg);

      expect(result.text).toBe('[Voice message]: Transcribed speech\nexisting text');
      expect(mockSTT.transcribe).toHaveBeenCalledWith(
        Buffer.from('audio-data'),
        'audio/webm',
      );
    });

    it('returns message unchanged when no audio attachments', async () => {
      const processor = new VoiceProcessor({
        stt: mockSTT,
        config: makeConfig(),
      });

      const msg = makeInbound({
        text: 'just text',
        attachments: [
          { type: 'image', url: 'https://example.com/photo.jpg' },
        ],
      });

      const result = await processor.processInbound(msg);

      expect(result).toEqual(msg);
      expect(mockSTT.transcribe).not.toHaveBeenCalled();
    });

    it('returns message unchanged when voice disabled', async () => {
      const processor = new VoiceProcessor({
        stt: mockSTT,
        config: makeConfig({ enabled: false }),
      });

      const msg = makeInbound({
        attachments: [
          {
            type: 'audio',
            data: Buffer.from('audio-data'),
            mimeType: 'audio/webm',
          },
        ],
      });

      const result = await processor.processInbound(msg);

      expect(result).toEqual(msg);
      expect(mockSTT.transcribe).not.toHaveBeenCalled();
    });

    it('skips attachments without data buffer (only url)', async () => {
      const processor = new VoiceProcessor({
        stt: mockSTT,
        config: makeConfig(),
      });

      const msg = makeInbound({
        text: '',
        attachments: [
          {
            type: 'audio',
            url: 'https://example.com/voice.ogg',
            mimeType: 'audio/ogg',
          },
        ],
      });

      const result = await processor.processInbound(msg);

      // No data buffer, so transcribe should not be called, message unchanged
      expect(result).toEqual(msg);
      expect(mockSTT.transcribe).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // processOutbound
  // -------------------------------------------------------------------------

  describe('processOutbound', () => {
    it('synthesizes text to audio attachment', async () => {
      const processor = new VoiceProcessor({
        tts: mockTTS,
        config: makeConfig(),
      });

      const msg = makeOutbound({ text: 'Hello from the bot' });
      const result = await processor.processOutbound(msg);

      expect(mockTTS.synthesize).toHaveBeenCalledWith('Hello from the bot');
      expect(result.attachments).toHaveLength(1);

      const attachment = result.attachments![0]!;
      expect(attachment.type).toBe('audio');
      expect(attachment.mimeType).toBe('audio/mpeg');
      expect(attachment.filename).toBe('response.mp3');
      expect(Buffer.isBuffer(attachment.data)).toBe(true);
    });

    it('returns message unchanged when TTS not configured', async () => {
      const processor = new VoiceProcessor({
        // no tts provider
        config: makeConfig(),
      });

      const msg = makeOutbound({ text: 'Hello' });
      const result = await processor.processOutbound(msg);

      expect(result).toEqual(msg);
    });

    it('returns message unchanged when voice disabled', async () => {
      const processor = new VoiceProcessor({
        tts: mockTTS,
        config: makeConfig({ enabled: false }),
      });

      const msg = makeOutbound({ text: 'Hello' });
      const result = await processor.processOutbound(msg);

      expect(result).toEqual(msg);
      expect(mockTTS.synthesize).not.toHaveBeenCalled();
    });

    it('returns message unchanged for empty text', async () => {
      const processor = new VoiceProcessor({
        tts: mockTTS,
        config: makeConfig(),
      });

      const msg = makeOutbound({ text: '' });
      const result = await processor.processOutbound(msg);

      expect(result).toEqual(msg);
      expect(mockTTS.synthesize).not.toHaveBeenCalled();
    });
  });
});
