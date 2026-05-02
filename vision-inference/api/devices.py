"""
devices.py -- 设备管理 API

路由：
  GET    /devices              -- 返回所有已注册设备
  POST   /devices              -- 注册新设备
  PUT    /devices/{mac}        -- 更新设备信息
  DELETE /devices/{mac}        -- 删除设备
  GET    /devices/scan?ip=     -- 从 IP 扫描 ESP32 设备信息（用于预填注册表单）
"""

import logging
from typing import Optional
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from api.db import get_conn

log = logging.getLogger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])


def _row_to_dict(r):
    ip = r[3]
    if not ip and r[5]:
        try:
            ip = r[5].split("//")[-1].split(":")[0].split("/")[0]
        except Exception:
            pass
    cap_raw = r[12] if len(r) > 12 else "video_in"
    cap_list = [c.strip() for c in (cap_raw or "video_in").split(",") if c.strip()]
    return {
        "mac":          r[0],
        "name":         r[1],
        "location":     r[2],
        "ip":           ip,
        "description":  r[4],
        "stream_url":   r[5],
        "registered_at": r[6].isoformat() if r[6] else None,
        "rotate":       r[7] if len(r) > 7 else 0,
        "hmirror":      r[8] if len(r) > 8 else 0,
        "vflip":        r[9] if len(r) > 9 else 0,
        "is_default":   bool(r[10]) if len(r) > 10 else False,
        "tag":          r[11] if len(r) > 11 else None,
        "capability":   cap_list,
    }


@router.get("")
def list_devices():
    """返回所有已注册设备。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT mac, name, location, ip, description, stream_url, registered_at, rotate, hmirror, vflip, is_default, tag, capability"
                " FROM devices ORDER BY registered_at DESC"
            )
            rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"devices": [_row_to_dict(r) for r in rows]}


class DeviceCreate(BaseModel):
    mac:         str
    name:        str
    location:    Optional[str] = None
    ip:          Optional[str] = None
    description: Optional[str] = None
    stream_url:  Optional[str] = None
    tag:         Optional[str] = None
    capability:  Optional[str] = "video_in"


@router.post("")
def register_device(body: DeviceCreate):
    """注册新设备，MAC 已存在则更新。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                """INSERT INTO devices (mac, name, location, ip, description, stream_url, tag, capability)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (mac) DO UPDATE SET
                     name        = EXCLUDED.name,
                     location    = EXCLUDED.location,
                     ip          = EXCLUDED.ip,
                     description = EXCLUDED.description,
                     stream_url  = EXCLUDED.stream_url,
                     tag         = EXCLUDED.tag,
                     capability  = EXCLUDED.capability
                   RETURNING mac, name, location, ip, description, stream_url, registered_at, rotate, hmirror, vflip, is_default, tag, capability""",
                (body.mac.upper(), body.name, body.location,
                 body.ip, body.description, body.stream_url, body.tag,
                 body.capability or "video_in")
            )
            row = cur.fetchone()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return _row_to_dict(row)


class DeviceUpdate(BaseModel):
    name:        Optional[str] = None
    location:    Optional[str] = None
    ip:          Optional[str] = None
    description: Optional[str] = None
    stream_url:  Optional[str] = None
    rotate:      Optional[int] = None
    hmirror:     Optional[int] = None
    vflip:       Optional[int] = None
    is_default:  Optional[bool] = None
    tag:         Optional[str] = None
    capability:  Optional[str] = None


@router.put("/{mac}")
def update_device(mac: str, body: DeviceUpdate):
    """更新设备字段（仅更新非 None 字段）。"""
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [mac.upper()]
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                f"UPDATE devices SET {set_clause} WHERE mac = %s"
                " RETURNING mac, name, location, ip, description, stream_url, registered_at, rotate, hmirror, vflip, is_default, tag, capability",
                values
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device {mac} not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return _row_to_dict(row)


@router.get("/ping")
async def ping_device(ip: str):
    """快速心跳检测：调 ESP32 /status，2.5s 超时，返回在线状态和基础指标。"""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(2.5)) as client:
            r = await client.get(f"http://{ip}/status")
            if r.status_code == 200:
                data = r.json()
                return {
                    "online": True, "ip": ip,
                    "rssi": data.get("rssi"),
                    "uptime_sec": data.get("uptime_sec"),
                    "free_heap": data.get("free_heap"),
                }
    except Exception:
        pass
    return {"online": False, "ip": ip}


@router.get("/scan")
async def scan_device(ip: str):
    """
    通过 IP 地址查询 ESP32 /status，返回设备信息用于预填注册表单。
    用户在 Devices 页输入摄像头 IP 点击扫描，可自动填写 MAC / 名称 / 位置。
    """
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(4.0)) as client:
            r = await client.get(f"http://{ip}/status")
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail=f"ESP32 returned {r.status_code}")
            data = r.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach {ip}: {e}")

    mac = data.get("mac", "")
    # Check if already registered
    registered = False
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT name FROM devices WHERE mac = %s", (mac.upper(),))
            row = cur.fetchone()
            registered = row is not None
    except Exception:
        pass

    return {
        "mac":        mac,
        "ip":         data.get("ip", ip),
        "name":       data.get("device_name", ""),
        "location":   data.get("location", ""),
        "stream_url": f"http://{ip}:81/",
        "registered": registered,
    }


