#!/usr/bin/env python3
"""
NEPTUNE-AI: Asterisk Voice Agent Bridge
Handles:
1. Inbound Interactive Voice Assistant with Caller Identification (Ext 1001 -> Sultan, Ext 1002 -> Desk).
2. Proactive Outbound Messaging ("Call Sultan and tell him dinner is ready").
3. Universal Agenda & Reminder Outbound Voice Delivery.
Powered by Wyoming Whisper (STT) + Fast-Path / Qwen LLM + Wyoming Piper (TTS).
"""

import sys
import os
import asyncio
import wave
import subprocess
import json
import urllib.request
from wyoming.client import AsyncTcpClient
from wyoming.tts import Synthesize
from wyoming.asr import Transcribe, Transcript
from wyoming.audio import AudioChunk, AudioStop, AudioStart

WHISPER_HOST = os.environ.get("WHISPER_HOST", "neptune-whisper")
WHISPER_PORT = int(os.environ.get("WHISPER_PORT", "10300"))
PIPER_HOST = os.environ.get("PIPER_HOST", "neptune-piper")
PIPER_PORT = int(os.environ.get("PIPER_PORT", "10200"))
BACKEND_URL = os.environ.get("BACKEND_URL", "http://neptune-backend:3000/api/command")

# Known extensions and names mapping (customizable via env or config)
CONTACTS = {
    "1001": os.environ.get("CALLER_NAME_1001", "Primary"),
    "1002": os.environ.get("CALLER_NAME_1002", "Desk"),
    "7000": "Neptune",
}

def send_agi(cmd):
    sys.stdout.write(f"{cmd}\n")
    sys.stdout.flush()
    return sys.stdin.readline().strip()

def get_variable(var_name):
    res = send_agi(f"GET VARIABLE {var_name}")
    if "result=1" in res and "(" in res:
        return res.split("(", 1)[1].rstrip(")")
    return ""

async def transcribe_wav(wav_path):
    try:
        sys.stderr.write(f"[STT] Transcribing: {wav_path} (size: {os.path.getsize(wav_path)} bytes)\n")
        # Ensure 16kHz mono 16-bit PCM for Whisper
        wav_16k = "/var/spool/asterisk/tmp/whisper_16k.wav"
        subprocess.run(["sox", wav_path, "-r", "16000", "-c", "1", "-b", "16", wav_16k], check=True)

        client = AsyncTcpClient(WHISPER_HOST, WHISPER_PORT)
        await client.connect()

        with wave.open(wav_16k, "rb") as wf:
            rate = wf.getframerate()
            width = wf.getsampwidth()
            channels = wf.getnchannels()
            frames = wf.readframes(wf.getnframes())

        await client.write_event(Transcribe().event())
        await client.write_event(AudioStart(rate=rate, width=width, channels=channels).event())

        chunk_size = 2048
        for i in range(0, len(frames), chunk_size):
            chunk = frames[i:i+chunk_size]
            await client.write_event(AudioChunk(audio=chunk, rate=rate, width=width, channels=channels).event())

        await client.write_event(AudioStop().event())

        while True:
            event = await client.read_event()
            if event is None:
                break
            if Transcript.is_type(event.type):
                transcript = Transcript.from_event(event)
                sys.stderr.write(f"[STT] Whisper recognized: '{transcript.text}'\n")
                return transcript.text.strip()
    except Exception as e:
        sys.stderr.write(f"[STT Error] {e}\n")
    return ""

