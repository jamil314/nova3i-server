"""Set the cam-gate password. Writes CAM_GATE_ENV (default /root/.cam-gate.env).

Keeps an existing signing secret, so changing the password does not need a new
secret; pass --new-secret to also sign everyone out.
"""

import getpass
import hashlib
import os
import secrets
import sys


def hash_password(password, salt):
    # Must match app.hash_password.
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


def load_config(path):
    cfg = {}
    with open(path) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                cfg[k] = v
    return cfg


path = os.environ.get("CAM_GATE_ENV", "/root/.cam-gate.env")
existing = load_config(path) if os.path.exists(path) else {}

pw = getpass.getpass("cam-gate password: ")
if not pw or pw != getpass.getpass("Confirm: "):
    sys.exit("Passwords empty or do not match.")

salt = secrets.token_bytes(16)
secret = existing.get("CAM_GATE_SECRET")
if not secret or "--new-secret" in sys.argv:
    secret = secrets.token_hex(32)

old_umask = os.umask(0o077)
with open(path, "w") as f:
    f.write(f"CAM_GATE_PASSWORD_HASH=scrypt${salt.hex()}${hash_password(pw, salt).hex()}\n")
    f.write(f"CAM_GATE_SECRET={secret}\n")
os.umask(old_umask)
print(f"Wrote {path} (mode 600). Restart cam-gate to apply.")
