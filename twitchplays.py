#!/usr/bin/env python3
"""
Twitch Plays - lad Twitch-chatten styre et spil via tastatur/mus.

Ingen pip-pakker, ingen API-noegler, ingen login. Kun Python 3.8+ paa Windows.
Konfiguration ligger i config.json (eller en fil du giver som argument).
"""

import ctypes
import json
import os
import random
import socket
import ssl
import sys
import threading
import time
from collections import Counter, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# =====================================================================
#  Windows input via SendInput (scancodes - virker i DirectX-spil)
# =====================================================================

PUL = ctypes.POINTER(ctypes.c_ulong)
_user32 = ctypes.windll.user32


class _KeyBdInput(ctypes.Structure):
    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                ("dwExtraInfo", PUL)]


class _MouseInput(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", PUL)]


class _HardwareInput(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_short),
                ("wParamH", ctypes.c_ushort)]


class _InputI(ctypes.Union):
    _fields_ = [("ki", _KeyBdInput), ("mi", _MouseInput), ("hi", _HardwareInput)]


class _Input(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("ii", _InputI)]


KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

SCANCODES = {
    "esc": 0x01, "1": 0x02, "2": 0x03, "3": 0x04, "4": 0x05, "5": 0x06,
    "6": 0x07, "7": 0x08, "8": 0x09, "9": 0x0A, "0": 0x0B, "-": 0x0C,
    "=": 0x0D, "backspace": 0x0E, "tab": 0x0F,
    "q": 0x10, "w": 0x11, "e": 0x12, "r": 0x13, "t": 0x14, "y": 0x15,
    "u": 0x16, "i": 0x17, "o": 0x18, "p": 0x19, "[": 0x1A, "]": 0x1B,
    "enter": 0x1C, "ctrl": 0x1D, "lctrl": 0x1D,
    "a": 0x1E, "s": 0x1F, "d": 0x20, "f": 0x21, "g": 0x22, "h": 0x23,
    "j": 0x24, "k": 0x25, "l": 0x26, ";": 0x27, "'": 0x28, "`": 0x29,
    "shift": 0x2A, "lshift": 0x2A, "\\": 0x2B,
    "z": 0x2C, "x": 0x2D, "c": 0x2E, "v": 0x2F, "b": 0x30, "n": 0x31,
    "m": 0x32, ",": 0x33, ".": 0x34, "/": 0x35, "rshift": 0x36,
    "alt": 0x38, "lalt": 0x38, "space": 0x39, "capslock": 0x3A,
    "f1": 0x3B, "f2": 0x3C, "f3": 0x3D, "f4": 0x3E, "f5": 0x3F, "f6": 0x40,
    "f7": 0x41, "f8": 0x42, "f9": 0x43, "f10": 0x44, "f11": 0x57, "f12": 0x58,
    "num7": 0x47, "num8": 0x48, "num9": 0x49, "num4": 0x4B, "num5": 0x4C,
    "num6": 0x4D, "num1": 0x4F, "num2": 0x50, "num3": 0x51, "num0": 0x52,
    "up": 0x48, "left": 0x4B, "right": 0x4D, "down": 0x50,
    "home": 0x47, "end": 0x4F, "pageup": 0x49, "pagedown": 0x51,
    "insert": 0x52, "delete": 0x53,
    "rctrl": 0x1D, "ralt": 0x38,
}

EXTENDED = {"up", "down", "left", "right", "home", "end", "pageup",
            "pagedown", "insert", "delete", "rctrl", "ralt"}

MOUSE_FLAGS = {
    "left": (0x0002, 0x0004),
    "right": (0x0008, 0x0010),
    "middle": (0x0020, 0x0040),
}

_held = set()
_held_lock = threading.Lock()


def _send(inp):
    _user32.SendInput(1, ctypes.pointer(inp), ctypes.sizeof(inp))


def key_down(name):
    sc = SCANCODES.get(name)
    if sc is None:
        return
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_EXTENDEDKEY if name in EXTENDED else 0)
    extra = ctypes.c_ulong(0)
    ii = _InputI()
    ii.ki = _KeyBdInput(0, sc, flags, 0, ctypes.pointer(extra))
    _send(_Input(1, ii))
    with _held_lock:
        _held.add(name)


def key_up(name):
    sc = SCANCODES.get(name)
    if sc is None:
        return
    flags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP
    if name in EXTENDED:
        flags |= KEYEVENTF_EXTENDEDKEY
    extra = ctypes.c_ulong(0)
    ii = _InputI()
    ii.ki = _KeyBdInput(0, sc, flags, 0, ctypes.pointer(extra))
    _send(_Input(1, ii))
    with _held_lock:
        _held.discard(name)


