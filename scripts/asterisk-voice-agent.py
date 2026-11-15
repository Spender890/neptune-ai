#!/usr/bin/env python3
"""
NEPTUNE-AI: Asterisk Voice Agent Bridge
Handles:
1. Inbound Interactive Voice Assistant with Caller Identification (Ext 1001 -> Primary, Ext 1002 -> Desk).
2. Proactive Outbound Messaging ("Call Desk and tell them dinner is ready").
3. Universal Agenda & Reminder Outbound Voice Delivery.
Powered by Wyoming Whisper (STT) + Fast-Path / Qwen LLM + Wyoming Piper (TTS).
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import urllib.request
import wave

try:
    from wyoming.asr import Transcribe, Transcript
    from wyoming.audio import AudioChunk, AudioStart, AudioStop
    from wyoming.client import AsyncTcpClient
    from wyoming.tts import Synthesize

    HAS_WYOMING = True
except ImportError:
    HAS_WYOMING = False

def _resolve_host(env_var, default_host):
    val = os.environ.get(env_var)
    if val:
        return val
    try:
        import socket
        socket.gethostbyname(default_host)
        return default_host
    except Exception:
        return "127.0.0.1"


WHISPER_HOST = _resolve_host("WHISPER_HOST", "neptune-whisper")
WHISPER_PORT = int(os.environ.get("WHISPER_PORT", "10300"))
PIPER_HOST = _resolve_host("PIPER_HOST", "neptune-piper")
PIPER_PORT = int(os.environ.get("PIPER_PORT", "10200"))
BACKEND_HOST = _resolve_host("BACKEND_HOST", "neptune-backend")
BACKEND_URL = os.environ.get("BACKEND_URL", f"http://{BACKEND_HOST}:3000/api/command")
NEPTUNE_API_KEY = os.environ.get("NEPTUNE_API_KEY", "")
SPOOL_TMP_DIR = os.environ.get("ASTERISK_TMP_DIR", "/var/spool/asterisk/tmp")

# Known extensions and names mapping (customizable via env)
CONTACTS = {
    "1001": os.environ.get("CALLER_NAME_1001", os.environ.get("PRIMARY_USER_NAME", "Primary")),
    "1002": os.environ.get("CALLER_NAME_1002", "Desk"),
    "7000": "Neptune",
}

HANGUP_EXACT_PHRASES = {"goodbye", "bye", "cancel", "exit", "stop", "hang up", "thank you", "thanks"}
HANGUP_REGEX = re.compile(r"\b(?:goodbye|bye|hang\s+up)\b")


class WyomingEvent:
    """Lightweight representation of a Wyoming protocol JSONL + binary payload event."""

    def __init__(self, event_type, data=None, payload=b""):
        self.type = event_type
        self.data = data or {}
        self.payload = payload


class StdlibWyomingClient:
    """Minimal asyncio TCP Wyoming protocol client used when the `wyoming` package is unavailable."""

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.reader = None
        self.writer = None

    async def connect(self):
        self.reader, self.writer = await asyncio.open_connection(self.host, self.port)

    async def write_raw_event(self, event_type, data=None, payload=b""):
        data_bytes = b""
        header = {"type": event_type}
        if data:
            data_bytes = json.dumps(data).encode("utf-8")
            header["data_length"] = len(data_bytes)
        if payload:
            header["payload_length"] = len(payload)
        line = (json.dumps(header) + "\n").encode("utf-8")
        self.writer.write(line + data_bytes + (payload or b""))
        await self.writer.drain()

    async def read_raw_event(self):
        while True:
            line = await self.reader.readline()
            if not line:
                return None
            line_str = line.decode("utf-8", errors="replace").strip()
            if not line_str:
                continue
            try:
                header = json.loads(line_str)
                break
            except Exception as e:
                sys.stderr.write(f"[Wyoming Header Warning] '{line_str}': {e}\n")
                continue

        data = header.get("data") or {}
        data_len = int(header.get("data_length", 0) or 0)
        if data_len > 0:
            data_bytes = await self.reader.readexactly(data_len)
            try:
                extra_data = json.loads(data_bytes.decode("utf-8", errors="replace"))
                if isinstance(extra_data, dict) and isinstance(data, dict):
                    data.update(extra_data)
                else:
                    data = extra_data
            except Exception as e:
                sys.stderr.write(f"[Wyoming Data Warning] {e}\n")

        payload_len = int(header.get("payload_length", 0) or 0)
        payload = b""
        if payload_len > 0:
            payload = await self.reader.readexactly(payload_len)

        return WyomingEvent(header.get("type"), data, payload)

    async def close(self):
        if self.writer:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except Exception:
                pass


def _sanitize_agi_arg(value):
    return str(value).replace("\r", " ").replace("\n", " ").replace("\0", "").strip()


def send_agi(cmd):
    safe_cmd = _sanitize_agi_arg(cmd)
    sys.stdout.write(f"{safe_cmd}\n")
    sys.stdout.flush()
    return sys.stdin.readline().strip()


def get_variable(var_name):
    res = send_agi(f"GET VARIABLE {_sanitize_agi_arg(var_name)}")
    if "result=1" in res and "(" in res:
        return res.split("(", 1)[1].rstrip(")")
    return ""


def read_agi_env(stream=None):
    """Parses Asterisk AGI startup environment headers until blank line."""
    src = stream if stream is not None else sys.stdin
    agi_env = {}
    while True:
        line = src.readline()
        if not line:
            break
        stripped = line.strip()
        if not stripped:
            break
        if ":" in stripped:
            key, val = stripped.split(":", 1)
            agi_env[key.strip()] = val.strip()
    return agi_env


def identify_caller(caller_id):
    clean_id = str(caller_id or "").strip()
    if clean_id in CONTACTS:
        return CONTACTS[clean_id]
    return "Caller"


def is_hangup_intent(user_text):
    clean = re.sub(r"[.,!?;:]+", "", str(user_text or "").strip().lower())
    if not clean:
        return False
    if clean in HANGUP_EXACT_PHRASES:
        return True
    return bool(HANGUP_REGEX.search(clean))


async def transcribe_wav(wav_path, whisper_host=WHISPER_HOST, whisper_port=WHISPER_PORT):
    try:
        os.makedirs(SPOOL_TMP_DIR, exist_ok=True)
        file_size = os.path.getsize(wav_path)
        sys.stderr.write(f"[STT] Transcribing: {wav_path} (size: {file_size} bytes)\n")
        # Ensure 16kHz mono 16-bit PCM for Whisper, suppress ALSA warnings from sox
        wav_16k = os.path.join(SPOOL_TMP_DIR, "whisper_16k.wav")
        subprocess.run(
            ["sox", wav_path, "-r", "16000", "-c", "1", "-b", "16", wav_16k],
            check=True,
            stderr=subprocess.DEVNULL,
        )

        with wave.open(wav_16k, "rb") as wf:
            rate = wf.getframerate()
            width = wf.getsampwidth()
            channels = wf.getnchannels()
            frames = wf.readframes(wf.getnframes())

        text = await transcribe_pcm_frames(frames, rate, width, channels, whisper_host, whisper_port)
        clean = text.lower().strip().rstrip(".?!,")
        # Filter out common Faster-Whisper hallucinations on short ambient silence
        if clean in {"you", "thank you", "thanks"}:
            sys.stderr.write(f"[STT] Filtered hallucination on silence: '{text}'\n")
            return ""
        return text
    except Exception as e:
        sys.stderr.write(f"[STT Error] {e}\n")
    return ""


async def transcribe_pcm_frames(frames, rate=16000, width=2, channels=1, whisper_host=WHISPER_HOST, whisper_port=WHISPER_PORT):
    """Streams raw PCM frames to Wyoming Whisper over TCP and returns recognized transcript text."""
    if HAS_WYOMING:
        client = AsyncTcpClient(whisper_host, whisper_port)
        await client.connect()
        try:
            await client.write_event(Transcribe(language="en").event())
            await client.write_event(AudioStart(rate=rate, width=width, channels=channels).event())
            chunk_size = 2048
            for i in range(0, len(frames), chunk_size):
                chunk = frames[i : i + chunk_size]
                await client.write_event(AudioChunk(audio=chunk, rate=rate, width=width, channels=channels).event())
            await client.write_event(AudioStop().event())

            while True:
                event = await client.read_event()
                if event is None:
                    break
                if Transcript.is_type(event.type):
                    transcript = Transcript.from_event(event)
                    text = str(transcript.text or "").strip()
                    sys.stderr.write(f"[STT] Wyoming recognized: '{text}'\n")
                    return text
        finally:
            await client.disconnect()
        return ""

    client = StdlibWyomingClient(whisper_host, whisper_port)
    await client.connect()
    try:
        await client.write_raw_event("transcribe", {"language": "en"})
        await client.write_raw_event("audio-start", {"rate": rate, "width": width, "channels": channels})
        chunk_size = 2048
        for i in range(0, len(frames), chunk_size):
            chunk = frames[i : i + chunk_size]
            await client.write_raw_event("audio-chunk", {"rate": rate, "width": width, "channels": channels}, chunk)
        await client.write_raw_event("audio-stop")

        while True:
            event = await client.read_raw_event()
            if event is None:
                break
            if event.type == "transcript":
                text = str(event.data.get("text", "")).strip()
                sys.stderr.write(f"[STT] Whisper recognized: '{text}'\n")
                return text
    finally:
        await client.close()
    return ""


async def synthesize_pcm(text, piper_host=PIPER_HOST, piper_port=PIPER_PORT):
    """Requests TTS synthesis from Wyoming Piper over TCP and returns (audio_bytes, rate, width, channels)."""
    if HAS_WYOMING:
        audio_bytes = bytearray()
        rate = 22050
        width = 2
        channels = 1
        client = AsyncTcpClient(piper_host, piper_port)
        await client.connect()
        try:
            await client.write_event(Synthesize(text=text).event())
            while True:
                event = await client.read_event()
                if event is None:
                    break
                if AudioStart.is_type(event.type):
                    start = AudioStart.from_event(event)
                    rate = int(start.rate)
                    width = int(start.width)
                    channels = int(start.channels)
                elif AudioChunk.is_type(event.type):
                    chunk = AudioChunk.from_event(event)
                    audio_bytes.extend(chunk.audio)
                elif AudioStop.is_type(event.type):
                    break
        finally:
            await client.disconnect()
        return bytes(audio_bytes), rate, width, channels

    audio_bytes = bytearray()
    rate = 22050
    width = 2
    channels = 1

    client = StdlibWyomingClient(piper_host, piper_port)
    await client.connect()
    try:
        await client.write_raw_event("synthesize", {"text": text})
        while True:
            event = await client.read_raw_event()
            if event is None:
                break
            if event.type == "audio-start":
                rate = int(event.data.get("rate", rate))
                width = int(event.data.get("width", width))
                channels = int(event.data.get("channels", channels))
            elif event.type == "audio-chunk":
                audio_bytes.extend(event.payload)
            elif event.type == "audio-stop":
                break
    finally:
        await client.close()
    return bytes(audio_bytes), rate, width, channels


async def synthesize_speech(text, output_base, piper_host=PIPER_HOST, piper_port=PIPER_PORT):
    try:
        os.makedirs(os.path.dirname(output_base) or SPOOL_TMP_DIR, exist_ok=True)
        sys.stderr.write(f"[TTS] Synthesizing: '{text}'\n")
        audio_bytes, rate, width, channels = await synthesize_pcm(text, piper_host, piper_port)
        if not audio_bytes:
            return False

        # Save Piper native WAV
        piper_wav = f"{output_base}_piper.wav"
        with wave.open(piper_wav, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(width)
            wf.setframerate(rate)
            wf.writeframes(audio_bytes)

        # Resample to 8000Hz mono 16-bit PCM for Asterisk phone channel, suppress ALSA warnings
        phone_wav = f"{output_base}.wav"
        subprocess.run(
            ["sox", piper_wav, "-r", "8000", "-c", "1", "-b", "16", phone_wav],
            check=True,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception as e:
        sys.stderr.write(f"[TTS Error] {e}\n")
        return False


def query_backend(text, caller_id="", caller_name="", backend_url=BACKEND_URL, api_key=NEPTUNE_API_KEY):
    try:
        sys.stderr.write(f"[Backend] Querying {backend_url} with: '{text}' (timeout 30s)\n")
        req_data = json.dumps({
            "text": text,
            "caller_id": caller_id,
            "caller_name": caller_name,
        }).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["X-API-Key"] = api_key
        req = urllib.request.Request(backend_url, data=req_data, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            res = json.loads(response.read().decode("utf-8"))
            reply = res.get("speech", "Command completed successfully.")
            sys.stderr.write(f"[Backend] Reply: '{reply}'\n")
            return reply
    except Exception as e:
        sys.stderr.write(f"[Backend Error] {e}\n")
        return "I am currently unable to reach the Neptune AI backend."


def main():
    os.makedirs(SPOOL_TMP_DIR, exist_ok=True)
    agi_env = read_agi_env()

    caller_id = agi_env.get("agi_callerid", "").strip()
    caller_name = identify_caller(caller_id)

    # Mode 1: Personalized Inbound Greeting
    if len(sys.argv) > 1 and sys.argv[1] == "greet":
        send_agi(f'VERBOSE "[Neptune-AI] Identified caller {caller_id} as {caller_name}" 1')
        greeting_text = f"Hello {caller_name}! I am Neptune. How can I help you today?"
        greet_base = os.path.join(SPOOL_TMP_DIR, "inbound_greeting")
        if asyncio.run(synthesize_speech(greeting_text, greet_base)):
            send_agi(f'STREAM FILE {greet_base} ""')
        return

    # Mode 2: Proactive Outbound Call Message Delivery
    outbound_msg = get_variable("OUTBOUND_MSG")
    if outbound_msg:
        outbound_to = get_variable("OUTBOUND_TO") or caller_name
        outbound_from = get_variable("OUTBOUND_FROM") or "Neptune"

        if outbound_from.lower() != "neptune":
            spoken_phrase = f"Hello {outbound_to}. I have a message from {outbound_from}: {outbound_msg}. Have a good day!"
        else:
            spoken_phrase = f"Hello {outbound_to}. This is Neptune with a message for you: {outbound_msg}. Have a good day!"

        send_agi(f'VERBOSE "[Neptune-AI] Outbound message to {outbound_to}: {spoken_phrase}" 1')
        msg_base = os.path.join(SPOOL_TMP_DIR, "outbound_msg_reply")
        if asyncio.run(synthesize_speech(spoken_phrase, msg_base)):
            send_agi(f'STREAM FILE {msg_base} ""')
        send_agi("WAIT 1")
        send_agi("SET VARIABLE HANGUP_NOW 1")
        return

    # Mode 3: Outbound Reminder Delivery
    reminder_text = get_variable("REMINDER_MSG")
    if reminder_text:
        outbound_to = get_variable("OUTBOUND_TO") or caller_name
        spoken_phrase = f"Hello {outbound_to}. This is your reminder to {reminder_text}."
        send_agi(f'VERBOSE "[Neptune-AI] Outbound reminder to {outbound_to}: {spoken_phrase}" 1')
        rem_base = os.path.join(SPOOL_TMP_DIR, "reminder_reply")
        if asyncio.run(synthesize_speech(spoken_phrase, rem_base)):
            send_agi(f'STREAM FILE {rem_base} ""')
        send_agi("WAIT 1")
        send_agi("SET VARIABLE HANGUP_NOW 1")
        return

    # Mode 4: Inbound Interactive Voice Turn
    recorded_file = os.path.join(SPOOL_TMP_DIR, "user_turn.wav")
    user_text = ""

    if os.path.exists(recorded_file):
        file_size = os.path.getsize(recorded_file)
        sys.stderr.write(f"[Neptune-AI] Turn audio recorded: {recorded_file} ({file_size} bytes)\n")
        if file_size > 2000:
            user_text = asyncio.run(transcribe_wav(recorded_file))
        try:
            os.remove(recorded_file)
        except Exception:
            pass
    else:
        sys.stderr.write(f"[Neptune-AI] Turn audio file not found: {recorded_file}\n")

    sys.stderr.write(f"[Neptune-AI] Caller {caller_name} ({caller_id}) user_text: '{user_text}'\n")

    if not user_text:
        reprompt_base = os.path.join(SPOOL_TMP_DIR, "reprompt")
        if asyncio.run(synthesize_speech(f"I didn't catch that, {caller_name}. What would you like me to do?", reprompt_base)):
            send_agi(f'STREAM FILE {reprompt_base} ""')
        return

    if is_hangup_intent(user_text):
        bye_base = os.path.join(SPOOL_TMP_DIR, "bye")
        if asyncio.run(synthesize_speech(f"Goodbye {caller_name}! Have a wonderful day.", bye_base)):
            send_agi(f'STREAM FILE {bye_base} ""')
        send_agi("SET VARIABLE HANGUP_NOW 1")
        return

    send_agi(f'VERBOSE "[Neptune-AI] Processing command from {caller_name}: {user_text}" 1')
    reply = query_backend(user_text, caller_id=caller_id, caller_name=caller_name)

    resp_base = os.path.join(SPOOL_TMP_DIR, "reply")
    if asyncio.run(synthesize_speech(reply, resp_base)):
        send_agi(f'STREAM FILE {resp_base} ""')


if __name__ == "__main__":
    main()
