"""
stream_proxy.py -- MJPEG stream proxy with fan-out broadcaster

Routes:
  GET /stream             proxy raw camera MJPEG stream (no transform)
  GET /stream/capture     single raw frame (for detection/faces)
  GET /stream/snapshot    single frame with transforms (for screenshot)
  GET /stream/status      proxy ESP32 /status
  GET /stream/config      query rotate/hmirror/vflip/source config
  POST /stream/config     update config, persist to app-runtime.yaml

Architecture:
  - Stream/capture deliver RAW frames from ESP32 (no Pillow processing)
  - Frontend applies CSS transforms for live preview
  - Backend applies transforms only when saving/detecting (via storage.apply_orientation)
  - Config params are the single source of truth in app-runtime.yaml
"""

import io
import time
import logging
import asyncio
import httpx
import yaml
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


def _esp32_base_url() -> str:
    """ESP32 HTTP base (without :81 stream port)."""
    source = _esp32_stream_url()
    return source.rsplit(":", 1)[0]


def _process_frame(jpeg_bytes: bytes, rotate: int, hmirror: int, vflip: int) -> bytes:
    """
    Apply image transforms using Pillow to match CSS transform behavior.
    CSS: transform: scaleX(-1) scaleY(-1) rotate(Ndeg)
    CSS applies right-to-left: rotate first, then scale.
    So Pillow must also: rotate first, then mirror/flip.
    """
    if rotate == 0 and hmirror == 0 and vflip == 0:
        return jpeg_bytes
    img = Image.open(io.BytesIO(jpeg_bytes))
    if rotate:
        img = img.rotate(-rotate, expand=True)
    if hmirror:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    if vflip:
        img = img.transpose(Image.FLIP_TOP_BOTTOM)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


# ── MJPEG Broadcaster (raw frames, no transform) ────────────