def mouse_click(button, duration):
    down, up = MOUSE_FLAGS.get(button, (None, None))
    if down is None:
        return
    extra = ctypes.c_ulong(0)
    ii = _InputI()
    ii.mi = _MouseInput(0, 0, 0, down, 0, ctypes.pointer(extra))
    _send(_Input(0, ii))
    time.sleep(duration)
    ii = _InputI()
    ii.mi = _MouseInput(0, 0, 0, up, 0, ctypes.pointer(extra))
    _send(_Input(0, ii))


def mouse_move(dx, dy):
    extra = ctypes.c_ulong(0)
    ii = _InputI()
    ii.mi = _MouseInput(int(dx), int(dy), 0, 0x0001, 0, ctypes.pointer(extra))
    _send(_Input(0, ii))


def release_all():
    with _held_lock:
        stuck = list(_held)
    for name in stuck:
        key_up(name)


def foreground_title():
    hwnd = _user32.GetForegroundWindow()
    length = _user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    _user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


# =====================================================================
#  Delt tilstand (bruges af overlay + konsol)
# =====================================================================

class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.mode = "anarchy"
        self.paused = False
        self.connected = False
        self.votes = Counter()
        self.round_ends = 0.0
        self.round_len = 0.0
        self.last_winner = ""
        self.feed = deque(maxlen=12)
        self.total = 0
        self.commands = []
        self.hold_example = ""
        self.vote_seconds = 10.0

    def set_commands(self, cfg):
        """Gemmer kommandolisten som seerne skal kunne laese paa overlayet."""
        listed = []
        example = ""
        for name, spec in (cfg.get("commands") or {}).items():
            listed.append({
                "name": name,
                "aliases": [str(a) for a in spec.get("aliases", [])],
                "info": str(spec.get("info", "")).strip(),
            })
            if not example and spec.get("max_hold"):
                example = "{} 2".format(name)
        with self.lock:
            self.commands = listed
            self.hold_example = example
            self.mode = cfg.get("mode", "anarchy")
            self.vote_seconds = float(cfg.get("vote_seconds", 10) or 10)

    def snapshot(self):
        with self.lock:
            votes = self.votes.most_common(6)
            return {
                "mode": self.mode,
                "paused": self.paused,
                "connected": self.connected,
                "votes": [{"cmd": c, "n": n} for c, n in votes],
                "total_votes": sum(self.votes.values()),
                "remaining": max(0.0, round(self.round_ends - time.time(), 1)),
                "round_len": self.round_len,
                "last_winner": self.last_winner,
                "feed": list(self.feed),
                "total": self.total,
                "commands": self.commands,
                "hold_example": self.hold_example,
                "vote_seconds": self.vote_seconds,
            }

    def log(self, user, cmd):
        with self.lock:
            self.feed.appendleft({"user": user, "cmd": cmd})
            self.total += 1


STATE = State()


# =====================================================================
#  Kommandoer
# =====================================================================

class Action:
    """En handling som chatten kan udloese."""

    def __init__(self, name, spec):
        self.name = name
        self.keys = spec.get("keys") or ([spec["key"]] if spec.get("key") else [])
        self.keys = [str(k).lower() for k in self.keys]
        self.mouse = spec.get("mouse")
        self.move = spec.get("move")
        self.duration = float(spec.get("duration", 0.15))
        self.max_hold = float(spec.get("max_hold", 0))
        self.aliases = [str(a).lower() for a in spec.get("aliases", [])]
        unknown = [k for k in self.keys if k not in SCANCODES]
        if unknown:
            print(f"  ! Kommandoen '{name}' bruger ukendt tast: {', '.join(unknown)}")

    def run(self, seconds=None):
        dur = self.duration if seconds is None else seconds
        if self.max_hold:
            dur = min(dur, self.max_hold)
        dur = max(0.0, min(dur, 30.0))
        if self.move:
            steps = max(1, int(dur / 0.016)) if dur > 0.05 else 1
            dx = self.move[0] / steps
            dy = self.move[1] / steps
            for _ in range(steps):
                mouse_move(dx, dy)
                time.sleep(0.016)
            return
        if self.mouse:
            mouse_click(self.mouse, dur)
            return
        for k in self.keys:
            key_down(k)
        time.sleep(dur)
        for k in reversed(self.keys):
            key_up(k)


