#!/usr/bin/env python3
"""
NEPTUNE-AI Vision Microservice
MediaPipe Hands finger-count passcode recognition on the intercom camera.
Default passcode: [5, 5, 4, 2, 3, 5] -> unlocks Door 1 via Neptune backend.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request

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
config = dict(DEFAULT_CONFIG)

runtime_state = {
    "status": "armed",  # armed | disabled | collecting | locked_out | unlocked
    "current_fingers": None,
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
    "frames_processed": 0,
    "fps": 0.0,
    "latest_jpeg": b"",
}


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


def count_raised_fingers(hand_landmarks):
    """
    Orientation- and mirror-invariant finger counter (0..5) using MediaPipe 21 landmarks.
    Fingers 2..5 compare tip-to-wrist vs pip-to-wrist distance.
    Thumb compares thumb-tip-to-pinky-MCP vs thumb-IP-to-pinky-MCP distance.
    """
    lm = hand_landmarks.landmark
    wrist = lm[0]
    palm_scale = max(dist2d(wrist, lm[9]), 1e-4)

    raised = 0
    # Thumb: tip(4) vs ip(3) distance to pinky_mcp(17), normalized against palm size
    if dist2d(lm[4], lm[17]) > dist2d(lm[3], lm[17]) + 0.12 * palm_scale:
        raised += 1

    # Index(8/6), Middle(12/10), Ring(16/14), Pinky(20/18)
    for tip_idx, pip_idx in [(8, 6), (12, 10), (16, 14), (20, 18)]:
        if dist2d(lm[tip_idx], wrist) > dist2d(lm[pip_idx], wrist) * 1.12:
            raised += 1

    return raised


def fetch_ha_snapshot(camera_entity):
    if not HA_URL or not HA_TOKEN or not camera_entity:
        raise RuntimeError("Missing HOMEASSISTANT_URL, HOMEASSISTANT_TOKEN, or camera_entity")
    url = f"{HA_URL}/api/camera_proxy/{urllib.parse.quote(camera_entity)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {HA_TOKEN}"})
    with urllib.request.urlopen(req, timeout=3.0) as resp:
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
    cv2.rectangle(overlay, (0, 0), (w, 54), (10, 16, 28), -1)
    cv2.addWeighted(overlay, 0.72, out, 0.28, 0, out)

    status = snapshot_info["status"].upper()
    fingers = snapshot_info["fingers"]
    entered = snapshot_info["entered"]
    total = snapshot_info["passcode_len"]
    prog = snapshot_info["hold_progress"]

    f_txt = f"Fingers: {fingers}" if fingers is not None else "No Hand"
    dots = " ".join(["*" if i < len(entered) else "-" for i in range(total)])
    banner_color = (16, 185, 129) if status == "UNLOCKED" else ((239, 68, 68) if status == "LOCKED_OUT" else (0, 210, 255))

    cv2.putText(out, f"{status} | {f_txt}", (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.58, banner_color, 2, cv2.LINE_AA)
    cv2.putText(out, f"Code: [{dots}] ({len(entered)}/{total})", (10, 44), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (235, 240, 248), 1, cv2.LINE_AA)

    if prog > 0:
        bar_w = int((w - 20) * min(1.0, prog))
        cv2.rectangle(out, (10, 50), (10 + bar_w, 54), (16, 185, 129), -1)

    ok, enc = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
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

    rtsp_cap = None
    rtsp_active_url = ""

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

        enabled = cfg["enabled"]
        passcode = cfg["passcode"]
        passcode_len = len(passcode)

        if not enabled:
            with state_lock:
                runtime_state["status"] = "disabled"
                runtime_state["current_fingers"] = None
                runtime_state["hand_detected"] = False
                runtime_state["entered"] = []
                runtime_state["hold_progress"] = 0.0
                runtime_state["needs_reset"] = False
            time.sleep(0.75)
            continue

        frame = None
        cam_err = ""
        rtsp_url = cfg.get("rtsp_url") or ""

        if rtsp_url:
            if rtsp_cap is None or rtsp_active_url != rtsp_url:
                if rtsp_cap is not None:
                    rtsp_cap.release()
                rtsp_cap = cv2.VideoCapture(rtsp_url)
                rtsp_active_url = rtsp_url
            ok, frm = rtsp_cap.read()
            if ok and frm is not None:
                frame = frm
            else:
                cam_err = "RTSP stream read failed"
                rtsp_cap.release()
                rtsp_cap = None
        else:
            if rtsp_cap is not None:
                rtsp_cap.release()
                rtsp_cap = None
                rtsp_active_url = ""
            try:
                frame = fetch_ha_snapshot(cfg["camera_entity"])
            except Exception as exc:
                cam_err = str(exc)

        if frame is None:
            with state_lock:
                runtime_state["camera_ok"] = False
                runtime_state["last_error"] = cam_err
            time.sleep(1.5)
            continue

        now = time.time()
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = hands.process(rgb)
        hand_list = results.multi_hand_landmarks or []
        fingers = count_raised_fingers(hand_list[0]) if hand_list else None

        with state_lock:
            if runtime_state["lockout_until"] > now:
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
                entered_snap = list(runtime_state["entered"])
                status_snap = "unlocked"
            else:
                # Clear sequence if timed out
                if runtime_state["entered"] and (now - last_activity > cfg["sequence_timeout"]):
                    runtime_state["entered"] = []
                    runtime_state["needs_reset"] = False
                    runtime_state["last_digit_committed"] = None
                    candidate_digit = None
                    reset_since = None

                # Handle fist (0) or dropped hand reset detection
                is_reset_pose = (fingers is None or fingers == 0)
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

                hold_prog = 0.0
                if not runtime_state["needs_reset"] and fingers is not None and 1 <= fingers <= 5:
                    # Only block immediate repeat if next digit equals last digit OR require_reset_between_all is True
                    last_dig = runtime_state["last_digit_committed"]
                    next_idx = len(runtime_state["entered"])
                    must_pause = cfg["require_reset_between_all"] or (
                        last_dig is not None and fingers == last_dig and next_idx < passcode_len
                    )
                    if must_pause:
                        # Same digit held continuously right after commit; wait for brief fist/drop
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
                            # Check if upcoming digit in passcode equals this digit -> require reset
                            nxt_i = len(runtime_state["entered"])
                            if cfg["require_reset_between_all"] or (
                                nxt_i < passcode_len and passcode[nxt_i] == fingers
                            ):
                                runtime_state["needs_reset"] = True
                                reset_since = None

                            # Evaluate completed passcode sequence
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

        jpeg = annotate_frame(
            frame,
            hand_list,
            drawer,
            styles,
            {
                "status": status_snap,
                "fingers": fingers,
                "entered": entered_snap,
                "passcode_len": passcode_len,
                "hold_progress": hold_prog if status_snap not in ("unlocked", "locked_out") else 0.0,
            },
        )
        fps_counter += 1
        elapsed_fps = time.time() - fps_window_start
        with state_lock:
            if jpeg:
                runtime_state["latest_jpeg"] = jpeg
            if elapsed_fps >= 2.0:
                runtime_state["fps"] = round(fps_counter / elapsed_fps, 1)
                fps_counter = 0
                fps_window_start = time.time()

        # Adaptive rate: fast (~8-10 FPS) when a hand is visible, gentle (~3 FPS) when idle
        target_interval = 0.1 if (fingers is not None or entered_snap) else 0.35
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
                    "frames_processed": runtime_state["frames_processed"],
                    "fps": runtime_state["fps"],
                }
            self._send_json(200, payload)
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