class MJPEGBroadcaster:
    """
    Single httpx connection to ESP32-CAM, fans out raw frames
    to all browser subscribers. No image processing here.
    """

    def __init__(self, source_url: str):
        self.source_url = source_url
        self.latest_frame: bytes = b""
        self._frame_id = 0
        self._last_frame_ts: float = 0.0
        self._task: asyncio.Task | None = None
        self._subscribers = 0

    async def _fetch_loop(self):
        """Pull raw MJPEG from ESP32, broadcast to subscribers."""
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
                                self.latest_frame = jpeg
                                self._frame_id += 1
                                self._last_frame_ts = time.time()
            except asyncio.CancelledError:
                log.info("Broadcaster fetch loop cancelled")
                return
            except Exception as e:
                log.warning("ESP32 stream error: %s, reconnecting in 2s", e)
                await asyncio.sleep(2)

    async def _ensure_running(self):
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._fetch_loop())
            log.info("Broadcaster started for %s", self.source_url)

    async def _maybe_stop(self):
        if self._subscribers <= 0 and self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
            log.info("Broadcaster stopped (no subscribers)")

    async def subscribe(self):
        """Async generator yielding raw MJPEG multipart frames."""
        self._subscribers += 1
        await self._ensure_running()
        last_seen = self._frame_id
        try:
            while True:
                while self._frame_id == last_seen:
                    await asyncio.sleep(0.01)
                last_seen = self._frame_id
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"\r\n" +
                    self.latest_frame +
                    b"\r\n"
                )
        except asyncio.CancelledError:
            pass
        finally:
            self._subscribers -= 1
            if self._subscribers <= 0:
                await self._maybe_stop()


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
    """Proxy raw MJPEG stream. CSS transforms are applied by the frontend."""
    bc = _get_broadcaster()
    log.info("New stream subscriber (total: %d)", bc._subscribers + 1)
    return StreamingResponse(
        bc.subscribe(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@router.get("/capture")
async def capture_frame():
    """
    Single JPEG frame for detection/faces.

    When the MJPEG broadcaster is active, waits for the NEXT fresh frame
    (not the stale latest_frame) to avoid motion blur from a cached frame.
    Falls back to ESP32 /capture only when no broadcaster is running.
    """
    bc = _get_broadcaster()
    if bc._task and not bc._task.done():
        # Broadcaster is active — wait for a fresh frame
        current_id = bc._frame_id
        for _ in range(50):            # up to 0.5 s
            await asyncio.sleep(0.01)
            if bc._frame_id != current_id:
                break
        if bc.latest_frame:
            return StreamingResponse(io.BytesIO(bc.latest_frame), media_type="image/jpeg")
    # No broadcaster — call ESP32 directly
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.get(_esp32_base_url() + "/capture")
            if r.status_code != 200:
                log.warning("ESP32 /capture returned %s", r.status_code)
                raise HTTPException(status_code=502, detail=f"ESP32 capture returned {r.status_code}")
            return StreamingResponse(io.BytesIO(r.content), media_type="image/jpeg")
    except HTTPException:
        raise
    except Exception as e:
        log.warning("ESP32 /capture failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Capture failed: {e}")


@router.get("/snapshot")
async def snapshot_frame():
    """Single JPEG frame with transforms applied (for screenshot download)."""
    cam = _camera_cfg()
    r = int(cam.get("rotate", 0))
    h = int(cam.get("hmirror", 0))
    v = int(cam.get("vflip", 0))
    # Get raw frame
    bc = _get_broadcaster()
    raw = bc.latest_frame
    if not raw:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resp = await client.get(_esp32_base_url() + "/capture")
                raw = resp.content
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Snapshot failed: {e}")
    frame = _process_frame(raw, r, h, v)
    return StreamingResponse(io.BytesIO(frame), media_type="image/jpeg")


@router.get("/status")
async def cam_status():
    """Proxy ESP32 /status endpoint."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            r = await client.get(_esp32_base_url() + "/status")
            return JSONResponse(r.json())
    except Exception:
        raise HTTPException(status_code=502, detail="Camera offline")


@router.get("/health")
def stream_health():
    """Return broadcaster liveness: online if a frame arrived within the last 3 seconds."""
    bc = _get_broadcaster() if _broadcaster else None
    if bc and bc._last_frame_ts and (time.time() - bc._last_frame_ts) < 3.0:
        return {"online": True, "frame_id": bc._frame_id}
    return {"online": False, "frame_id": bc._frame_id if bc else 0}


@router.get("/config")
def get_stream_config():
    """Return current orientation config."""
    cam = _camera_cfg()
    return {
        "source":  cam.get("source",  _DEFAULT_SOURCE),
        "rotate":  int(cam.get("rotate",  0)),
        "hmirror": int(cam.get("hmirror", 0)),
        "vflip":   int(cam.get("vflip",   0)),
    }


class StreamConfigUpdate(BaseModel):
    rotate:  int = None   # clockwise degrees: 0/90/180/270
    hmirror: int = None   # horizontal mirror: 0/1
    vflip:   int = None   # vertical flip: 0/1
    source:  str = None   # override ESP32 stream URL (optional)


@router.post("/config")
def update_stream_config(body: StreamConfigUpdate):
    """
    Update orientation config and persist to app-runtime.yaml.
    Frontend reads these to apply CSS transforms.
    Backend reads these in apply_orientation() when saving/detecting.
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

    # If source changed, reset broadcaster so next request reconnects to new URL
    if "source" in changed:
        global _broadcaster
        if _broadcaster is not None and _broadcaster._task and not _broadcaster._task.done():
            _broadcaster._task.cancel()
        _broadcaster = None
        log.info("Broadcaster reset for new source: %s", changed["source"])

    try:
        with open(runtime_path, "w", encoding="utf-8") as f:
            yaml.dump(raw, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config: {e}")

    log.info("Stream config updated: %s", changed)
    return get_stream_config()


@router.get("/{mac}")
async def stream_by_mac(mac: str):
    """Proxy raw MJPEG stream for a specific MAC."""
    bc = _get_broadcaster()
    log.info("New stream subscriber mac=%s (total: %d)", mac, bc._subscribers + 1)
    return StreamingResponse(
        bc.subscribe(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
