#!/usr/bin/env python3
"""
ota.py — Build + OTA push for ESP32 cameras

Usage:
  python3 .scripts/ota.py cam01          # build cam01, push to 192.168.50.87
  python3 .scripts/ota.py cam02          # build cam02, push to 192.168.50.88
  python3 .scripts/ota.py cam01 --push-only   # skip build, push last .bin
  python3 .scripts/ota.py cam01 --build-only  # build only, don't push
  python3 .scripts/ota.py all            # build & push both

Device IP is read from platformio.ini build_flags (CAM_STATIC_IP).
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path
import urllib.request
import urllib.parse

ROOT = Path(__file__).parent.parent
ESP_DIR = ROOT / "esp32-cam"
API_BASE = "http://192.168.50.71:8000"   # Vision inference API (OTA proxy)

# Map env name → static IP (parsed from platformio.ini)
def parse_env_ips():
    ini = (ESP_DIR / "platformio.ini").read_text()
    envs = {}
    current_env = None
    for line in ini.splitlines():
        m = re.match(r'^\[env:(.+)\]', line.strip())
        if m:
            current_env = m.group(1)
        if current_env:
            ip_m = re.search(r'CAM_STATIC_IP\s*=\s*([\d,]+)', line)
            if ip_m:
                envs[current_env] = ip_m.group(1).replace(',', '.')
    return envs

# Map IP → registered device MAC via API
def mac_for_ip(ip):
    try:
        with urllib.request.urlopen(f"{API_BASE}/devices", timeout=5) as r:
            import json
            data = json.loads(r.read())
            for d in data.get("devices", []):
                if d.get("ip") == ip:
                    return d.get("mac")
    except Exception as e:
        print(f"  [warn] Could not fetch devices from API: {e}")
    return None

def build(env):
    print(f"\n── Building [{env}] ─────────────────────────────────")
    result = subprocess.run(
        ["pio", "run", "-e", env],
        cwd=ESP_DIR,
    )
    if result.returncode != 0:
        print(f"  [FAIL] Build failed for {env}")
        sys.exit(1)
    bin_path = ESP_DIR / ".pio" / "build" / env / "firmware.bin"
    size = bin_path.stat().st_size
    print(f"  [OK] {bin_path.name} ({size/1024:.1f} KB)")
    return bin_path

def push(env, bin_path, ip, mac):
    print(f"\n── OTA push [{env}] → {ip} (MAC: {mac}) ────────────")
    if not bin_path.exists():
        print(f"  [FAIL] {bin_path} not found — run without --push-only first")
        sys.exit(1)

    import urllib.request
    import json

    size = bin_path.stat().st_size
    print(f"  Pushing {bin_path.name} ({size/1024:.1f} KB) via {API_BASE}/devices/{mac}/ota ...")

    boundary = "----PIOOTABoundary"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="firmware"; filename="{bin_path.name}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + bin_path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{API_BASE}/devices/{urllib.parse.quote(mac)}/ota",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            resp = json.loads(r.read())
            if resp.get("ok"):
                print(f"  [OK] OTA success — device rebooting")
            else:
                print(f"  [FAIL] OTA response: {resp}")
                sys.exit(1)
    except urllib.error.HTTPError as e:
        body_err = e.read().decode(errors="replace")
        print(f"  [FAIL] HTTP {e.code}: {body_err}")
        sys.exit(1)
    except Exception as e:
        print(f"  [FAIL] {e}")
        sys.exit(1)

def main():
    env_ips = parse_env_ips()

    parser = argparse.ArgumentParser(description="Build + OTA push ESP32 firmware")
    parser.add_argument("env", help=f"Environment: {list(env_ips.keys())} or 'all'")
    parser.add_argument("--push-only", action="store_true", help="Skip build, push last .bin")
    parser.add_argument("--build-only", action="store_true", help="Build only, no OTA push")
    args = parser.parse_args()

    targets = list(env_ips.keys()) if args.env == "all" else [args.env]
    for env in targets:
        if env not in env_ips:
            print(f"Unknown env '{env}'. Available: {list(env_ips.keys())}")
            sys.exit(1)

        ip = env_ips[env]
        bin_path = ESP_DIR / ".pio" / "build" / env / "firmware.bin"

        if not args.push_only:
            bin_path = build(env)

        if not args.build_only:
            mac = mac_for_ip(ip)
            if not mac:
                print(f"  [FAIL] No device registered with IP {ip}. Register it in the UI first.")
                sys.exit(1)
            push(env, bin_path, ip, mac)

    print("\n── Done ─────────────────────────────────────────────\n")

if __name__ == "__main__":
    main()
