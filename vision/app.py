#!/usr/bin/env python3
"""
NEPTUNE-AI Vision Microservice
MediaPipe Hands finger-count passcode recognition on the intercom camera.
Supports zero-lag RTSP streaming (Channel 102 substream) + Home Assistant snapshot fallback,
orientation-invariant high-five thumb detection, and live MJPEG streaming for Cockpit.
"""

from collections import Counter, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request

# Prefer reliable TCP transport for Hikvision RTSP streams
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay")

import cv2
import mediapipe as mp
import numpy as np

DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
CONFIG_PATH = os.path.join(DATA_DIR, "vision_config.json")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://neptune-backend:3000").rstrip("/")
HA_URL = os.environ.get("HOMEASSISTANT_URL", "").rstrip("/")
HA_TOKEN = os.environ.get("HOMEASSISTANT_TOKEN", "")
NEPTUNE_API_KEY = os.environ.get("NEPTUNE_API_KEY", "")
VISION_PORT = int(os.environ.get("VISION_PORT", "8090"))

DEFAULT_CONFIG = {
    "enabled": True,
    "passcode": [5, 5, 4, 2, 3, 5],
    "target_door": "door1",
    "camera_entity": os.environ.get("VISION_CAMERA_ENTITY", "camera.front_entry_door"),
    "rtsp_url": os.environ.get("VISION_RTSP_URL", ""),
    "hold_seconds": 0.6,
    "reset_seconds": 0.35,
    "require_reset_between_all": False,
    "sequence_timeout": 12.0,
    "max_attempts": 3,
    "lockout_seconds": 120.0,
    "unlock_cooldown": 6.0,
}

state_lock = threading.Lock()
frame_cond = threading.Condition()
config = dict(DEFAULT_CONFIG)
active_stream_clients = 0

runtime_state = {
    "status": "armed",  # armed | disabled | collecting | locked_out | unlocked
    "current_fingers": None,
    "finger_mask": [False, False, False, False, False],
    "hand_detected": False,
    "entered": [],
    "hold_progress": 0.0,
    "needs_reset": False,
    "last_digit_committed": None,
    "failed_attempts": 0,
    "lockout_until": 0.0,
    "cooldown_until": 0.0,
    "last_unlock": None,
    "last_error": "",
    "camera_ok": False,
    "source_mode": "ha_proxy",
    "frames_processed": 0,
    "fps": 0.0,
    "latest_jpeg": b"",
    "frame_seq": 0,
}


class RTSPGrabber:
    """Continuously drains an RTSP stream in a background thread so inference always gets the freshest frame."""

    def __init__(self):
        self._lock = threading.Lock()
        self._url = ""
        self._latest_frame = None
        self._latest_ts = 0.0
        self._error = ""
        self._stop = False
        self._thread = None

    def configure(self, rtsp_url: str):
        rtsp_url = (rtsp_url or "").strip()
        with self._lock:
            if rtsp_url == self._url and (not rtsp_url or (self._thread and self._thread.is_alive())):
                return
            self._url = rtsp_url
            self._latest_frame = None
            self._latest_ts = 0.0
            self._error = ""
            if rtsp_url and (self._thread is None or not self._thread.is_alive()):
                self._stop = False
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()

    def get_latest(self):
        with self._lock:
            if self._latest_frame is None:
                return None, self._error or "Connecting to RTSP stream..."
            age = time.time() - self._latest_ts
            if age > 4.0:
                return None, "RTSP stream stalled"
            return self._latest_frame.copy(), ""

    def _run(self):
        cap = None
        active_url = ""
        while not self._stop:
            with self._lock:
                url = self._url
            if not url:
                if cap is not None:
                    cap.release()
                    cap = None
                time.sleep(0.5)
                continue

            if cap is None or active_url != url:
                if cap is not None:
                    cap.release()
                cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
                try:
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                except Exception:
                    pass
                active_url = url
                if not cap.isOpened():
                    with self._lock:
                        self._error = "Failed to open RTSP stream"
                    cap.release()
                    cap = None
                    time.sleep(1.5)
                    continue

            ok, frm = cap.read()
            if ok and frm is not None:
                with self._lock:
                    self._latest_frame = frm
                    self._latest_ts = time.time()
                    self._error = ""
            else:
                with self._lock:
                    self._error = "RTSP frame read failed"
                cap.release()
                cap = None
                time.sleep(0.8)


