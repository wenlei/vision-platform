"""
stream_proxy.py -- MJPEG stream proxy with fan-out broadcaster

Routes:
  GET /stream             proxy default camera MJPEG stream
  GET /stream/{mac}       proxy specified MAC camera
  GET /stream/config      query rotate/hmirror/vflip/source config
  POST /stream/config     update config, persist to app-runtime.yaml

All image transforms (rotate, hmirror, vflip) are done server-side
with Pillow. No ESP32 sensor writes needed.

Architecture:
  ESP32-CAM only supports one HTTP stream connection at a time.
  MJPEGBroadcaster maintains a single httpx connection to ESP32
  and fans out processed frames to all browser subscribers via
  asyncio.Condition.
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


# ── MJPEG Broadcaster ───────────────────────────────────────

class MJPEGBroadcaster:
    """
    Maintains a single httpx connection to ESP32-CAM and broadcasts
    processed frames to all subscribers. Handles:
    - One ESP32 connection shared by all clients
    - Server-side rotate/hmirror/vflip (updated live)
    - Auto-start on first subscriber, auto-stop on last unsubscribe
    """

    def __init__(self, source_url: str):
        self.source_url = source_url
        self.rotate = _rotate_degrees()
        self.hmirror = _hmirror()
        self.vflip = _vflip()
        self.latest_frame: bytes = b""
        self._condition = asyncio.Condition()
        self._task: asyncio.Task | None = None
        self._subscribers = 0

    async def _fetch_loop(self):
        """Pull MJPEG from ESP32 in a single connection, process and broadcast."""
        while True:
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("GET", self.source_url) as resp:
                        if resp.status_code != 200:
                            log.error("ESP32 stream returned %s", resp.status_code)
                            await asyncio.sleep(2)
                            continue
                        log.info("Connected to ESP32 stream: %s", self.source_url)
                        buf = b""
                        async for chunk in resp.aiter_bytes(chunk_size=4096):
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
                                    frame = _process_frame(
                                        jpeg, self.rotate, self.hmirror, self.vflip
                                    )
                                except Exception as e:
                                    log.warning("Frame process failed: %s", e)
                                    frame = jpeg
                                async with self._condition:
                                    self.latest_frame = frame
                                    self._condition.notify_all()
            except asyncio.CancelledError:
                log.info("Broadcaster fetch loop cancelled")
                return
            except Exception as e:
                log.warning("ESP32 stream error: %s, reconnecting in 2s", e)
                await asyncio.sleep(2)

    async def _ensure_running(self):
        """Start fetch task if not already running."""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._fetch_loop())
            log.info("Broadcaster started for %s", self.source_url)

    async def _maybe_stop(self):
        """Stop fetch task if no subscribers remain."""
        if self._subscribers <= 0 and self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
            log.info("Broadcaster stopped (no subscribers)")

    async def subscribe(self):
        """Async generator yielding MJPEG multipart frames to one client."""
        self._subscribers += 1
        await self._ensure_running()
        try:
            # Wait for the first frame before yielding
            async with self._condition:
                await self._condition.wait()
            while True:
                frame = self.latest_frame
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"\r\n" +
                    frame +
                    b"\r\n"
                )
                async with self._condition:
                    await self._condition.wait()
        except asyncio.CancelledError:
            pass
        finally:
            self._subscribers -= 1
            if self._subscribers <= 0:
                await self._maybe_stop()

    def update_transforms(self, rotate=None, hmirror=None, vflip=None):
        """Update transform params (takes effect on next frame)."""
        if rotate is not None:
            self.rotate = rotate
        if hmirror is not None:
            self.hmirror = hmirror
        if vflip is not None:
            self.vflip = vflip


# Module-level broadcaster singleton
_broadcaster: MJPEGBroadcaster | None = None


def _get_broadcaster() -> MJPEGBroadcaster:
    global _broadcaster
    if _broadcaster is None:
        _broadcaster = MJPEGBroadcaster(_esp32_stream_url())
    return _broadcaster


# ── Routes ────────────────────────────────────────────────

@router.get("")
@router.get("/")
async def stream_default():
    """Proxy default camera MJPEG stream (shared single ESP32 connection)."""
    bc = _get_broadcaster()
    log.info("New stream subscriber (total: %d)", bc._subscribers + 1)
    return StreamingResponse(
        bc.subscribe(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@router.get("/config")
def get_stream_config():
    """Return current stream config."""
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
    Takes effect immediately (in-memory cfg + broadcaster updated).
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
        return get_stream_config()

    try:
        with open(runtime_path, "w", encoding="utf-8") as f:
            yaml.dump(raw, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config: {e}")

    log.info("Stream config updated: %s", changed)

    # Update broadcaster transforms live
    bc = _get_broadcaster()
    bc.update_transforms(
        rotate=changed.get("rotate"),
        hmirror=changed.get("hmirror"),
        vflip=changed.get("vflip"),
    )

    # Return full config (same format as GET /stream/config)
    return get_stream_config()


@router.get("/{mac}")
async def stream_by_mac(mac: str):
    """Proxy specified MAC camera MJPEG stream."""
    bc = _get_broadcaster()
    log.info("New stream subscriber mac=%s (total: %d)", mac, bc._subscribers + 1)
    return StreamingResponse(
        bc.subscribe(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