async def synthesize_speech(text, output_base):
    try:
        sys.stderr.write(f"[TTS] Synthesizing: '{text}'\n")
        client = AsyncTcpClient(PIPER_HOST, PIPER_PORT)
        await client.connect()

        await client.write_event(Synthesize(text=text).event())

        audio_bytes = bytearray()
        rate = 22050
        width = 2
        channels = 1

        while True:
            event = await client.read_event()
            if event is None:
                break
            if AudioStart.is_type(event.type):
                start = AudioStart.from_event(event)
                rate = start.rate
                width = start.width
                channels = start.channels
            elif AudioChunk.is_type(event.type):
                chunk = AudioChunk.from_event(event)
                audio_bytes.extend(chunk.audio)
            elif AudioStop.is_type(event.type):
                break

        # Save Piper native WAV
        piper_wav = f"{output_base}_piper.wav"
        with wave.open(piper_wav, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(width)
            wf.setframerate(rate)
            wf.writeframes(audio_bytes)

        # Resample to 8000Hz mono 16-bit PCM for Asterisk phone channel
        phone_wav = f"{output_base}.wav"
        subprocess.run(["sox", piper_wav, "-r", "8000", "-c", "1", "-b", "16", phone_wav], check=True)
        return True
    except Exception as e:
        sys.stderr.write(f"[TTS Error] {e}\n")
        return False

def query_backend(text, caller_id="", caller_name=""):
    try:
        req_data = json.dumps({
            "text": text,
            "caller_id": caller_id,
            "caller_name": caller_name
        }).encode("utf-8")
        req = urllib.request.Request(BACKEND_URL, data=req_data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as response:
            res = json.loads(response.read().decode("utf-8"))
            return res.get("speech", "Command completed successfully.")
    except Exception as e:
        sys.stderr.write(f"[Backend Error] {e}\n")
        return "I am currently unable to reach the Neptune AI backend."

def main():
    # Consume AGI startup headers sent by Asterisk
    agi_env = {}
    while True:
        line = sys.stdin.readline().strip()
        if not line:
            break
        if ":" in line:
            key, val = line.split(":", 1)
            agi_env[key.strip()] = val.strip()

    # Identify caller from AGI environment
    caller_id = agi_env.get("agi_callerid", "").strip()
    caller_name = CONTACTS.get(caller_id, os.environ.get("CALLER_NAME_1001", "Primary") if caller_id == "1001" else "Desk" if caller_id == "1002" else "Caller")

    # Mode 1: Personalized Inbound Greeting
    if len(sys.argv) > 1 and sys.argv[1] == "greet":
        send_agi(f"VERBOSE \"[Neptune-AI] Identified caller {caller_id} as {caller_name}\" 1")
        greeting_text = f"Hello {caller_name}! I am Neptune. How can I help you today?"
        greet_base = "/var/spool/asterisk/tmp/inbound_greeting"
        if asyncio.run(synthesize_speech(greeting_text, greet_base)):
            send_agi(f"STREAM FILE {greet_base} \"\"")
        return

    # Mode 2: Proactive Outbound Call Message Delivery ("Call [person] and tell them [msg]")
    outbound_msg = get_variable("OUTBOUND_MSG")
    if outbound_msg:
        outbound_to = get_variable("OUTBOUND_TO") or caller_name
        outbound_from = get_variable("OUTBOUND_FROM") or "Neptune"

        if outbound_from.lower() != "neptune":
            spoken_phrase = f"Hello {outbound_to}. I have a message from {outbound_from}: {outbound_msg}. Have a good day!"
        else:
            spoken_phrase = f"Hello {outbound_to}. This is Neptune with a message for you: {outbound_msg}. Have a good day!"

        send_agi(f"VERBOSE \"[Neptune-AI] Outbound message to {outbound_to}: {spoken_phrase}\" 1")
        msg_base = "/var/spool/asterisk/tmp/outbound_msg_reply"
        if asyncio.run(synthesize_speech(spoken_phrase, msg_base)):
            send_agi(f"STREAM FILE {msg_base} \"\"")
        send_agi("WAIT 1")
        send_agi("SET VARIABLE HANGUP_NOW 1")
        return

    # Mode 3: Outbound Reminder Delivery
    reminder_text = get_variable("REMINDER_MSG")
    if reminder_text:
        outbound_to = get_variable("OUTBOUND_TO") or caller_name
        spoken_phrase = f"Hello {outbound_to}. This is your reminder to {reminder_text}."
        send_agi(f"VERBOSE \"[Neptune-AI] Outbound reminder to {outbound_to}: {spoken_phrase}\" 1")
        rem_base = "/var/spool/asterisk/tmp/reminder_reply"
        if asyncio.run(synthesize_speech(spoken_phrase, rem_base)):
            send_agi(f"STREAM FILE {rem_base} \"\"")
        send_agi("WAIT 1")
        send_agi("SET VARIABLE HANGUP_NOW 1")
        return

    # Mode 4: Inbound Interactive Voice Turn
    recorded_file = "/var/spool/asterisk/tmp/user_turn.wav"
    user_text = ""

    if os.path.exists(recorded_file) and os.path.getsize(recorded_file) > 2000:
        user_text = asyncio.run(transcribe_wav(recorded_file))
        try:
            os.remove(recorded_file)
        except:
            pass

    if not user_text:
        reprompt_base = "/var/spool/asterisk/tmp/reprompt"
        asyncio.run(synthesize_speech(f"I didn't catch that, {caller_name}. What would you like me to do?", reprompt_base))
        send_agi(f"STREAM FILE {reprompt_base} \"\"")
        return

    # Check for hangup intent
    if any(w in user_text.lower() for w in ["goodbye", "bye", "cancel", "exit", "stop", "hang up", "thank you"]):
        bye_base = "/var/spool/asterisk/tmp/bye"
        asyncio.run(synthesize_speech(f"Goodbye {caller_name}! Have a wonderful day.", bye_base))
        send_agi(f"STREAM FILE {bye_base} \"\"")
        send_agi("SET VARIABLE HANGUP_NOW 1")
        return

    # Query Neptune backend with caller identity
    send_agi(f"VERBOSE \"[Neptune-AI] Processing command from {caller_name}: {user_text}\" 1")
    reply = query_backend(user_text, caller_id=caller_id, caller_name=caller_name)

    # Synthesize and speak response directly back through phone
    resp_base = "/var/spool/asterisk/tmp/reply"
    if asyncio.run(synthesize_speech(reply, resp_base)):
        send_agi(f"STREAM FILE {resp_base} \"\"")

if __name__ == "__main__":
    main()