@router.get("/scan-subnet")
async def scan_subnet(subnet: str = "192.168.50", start: int = 1, end: int = 254, concurrency: int = 50):
    """
    并发扫描子网，找出所有响应 /status 的 ESP32 设备。
    默认扫描 192.168.50.1-254，并发 50，约 10 秒完成。
    """
    import asyncio

    registered_macs: set[str] = set()
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT mac FROM devices")
            registered_macs = {r[0].upper() for r in cur.fetchall()}
    except Exception:
        pass

    async def probe(ip: str) -> dict | None:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(2.0)) as client:
                r = await client.get(f"http://{ip}/status")
                if r.status_code == 200:
                    data = r.json()
                    if data.get("platform") != "desk-vision":
                        return None
                    mac = data.get("mac", "").upper()
                    return {
                        "ip":         ip,
                        "mac":        mac,
                        "name":       data.get("device_name", ""),
                        "stream_url": f"http://{ip}:81/",
                        "registered": mac in registered_macs,
                    }
        except Exception:
            return None

    ips = [f"{subnet}.{i}" for i in range(start, end + 1)]
    sem = asyncio.Semaphore(concurrency)

    async def bounded(ip):
        async with sem:
            return await probe(ip)

    results = await asyncio.gather(*[bounded(ip) for ip in ips])
    found = [r for r in results if r is not None]
    return {"found": found, "count": len(found), "subnet": subnet}


@router.get("/discovered")
def discovered_devices():
    try:
        with get_conn() as (conn, cur):
            cur.execute("""
                SELECT vl.device_mac, vl.camera_ip,
                       MAX(vl.captured_at) as last_seen,
                       d.name as device_name,
                       d.id IS NOT NULL as is_registered
                FROM vision_log vl
                LEFT JOIN devices d ON d.mac = vl.device_mac
                WHERE vl.device_mac IS NOT NULL
                  AND vl.captured_at > NOW() - INTERVAL '7 days'
                GROUP BY vl.device_mac, vl.camera_ip, d.name, d.id
                ORDER BY last_seen DESC
            """)
            rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"discovered": [
        {"mac": r[0], "ip": r[1], "last_seen": r[2].isoformat() if r[2] else None,
         "device_name": r[3], "is_registered": bool(r[4])}
        for r in rows
    ]}


@router.post("/camconfig/{mac}")
async def cam_config(mac: str, framesize: str = None, vflip: int = None, hmirror: int = None):
    """
    代理调用 ESP32 /config 接口，按 MAC 查找设备 IP，下发配置参数。
    支持 ?framesize=VGA&vflip=0&hmirror=0
    """
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT ip, stream_url FROM devices WHERE mac = %s",
                (mac.upper(),)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device {mac} not found")
            ip = row[0] or (row[1].split("//")[-1].split(":")[0] if row[1] else None)
            if not ip:
                raise HTTPException(status_code=422, detail="Device has no IP")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    params = {}
    if framesize is not None:
        params["framesize"] = framesize
    if vflip is not None:
        params["vflip"] = vflip
    if hmirror is not None:
        params["hmirror"] = hmirror
    if not params:
        raise HTTPException(status_code=400, detail="No config params provided")

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(4.0)) as client:
            r = await client.post(f"http://{ip}/config", params=params)
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach {ip}: {e}")


@router.get("/camstatus/{mac}")
async def cam_status(mac: str):
    """查询 ESP32 /status，按 MAC 找到设备 IP。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute(
                "SELECT ip, stream_url FROM devices WHERE mac = %s",
                (mac.upper(),)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device {mac} not found")
            ip = row[0] or (row[1].split("//")[-1].split(":")[0] if row[1] else None)
            if not ip:
                raise HTTPException(status_code=422, detail="Device has no IP")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(4.0)) as client:
            r = await client.get(f"http://{ip}/status")
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach {ip}: {e}")


@router.put("/{mac}/set-default")
def set_default_device(mac: str):
    """将指定设备设为默认（清除其余设备的 is_default）。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute("UPDATE devices SET is_default = FALSE WHERE is_default = TRUE")
            cur.execute(
                "UPDATE devices SET is_default = TRUE WHERE mac = %s"
                " RETURNING mac, name, location, ip, description, stream_url, registered_at, rotate, hmirror, vflip, is_default, tag, capability",
                (mac.upper(),)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device {mac} not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return _row_to_dict(row)


@router.delete("/{mac}")
def delete_device(mac: str):
    """删除设备。"""
    try:
        with get_conn() as (conn, cur):
            cur.execute("DELETE FROM devices WHERE mac = %s RETURNING name", (mac.upper(),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"Device {mac} not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DB error: {e}")
    return {"ok": True, "deleted": row[0]}
