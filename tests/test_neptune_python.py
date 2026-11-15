#!/usr/bin/env python3
"""
Neptune-AI Python Voice Pipeline, Asterisk AGI, and Repository Security Tests.
Runs deterministically without live Docker services, Asterisk, or OS network sockets.
"""

import asyncio
import importlib.util
import io
import json
import os
import re
import struct
import unittest
from pathlib import Path
from unittest import mock
import wave

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_module(name, rel_path):
    path = REPO_ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


voice_bench = load_module("benchmark_voice_phase3", "scripts/benchmark-voice-phase3.py")
agi_agent = load_module("asterisk_voice_agent", "scripts/asterisk-voice-agent.py")


class FakeBlockingSocket:
    """In-memory socket double for testing Wyoming framing without OS sockets."""

    def __init__(self, incoming_bytes=b""):
        self._in = io.BytesIO(incoming_bytes)
        self.sent = bytearray()

    def recv(self, bufsize):
        return self._in.read(bufsize)

    def sendall(self, data):
        self.sent.extend(data)


class FakeAsyncReader:
    """In-memory asyncio StreamReader double without event-loop or OS sockets."""

    def __init__(self, initial_bytes=b""):
        self._buf = io.BytesIO(initial_bytes)

    async def readline(self):
        return self._buf.readline()

    async def readexactly(self, n):
        chunk = self._buf.read(n)
        if len(chunk) < n:
            raise asyncio.IncompleteReadError(chunk, n)
        return chunk


def run_sync_coro(coro):
    """Drives a synchronous-mocked coroutine without asyncio.run() socket pairs."""
    try:
        while True:
            coro.send(None)
    except StopIteration as exc:
        return exc.value


class FakeAsyncWriter:
    """In-memory asyncio StreamWriter double."""

    def __init__(self):
        self.sent = bytearray()
        self.closed = False

    def write(self, data):
        self.sent.extend(data)

    async def drain(self):
        return None

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return None


def encode_wyoming_event(event_type, data=None, payload=b""):
    header = {"type": event_type}
    if data:
        header["data"] = data
    if payload:
        header["payload_length"] = len(payload)
    return (json.dumps(header) + "\n").encode("utf-8") + payload