rtsp_grabber = RTSPGrabber()


def sanitize_passcode(raw):
    if isinstance(raw, str):
        tokens = [int(ch) for ch in raw if ch.isdigit()]
    elif isinstance(raw, list):
        tokens = []
        for item in raw:
            try:
                tokens.append(int(item))
            except Exception:
                pass
    else:
        return None
    valid = [d for d in tokens if 1 <= d <= 5]
    if 3 <= len(valid) <= 8:
        return valid
    return None


def load_config():
    global config
    base = dict(DEFAULT_CONFIG)
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                base = merge_config(base, saved)
    except Exception as exc:
        print(f"[Vision] Failed to load config: {exc}")
    # Env VISION_RTSP_URL takes effect if saved rtsp_url is blank
    if not base.get("rtsp_url") and os.environ.get("VISION_RTSP_URL"):
        base["rtsp_url"] = os.environ["VISION_RTSP_URL"].strip()
    config = base


def merge_config(base, patch):
    nxt = dict(base)
    if isinstance(patch.get("enabled"), bool):
        nxt["enabled"] = patch["enabled"]
    if "passcode" in patch:
        pc = sanitize_passcode(patch["passcode"])
        if pc:
            nxt["passcode"] = pc
    if patch.get("target_door") in ("door1", "door2", "all"):
        nxt["target_door"] = patch["target_door"]
    if isinstance(patch.get("camera_entity"), str) and patch["camera_entity"].strip():
        nxt["camera_entity"] = patch["camera_entity"].strip()
    if isinstance(patch.get("rtsp_url"), str):
        nxt["rtsp_url"] = patch["rtsp_url"].strip()
    if isinstance(patch.get("require_reset_between_all"), bool):
        nxt["require_reset_between_all"] = patch["require_reset_between_all"]
    for key, lo, hi in [
        ("hold_seconds", 0.25, 2.5),
        ("reset_seconds", 0.15, 2.0),
        ("sequence_timeout", 4.0, 30.0),
        ("lockout_seconds", 15.0, 600.0),
        ("unlock_cooldown", 2.0, 30.0),
    ]:
        if key in patch:
            try:
                val = float(patch[key])
                if lo <= val <= hi:
                    nxt[key] = round(val, 2)
            except Exception:
                pass
    if "max_attempts" in patch:
        try:
            ma = int(patch["max_attempts"])
            if 1 <= ma <= 10:
                nxt["max_attempts"] = ma
        except Exception:
            pass
    return nxt


def persist_config(cfg):
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, CONFIG_PATH)
    except Exception as exc:
        print(f"[Vision] Failed to persist config: {exc}")


def dist2d(a, b):
    return math.hypot(a.x - b.x, a.y - b.y)


def joint_angle_deg(a, b, c):
    """Returns angle ABC in degrees (0..180)."""
    v1x, v1y = a.x - b.x, a.y - b.y
    v2x, v2y = c.x - b.x, c.y - b.y
    n1 = math.hypot(v1x, v1y)
    n2 = math.hypot(v2x, v2y)
    if n1 < 1e-6 or n2 < 1e-6:
        return 0.0
    cos_ang = max(-1.0, min(1.0, (v1x * v2x + v1y * v2y) / (n1 * n2)))
    return math.degrees(math.acos(cos_ang))


