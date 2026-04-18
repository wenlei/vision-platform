# Vision Platform UI

> **Version:** 20260418

Single-page web app for managing ESP32-S3 cameras, running detections, and browsing results.  
Served by FastAPI at `/` and `/ui/*` — no build step required.

## File Structure

```
UI/
├── index.html        Main SPA
├── style.css         Light theme (Inter font, indigo accent)
├── app.js            All client-side logic
└── desk-viewer.html  Lightweight standalone stream viewer
```

## Pages

| Page | Function |
|------|----------|
| **Live** | MJPEG stream preview, device switcher, scoped detection (current / all / tag group), face identify, orientation controls |
| **History** | Detection log grid with label search |
| **Items** | Register custom objects (CLIP few-shot) |
| **Faces** | Register and manage face embeddings |
| **Devices** | ESP32 registration, tag assignment, infrastructure topology |
| **API** | Endpoint reference, tag ↔ endpoint binding, per-device paths |

## Detection Scope (Live page)

The scope selector controls what `⚡ 检测` triggers:

| Selection | Endpoint called |
|-----------|----------------|
| 📷 当前摄像头 | `POST /describe` (current stream device) |
| 🌐 全部设备 | `POST /detect/all` |
| 🏷 {tag} | `POST /detect/group/{tag}` |

Tag groups are populated dynamically from `GET /devices`.

## API Page — Tag Bindings

Each device carries a `tag` field (comma/semicolon separated). The API page:

1. Groups devices by tag
2. Shows three endpoint chips per tag row — `POST /detect/group/{tag}`, `/describe/group/{tag}`, `/capture/group/{tag}`
3. Click a chip to enable / disable → saves via `PUT /bindings/{tag}`

Per-device paths support both name and MAC: `POST /detect/desk-cam-01` or `POST /detect/AA:BB:CC:DD:EE:FF`.

## Orientation

Stored per-device in `devices` table (`rotate`, `hmirror`, `vflip`).  
Stream proxy applies orientation server-side — all saved images and inference results use the corrected orientation.  
Live page controls write directly to the stream config YAML.

## Version Mismatch Detection

On startup the UI fetches `GET /version` and compares the response against the embedded `UI_VERSION` constant. If they differ, the sidebar label turns amber and shows:

```
UI 20260418 / 服务 20260XXX
```

with a tooltip: *"版本不一致：请在服务器 git pull 并重启 Docker"*. This catches cases where a git push was made but Docker was not restarted on the server.

## Configuration

API address stored in `localStorage`:

| Key | Default | Description |
|-----|---------|-------------|
| `vision_api` | `location.origin` | Inference service base URL |

Editable in the API page → "推理服务地址".

## Design

- **Font**: Inter (Google Fonts) with system-ui fallback
- **Accent**: Indigo `#6366f1`
- **Theme**: Light — white cards, `#f5f6fa` page background
- **Status colours**: Green (online) · Amber (checking) · Red (offline/error)