class Commands:
    def __init__(self, cfg):
        self.actions = {}
        for name, spec in cfg.get("commands", {}).items():
            act = Action(name, spec)
            self.actions[name.lower()] = act
            for alias in act.aliases:
                self.actions[alias] = act

    def parse(self, message):
        """Returnerer (Action, sekunder) eller (None, None)."""
        text = message.strip().lower()
        if not text:
            return None, None
        parts = text.split()
        act = self.actions.get(parts[0])
        if act is None:
            act = self.actions.get(text)
            if act is None:
                return None, None
            return act, None
        if len(parts) >= 2 and act.max_hold:
            try:
                return act, float(parts[1].replace(",", "."))
            except ValueError:
                pass
        return act, None


# =====================================================================
#  Twitch-chat (anonym IRC - ingen token noedvendig)
# =====================================================================

class TwitchChat(threading.Thread):
    def __init__(self, channel, on_message):
        super().__init__(daemon=True)
        self.channel = channel.lower().lstrip("#")
        self.on_message = on_message
        self.sock = None
        self.running = True

    def connect(self):
        raw = socket.create_connection(("irc.chat.twitch.tv", 6697), timeout=10)
        ctx = ssl.create_default_context()
        self.sock = ctx.wrap_socket(raw, server_hostname="irc.chat.twitch.tv")
        nick = f"justinfan{random.randint(10000, 99999)}"
        self.sock.sendall(f"PASS SCHMOOPIIE\r\nNICK {nick}\r\n".encode())
        self.sock.sendall(f"JOIN #{self.channel}\r\n".encode())
        self.sock.settimeout(330)

    def run(self):
        buf = ""
        while self.running:
            try:
                if self.sock is None:
                    self.connect()
                    with STATE.lock:
                        STATE.connected = True
                    print(f"  Forbundet til #{self.channel}")
                data = self.sock.recv(4096).decode("utf-8", "ignore")
                if not data:
                    raise ConnectionError("forbindelse lukket")
                buf += data
                while "\r\n" in buf:
                    line, buf = buf.split("\r\n", 1)
                    self.handle(line)
            except Exception as exc:
                with STATE.lock:
                    STATE.connected = False
                if not self.running:
                    return
                print(f"  ! Chat-forbindelse tabt ({exc}) - proever igen om 5 sek.")
                try:
                    self.sock.close()
                except Exception:
                    pass
                self.sock = None
                buf = ""
                time.sleep(5)

    def handle(self, line):
        if line.startswith("PING"):
            self.sock.sendall(b"PONG :tmi.twitch.tv\r\n")
            return
        if "PRIVMSG" not in line:
            return
        try:
            prefix, rest = line.split("PRIVMSG", 1)
            user = prefix.split("!", 1)[0].lstrip(":")
            message = rest.split(":", 1)[1]
        except (IndexError, ValueError):
            return
        self.on_message(user, message)

    def stop(self):
        self.running = False
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


# =====================================================================
#  Udfoerelse: anarki eller demokrati
# =====================================================================