class TestWyomingVoicePipeline(unittest.TestCase):
    def test_send_and_read_wyoming_event_roundtrip(self):
        pcm = b"\x01\x02\x03\x04\x05\x06"
        tx_sock = FakeBlockingSocket()
        voice_bench.send_wyoming_event(
            tx_sock,
            "audio-chunk",
            data={"rate": 16000, "width": 2, "channels": 1},
            payload=pcm,
        )

        rx_sock = FakeBlockingSocket(bytes(tx_sock.sent))
        header, payload = voice_bench.read_wyoming_event(rx_sock)
        self.assertIsNotNone(header)
        self.assertEqual(header["type"], "audio-chunk")
        self.assertEqual(header["data"]["rate"], 16000)
        self.assertEqual(payload, pcm)

    def test_read_wyoming_event_handles_eof_and_bad_json(self):
        empty_sock = FakeBlockingSocket(b"")
        header, payload = voice_bench.read_wyoming_event(empty_sock)
        self.assertIsNone(header)
        self.assertEqual(payload, b"")

        corrupt_sock = FakeBlockingSocket(b"not-valid-json\n")
        header, payload = voice_bench.read_wyoming_event(corrupt_sock)
        self.assertIsNone(header)

    def test_convert_wav_to_16k_mono_from_22050_and_48k_stereo(self):
        # Case 1: already 16kHz mono 16-bit returns raw PCM untouched
        pcm_16k = struct.pack("<4h", 100, -100, 200, -200)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(pcm_16k)
        self.assertEqual(voice_bench.convert_wav_to_16k_mono(buf.getvalue()), pcm_16k)

        # Case 2: 22050Hz mono -> 16000Hz mono downsampling length check
        num_in = 2205  # 0.1s at 22050Hz
        samples = [int(1000 * ((i % 20) - 10) / 10) for i in range(num_in)]
        in_frames = struct.pack(f"<{num_in}h", *samples)
        buf2 = io.BytesIO()
        with wave.open(buf2, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(22050)
            wf.writeframes(in_frames)
        out_16k = voice_bench.convert_wav_to_16k_mono(buf2.getvalue())
        expected_samples = int(num_in * 16000 / 22050)
        self.assertEqual(len(out_16k), expected_samples * 2)

        # Case 3: 48000Hz stereo -> 16000Hz mono
        num_stereo_frames = 480
        stereo_samples = []
        for i in range(num_stereo_frames):
            stereo_samples.extend([500, -500])
        buf3 = io.BytesIO()
        with wave.open(buf3, "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(48000)
            wf.writeframes(struct.pack(f"<{len(stereo_samples)}h", *stereo_samples))
        out_stereo = voice_bench.convert_wav_to_16k_mono(buf3.getvalue())
        self.assertEqual(len(out_stereo), int(num_stereo_frames * 16000 / 48000) * 2)


class TestAsteriskVoiceAgent(unittest.TestCase):
    def test_agi_env_parsing_and_caller_identification(self):
        raw_stream = io.StringIO(
            "agi_request: asterisk-voice-agent.py\n"
            "agi_callerid: 1002\n"
            "agi_uniqueid: 1700000000.1\n"
            "\n"
        )
        env = agi_agent.read_agi_env(raw_stream)
        self.assertEqual(env["agi_callerid"], "1002")
        self.assertEqual(agi_agent.identify_caller("1002"), "Desk")
        self.assertEqual(agi_agent.identify_caller("9999"), "Caller")

    def test_hangup_intent_detection_does_not_misfire_on_media_stop(self):
        self.assertTrue(agi_agent.is_hangup_intent("Goodbye!"))
        self.assertTrue(agi_agent.is_hangup_intent("stop"))
        self.assertTrue(agi_agent.is_hangup_intent("Please hang up now"))
        self.assertFalse(agi_agent.is_hangup_intent("stop the living room tv"))
        self.assertFalse(agi_agent.is_hangup_intent("turn off the kitchen light"))

    def test_sanitize_agi_arg_strips_newlines(self):
        cleaned = agi_agent._sanitize_agi_arg("VERBOSE \"hello\nEXEC System rm\"\r\0")
        self.assertNotIn("\n", cleaned)
        self.assertNotIn("\r", cleaned)
        self.assertNotIn("\0", cleaned)

    def test_async_wyoming_stt_and_tts_protocol_fallback(self):
        async def run_stt_and_tts():
            # Mock Whisper returning transcript event
            stt_reader = FakeAsyncReader(
                encode_wyoming_event("transcript", {"text": "Turn off the kitchen light"})
            )
            stt_writer = FakeAsyncWriter()

            async def open_stt(host, port):
                return (stt_reader, stt_writer)

            with mock.patch("asyncio.open_connection", side_effect=open_stt):
                transcript = await agi_agent.transcribe_pcm_frames(b"\x00\x01" * 1600)
                self.assertEqual(transcript, "Turn off the kitchen light")
                self.assertIn(b'"type": "transcribe"', bytes(stt_writer.sent))
                self.assertIn(b'"type": "audio-stop"', bytes(stt_writer.sent))

            # Mock Piper returning audio-start + audio-chunk + audio-stop
            tts_reader = FakeAsyncReader(
                encode_wyoming_event("audio-start", {"rate": 22050, "width": 2, "channels": 1})
                + encode_wyoming_event("audio-chunk", payload=b"\x10\x20\x30\x40")
                + encode_wyoming_event("audio-stop")
            )
            tts_writer = FakeAsyncWriter()

            async def open_tts(host, port):
                return (tts_reader, tts_writer)

            with mock.patch("asyncio.open_connection", side_effect=open_tts):
                pcm, rate, width, channels = await agi_agent.synthesize_pcm("Hello")
                self.assertEqual(pcm, b"\x10\x20\x30\x40")
                self.assertEqual((rate, width, channels), (22050, 2, 1))
                self.assertIn(b'"type": "synthesize"', bytes(tts_writer.sent))

        run_sync_coro(run_stt_and_tts())

    def test_query_backend_forwards_api_key_and_handles_errors(self):
        fake_resp = mock.MagicMock()
        fake_resp.__enter__.return_value.read.return_value = json.dumps({"speech": "Light turned off."}).encode("utf-8")

        with mock.patch("urllib.request.urlopen", return_value=fake_resp) as mock_open:
            reply = agi_agent.query_backend("turn off light", caller_id="1001", caller_name="Primary", api_key="k123")
            self.assertEqual(reply, "Light turned off.")
            req_obj = mock_open.call_args[0][0]
            self.assertEqual(req_obj.headers.get("X-api-key"), "k123")

        with mock.patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            fallback = agi_agent.query_backend("hello")
            self.assertIn("unable to reach", fallback.lower())


class TestRepositoryConfigAndSecurity(unittest.TestCase):
    def test_json_configs_are_valid(self):
        json_files = [
            "config/allowed_entities.json",
            "config/contacts.json.example",
            "backend/package.json",
            "backend/tsconfig.json",
            "backend/tsconfig.test.json",
        ]
        for rel in json_files:
            with open(REPO_ROOT / rel, encoding="utf-8") as f:
                data = json.load(f)
            self.assertIsNotNone(data)

    def test_docker_compose_uses_pinned_image_tags_and_healthchecks(self):
        compose_text = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        images = re.findall(r"^\s*image:\s*(\S+)", compose_text, flags=re.MULTILINE)
        self.assertGreaterEqual(len(images), 6)
        for img in images:
            self.assertNotIn(":latest", img, f"Unpinned :latest tag found in {img}")
            self.assertIn(":", img, f"Missing explicit tag on image {img}")
        self.assertGreaterEqual(compose_text.count("healthcheck:"), 6)

    def test_frontend_escapes_html_before_innerhtml(self):
        html_text = (REPO_ROOT / "frontend/dist/index.html").read_text(encoding="utf-8")
        self.assertIn("function escapeHtml(", html_text)
        self.assertIn("escapeHtml(rem.title)", html_text)
        self.assertNotIn("onclick=\"deleteReminder('${rem.id}')\"", html_text)
        self.assertIn("function apiFetch(", html_text)
        self.assertIn("'X-API-Key'", html_text)
        self.assertNotIn("QNED806QA", html_text)
        self.assertNotIn("WD Sentinel Jellyfin", html_text)

    def test_no_real_secrets_in_tracked_templates(self):
        env_text = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("your_ha_long_lived_access_token_here", env_text)
        self.assertIn("your_jellyfin_api_key_here", env_text)

        pjsip_text = (REPO_ROOT / "asterisk/pjsip.conf").read_text(encoding="utf-8")
        self.assertIn("CHANGE_ME_STRONG_SIP_SECRET_1001", pjsip_text)
        self.assertIn("CHANGE_ME_STRONG_SIP_SECRET_1002", pjsip_text)
        self.assertIn("CHANGE_ME_STRONG_SIP_SECRET_7000", pjsip_text)

    def test_package_versions_consistent_at_0_1_0(self):
        pkg = json.loads((REPO_ROOT / "backend/package.json").read_text(encoding="utf-8"))
        self.assertEqual(pkg["version"], "0.1.0")
        engine_ts = (REPO_ROOT / "backend/src/engine.ts").read_text(encoding="utf-8")
        self.assertIn("version: '0.1.0'", engine_ts)


if __name__ == "__main__":
    unittest.main()
