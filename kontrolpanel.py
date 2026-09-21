#!/usr/bin/env python3
"""
Kontrolpanel til Twitch Plays.

Starter en lille lokal webserver og aabner den som et app-vindue,
saa alt kan styres med musen uden at redigere tekstfiler.
"""

import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import twitchplays as tp

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
PROFILE_DIR = os.path.join(HERE, "profiler")
UI_PORT = 8776


# =====================================================================
#  Liste over aabne vinduer (til "send kun input til dette spil")
# =====================================================================

def list_windows():
    titles = []
    user32 = ctypes.windll.user32
    proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if not length:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value.strip()
        if title and title not in titles:
            titles.append(title)
        return True

    user32.EnumWindows(proc_type(callback), 0)
    skip = ("Twitch Plays", "Kontrolpanel", "Program Manager", "Windows Input Experience",
            "Indstillinger", "Settings")
    return [t for t in titles if not any(s.lower() in t.lower() for s in skip)]


# =====================================================================
#  Styring af motoren
# =====================================================================

class Runner:
    def __init__(self):
        self.lock = threading.Lock()
        self.engine = None
        self.chat = None
        self.overlay = None
        self.overlay_port = None
        self.cfg = self.load()
        self.profile_name = "config.json"
        self.channel_live = None
        self.error = ""
        tp.STATE.set_commands(self.cfg)

    # ---- konfiguration ------------------------------------------
    def load(self, path=CONFIG_PATH):
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def save(self, cfg, path=CONFIG_PATH, order=None):
        ordered = {"_om_denne_fil": cfg.get(
            "_om_denne_fil",
            "Styres nemmest via kontrolpanelet - dobbeltklik paa START.bat")}
        for key in ("channel", "mode", "vote_seconds", "message_rate", "max_queue",
                    "user_cooldown", "max_workers", "target_window", "overlay_port",
                    "commands"):
            if key in cfg:
                ordered[key] = cfg[key]
        # JavaScript sorterer automatisk tal-agtige noegler forrest, saa
        # raekkefoelgen fra brugerfladen sendes med separat og genskabes her.
        if order and isinstance(ordered.get("commands"), dict):
            cmds = ordered["commands"]
            ordered["commands"] = {n: cmds[n] for n in order if n in cmds}
            for name, spec in cmds.items():
                ordered["commands"].setdefault(name, spec)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(ordered, fh, indent=2, ensure_ascii=False)
        self.cfg = ordered
        tp.STATE.set_commands(ordered)
        return ordered

    # ---- start / stop -------------------------------------------
    def running(self):
        return self.chat is not None and self.chat.running

    def _dispatch(self, user, message):
        """Sendes til den motor der koerer lige nu, saa indstillinger kan
        aendres uden at chatforbindelsen skal brydes."""
        engine = self.engine
        if engine is not None:
            engine.on_message(user, message)

    def _build_engine(self):
        """Bygger en ny motor ud fra self.cfg. Returnerer fejltekst eller ''."""
        try:
            commands = tp.Commands(self.cfg)
        except Exception as exc:
            return "Fejl i kommandoerne: {}".format(exc)
        if not commands.actions:
            return "Der er ingen kommandoer at styre med."
        old = self.engine
        engine = tp.Engine(self.cfg, commands)
        engine.start()
        self.engine = engine
        if old is not None:
            old.stop()
        return ""

    def start(self):
        with self.lock:
            self._stop_locked()
            self.error = ""
            channel = str(self.cfg.get("channel", "")).strip().lstrip("#")
            if not channel or channel == "DIN_KANAL":
                self.error = "Skriv dit Twitch-kanalnavn foerst."
                return False
            self.error = self._build_engine()
            if self.error:
                return False
            tp.STATE.total = 0
            tp.STATE.feed.clear()
            tp.STATE.paused = False
            self.chat = tp.TwitchChat(channel, self._dispatch)
            self.chat.start()
            self.channel_live = channel
            self.ensure_overlay()
            return True

    def apply_live(self):
        """Tager nye indstillinger i brug mens programmet koerer.
        Chatforbindelsen genbruges, medmindre kanalen er skiftet."""
        with self.lock:
            if not self.running():
                return
            channel = str(self.cfg.get("channel", "")).strip().lstrip("#")
            if channel and channel != getattr(self, "channel_live", None):
                self._stop_locked()
            else:
                self.error = self._build_engine()
                return
        self.start()

    def _stop_locked(self):
        if self.chat:
            self.chat.stop()
            self.chat = None
        if self.engine:
            self.engine.stop()
            self.engine = None
        tp.release_all()
        with tp.STATE.lock:
            tp.STATE.connected = False
            tp.STATE.votes.clear()

    def stop(self):
        with self.lock:
            self._stop_locked()

    def ensure_overlay(self):
        port = int(self.cfg.get("overlay_port", 8777) or 0)
        if port == self.overlay_port and self.overlay:
            return
        if self.overlay:
            self.overlay.shutdown()
            self.overlay = None
            self.overlay_port = None
        if port:
            self.overlay = tp.start_overlay(port, os.path.join(HERE, "overlay.html"))
            self.overlay_port = port if self.overlay else None

    # ---- profiler ------------------------------------------------
    def profiles(self):
        found = ["config.json"]
        if os.path.isdir(PROFILE_DIR):
            for name in sorted(os.listdir(PROFILE_DIR)):
                if name.lower().endswith(".json"):
                    found.append("profiler/" + name)
        return found

    def profile_path(self, name):
        name = name.replace("\\", "/")
        if name == "config.json":
            return CONFIG_PATH
        if not name.startswith("profiler/") or "/" in name[9:] or ".." in name:
            raise ValueError("ugyldigt profilnavn")
        return os.path.join(PROFILE_DIR, name[9:])