def detect_raised_fingers(hand_landmarks):
    """
    Orientation- and mirror-invariant finger counter (0..5) + [T, I, M, R, P] mask.
    Specifically tuned so upright/relaxed high-five thumbs count reliably as 5,
    while folded thumbs count cleanly as 4.
    """
    lm = hand_landmarks.landmark
    wrist = lm[0]
    palm_scale = max(dist2d(wrist, lm[9]), 1e-4)

    # Thumb: check joint straightness + distance from palm center/index base/pinky base
    thumb_angle = joint_angle_deg(lm[2], lm[3], lm[4])
    thumb_abducted = dist2d(lm[4], lm[17]) > dist2d(lm[3], lm[17]) * 1.03
    thumb_away_from_palm = (
        dist2d(lm[4], lm[9]) > dist2d(lm[2], lm[9]) * 0.95
        and dist2d(lm[4], lm[5]) > 0.36 * palm_scale
    )
    thumb_strong_open = dist2d(lm[4], lm[17]) > dist2d(lm[3], lm[17]) * 1.10
    thumb_up = thumb_strong_open or (thumb_angle >= 140.0 and (thumb_abducted or thumb_away_from_palm))

    mask = [thumb_up]
    # Index(5,6,8), Middle(9,10,12), Ring(13,14,16), Pinky(17,18,20)
    for mcp_idx, pip_idx, tip_idx in [(5, 6, 8), (9, 10, 12), (13, 14, 16), (17, 18, 20)]:
        tip_further = dist2d(lm[tip_idx], wrist) > dist2d(lm[pip_idx], wrist) * 1.06
        finger_straight = joint_angle_deg(lm[mcp_idx], lm[pip_idx], lm[tip_idx]) >= 125.0
        mask.append(bool(tip_further and finger_straight))

    return sum(1 for m in mask if m), mask


