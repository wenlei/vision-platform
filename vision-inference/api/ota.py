"""
ota.py — OTA 固件升级代理

路由：
  POST /devices/{mac}/ota  — 接收 .bin 固件文件，转发给 ESP32 /update 接口
"""

import logging

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile

from api.db import get_conn

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/devices/{mac}/ota")
async def ota_update(mac: str, firmware: UploadFile = File(...)):
    """
    接收固件 .bin 文件，通过后端转发给对应 ESP32 的 /update 接口。
    绕过浏览器直连 ESP32 的 CORS 限制。
    ESP32 升级成功后会自动重启，连接中断属正常现象。
    """
    mac = mac.upper()

    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT ip, name FROM devices WHERE mac = %s", (mac,))
            row = cur.fetchone()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DB error: {e}")

    if not row:
        raise HTTPException(status_code=404, detail=f"Device {mac} not registered")

    ip, name = row
    if not ip:
        raise HTTPException(status_code=400, detail=f"Device {name} has no IP configured")

    data = await firmware.read()
    size = len(data)
    log.info("OTA: pushing %d bytes to %s (%s) at %s", size, name, mac, ip)

    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(
                f"http://{ip}/update",
                files={"firmware": (firmware.filename, data, "application/octet-stream")},
            )
        log.info("OTA: %s responded HTTP %d: %s", name, resp.status_code, resp.text)
        if resp.status_code == 200:
            return {"ok": True, "device": name, "ip": ip, "bytes": size, "msg": resp.text.strip()}
        else:
            raise HTTPException(status_code=502, detail=f"ESP32 OTA failed ({resp.status_code}): {resp.text}")

    except (httpx.TimeoutException, httpx.RemoteProtocolError):
        # ESP32 reboots mid-transfer — connection drop is expected on success
        log.info("OTA: %s connection closed (likely rebooting — success)", name)
        return {"ok": True, "device": name, "ip": ip, "bytes": size, "msg": "rebooting"}

    except httpx.ConnectError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach {name} at {ip}: {e}")