RUNNER = Runner()


# =====================================================================
#  Webserver til brugerfladen
# =====================================================================

class UIHandler(BaseHTTPRequestHandler):
    server_version = "TwitchPlaysUI"

    # ---- hjaelpere ----------------------------------------------
    def reply(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_file(self, path, mime):
        try:
            with open(path, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def snapshot(self):
        state = tp.STATE.snapshot()
        state["running"] = RUNNER.running()
        state["config"] = RUNNER.cfg
        state["profile"] = RUNNER.profile_name
        state["command_order"] = list((RUNNER.cfg.get("commands") or {}).keys())
        state["profiles"] = RUNNER.profiles()
        state["error"] = RUNNER.error
        state["overlay_port"] = RUNNER.overlay_port
        return state

    # ---- ruter ---------------------------------------------------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            return self.send_file(os.path.join(HERE, "ui.html"), "text/html; charset=utf-8")
        if path == "/api/state":
            return self.reply(self.snapshot())
        if path == "/api/windows":
            return self.reply({"windows": list_windows()})
        if path == "/api/keys":
            return self.reply({"keys": sorted(tp.SCANCODES.keys())})
        self.send_error(404)

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/start":
                RUNNER.start()
                return self.reply(self.snapshot())
            if path == "/api/stop":
                RUNNER.stop()
                return self.reply(self.snapshot())
            if path == "/api/pause":
                tp.STATE.paused = not tp.STATE.paused
                if tp.STATE.paused:
                    tp.release_all()
                return self.reply(self.snapshot())
            if path == "/api/config":
                data = self.read_json()
                RUNNER.save(data.get("config", {}),
                            RUNNER.profile_path(RUNNER.profile_name),
                            order=data.get("order"))
                RUNNER.ensure_overlay()
                RUNNER.apply_live()
                return self.reply(self.snapshot())
            if path == "/api/profile":
                data = self.read_json()
                name = data.get("name", "config.json")
                RUNNER.stop()
                RUNNER.cfg = RUNNER.load(RUNNER.profile_path(name))
                RUNNER.profile_name = name
                RUNNER.error = ""
                tp.STATE.set_commands(RUNNER.cfg)
                RUNNER.ensure_overlay()
                return self.reply(self.snapshot())
            if path == "/api/test":
                data = self.read_json()
                commands = tp.Commands(RUNNER.cfg)
                act = commands.actions.get(str(data.get("name", "")).lower())
                if act:
                    threading.Thread(target=act.run, args=(None,), daemon=True).start()
                return self.reply({"ok": act is not None})
        except Exception as exc:
            return self.reply({"error": str(exc)}, 400)
        self.send_error(404)

    def log_message(self, *args):
        pass


# =====================================================================
#  Aabn som app-vindue
# =====================================================================

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def open_window(url):
    profile = os.path.join(os.environ.get("TEMP", HERE), "twitchplays-ui")
    for exe in BROWSERS:
        if os.path.isfile(exe):
            try:
                subprocess.Popen([
                    exe,
                    "--app=" + url,
                    "--window-size=1180,820",
                    "--user-data-dir=" + profile,
                    "--no-first-run",
                    "--no-default-browser-check",
                ])
                return True
            except OSError:
                continue
    webbrowser.open(url)
    return False


def main():
    try:
        server = ThreadingHTTPServer(("127.0.0.1", UI_PORT), UIHandler)
    except OSError as exc:
        print("Kunne ikke starte kontrolpanelet paa port {}: {}".format(UI_PORT, exc))
        print("Koerer det allerede i et andet vindue?")
        input("Tryk Enter for at lukke...")
        return 1

    threading.Thread(target=server.serve_forever, daemon=True).start()
    RUNNER.ensure_overlay()

    url = "http://localhost:{}/".format(UI_PORT)
    print("\n  Twitch Plays kontrolpanel koerer.")
    print("  Vinduet aabner nu. Luk DETTE vindue for at slukke helt.")
    print("  Hvis vinduet ikke kom frem, aabn selv: " + url + "\n")
    if "--no-window" not in sys.argv:
        open_window(url)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        RUNNER.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