def fetch_ha_snapshot(camera_entity):
    if not HA_URL or not HA_TOKEN or not camera_entity:
        raise RuntimeError("Missing HOMEASSISTANT_URL, HOMEASSISTANT_TOKEN, or camera_entity")
    url = f"{HA_URL}/api/camera_proxy/{urllib.parse.quote(camera_entity)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {HA_TOKEN}"})
    with urllib.request.urlopen(req, timeout=2.5) as resp:
        raw = resp.read()
    arr = np.frombuffer(raw, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("Failed to decode JPEG from Home Assistant camera_proxy")
    return frame


def trigger_door_unlock(target_door):
    url = f"{BACKEND_URL}/api/door/unlock"
    payload = json.dumps({"door": target_door}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if NEPTUNE_API_KEY:
        headers["X-API-Key"] = NEPTUNE_API_KEY
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return bool(body.get("success", True)), body.get("speech", "Unlocked")
    except Exception as exc:
        return False, str(exc)


def annotate_frame(frame, hand_landmarks_list, drawer, styles, snapshot_info):
    out = frame.copy()
    h, w = out.shape[:2]

    if hand_landmarks_list:
        for hlm in hand_landmarks_list:
            drawer.draw_landmarks(
                out,
                hlm,
                mp.solutions.hands.HAND_CONNECTIONS,
                styles.get_default_hand_landmarks_style(),
                styles.get_default_hand_connections_style(),
            )

    # Top dark banner overlay
    overlay = out.copy()
    cv2.rectangle(overlay, (0, 0), (w, 56), (10, 16, 28), -1)
    cv2.addWeighted(overlay, 0.72, out, 0.28, 0, out)

    status = snapshot_info["status"].upper()
    fingers = snapshot_info["fingers"]
    finger_mask = snapshot_info.get("finger_mask") or [False, False, False, False, False]
    entered = snapshot_info["entered"]
    total = snapshot_info["passcode_len"]
    prog = snapshot_info["hold_progress"]
    fps_val = snapshot_info.get("fps", 0.0)

    f_txt = f"Fingers: {fingers}" if fingers is not None else "No Hand"
    dots = " ".join(["*" if i < len(entered) else "-" for i in range(total)])
    banner_color = (16, 185, 129) if status == "UNLOCKED" else ((239, 68, 68) if status == "LOCKED_OUT" else (0, 210, 255))

    cv2.putText(out, f"{status} | {f_txt} | {fps_val:.0f} FPS", (10, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.54, banner_color, 2, cv2.LINE_AA)
    cv2.putText(out, f"Code: [{dots}] ({len(entered)}/{total})", (10, 44), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (235, 240, 248), 1, cv2.LINE_AA)

    # Per-finger indicator badges (T I M R P) on top-right
    labels = ["T", "I", "M", "R", "P"]
    base_x = max(250, w - 115)
    for idx, ch in enumerate(labels):
        col = (16, 185, 129) if (fingers is not None and finger_mask[idx]) else (100, 116, 139)
        cv2.putText(out, ch, (base_x + idx * 20, 44), cv2.FONT_HERSHEY_SIMPLEX, 0.52, col, 2, cv2.LINE_AA)

    if prog > 0:
        bar_w = int((w - 20) * min(1.0, prog))
        cv2.rectangle(out, (10, 52), (10 + bar_w, 56), (16, 185, 129), -1)

    ok, enc = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return enc.tobytes() if ok else b""


def vision_loop():
    mp_hands = mp.solutions.hands
    drawer = mp.solutions.drawing_utils
    styles = mp.solutions.drawing_styles

    hands = mp_hands.Hands(
        static_image_mode=False,
        max_num_hands=1,
        model_complexity=0,
        min_detection_confidence=0.6,
        min_tracking_confidence=0.55,
    )

    finger_history = deque(maxlen=3)
    candidate_digit = None
    candidate_since = 0.0
    reset_since = None
    last_activity = 0.0
    fps_counter = 0
    fps_window_start = time.time()

    while True:
        loop_start = time.time()
        with state_lock:
            cfg = dict(config)
            streaming_active = active_stream_clients > 0

        enabled = cfg["enabled"]
        passcode = cfg["passcode"]
        passcode_len = len(passcode)
        rtsp_url = (cfg.get("rtsp_url") or "").strip()
        rtsp_grabber.configure(rtsp_url)

        if not enabled and not streaming_active:
            with state_lock:
                runtime_state["status"] = "disabled"
                runtime_state["current_fingers"] = None
                runtime_state["finger_mask"] = [False, False, False, False, False]
                runtime_state["hand_detected"] = False
                runtime_state["entered"] = []
                runtime_state["hold_progress"] = 0.0
                runtime_state["needs_reset"] = False
            time.sleep(0.75)
            continue

        frame = None
        cam_err = ""
        if rtsp_url:
            frame, cam_err = rtsp_grabber.get_latest()
        else:
            try:
                frame = fetch_ha_snapshot(cfg["camera_entity"])
            except Exception as exc:
                cam_err = str(exc)

        if frame is None:
            with state_lock:
                runtime_state["camera_ok"] = False
                runtime_state["last_error"] = cam_err
                runtime_state["source_mode"] = "rtsp" if rtsp_url else "ha_proxy"
            time.sleep(0.35 if rtsp_url else 1.2)
            continue

        now = time.time()
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = hands.process(rgb)
        hand_list = results.multi_hand_landmarks or []
        if hand_list:
            raw_fingers, finger_mask = detect_raised_fingers(hand_list[0])
            finger_history.append(raw_fingers)
            fingers = Counter(finger_history).most_common(1)[0][0]
        else:
            finger_history.clear()
            fingers = None
            finger_mask = [False, False, False, False, False]

        with state_lock:
            runtime_state["source_mode"] = "rtsp" if rtsp_url else "ha_proxy"
            runtime_state["finger_mask"] = finger_mask
            hold_prog = 0.0
            if not enabled:
                runtime_state["status"] = "disabled"
                runtime_state["current_fingers"] = fingers
                runtime_state["hand_detected"] = fingers is not None
                entered_snap = []
                status_snap = "disabled"
            elif runtime_state["lockout_until"] > now:
                runtime_state["status"] = "locked_out"
                runtime_state["current_fingers"] = fingers
                runtime_state["hand_detected"] = fingers is not None
                runtime_state["hold_progress"] = 0.0
                entered_snap = list(runtime_state["entered"])
                status_snap = "locked_out"
            elif runtime_state["cooldown_until"] > now:
                runtime_state["status"] = "unlocked"
                runtime_state["current_fingers"] = fingers
                runtime_state["hand_detected"] = fingers is not None
                runtime_state["hold_progress"] = 1.0
                hold_prog = 1.0
                entered_snap = list(runtime_state["entered"])
                status_snap = "unlocked"
            else:
                if runtime_state["entered"] and (now - last_activity > cfg["sequence_timeout"]):
                    runtime_state["entered"] = []
                    runtime_state["needs_reset"] = False
                    runtime_state["last_digit_committed"] = None
                    candidate_digit = None
                    reset_since = None

                is_reset_pose = fingers is None or fingers == 0
                if runtime_state["needs_reset"]:
                    if is_reset_pose:
                        if reset_since is None:
                            reset_since = now
                        elif (now - reset_since) >= cfg["reset_seconds"]:
                            runtime_state["needs_reset"] = False
                            reset_since = None
                            candidate_digit = None
                    else:
                        reset_since = None

                if not runtime_state["needs_reset"] and fingers is not None and 1 <= fingers <= 5:
                    last_dig = runtime_state["last_digit_committed"]
                    next_idx = len(runtime_state["entered"])
                    must_pause = cfg["require_reset_between_all"] or (
                        last_dig is not None and fingers == last_dig and next_idx < passcode_len
                    )
                    if must_pause:
                        runtime_state["needs_reset"] = True
                        reset_since = None
                        candidate_digit = None
                    else:
                        if fingers != candidate_digit:
                            candidate_digit = fingers
                            candidate_since = now
                        held = now - candidate_since
                        hold_prog = min(1.0, held / max(0.1, cfg["hold_seconds"]))
                        if held >= cfg["hold_seconds"]:
                            runtime_state["entered"].append(fingers)
                            runtime_state["last_digit_committed"] = fingers
                            last_activity = now
                            candidate_digit = None
                            hold_prog = 0.0
                            nxt_i = len(runtime_state["entered"])
                            if cfg["require_reset_between_all"] or (
                                nxt_i < passcode_len and passcode[nxt_i] == fingers
                            ):
                                runtime_state["needs_reset"] = True
                                reset_since = None

                            if len(runtime_state["entered"]) >= passcode_len:
                                if runtime_state["entered"][:passcode_len] == passcode:
                                    print(f"[Vision] Hand-sign passcode matched! Unlocking {cfg['target_door']}")
                                    ok, msg = trigger_door_unlock(cfg["target_door"])
                                    runtime_state["failed_attempts"] = 0
                                    runtime_state["cooldown_until"] = now + cfg["unlock_cooldown"]
                                    runtime_state["last_unlock"] = {
                                        "timestamp": int(now * 1000),
                                        "door": cfg["target_door"],
                                        "success": ok,
                                        "message": msg,
                                    }
                                    runtime_state["status"] = "unlocked"
                                else:
                                    runtime_state["failed_attempts"] += 1
                                    print(f"[Vision] Wrong hand-sign sequence ({runtime_state['failed_attempts']}/{cfg['max_attempts']})")
                                    runtime_state["entered"] = []
                                    runtime_state["last_digit_committed"] = None
                                    runtime_state["needs_reset"] = False
                                    if runtime_state["failed_attempts"] >= cfg["max_attempts"]:
                                        runtime_state["lockout_until"] = now + cfg["lockout_seconds"]
                                        runtime_state["failed_attempts"] = 0
                                        runtime_state["status"] = "locked_out"
                else:
                    candidate_digit = None

                runtime_state["current_fingers"] = fingers
                runtime_state["hand_detected"] = fingers is not None
                runtime_state["hold_progress"] = round(hold_prog, 2)
                if runtime_state["status"] not in ("unlocked", "locked_out"):
                    runtime_state["status"] = "collecting" if runtime_state["entered"] else "armed"
                entered_snap = list(runtime_state["entered"])
                status_snap = runtime_state["status"]

            runtime_state["camera_ok"] = True
            runtime_state["last_error"] = ""
            runtime_state["frames_processed"] += 1
            current_fps = runtime_state["fps"]

        jpeg = annotate_frame(
            frame,
            hand_list,
            drawer,
            styles,
            {
                "status": status_snap,
                "fingers": fingers,
                "finger_mask": finger_mask,
                "entered": entered_snap,
                "passcode_len": passcode_len,
                "hold_progress": hold_prog,
                "fps": current_fps,
            },
        )
        fps_counter += 1
        elapsed_fps = time.time() - fps_window_start
        with state_lock:
            if elapsed_fps >= 1.5:
                runtime_state["fps"] = round(fps_counter / elapsed_fps, 1)
                fps_counter = 0
                fps_window_start = time.time()

        if jpeg:
            with frame_cond:
                runtime_state["latest_jpeg"] = jpeg
                runtime_state["frame_seq"] += 1
                frame_cond.notify_all()

        # Boost to ~18-22 FPS during active preview or hand entry; ~5 FPS when idle
        target_interval = 0.045 if (streaming_active or fingers is not None or entered_snap) else 0.2
        sleep_time = target_interval - (time.time() - loop_start)
        if sleep_time > 0:
            time.sleep(sleep_time)


class VisionHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global active_stream_clients
        if self.path == "/health":
            self._send_json(200, {"ok": True, "service": "neptune-vision"})
            return

        if self.path == "/status":
            now = time.time()
            with state_lock:
                lockout_rem = max(0, int(round(runtime_state["lockout_until"] - now)))
                payload = {
                    "config": dict(config),
                    "status": runtime_state["status"],
                    "current_fingers": runtime_state["current_fingers"],
                    "finger_mask": runtime_state["finger_mask"],
                    "hand_detected": runtime_state["hand_detected"],
                    "entered_count": len(runtime_state["entered"]),
                    "entered_mask": "*" * len(runtime_state["entered"]) + "-" * max(0, len(config["passcode"]) - len(runtime_state["entered"])),
                    "hold_progress": runtime_state["hold_progress"],
                    "needs_reset": runtime_state["needs_reset"],
                    "failed_attempts": runtime_state["failed_attempts"],
                    "lockout_remaining": lockout_rem,
                    "last_unlock": runtime_state["last_unlock"],
                    "last_error": runtime_state["last_error"],
                    "camera_ok": runtime_state["camera_ok"],
                    "source_mode": runtime_state["source_mode"],
                    "frames_processed": runtime_state["frames_processed"],
                    "fps": runtime_state["fps"],
                }
            self._send_json(200, payload)
            return

        if self.path.startswith("/stream.mjpg"):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.end_headers()

            with state_lock:
                active_stream_clients += 1
            last_seq = -1
            try:
                while True:
                    with frame_cond:
                        if runtime_state["frame_seq"] == last_seq:
                            frame_cond.wait(timeout=1.5)
                        jpeg = runtime_state["latest_jpeg"]
                        seq = runtime_state["frame_seq"]
                    if not jpeg or seq == last_seq:
                        continue
                    last_seq = seq
                    header = (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
                    )
                    self.wfile.write(header + jpeg + b"\r\n")
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                with state_lock:
                    active_stream_clients = max(0, active_stream_clients - 1)
            return

        if self.path.startswith("/snapshot.jpg"):
            with state_lock:
                jpeg = runtime_state["latest_jpeg"]
            if not jpeg:
                self._send_json(404, {"error": "No camera frame captured yet"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(jpeg)))
            self.end_headers()
            self.wfile.write(jpeg)
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}

        if self.path == "/config":
            with state_lock:
                updated = merge_config(config, body if isinstance(body, dict) else {})
                config.clear()
                config.update(updated)
                persist_config(config)
                runtime_state["entered"] = []
                runtime_state["needs_reset"] = False
                runtime_state["last_digit_committed"] = None
            self._send_json(200, {"success": True, "config": updated})
            return

        if self.path == "/reset":
            with state_lock:
                runtime_state["entered"] = []
                runtime_state["needs_reset"] = False
                runtime_state["last_digit_committed"] = None
                runtime_state["failed_attempts"] = 0
                runtime_state["lockout_until"] = 0.0
                runtime_state["cooldown_until"] = 0.0
                runtime_state["status"] = "armed" if config["enabled"] else "disabled"
            self._send_json(200, {"success": True})
            return

        self._send_json(404, {"error": "Not found"})


def main():
    load_config()
    t = threading.Thread(target=vision_loop, daemon=True)
    t.start()
    server = ThreadingHTTPServer(("0.0.0.0", VISION_PORT), VisionHandler)
    print(f"[Vision] Neptune MediaPipe Hand-Sign server listening on 0.0.0.0:{VISION_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
