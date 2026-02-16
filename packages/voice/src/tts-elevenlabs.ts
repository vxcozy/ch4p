/**
 * ElevenLabs text-to-speech provider.
 *
 * Uses the ElevenLabs REST API with the eleven_flash_v2_5 model to synthesize
 * text into audio. Relies on native fetch() only.
 */

import type { TTSProvider } from './types.js';

/** Configuration for the ElevenLabs TTS provider. */
export interface ElevenLabsTTSConfig {
  apiKey: string;
  /** ElevenLabs voice ID. Defaults to '21m00Tcm4TlvDq8ikWAM' (Rachel). */
  voiceId?: string;
}

/** Default ElevenLabs voice ID (Rachel). */
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

/**
 * Text-to-speech provider backed by ElevenLabs.
 *
 * @example
 * ```ts
 * const tts = new ElevenLabsTTS({ apiKey: process.env.ELEVENLABS_API_KEY! });
 * const { audio, mimeType } = await tts.synthesize('Hello, world!');
 * ```
 */
export class ElevenLabsTTS implements TTSProvider {
  private readonly apiKey: string;
  private readonly voiceId: string;

  constructor(config: ElevenLabsTTSConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId ?? DEFAULT_VOICE_ID;
  }

  /**
   * Synthesize text into audio using ElevenLabs.
   *
   * @param text - The text to convert to speech.
   * @returns An object containing the audio Buffer and its MIME type.
   */
  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${body}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuf),
      mimeType: 'audio/mpeg',
    };
  }
}
