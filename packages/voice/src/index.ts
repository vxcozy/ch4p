/**
 * @ch4p/voice - Voice processing for ch4p.
 *
 * Provides speech-to-text (STT) and text-to-speech (TTS) capabilities
 * with pluggable provider backends (Whisper, Deepgram, ElevenLabs),
 * plus always-on voice wake listening with energy-based VAD.
 *
 * @packageDocumentation
 */

export { VoiceProcessor } from './processor.js';
export { WhisperSTT } from './stt-whisper.js';
export { DeepgramSTT } from './stt-deepgram.js';
export { ElevenLabsTTS } from './tts-elevenlabs.js';
export { VoiceActivityDetector } from './vad.js';
export { MicCapture } from './mic.js';
export { AudioPlayback } from './playback.js';
export { WakeListener } from './wake-listener.js';
export type { STTProvider, TTSProvider, VoiceConfig } from './types.js';
export type { VADConfig } from './vad.js';
export type { MicCaptureConfig } from './mic.js';
export type { WakeListenerConfig, WakeEvent } from './wake-listener.js';
