/**
 * OpenAI Whisper speech-to-text provider.
 *
 * Uses the OpenAI transcriptions API with the whisper-1 model to convert
 * audio buffers into text. Relies on native fetch() and FormData (Node 18+).
 */

import type { STTProvider } from './types.js';

/** Configuration for the Whisper STT provider. */
export interface WhisperSTTConfig {
  apiKey: string;
}

/**
 * Speech-to-text provider backed by OpenAI Whisper.
 *
 * @example
 * ```ts
 * const stt = new WhisperSTT({ apiKey: process.env.OPENAI_API_KEY! });
 * const transcript = await stt.transcribe(audioBuffer, 'audio/webm');
 * ```
 */
export class WhisperSTT implements STTProvider {
  private readonly apiKey: string;

  constructor(config: WhisperSTTConfig) {
    this.apiKey = config.apiKey;
  }

  /**
   * Transcribe an audio buffer to text using OpenAI Whisper.
   *
   * @param audio  - Raw audio data as a Buffer.
   * @param mimeType - MIME type of the audio (e.g. 'audio/webm', 'audio/mp3').
   * @returns The transcribed text.
   */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const ext = mimeTypeToExtension(mimeType);
    const blob = new Blob([audio], { type: mimeType });

    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Whisper STT failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as { text: string };
    return json.text;
  }
}

/**
 * Map a MIME type to a reasonable file extension for the Whisper API.
 * Whisper infers format from the filename extension.
 */
function mimeTypeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/mp3': 'mp3',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/x-m4a': 'm4a',
  };
  return map[mimeType] ?? 'webm';
}
