# How to Set Up Voice

This guide explains how to configure the voice pipeline for speech-to-text (STT) and text-to-speech (TTS) capabilities.

---

## Prerequisites

- An API key for your chosen STT/TTS provider
- A channel that supports voice messages (e.g., Telegram, Discord)

---

## Overview

The voice pipeline consists of two components:

- **STT (Speech-to-Text)**: Transcribes voice messages into text for the agent
- **TTS (Text-to-Speech)**: Converts agent responses into audio

Supported providers:

| Component | Providers |
|-----------|-----------|
| STT | Whisper (OpenAI), Deepgram |
| TTS | ElevenLabs |

---

## Step 1: Configure STT

### Whisper (OpenAI)

```json
{
  "voice": {
    "stt": {
      "provider": "whisper",
      "apiKey": "${OPENAI_API_KEY}",
      "model": "whisper-1"
    }
  }
}
```

### Deepgram

```json
{
  "voice": {
    "stt": {
      "provider": "deepgram",
      "apiKey": "${DEEPGRAM_API_KEY}",
      "model": "nova-2"
    }
  }
}
```

---

## Step 2: Configure TTS

### ElevenLabs

```json
{
  "voice": {
    "tts": {
      "provider": "elevenlabs",
      "apiKey": "${ELEVENLABS_API_KEY}",
      "voiceId": "21m00Tcm4TlvDq8ikWAM",
      "model": "eleven_monolingual_v1"
    }
  }
}
```

---

## Step 3: Enable Voice in a Channel

Voice processing is handled per-channel in the gateway. When a voice message arrives (e.g., a Telegram voice note), the gateway:

1. Downloads the audio file
2. Sends it through the STT provider
3. Passes the transcribed text to the agent
4. Optionally converts the response back to audio via TTS

---

## Environment Variables

Store API keys in `~/.ch4p/.env`:

```
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
```

Reference them in config using `${VAR_NAME}` syntax.

---

## Voice Wake (Always-On Listening)

Voice wake enables always-on microphone listening with automatic speech detection. When enabled, ch4p continuously listens for speech (or a specific wake word), transcribes it via your configured STT provider, and feeds the text into the agent loop.

### Prerequisites

- SoX audio toolkit — provides the `rec` command for microphone capture
  - macOS: `brew install sox`
  - Linux: `apt install sox`
- A configured STT provider (Whisper or Deepgram)

### Configuration

```json
{
  "voice": {
    "stt": { "provider": "whisper", "apiKey": "${OPENAI_API_KEY}" },
    "tts": { "provider": "elevenlabs", "apiKey": "${ELEVENLABS_API_KEY}" },
    "wake": {
      "enabled": true,
      "wakeWord": "hey chappie",
      "energyThreshold": 500,
      "silenceDurationMs": 800
    }
  }
}
```

### Wake word

Set `wakeWord` to filter utterances — only speech starting with the wake word triggers the agent. Omit `wakeWord` for push-to-talk style (all detected speech is processed).

### Tuning sensitivity

- **`energyThreshold`** (default 500) — lower values make the VAD more sensitive to quiet speech. Increase if ambient noise triggers false detections.
- **`silenceDurationMs`** (default 800) — how long silence must persist before the system considers speech complete. Increase for speakers who pause frequently.

### How it works

1. `MicCapture` spawns SoX `rec` as a child process streaming raw PCM audio
2. `VoiceActivityDetector` computes RMS energy on each audio chunk
3. When energy exceeds the threshold, speech recording begins
4. When silence persists beyond `silenceDurationMs`, the captured audio is sent to STT
5. The transcribed text is emitted as an agent message
6. Agent response is synthesized via TTS and played back through speakers

---

## Limitations

- Voice pipeline requires the gateway to be running (`ch4p gateway`)
- Not all channels support voice messages
- Audio format conversion may be needed depending on the channel and provider
