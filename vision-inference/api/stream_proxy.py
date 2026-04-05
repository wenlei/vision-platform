"""
stream_proxy.py -- MJPEG ?????

???
  ? ESP32 :81 ?? MJPEG ????? app-runtime.yaml ????
  ????????????? FastAPI ??? UI?

  UI ?????? ESP32:81????? /stream?

???
  GET /stream             ???????? MJPEG ?
  GET /stream/{mac}       ???? MAC ???? MJPEG ?
  GET /stream/config      ???????
  POST /stream/config     ??????????? app-runtime.yaml

?????
  rotate ????? Pillow ?????????????
  UI ???? CSS transform???????
  rotate ????0 / 90 / 180 / 270?????
"""

import io
import logging
import httpx
import yaml
from pathlib import Path
from PIL import Image
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from api.config import cfg, BASE_DIR

log = logging.getLogger(__name__)
router = APIRouter(prefix="/stream", tags=["stream"])


def _camera_cfg() -> dict:
    """? cfg ?? camera ?????????"""
    return cfg.get("camera", {})


def _esp32_stream_url(mac: str = None) -> str:
    """
    ?? ESP32 MJPEG ?? URL?
    ??? app-runtime.yaml camera.source ???
    ????? device_layer ? MAC ? DB ?? IP?
    """
    return _camera_cfg().get("source", "http://192.168.50.87:81/")


def _rotate_degrees() -> int:
    """????????????0/90/180/270??"""
    return int(_camera_cfg().get("rotate", 0))


def _rotate_frame(jpeg_bytes: bytes, degrees: int) -> bytes:
    """
    ??? JPEG ????????
    degrees=0 ????????????? CPU?
    """
    if degrees == 0:
        return jpeg_bytes
    img = Image.open(io.BytesIO(jpeg_bytes))
    rotated = img.rotate(-degrees, expand=True)  # Pillow ????????
    buf = io.BytesIO()
    rotated.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


async def _iter_mjpeg_frames(source_url: str, rotate: int):
    """
    ??????? source_url ?? MJPEG ??
    ?????? yield multipart ??????
    """
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("GET", source_url) as response:
            if response.status_code != 200:
                log.error("ESP32 stream returned %s", response.status_code)
                return
            buf = b""
            async for chunk in response.aiter_bytes(chunk_size=4096):
                buf += chunk
                while True:
                    soi = buf.find(b"\xff\xd8")
                    if soi == -1:
                        break
                    eoi = buf.find(b"\xff\xd9", soi)
                    if eoi == -1:
                        break
                    jpeg = buf[soi:eoi + 2]
                    buf = buf[eoi + 2:]
                    try:
                        frame = _rotate_frame(jpeg, rotate)
                    except Exception as e:
                        log.warning("Frame rotate failed: %s", e)
                        frame = jpeg
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"\r\n" +
                        frame +
                        b"\r\n"
                    )


# ?? ?? ?????????????????????????????????????????????????????

@router.get("")
@router.get("/")
async def stream_default():
    """???????? MJPEG ??????????????"""
    source_url = _esp32_stream_url()
    rotate = _rotate_degrees()
    log.info("Streaming from %s rotate=%d", source_url, rotate)
    return StreamingResponse(
        _iter_mjpeg_frames(source_url, rotate),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@router.get("/config")
def get_stream_config():
    """????????rotate?source?vflip?hmirror??"""
    cam = _camera_cfg()
    return {
        "source":  cam.get("source", "http://192.168.50.87:81/"),
        "rotate":  int(cam.get("rotate", 0)),
        "vflip":   int(cam.get("default_vflip", 0)),
        "hmirror": int(cam.get("default_hmirror", 0)),
    }


class StreamConfigUpdate(BaseModel):
    """??????????"""
    rotate: int = None   # ????????0 / 90 / 180 / 270
    source: str = None   # ?? ESP32 ?? URL????


@router.post("/config")
def update_stream_config(body: StreamConfigUpdate):
    """
    ?????????? app-runtime.yaml?
    ???? cfg ?????????????
    """
    if body.rotate is not None and body.rotate not in (0, 90, 180, 270):
        raise HTTPException(status_code=400, detail="rotate must be 0, 90, 180, or 270")

    runtime_path = BASE_DIR / "app-runtime.yaml"
    try:
        with open(runtime_path, encoding="utf-8") as f:
            raw = yaml.safe_load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read config: {e}")

    if "camera" not in raw:
        raw["camera"] = {}

    changed = {}
    if body.rotate is not None:
        raw["camera"]["rotate"] = body.rotate
        cfg.setdefault("camera", {})["rotate"] = body.rotate
        changed["rotate"] = body.rotate
    if body.source is not None:
        raw["camera"]["source"] = body.source
        cfg.setdefault("camera", {})["source"] = body.source
        changed["source"] = body.source

    if not changed:
        return JSONResponse({"status": "no change"})

    try:
        with open(runtime_path, "w", encoding="utf-8") as f:
            yaml.dump(raw, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config: {e}")

    log.info("Stream config updated: %s", changed)
    return {"status": "ok", "updated": changed}




@router.get("/camera/config")
async def get_camera_config():
    """
    代理 ESP32 /status 接口，返回当前 vflip/hmirror 状态。
    UI 只需和推理服务通信，不直接访问 ESP32。
    """
    source = _esp32_stream_url()
    esp32_base = source.rstrip("/").rsplit(":", 1)[0]  # http://192.168.50.87
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(esp32_base + "/status")
            data = res.json()
            return {
                "status": "ok",
                "vflip": data.get("vflip", 0),
                "hmirror": data.get("hmirror", 0),
            }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"ESP32 unreachable: {e}")


@router.post("/camera/config")
async def set_camera_config(vflip: int = None, hmirror: int = None):
    """
    代理 ESP32 /config 接口，设置 vflip/hmirror。
    由推理服务转发，避免 UI 直连 ESP32 时被 MJPEG 流阻塞。
    params 通过 query string 传递：POST /stream/camera/config?vflip=1&hmirror=0
    """
    source = _esp32_stream_url()
    esp32_base = source.rstrip("/").rsplit(":", 1)[0]
    params = {}
    if vflip is not None:
        params["vflip"] = vflip
    if hmirror is not None:
        params["hmirror"] = hmirror
    if not params:
        raise HTTPException(status_code=400, detail="vflip or hmirror required")
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(esp32_base + "/config", params=params)
            data = res.json()
            log.info("Camera config updated: %s", params)
            return data
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"ESP32 unreachable: {e}")

@router.get("/{mac}")
async def stream_by_mac(mac: str):
    """
    ???? MAC ???? MJPEG ??
    ???????? source???? device_layer ? DB ?? IP?
    """
    source_url = _esp32_stream_url(mac)
    rotate = _rotate_degrees()
    log.info("Streaming mac=%s from %s rotate=%d", mac, source_url, rotate)
    return StreamingResponse(
        _iter_mjpeg_frames(source_url, rotate),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
