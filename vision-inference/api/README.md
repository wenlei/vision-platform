# api/ — FastAPI Service Modules

> **Version:** 20260418

## Directory Structure

```
api/
├── __init__.py        Package entry
├── config.py          Config loader (app-runtime.yaml + .env)
├── models.py          Model loading (YOLO11L / CLIP / InsightFace)
├── db.py              DB connection pool and common queries
├── storage.py         Image storage (save / path generation)
├── device_layer.py    Device abstraction (MAC → name, location, orientation)
├── detection.py       /detect, /describe, /detect/all, /detect/group/{tag}, /detect/{name-or-mac}
├── devices.py         /devices CRUD + /devices/scan, /devices/ping, /devices/camstatus
├── groups.py          /groups CRUD (detection groups — legacy, tag-based preferred)
├── bindings.py        /bindings — tag ↔ endpoint binding management
├── faces.py           /face/register, /face/identify, /faces
├── items.py           /register, /items (custom item CRUD)
├── search.py          /search — detection history queries
├── health.py          /health
├── stream_proxy.py    /stream, /stream/capture, /stream/snapshot, /stream/config
├── cleanup.py         Scheduled image cleanup daemon
└── main.py            FastAPI app entry — mounts all routers, runs DB migrations
```

## Module Dependencies

```
main.py
  ├── config.py          ← loaded first, no internal deps
  ├── models.py          ← config
  ├── db.py              ← config
  ├── storage.py         ← config
  ├── device_layer.py    ← db, config
  ├── detection.py       ← models, db, storage, device_layer
  ├── devices.py         ← db
  ├── groups.py          ← db
  ├── bindings.py        ← db
  ├── faces.py           ← models, db, storage, device_layer
  ├── items.py           ← models, db
  ├── search.py          ← db
  ├── health.py          ← config, models
  └── stream_proxy.py    ← config, db, storage
```

## Key Routes

### Detection

```
POST /detect                   Upload image → YOLO + CLIP, returns detections + annotated path
POST /describe                 Upload image → text description only (no annotated image)
POST /detect/all               All registered devices: parallel capture → sequential inference
POST /detect/group/{tag}       Devices matching tag: parallel capture → sequential inference
POST /detect/{name-or-mac}     Single device by name (preferred) or MAC — no upload needed
```

`/detect/group/{tag}` matches devices whose `tag` field (comma/semicolon separated) contains the given tag exactly.  
`/detect/{name-or-mac}` tries MAC match first (uppercase), then case-insensitive name match.

### History

```
GET  /search                   Detection history. Params: ?label= ?device_mac= ?limit=50
GET  /images/{filename}        Serve captured image (StaticFiles, /app/images/)
```

### Bindings

```
GET  /bindings                 All tag bindings + endpoint definitions
PUT  /bindings/{tag}           Replace enabled endpoint list for tag
                               Body: { "enabled": ["detect", "describe", "capture_snapshot"] }
```

Endpoint keys: `detect`, `describe`, `capture_snapshot`

### Devices

```
GET    /devices                    List all devices
POST   /devices                    Register { mac, name, ip, stream_url, tag, ... }
PUT    /devices/{mac}              Update fields
DELETE /devices/{mac}              Remove
PUT    /devices/{mac}/set-default  Set as default
GET    /devices/scan               Scan LAN for ESP32 devices
GET    /devices/discovered         Discovered but unregistered devices
GET    /devices/ping               Ping all registered devices
GET    /devices/camstatus/{mac}    Camera resolution / RSSI / uptime
POST   /devices/camconfig/{mac}    Set camera framesize
```

`devices.tag` is a VARCHAR(64) storing comma or semicolon separated tags, e.g. `desk,front`.

### Stream

```
GET    /stream                  MJPEG stream (default device)
GET    /stream/{mac}            MJPEG stream for specific device
GET    /stream/capture          Single frame JPEG (default device)
GET    /stream/snapshot         Timestamped snapshot saved to disk
GET    /stream/status           Broadcaster status
GET    /stream/health           Stream online check
GET    /stream/config           Current stream source + orientation
POST   /stream/config           Update source + orientation (rotate/hmirror/vflip)
```

### Face Recognition

```
POST   /face/register           Register face embedding (form-data: file, name)
POST   /face/identify           Identify face in uploaded image
GET    /faces                   List registered faces
```

### Custom Items

```
POST   /register                Register item via CLIP (form-data: file, label)
GET    /items                   List registered items
```

### Groups (legacy)

```
GET    /groups                  List detection groups
POST   /groups                  Create group { name, description, macs: [...] }
PUT    /groups/{name}           Update group
DELETE /groups/{name}           Delete group
```

### Health & UI

```
GET    /health                  Service status, CUDA device, DB connection
GET    /version                 Current service version {"version": "YYYYMMDD"}
GET    /                        Web UI (index.html, no-cache)
```

## Startup

```bash
# From vision-inference/ root
uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 1
```

## Configuration Files

| File | Description | In Git |
|------|-------------|--------|
| `app-runtime.yaml` | Runtime config (camera source, storage, face thresholds) | YES |
| `.env` | DB password and secrets | NO |
| `.env.example` | Template | YES |

## DB Schema

Key tables (see `init_db.sql` for full schema):

| Table | Purpose |
|-------|---------|
| `devices` | ESP32 registration (mac, name, ip, stream_url, tag, rotate/hmirror/vflip) |
| `vision_log` | Detection history (labels, confidence, image_url, raw_result) |
| `tag_endpoints` | Tag ↔ enabled endpoint bindings |
| `custom_items` | CLIP-registered custom objects (512-dim embedding) |
| `faces` | InsightFace registrations (512-dim embedding, adaptive learning) |

## Face Recognition Thresholds

| Similarity | Behaviour |
|------------|-----------|
| ≥ 0.75 | High confidence match |
| 0.40 – 0.75 | Low confidence + auto adaptive learning |
| < 0.40 | Unknown, no learning triggered |
