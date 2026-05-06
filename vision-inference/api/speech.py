"""
speech.py -- 语音识别 API

路由：
  POST /speech/recognize — 接收 PCM 音频，使用 faster-whisper 识别文字
"""

import io
import struct
import logging
import tempfile
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)
router = APIRouter()

# ── Whisper 模型缓存 ──────────────────────────────────────
_whisper_model = None


def _load_whisper():
    """延迟加载 faster-whisper 模型（首次调用时加载）"""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model

    log.info("加载 faster-whisper 模型...")
    from faster_whisper import WhisperModel
    # 模型选择：large-v3（高精度）/ medium（平衡）/ small（快速）
    # GPU 使用 float16，CPU 使用 int8
    device = "cuda" if _check_cuda() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    _whisper_model = WhisperModel("large-v3", device=device, compute_type=compute_type)
    log.info(f"Whisper 模型加载完成: device={device}, compute_type={compute_type}")
    return _whisper_model


def _check_cuda():
    try:
        import torch
        return torch.cuda.is_available()
    except:
        return False


def pcm_to_wav(pcm_data, sample_rate=16000, num_channels=1, bits_per_sample=16):
    """将 PCM 数据转换为 WAV 格式"""
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_data)

    wav = bytearray()
    # RIFF header
    wav.extend(b'RIFF')
    wav.extend(struct.pack('<I', 36 + data_size))
    wav.extend(b'WAVE')
    # fmt chunk
    wav.extend(b'fmt ')
    wav.extend(struct.pack('<I', 16))
    wav.extend(struct.pack('<H', 1))  # PCM format
    wav.extend(struct.pack('<H', num_channels))
    wav.extend(struct.pack('<I', sample_rate))
    wav.extend(struct.pack('<I', byte_rate))
    wav.extend(struct.pack('<H', block_align))
    wav.extend(struct.pack('<H', bits_per_sample))
    # data chunk
    wav.extend(b'data')
    wav.extend(struct.pack('<I', data_size))
    wav.extend(pcm_data)

    return bytes(wav)


@router.post("/speech/recognize")
async def recognize_speech(request: Request):
    """
    接收 PCM 音频（16kHz 16-bit 单声道），使用 faster-whisper 识别文字。
    返回识别结果、时间戳、语言信息。
    """
    sample_rate = int(request.headers.get("X-Sample-Rate", "16000"))
    device = request.headers.get("X-Device", "unknown")

    body = await request.body()
    audio_len = len(body)
    duration_sec = audio_len / (sample_rate * 2)  # 16-bit = 2 bytes/sample

    log.info(f"语音识别: device={device}, {audio_len} bytes, {duration_sec:.1f}s, {sample_rate}Hz")

    if audio_len < 3200:  # 至少 0.1 秒
        return JSONResponse({"error": "Audio too short", "duration": duration_sec})

    # 转换为 WAV 格式（Whisper 需要）
    wav_data = pcm_to_wav(body, sample_rate)

    # 加载模型（延迟加载）
    model = _load_whisper()

    # 写入临时文件
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav_data)
        tmp_path = f.name

    try:
        # 使用 faster-whisper 识别
        segments, info = model.transcribe(
            tmp_path,
            language="zh",  # 中文
            beam_size=5,
            vad_filter=True,  # 语音活动检测
        )

        # 收集识别结果
        results = []
        full_text = ""
        for segment in segments:
            results.append({
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text.strip(),
            })
            full_text += segment.text.strip()

        log.info(f"识别完成: {len(full_text)} 字符, {len(results)} 段")

        return JSONResponse({
            "text": full_text,
            "segments": results,
            "language": info.language,
            "duration": round(duration_sec, 1),
            "device": device,
        })
    finally:
        import os
        os.unlink(tmp_path)
