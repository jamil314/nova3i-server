"""Password gate in front of the IP Webcam stream.

Caddy calls GET /auth (forward_auth) for every /cam/* request. A valid signed
cookie lets the request through to IP Webcam, which then asks for its own
password. Without the cookie the browser is redirected to /cam-login.

Config comes from CAM_GATE_ENV (default /root/.cam-gate.env), written by
set-password.py:
  CAM_GATE_PASSWORD_HASH=scrypt$<salt hex>$<hash hex>
  CAM_GATE_SECRET=<hex>
"""

import asyncio
import hashlib
import hmac
import html
import os
import time
from urllib.parse import parse_qs, quote

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

COOKIE = "cam_gate"
COOKIE_PATH = "/cam"
SESSION_SECONDS = 12 * 3600
# Funnel reaches Caddy over plain TCP, so every client looks like 127.0.0.1.
# The failure limit is therefore global rather than per IP.
MAX_FAILURES = 10
FAILURE_WINDOW = 15 * 60
LOGIN_PATH = "/cam-login"


def load_config(path):
    cfg = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip("'\"")
    return cfg


CONFIG = load_config(os.environ.get("CAM_GATE_ENV", "/root/.cam-gate.env"))
SECRET = bytes.fromhex(CONFIG["CAM_GATE_SECRET"])
PASSWORD_HASH = CONFIG["CAM_GATE_PASSWORD_HASH"]

