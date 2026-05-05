"""
audio.py -- 音频处理 API

路由：
  POST /audio/infer — 接收 ESP32 上传的 PCM 音频，处理后返回音频响应
"""

import io
import struct
import logging
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import Response

log = logging.getLogger(__name__)
router = APIRouter()


def generate_tone(freq=440, duration=0.5, sample_rate=16000):
    """生成简单的正弦波测试音，用于验证扬声器是否正常工作。"""
    t = np.linspace(0, duration, int(sample_rate * duration), dtype=np.float32)
    # 正弦波 + 淡入淡出（避免爆音）
    tone = np.sin(2 * np.pi * freq * t) * 0.3
    fade_len = int(0.01 * sample_rate)
    tone[:fade_len] *= np.linspace(0, 1, fade_len)
    tone[-fade_len:] *= np.linspace(1, 0, fade_len)
    # 转为 16-bit PCM
    pcm = (tone * 32767).astype(np.int16).tobytes()
    return pcm


@router.post("/audio/infer")
async def audio_infer(request: Request):
    """
    接收 ESP32 上传的 PCM 音频（16kHz 16-bit 单声道），
    原样返回（echo 测试）用于验证录音和扬声器是否正常工作。
    后续可接入 STT + LLM + TTS 实现语音交互。
    """
    sample_rate = int(request.headers.get("X-Sample-Rate", "16000"))
    device = request.headers.get("X-Device", "unknown")

    body = await request.body()
    audio_len = len(body)
    duration_sec = audio_len / (sample_rate * 2)

    log.info(f"收到音频: device={device}, {audio_len} bytes, {duration_sec:.1f}s, {sample_rate}Hz")

    # Echo 模式：原样返回录制的音频，同时发送到浏览器播放
    # 这样用户可以通过浏览器听到自己说的话（验证麦克风正常）
    # 同时 ESP32 也会播放（验证扬声器正常）

    return Response(
        content=body,
        media_type="audio/pcm",
        headers={
            "X-Sample-Rate": str(sample_rate),
            "X-Bits-Per-Sample": "16",
            "X-Channels": "1",
            "X-Echo": "true",
        },
    )


@router.post("/speak")
async def speak(request: Request):
    """
    从后端主动向 ESP32 推送音频（用于 TTS 播报）。
    请求体：PCM 音频二进制数据。
    目标设备通过查询 X-Device 头确定。
    """
    device = request.headers.get("X-Device", "")
    sample_rate = int(request.headers.get("X-Sample-Rate", "16000"))

    body = await request.body()
    if not body:
        return {"error": "No audio data"}

    log.info(f"推送音频: device={device}, {len(body)} bytes")

    # 查找设备 IP
    try:
        from api.db import get_conn
        with get_conn() as (conn, cur):
            cur.execute("SELECT ip FROM devices WHERE name = %s OR mac = %s", (device, device))
            row = cur.fetchone()
            if not row or not row[0]:
                return {"error": f"Device {device} not found or no IP"}
            device_ip = row[0]
    except Exception as e:
        return {"error": f"DB error: {e}"}

    # 转发音频到 ESP32（ESP32 当前无 /speak 端点，需后续固件支持）
    try:
        import httpx
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            r = await client.post(
                f"http://{device_ip}/speak",
                content=body,
                headers={
                    "Content-Type": "audio/pcm",
                    "X-Sample-Rate": str(sample_rate),
                },
            )
            return {"status": "sent", "device": device, "ip": device_ip, "bytes": len(body), "response": r.status_code}
    except Exception as e:
        return {"error": f"Send failed: {e}"}
