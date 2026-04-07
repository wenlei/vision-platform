# Vision Platform UI

桌面摄像头管理前端，用于实时预览、方向调节、物体检测和人脸识别。

## 文件结构

```
UI/
├── index.html        # 主界面（SPA 单页应用）
├── style.css         # 样式（暗色工业风）
├── app.js            # 业务逻辑
└── desk-viewer.html  # 轻量桌面预览器
```

## 方向控制架构

摄像头画面的方向调节**不在摄像头端（ESP32-CAM）完成**，而是由后台 `stream_proxy` 在服务端处理：

```
ESP32-CAM (原始 MJPEG)
    │
    ▼
stream_proxy (FastAPI + Pillow)
    ├── rotate   0/90/180/270°
    ├── hmirror  水平镜像
    └── vflip    垂直翻转
    │
    ▼
UI 前端显示处理后的画面
```

- **旋转/翻转/镜像** → `POST /stream/config` 修改后台参数，Pillow 逐帧处理 MJPEG 流
- **CSS 旋转**（顺时针/逆时针按钮）→ 仅作为前端预览辅助，不影响保存和推理
- 参数调好后，后台按此配置处理所有下游任务（截图保存、YOLO 推理、人脸识别）

## 页面说明

| 页面 | 功能 |
|------|------|
| **Live** | MJPEG 实时预览 + 方向控制 + 单帧检测/人脸识别 |
| **History** | 检测历史记录，按标签搜索 |
| **Items** | 自定义物品注册（上传图片 + 标签） |
| **Faces** | 人脸注册与管理 |
| **Devices** | 设备状态（ESP32、GPU 服务、数据库） |
| **System** | 服务健康状态、运行配置、API 地址设置 |

## 依赖

纯前端，无构建步骤。由后台 FastAPI 以静态文件方式挂载：

```python
# main.py
app.mount("/ui", StaticFiles(directory="UI", html=True))
```

## 配置

前端通过 `localStorage` 持久化两个地址：

| Key | 默认值 | 说明 |
|-----|--------|------|
| `vision_api` | `http://192.168.50.71:8000` | 推理服务 API |
| `vision_cam` | `http://192.168.50.87` | 摄像头基地址 |

可在 System 页面修改，保存后立即生效。
