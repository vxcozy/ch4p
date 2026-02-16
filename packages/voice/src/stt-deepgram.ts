/**
 * Deepgram speech-to-text provider.
 *
 * Uses the Deepgram REST API with the Nova-3 model to convert audio
 * buffers into text. Relies on native fetch() only.
 */

import type { STTProvider } from './types.js';

/** Configuration for the Deepgram STT provider. */
export interface DeepgramSTTConfig {
  apiKey: string;
}

/** Deepgram transcription response shape (subset). */
interface DeepgramResponse {
  results: {
    channels: Array<{
      alternatives: Array<{
        transcript: string;
      }>;
    }>;
  };
}

/**
 * Speech-to-text provider backed by Deepgram Nova-3.
 *
 * @example
 * ```ts
 * const stt = new DeepgramSTT({ apiKey: process.env.DEEPGRAM_API_KEY! });
 * const transcript = await stt.transcribe(audioBuffer, 'audio/webm');
 * ```
 */
export class DeepgramSTT implements STTProvider {
  private readonly apiKey: string;

  constructor(config: DeepgramSTTConfig) {
    this.apiKey = config.apiKey;
  }

  /**
   * Transcribe an audio buffer to text using Deepgram Nova-3.
   *
   * @param audio    - Raw audio data as a Buffer.
   * @param mimeType - MIME type of the audio (e.g. 'audio/webm', 'audio/wav').
   * @returns The transcribed text.
   */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const res = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': mimeType,
        },
        body: audio,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Deepgram STT failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as DeepgramResponse;
    return json.results.channels[0]?.alternatives[0]?.transcript ?? '';
  }
}
