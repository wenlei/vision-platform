"""
stream_proxy.py -- MJPEG stream proxy

Routes:
  GET /stream             proxy default camera MJPEG stream
  GET /stream/{mac}       proxy specified MAC camera
  GET /stream/config      query rotate/hmirror/vflip/source config
  POST /stream/config     update config, persist to app-runtime.yaml

All image transforms (rotate, hmirror, vflip) are done server-side
with Pillow. No ESP32 sensor writes needed.
"""

import io
import logging
import asyncio
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
    return cfg.get("camera", {})


_DEFAULT_SOURCE = "http://192.168.50.87:81/"


def _esp32_stream_url(mac: str = None) -> str:
    return _camera_cfg().get("source", _DEFAULT_SOURCE)


def _rotate_degrees() -> int:
    return int(_camera_cfg().get("rotate", 0))


def _hmirror() -> int:
    return int(_camera_cfg().get("hmirror", 0))


def _vflip() -> int:
    return int(_camera_cfg().get("vflip", 0))


def _process_frame(jpeg_bytes: bytes, rotate: int, hmirror: int, vflip: int) -> bytes:
    """
    Apply server-side image transforms using Pillow.
    All of rotate/hmirror/vflip are handled here, not on ESP32.
    Returns original bytes unchanged when all params are 0.
    """
    if rotate == 0 and hmirror == 0 and vflip == 0:
        return jpeg_bytes
    img = Image.open(io.BytesIO(jpeg_bytes))
    if hmirror:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    if vflip:
        img = img.transpose(Image.FLIP_TOP_BOTTOM)
    if rotate:
        img = img.rotate(-rotate, expand=True)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


async def _iter_mjpeg_frames(source_url: str, rotate: int, hmirror: int = 0, vflip: int = 0):
    """
    Async generator: pull MJPEG from ESP32, apply transforms, yield multipart frames.
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
                        frame = _process_frame(jpeg, rotate, hmirror, vflip)
                    except Exception as e:
                        log.warning("Frame process failed: %s", e)
                        frame = jpeg
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"\r\n" +
                        frame +
                        b"\r\n"
                    )


# ── Routes ────────────────────────────────────────────────

@router.get("")
@router.get("/")
async def stream_default():
    """Proxy default camera MJPEG stream with server-side transforms."""
    source_url = _esp32_stream_url()
    rotate = _rotate_degrees()
    hmirror = _hmirror()
    vflip = _vflip()
    log.info("Streaming from %s rotate=%d hmirror=%d vflip=%d", source_url, rotate, hmirror, vflip)
    return StreamingResponse(
        _iter_mjpeg_frames(source_url, rotate, hmirror, vflip),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@router.get("/config")
def get_stream_config():
    """Return current stream config (rotate/hmirror/vflip all handled server-side)."""
    cam = _camera_cfg()
    return {
        "source":  cam.get("source",  _DEFAULT_SOURCE),
        "rotate":  int(cam.get("rotate",  0)),
        "hmirror": int(cam.get("hmirror", 0)),
        "vflip":   int(cam.get("vflip",   0)),
    }


class StreamConfigUpdate(BaseModel):
    """Update stream config. rotate/hmirror/vflip all processed server-side by Pillow."""
    rotate:  int = None   # clockwise degrees: 0/90/180/270
    hmirror: int = None   # horizontal mirror: 0/1
    vflip:   int = None   # vertical flip: 0/1
    source:  str = None   # override ESP32 stream URL (optional)


@router.post("/config")
def update_stream_config(body: StreamConfigUpdate):
    """
    Update stream config and persist to app-runtime.yaml.
    rotate/hmirror/vflip are applied by Pillow on every frame.
    Takes effect immediately (in-memory cfg updated).
    """
    if body.rotate is not None and body.rotate not in (0, 90, 180, 270):
        raise HTTPException(status_code=400, detail="rotate must be 0, 90, 180, or 270")
    if body.hmirror is not None and body.hmirror not in (0, 1):
        raise HTTPException(status_code=400, detail="hmirror must be 0 or 1")
    if body.vflip is not None and body.vflip not in (0, 1):
        raise HTTPException(status_code=400, detail="vflip must be 0 or 1")

    runtime_path = BASE_DIR / "app-runtime.yaml"
    try:
        with open(runtime_path, encoding="utf-8") as f:
            raw = yaml.safe_load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read config: {e}")

    if "camera" not in raw:
        raw["camera"] = {}

    changed = {}
    for field in ("rotate", "hmirror", "vflip", "source"):
        val = getattr(body, field)
        if val is not None:
            raw["camera"][field] = val
            cfg.setdefault("camera", {})[field] = val
            changed[field] = val

    if not changed:
        return JSONResponse({"status": "no change"})

    try:
        with open(runtime_path, "w", encoding="utf-8") as f:
            yaml.dump(raw, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config: {e}")

    log.info("Stream config updated: %s", changed)
    return {"status": "ok", "updated": changed}


@router.get("/{mac}")
async def stream_by_mac(mac: str):
    """Proxy specified MAC camera MJPEG stream."""
    source_url = _esp32_stream_url(mac)
    rotate = _rotate_degrees()
    hmirror = _hmirror()
    vflip = _vflip()
    log.info("Streaming mac=%s from %s rotate=%d hmirror=%d vflip=%d",
             mac, source_url, rotate, hmirror, vflip)
    return StreamingResponse(
        _iter_mjpeg_frames(source_url, rotate, hmirror, vflip),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
