/**
 * VoiceProcessor - orchestrates speech-to-text and text-to-speech.
 *
 * Sits between inbound/outbound message flow and the STT/TTS providers,
 * automatically transcribing audio attachments on inbound messages and
 * synthesizing audio for outbound messages.
 */

import type { InboundMessage, OutboundMessage, Attachment } from '@ch4p/core';
import type { STTProvider, TTSProvider, VoiceConfig } from './types.js';

/** Construction options for VoiceProcessor. */
export interface VoiceProcessorOptions {
  stt?: STTProvider;
  tts?: TTSProvider;
  config: VoiceConfig;
}

/**
 * Orchestrates voice processing for the ch4p pipeline.
 *
 * On the inbound side it detects audio attachments and transcribes them via
 * the configured STT provider, prepending the transcript to the message text.
 *
 * On the outbound side it synthesizes the reply text into audio via the
 * configured TTS provider and attaches it to the outbound message.
 *
 * @example
 * ```ts
 * const processor = new VoiceProcessor({
 *   stt: new WhisperSTT({ apiKey: '...' }),
 *   tts: new ElevenLabsTTS({ apiKey: '...' }),
 *   config: { enabled: true, stt: { provider: 'whisper' }, tts: { provider: 'elevenlabs' } },
 * });
 *
 * const enriched = await processor.processInbound(inboundMsg);
 * const withAudio = await processor.processOutbound(outboundMsg);
 * ```
 */
export class VoiceProcessor {
  private readonly stt?: STTProvider;
  private readonly tts?: TTSProvider;
  private readonly config: VoiceConfig;

  constructor(opts: VoiceProcessorOptions) {
    this.stt = opts.stt;
    this.tts = opts.tts;
    this.config = opts.config;
  }

  /**
   * Process an inbound message, transcribing any audio attachments.
   *
   * If no STT provider is configured or the message has no audio attachments,
   * the message is returned unchanged.
   *
   * For each audio attachment that carries a `data` Buffer, the provider
   * transcribes it directly. Attachments that only have a `url` are skipped
   * (the caller is responsible for downloading the audio first).
   *
   * The transcript is prepended to the message text as "[Voice message]: ...".
   *
   * @param msg - The inbound message to process.
   * @returns The message with transcripts prepended to the text.
   */
  async processInbound(msg: InboundMessage): Promise<InboundMessage> {
    if (!this.stt || !this.config.enabled) {
      return msg;
    }

    const audioAttachments = (msg.attachments ?? []).filter(
      (a) => a.type === 'audio',
    );

    if (audioAttachments.length === 0) {
      return msg;
    }

    const transcripts: string[] = [];

    for (const attachment of audioAttachments) {
      if (attachment.data) {
        const mimeType = attachment.mimeType ?? 'audio/webm';
        const transcript = await this.stt.transcribe(attachment.data, mimeType);
        if (transcript) {
          transcripts.push(transcript);
        }
      }
      // Attachments with only a url are skipped; caller must download first.
    }

    if (transcripts.length === 0) {
      return msg;
    }

    const voiceText = transcripts
      .map((t) => `[Voice message]: ${t}`)
      .join('\n');

    const newText = msg.text ? `${voiceText}\n${msg.text}` : voiceText;

    return { ...msg, text: newText };
  }

  /**
   * Process an outbound message, synthesizing audio from the text.
   *
   * If no TTS provider is configured or voice is disabled, the message is
   * returned unchanged.
   *
   * The synthesized audio is added as an attachment to the message.
   *
   * @param msg - The outbound message to process.
   * @returns The message with an audio attachment added.
   */
  async processOutbound(msg: OutboundMessage): Promise<OutboundMessage> {
    if (!this.tts || !this.config.enabled) {
      return msg;
    }

    if (!msg.text) {
      return msg;
    }

    const { audio, mimeType } = await this.tts.synthesize(msg.text);

    const audioAttachment: Attachment = {
      type: 'audio',
      data: audio,
      mimeType,
      filename: 'response.mp3',
    };

    const existingAttachments = msg.attachments ?? [];

    return {
      ...msg,
      attachments: [...existingAttachments, audioAttachment],
    };
  }
}
