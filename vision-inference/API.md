# Vision Inference — API Reference

Base URL: `http://192.168.50.71:8000`

---

## Detection

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/detect` | Upload image → YOLO + CLIP, returns detections + annotated image path. Form fields: `file`, `camera_ip`, `device_mac` |
| `POST` | `/describe` | Same as `/detect` but lightweight — no annotated image generated |
| `POST` | `/detect/{mac}` | Server captures frame from device by MAC, runs full detection. No upload needed |
| `POST` | `/detect/all` | Capture + detect on **all** registered devices in parallel |
| `POST` | `/detect/group/{name}` | Capture + detect on all devices in a named group |

**`POST /detect` form fields**

| Field | Required | Description |
|-------|----------|-------------|
| `file` | ✓ | JPEG image |
| `camera_ip` | — | Camera IP (used to resolve device if MAC unknown) |
| `device_mac` | — | Device MAC (preferred; used to look up orientation from DB) |

**Detection result shape**

```json
{
  "detections": [{"label": "person", "confidence": 0.91, "bbox": [x1,y1,x2,y2]}],
  "custom_matches": [["my-keys", 0.83]],
  "count": 1,
  "description": "Detected: person",
  "image_path": "/app/images/...",
  "annotated_path": "/app/images/..._ann_....jpg",
  "saved": true,
  "device_name": "desk-cam-01",
  "location": "study-desk"
}
```

`/detect/all` and `/detect/group/{name}` return:

```json
{
  "results": [{ "device_mac": "...", "device_name": "...", "location": "...", ...detection fields... }],
  "count": 2
}
```

---

## Stream

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stream` | MJPEG stream (multipart). Proxy of active camera, raw frames |
| `GET` | `/stream/capture` | Single raw JPEG frame (from broadcaster cache or ESP32 `/capture`) |
| `GET` | `/stream/snapshot` | Single JPEG with server-side orientation applied (for download) |
| `GET` | `/stream/status` | Proxy ESP32 `/status` — returns uptime, RSSI, resolution, heap |
| `GET` | `/stream/health` | Broadcaster liveness: `{"online": true, "frame_id": 1234}` |
| `GET` | `/stream/config` | Current source URL + orientation: `{"source", "rotate", "hmirror", "vflip"}` |
| `POST` | `/stream/config` | Update source and/or orientation. Body: `{"source": "http://ip:81/", "rotate": 90, "hmirror": 1, "vflip": 0}` |

Orientation is stored per-device in the DB (keyed by `stream_url`). Changing `source` also resets the broadcaster.

---

## Devices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/devices` | List all registered devices |
| `POST` | `/devices` | Register device. Body: `{mac, name, location?, ip?, stream_url?, description?}` |
| `PUT` | `/devices/{mac}` | Update device fields (partial). Supports `rotate`, `hmirror`, `vflip`, `is_default` |
| `DELETE` | `/devices/{mac}` | Delete device |
| `PUT` | `/devices/{mac}/set-default` | Mark device as default stream source on startup |
| `GET` | `/devices/ping?ip=` | Quick heartbeat to ESP32 `/status`. Returns `{online, rssi, uptime_sec, free_heap}` |
| `GET` | `/devices/scan?ip=` | Scan ESP32 at IP, return `{mac, ip, name, location, stream_url, registered}` for pre-filling registration |
| `GET` | `/devices/discovered` | Devices seen in `vision_log` in the last 7 days (whether registered or not) |
| `POST` | `/devices/camconfig/{mac}?framesize=VGA&hmirror=0&vflip=0` | Push hardware config to ESP32 (proxied) |
| `GET` | `/devices/camstatus/{mac}` | Fetch live ESP32 `/status` by MAC (proxied) |

**Device object**

```json
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "name": "desk-cam-01",
  "location": "study-desk",
  "ip": "192.168.50.87",
  "stream_url": "http://192.168.50.87:81/",
  "description": "",
  "rotate": 0,
  "hmirror": 1,
  "vflip": 0,
  "is_default": true,
  "registered_at": "2026-04-01T12:00:00"
}
```

---

## Detection Groups

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/groups` | List all groups with device lists |
| `POST` | `/groups` | Create group. Body: `{name, description?, macs: ["AA:BB:...", ...]}` |
| `PUT` | `/groups/{name}` | Update group. Body: `{name?, description?, macs?}` — `macs` replaces entire list |
| `DELETE` | `/groups/{name}` | Delete group (cascades) |

**Group object**

```json
{
  "id": 1,
  "name": "mydesk",
  "description": "Desk area cameras",
  "device_count": 2,
  "devices": [{"mac": "...", "name": "...", "location": "...", "ip": "..."}],
  "created_at": "2026-04-09T10:00:00"
}
```

---

## Faces

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/face/register` | Register face. Form: `file` (image), `name`. Rolling-average if name exists |
| `POST` | `/face/identify` | Identify face in image. Returns match list with confidence + auto-learns on low-confidence hits. Form: `file` |
| `GET` | `/faces` | List all registered faces |

**Identify response**

```json
{
  "results": [
    {"name": "Wenlei", "similarity": 0.88, "confidence": "high", "matched": true, "learned": false}
  ]
}
```

Confidence levels: `high` (≥ 0.75) · `low` (0.40–0.75, triggers auto-learn) · unmatched (< 0.40)

---

## Custom Items

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Register custom item with CLIP embedding. Form: `file`, `label`, `description?`. Rolling-average on repeat |
| `GET` | `/items` | List all registered custom items |

---

## Search / History

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search?label=keys&limit=20` | Search `vision_log` by label. `label` optional (omit for latest N). Default limit 50 |

**Search result item**

```json
{
  "id": 42,
  "captured_at": "2026-04-09T14:23:00",
  "camera_ip": "192.168.50.87",
  "device_mac": "AA:BB:CC:DD:EE:FF",
  "device_name": "desk-cam-01",
  "labels": ["person", "laptop"],
  "description": "Detected: person, laptop",
  "image_url": "/app/images/...",
  "confidence": {"person": 0.91, "laptop": 0.76}
}
```

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service status, CUDA info, storage mode, face thresholds, DB host |

```json
{
  "status": "ok",
  "device": "NVIDIA GeForce RTX ...",
  "cuda": true,
  "image_storage": "retention",
  "face_threshold": {"high": 0.75, "low": 0.40},
  "db_host": "192.168.50.118"
}
```

---

## Quick Examples

```bash
# Trigger detection on a specific camera (no upload)
curl -X POST http://192.168.50.71:8000/detect/AA:BB:CC:DD:EE:FF

# Detect only desk area
curl -X POST http://192.168.50.71:8000/detect/group/mydesk

# Detect on all cameras
curl -X POST http://192.168.50.71:8000/detect/all

# Upload image for detection
curl -X POST http://192.168.50.71:8000/detect \
  -F file=@frame.jpg -F device_mac=AA:BB:CC:DD:EE:FF

# Search for keys in last 20 records
curl "http://192.168.50.71:8000/search?label=keys&limit=20"

# Switch active stream to cam2
curl -X POST http://192.168.50.71:8000/stream/config \
  -H "Content-Type: application/json" \
  -d '{"source": "http://192.168.50.88:81/"}'

# Create a detection group
curl -X POST http://192.168.50.71:8000/groups \
  -H "Content-Type: application/json" \
  -d '{"name": "mydesk", "macs": ["AA:BB:CC:DD:EE:FF"]}'
```
