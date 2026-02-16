/**
 * Voice processing types for ch4p.
 *
 * Defines the provider interfaces and configuration for speech-to-text (STT)
 * and text-to-speech (TTS) capabilities used by the voice processor.
 */

/** Speech-to-text provider interface. */
export interface STTProvider {
  /** Transcribe an audio buffer to text. */
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

/** Text-to-speech provider interface. */
export interface TTSProvider {
  /** Synthesize text into audio. */
  synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }>;
}

/** Voice configuration. */
export interface VoiceConfig {
  enabled: boolean;
  stt: {
    provider: 'whisper' | 'deepgram';
    apiKey?: string;
  };
  tts: {
    provider: 'elevenlabs' | 'none';
    apiKey?: string;
    voiceId?: string;
  };
}
