/**
 * @ch4p/voice - Voice processing for ch4p.
 *
 * Provides speech-to-text (STT) and text-to-speech (TTS) capabilities
 * with pluggable provider backends (Whisper, Deepgram, ElevenLabs).
 *
 * @packageDocumentation
 */

export { VoiceProcessor } from './processor.js';
export { WhisperSTT } from './stt-whisper.js';
export { DeepgramSTT } from './stt-deepgram.js';
export { ElevenLabsTTS } from './tts-elevenlabs.js';
export type { STTProvider, TTSProvider, VoiceConfig } from './types.js';