class Engine:
    def __init__(self, cfg, commands):
        self.cfg = cfg
        self.commands = commands
        self.mode = cfg.get("mode", "anarchy").lower()
        self.rate = float(cfg.get("message_rate", 0.4))
        self.max_queue = int(cfg.get("max_queue", 20))
        self.cooldown = float(cfg.get("user_cooldown", 0))
        self.vote_seconds = float(cfg.get("vote_seconds", 10))
        self.target_window = (cfg.get("target_window") or "").lower()
        self.max_workers = int(cfg.get("max_workers", 40))
        self.queue = deque()
        self.qlock = threading.Lock()
        self.last_seen = {}
        self.workers = threading.Semaphore(self.max_workers)
        self.running = True
        STATE.set_commands(cfg)
        STATE.mode = self.mode

    # ---- indgang fra chatten ------------------------------------
    def on_message(self, user, message):
        if STATE.paused:
            return
        act, secs = self.commands.parse(message)
        if act is None:
            return
        if self.cooldown:
            now = time.time()
            if now - self.last_seen.get(user, 0) < self.cooldown:
                return
            self.last_seen[user] = now
        if self.mode == "democracy":
            with STATE.lock:
                STATE.votes[act.name] += 1
            STATE.log(user, act.name)
        else:
            with self.qlock:
                if len(self.queue) >= self.max_queue:
                    return
                self.queue.append((user, act, secs))

    # ---- baggrundsloekker ---------------------------------------
    def window_ok(self):
        if not self.target_window:
            return True
        return self.target_window in foreground_title().lower()

    def fire(self, act, secs):
        if not self.window_ok():
            return
        if not self.workers.acquire(blocking=False):
            return

        def job():
            try:
                act.run(secs)
            finally:
                self.workers.release()

        threading.Thread(target=job, daemon=True).start()

    def run_anarchy(self):
        while self.running:
            time.sleep(self.rate)
            if STATE.paused:
                continue
            with self.qlock:
                if not self.queue:
                    continue
                user, act, secs = self.queue.popleft()
            label = act.name if not secs else "{} {:g}s".format(act.name, secs)
            STATE.log(user, label)
            print("  {}: {}".format(user, label))
            self.fire(act, secs)

    def run_democracy(self):
        while self.running:
            with STATE.lock:
                STATE.votes.clear()
                STATE.round_ends = time.time() + self.vote_seconds
                STATE.round_len = self.vote_seconds
            time.sleep(self.vote_seconds)
            if STATE.paused:
                continue
            winner, top = None, 0
            with STATE.lock:
                if not STATE.votes:
                    STATE.last_winner = ""
                else:
                    top = max(STATE.votes.values())
                    winner = random.choice([c for c, n in STATE.votes.items() if n == top])
                    STATE.last_winner = "{} ({})".format(winner, top)
            if winner is None:
                continue
            act = self.commands.actions.get(winner)
            if act:
                print("  AFSTEMNING -> {} ({} stemmer)".format(winner, top))
                self.fire(act, None)

    def start(self):
        target = self.run_democracy if self.mode == "democracy" else self.run_anarchy
        threading.Thread(target=target, daemon=True).start()

    def stop(self):
        self.running = False


# =====================================================================
#  Overlay til OBS (browserkilde paa http://localhost:PORT)
# =====================================================================

class OverlayHandler(BaseHTTPRequestHandler):
    html_path = ""

    def do_GET(self):
        if self.path.startswith("/state"):
            body = json.dumps(STATE.snapshot()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            with open(self.html_path, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start_overlay(port, html_path):
    OverlayHandler.html_path = html_path
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), OverlayHandler)
    except OSError as exc:
        print("  ! Kunne ikke starte overlay paa port {}: {}".format(port, exc))
        return None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# =====================================================================
#  Pause-genvej (F8) - noedbremse hvis noget gaar galt
# =====================================================================

def pause_watcher():
    VK_F8 = 0x77
    while True:
        if _user32.GetAsyncKeyState(VK_F8) & 0x0001:
            STATE.paused = not STATE.paused
            if STATE.paused:
                release_all()
                print("\n  === PAUSE (tryk F8 igen for at fortsaette) ===\n")
            else:
                print("\n  === KOERER IGEN ===\n")
        time.sleep(0.08)


# =====================================================================
#  Opstart
# =====================================================================

BANNER = """
  =========================================================
     TWITCH PLAYS  -  chatten styrer spillet
  =========================================================
"""


def load_config(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    cfg_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "config.json")
    if not os.path.isfile(cfg_path):
        print("Fandt ikke konfigurationsfilen: {}".format(cfg_path))
        input("Tryk Enter for at lukke...")
        return 1

    cfg = load_config(cfg_path)
    channel = str(cfg.get("channel", "")).strip()
    if not channel or channel == "DIN_KANAL":
        print("Du skal skrive dit Twitch-kanalnavn i feltet 'channel' i config.json")
        input("Tryk Enter for at lukke...")
        return 1

    print(BANNER)
    print("  Profil:   {}".format(os.path.basename(cfg_path)))
    print("  Kanal:    twitch.tv/{}".format(channel))
    print("  Tilstand: {}".format(cfg.get("mode", "anarchy")))

    commands = Commands(cfg)
    names = sorted({a.name for a in commands.actions.values()})
    print("  Kommandoer ({}): {}".format(len(names), ", ".join(names)))

    if cfg.get("target_window"):
        print("  Sender kun input naar vinduet hedder: {}".format(cfg["target_window"]))
    print("  F8 = pause/fortsaet     Ctrl+C = luk\n")

    port = int(cfg.get("overlay_port", 8777))
    if port and start_overlay(port, os.path.join(here, "overlay.html")):
        print("  OBS-overlay:  http://localhost:{}\n".format(port))

    engine = Engine(cfg, commands)
    engine.start()
    threading.Thread(target=pause_watcher, daemon=True).start()

    chat = TwitchChat(channel, engine.on_message)
    chat.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n  Lukker ned...")
    finally:
        engine.stop()
        chat.stop()
        release_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