failures = []
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def hash_password(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


def check_password(password):
    scheme, salt_hex, hash_hex = PASSWORD_HASH.split("$")
    if scheme != "scrypt":
        return False
    return hmac.compare_digest(hash_password(password, bytes.fromhex(salt_hex)).hex(), hash_hex)


def sign(expires):
    mac = hmac.new(SECRET, str(expires).encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{mac}"


def cookie_valid(value):
    if not value or "." not in value:
        return False
    expires, _ = value.split(".", 1)
    if not expires.isdigit() or int(expires) < time.time():
        return False
    return hmac.compare_digest(sign(int(expires)), value)


def safe_next(target):
    # Only ever send people back into the camera area of this site.
    if target and target.startswith("/cam/") and not target.startswith("//"):
        return target
    return "/cam/"


def locked_out():
    cutoff = time.time() - FAILURE_WINDOW
    failures[:] = [t for t in failures if t > cutoff]
    return len(failures) >= MAX_FAILURES


def login_page(next_url, error=""):
    msg = f'<p class="err">{html.escape(error)}</p>' if error else ""
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; padding: 0 16px; }}
  form {{ display: grid; gap: 12px; width: 100%; max-width: 320px; }}
  input, button {{ font: inherit; padding: 10px; }}
  .err {{ color: #c0392b; margin: 0; }}
</style></head>
<body><form method="post" action="{LOGIN_PATH}">
  <h1>Sign in</h1>{msg}
  <input type="hidden" name="next" value="{html.escape(next_url)}">
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Continue</button>
</form></body></html>"""
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


@app.get("/auth")
def auth(request: Request):
    if cookie_valid(request.cookies.get(COOKIE)):
        return Response(status_code=200)
    target = safe_next(request.headers.get("x-forwarded-uri", ""))
    return RedirectResponse(f"{LOGIN_PATH}?next={quote(target)}", status_code=302)


@app.get(LOGIN_PATH)
def login_form(next: str = "/cam/"):
    return login_page(safe_next(next))


@app.post(LOGIN_PATH)
async def login(request: Request):
    form = parse_qs((await request.body()).decode(), max_num_fields=4)
    password = form.get("password", [""])[0]
    next_url = safe_next(form.get("next", [""])[0])

    if locked_out():
        return login_page(next_url, "Too many attempts. Try again later.")
    if not check_password(password):
        failures.append(time.time())
        await asyncio.sleep(1)
        return login_page(next_url, "Wrong password.")

    expires = int(time.time()) + SESSION_SECONDS
    resp = RedirectResponse(next_url, status_code=303)
    resp.set_cookie(COOKIE, sign(expires), max_age=SESSION_SECONDS, path=COOKIE_PATH,
                    secure=True, httponly=True, samesite="strict")
    return resp


@app.post(LOGIN_PATH + "/logout")
def logout():
    resp = RedirectResponse(LOGIN_PATH, status_code=303)
    resp.delete_cookie(COOKIE, path=COOKIE_PATH)
    return resp


# Live view with a front/rear switch, rotate and flash LED buttons. The phone can only run one camera at a
# time (Android 9, no concurrent camera support), so this swaps IP Webcam's
# camera via its /settings/ffc endpoint. All /cam/... calls below go back
# through Caddy and carry the browser's IP Webcam login.
VIEWER_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Camera</title>
<style>
  :root { color-scheme: dark; }
  /* dvh: on mobile, vh includes the area under the browser toolbar, which
     pushed the button bar off screen. */
  body { margin: 0; background: #000; color: #eee; font-family: system-ui, sans-serif;
         display: grid; grid-template-rows: 1fr auto; height: 100vh; height: 100dvh; }
  #view { display: grid; place-items: center; overflow: hidden; min-height: 0; }
  #stream { max-width: 100%; max-height: 100%; }
  #bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: center;
         padding: 12px 16px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid #555;
           background: #222; color: inherit; }
  button:disabled { opacity: .5; }
  #state { min-width: 9ch; text-align: center; }
</style></head>
<body>
<div id="view"><img id="stream" alt="Camera stream"></div>
<div id="bar">
  <span id="state">...</span>
  <button id="swap" type="button">Switch camera</button>
  <button id="rotate" type="button">Rotate</button>
  <button id="light" type="button">Light</button>
</div>
<script>
const img = document.getElementById("stream");
const state = document.getElementById("state");
const swap = document.getElementById("swap");
const rotate = document.getElementById("rotate");
let front = null;
// IP Webcam's orientation values, in 90-degree steps.
const ORIENTATIONS = ["landscape", "portrait", "upsidedown", "upsidedown_portrait"];
let orientation = null;
const light = document.getElementById("light");
let torch = false;

function show(label) { state.textContent = label; }
function reload() { img.src = "/cam/video?t=" + Date.now(); }

// The stream drops while IP Webcam reopens the camera; keep retrying.
img.onerror = () => setTimeout(reload, 1500);

async function readState() {
  try {
    const r = await fetch("/cam/status.json", { cache: "no-store" });
    const s = await r.json();
    front = (s.curvals || {}).ffc === "on";
    orientation = (s.curvals || {}).orientation || null;
    torch = (s.curvals || {}).torch === "on";
    light.textContent = torch ? "Light off" : "Light";
    show(front ? "Front" : "Rear");
  } catch (e) {
    show("Unknown");
  }
}

swap.onclick = async () => {
  swap.disabled = true;
  show("Switching...");
  try {
    await fetch("/cam/settings/ffc?set=" + (front ? "off" : "on"), { cache: "no-store" });
  } catch (e) {}
  setTimeout(async () => { reload(); await readState(); swap.disabled = false; }, 2000);
};

rotate.onclick = async () => {
  rotate.disabled = true;
  const next = ORIENTATIONS[(ORIENTATIONS.indexOf(orientation) + 1) % ORIENTATIONS.length];
  try {
    await fetch("/cam/settings/orientation?set=" + next, { cache: "no-store" });
    orientation = next;
  } catch (e) {}
  setTimeout(() => { reload(); rotate.disabled = false; }, 1000);
};

// The flash LED is on the rear camera; IP Webcam ignores this on the front one.
light.onclick = async () => {
  light.disabled = true;
  try {
    await fetch(torch ? "/cam/disabletorch" : "/cam/enabletorch", { cache: "no-store" });
    torch = !torch;
    light.textContent = torch ? "Light off" : "Light";
  } catch (e) {}
  light.disabled = false;
};

reload();
readState();
</script>
</body></html>"""


@app.get("/cam/view")
def viewer(request: Request):
    # Caddy already checked the cookie; checking again costs nothing.
    if not cookie_valid(request.cookies.get(COOKIE)):
        return RedirectResponse(f"{LOGIN_PATH}?next=/cam/view", status_code=302)
    return HTMLResponse(VIEWER_HTML, headers={"Cache-Control": "no-store"})


@app.get("/health")
def health():
    return {"ok": True}
