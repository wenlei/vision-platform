"""
audio.py — 音频推理 API

路由：
  POST /audio/infer   — 接收 ESP32 PCM → Whisper → LLM → TTS → 返回 PCM
  GET  /audio/latest  — 获取指定设备最新录音
  POST /speak         — 后端主动向 ESP32 推送音频
  GET  /audio/status  — 查看推理组件加载状态
"""

import io
import time
import logging
import threading
import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import Response

log = logging.getLogger(__name__)
router = APIRouter()

# ── 音频缓存 ──────────────────────────────────────────────
_audio_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()

# ── 推理组件（懒加载，首次调用时初始化）─────────────────
_whisper_model = None
_llm = None
_tts = None
_components_lock = threading.Lock()
_components_ready = False


def _load_components():
    """懒加载推理组件，首次调用 /audio/infer 时触发。"""
    global _whisper_model, _llm, _tts, _components_ready
    with _components_lock:
        if _components_ready:
            return True
        try:
            # 1. Whisper
            log.info("[AUDIO] 加载 faster-whisper...")
            from faster_whisper import WhisperModel
            _whisper_model = WhisperModel(
                "large-v3",
                device="cuda",
                compute_type="float16",
                download_root="/app/models/whisper"
            )
            log.info("[AUDIO] Whisper 加载完成")

            # 2. LLM (llama-cpp-python)
            log.info("[AUDIO] 加载 LLM...")
            from llama_cpp import Llama
            import glob, os
            model_dir = "/app/models"
            gguf_files = glob.glob(f"{model_dir}/*.gguf")
            if not gguf_files:
                raise FileNotFoundError(f"没有找到 .gguf 文件在 {model_dir}")
            model_path = sorted(gguf_files)[0]
            log.info(f"[AUDIO] 使用模型: {model_path}")
            _llm = Llama(
                model_path=model_path,
                n_gpu_layers=-1,
                n_ctx=2048,
                verbose=False,
            )
            log.info("[AUDIO] LLM 加载完成")

            # 3. TTS (kokoro-onnx)
            log.info("[AUDIO] 加载 Kokoro TTS...")
            from kokoro_onnx import Kokoro
            _tts = Kokoro("/app/models/kokoro/kokoro-v0_19.onnx",
                         "/app/models/kokoro/voices.json")
            log.info("[AUDIO] TTS 加载完成")

            _components_ready = True
            return True

        except Exception as e:
            log.error(f"[AUDIO] 组件加载失败: {e}")
            return False


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 16000) -> bytes:
    """将原始 PCM (16-bit mono) 转换为 WAV 格式。"""
    num_samples = len(pcm_bytes) // 2
    wav_buf = io.BytesIO()
    import wave
    with wave.open(wav_buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return wav_buf.getvalue()


def _wav_to_pcm(wav_bytes: bytes, target_rate: int = 16000) -> bytes:
    """将 WAV 转换为原始 PCM (16-bit mono)。"""
    import wave
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, 'rb') as wf:
        frames = wf.readframes(wf.getnframes())
        src_rate = wf.getframerate()
        channels = wf.getnchannels()

    samples = np.frombuffer(frames, dtype=np.int16)

    # 多声道 → 单声道
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1).astype(np.int16)

    # 重采样
    if src_rate != target_rate:
        from scipy.signal import resample
        new_len = int(len(samples) * target_rate / src_rate)
        samples = resample(samples, new_len).astype(np.int16)

    return samples.tobytes()


@router.get("/audio/status")
async def audio_status():
    """查看推理组件加载状态。"""
    return {
        "ready": _components_ready,
        "whisper": _whisper_model is not None,
        "llm": _llm is not None,
        "tts": _tts is not None,
    }


@router.post("/audio/infer")
async def audio_infer(request: Request):
    """
    完整语音交互链路：
    PCM → Whisper 识别 → LLM 推理 → TTS → 返回 PCM
    """
    sample_rate = int(request.headers.get("X-Sample-Rate", "16000"))
    device = request.headers.get("X-Device", "unknown")
    t0 = time.time()

    body = await request.body()
    log.info(f"[AUDIO] 收到音频: device={device}, {len(body)} bytes, {sample_rate}Hz")

    # 存储录音
    with _cache_lock:
        _audio_cache[device] = {
            "data": body,
            "timestamp": time.time(),
            "sample_rate": sample_rate,
        }

    # 加载组件（首次调用）
    if not _components_ready:
        ok = _load_components()
        if not ok:
            # 组件未就绪，返回提示音
            log.warning("[AUDIO] 组件未就绪，返回 echo")
            return Response(
                content=body,
                media_type="audio/pcm",
                headers={"X-Error": "components-not-ready", "X-Sample-Rate": str(sample_rate)},
            )

    try:
        # 1. Whisper 语音识别
        t1 = time.time()
        wav_bytes = _pcm_to_wav(body, sample_rate)
        wav_buf = io.BytesIO(wav_bytes)
        segments, info = _whisper_model.transcribe(
            wav_buf,
            language="zh",
            beam_size=5,
            vad_filter=True,
        )
        text = " ".join(s.text for s in segments).strip()
        log.info(f"[AUDIO] Whisper ({time.time()-t1:.1f}s): {text!r}")

        if not text:
            text = "（未识别到语音）"

        # 2. LLM 推理
        t2 = time.time()
        prompt = f"""你是 Vision Platform 的语音助手，回答简洁，不超过两句话。

用户说：{text}
助手："""
        output = _llm(
            prompt,
            max_tokens=128,
            temperature=0.7,
            stop=["用户说：", "\n\n"],
        )
        reply = output["choices"][0]["text"].strip()
        log.info(f"[AUDIO] LLM ({time.time()-t2:.1f}s): {reply!r}")

        # 3. TTS 合成
        t3 = time.time()
        samples, tts_rate = _tts.create(
            reply,
            voice="af",
            speed=1.0,
            lang="zh-cn",
        )
        # TTS 输出 float32 → int16
        pcm_out = (samples * 32767).astype(np.int16).tobytes()
        # 如果 TTS 采样率和目标不同，重采样
        if tts_rate != sample_rate:
            wav_out = io.BytesIO()
            import wave
            with wave.open(wav_out, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(tts_rate)
                wf.writeframes(pcm_out)
            pcm_out = _wav_to_pcm(wav_out.getvalue(), sample_rate)

        log.info(f"[AUDIO] TTS ({time.time()-t3:.1f}s): {len(pcm_out)} bytes @ {sample_rate}Hz")
        log.info(f"[AUDIO] 总耗时: {time.time()-t0:.1f}s")

        return Response(
            content=pcm_out,
            media_type="audio/pcm",
            headers={
                "X-Sample-Rate": str(sample_rate),
                "X-Transcript": text,
                "X-Reply": reply,
                "X-Duration": f"{time.time()-t0:.1f}",
            },
        )

    except Exception as e:
        log.error(f"[AUDIO] 推理失败: {e}", exc_info=True)
        return Response(
            content=b"",
            media_type="audio/pcm",
            status_code=500,
            headers={"X-Error": str(e)},
        )


@router.get("/audio/latest")
async def audio_latest(device: str = ""):
    """获取指定设备的最新录音。"""
    with _cache_lock:
        if device:
            entry = _audio_cache.get(device)
            if not entry:
                return {"error": f"No audio for {device}"}
            return Response(
                content=entry["data"],
                media_type="audio/pcm",
                headers={
                    "X-Sample-Rate": str(entry["sample_rate"]),
                    "X-Bits-Per-Sample": "16",
                    "X-Channels": "1",
                    "X-Timestamp": str(int(entry["timestamp"])),
                },
            )
        return {
            "devices": [
                {
                    "device": d,
                    "bytes": len(v["data"]),
                    "duration": round(len(v["data"]) / (v["sample_rate"] * 2), 1),
                    "timestamp": int(v["timestamp"]),
                }
                for d, v in _audio_cache.items()
            ]
        }


@router.post("/speak")
async def speak(request: Request):
    """后端主动向 ESP32 推送音频。"""
    device = request.headers.get("X-Device", "")
    sample_rate = int(request.headers.get("X-Sample-Rate", "16000"))
    body = await request.body()

    if not body:
        return {"error": "No audio data"}

    log.info(f"[AUDIO] 推送音频: device={device}, {len(body)} bytes")

    try:
        from api.db import get_conn
        with get_conn() as (conn, cur):
            cur.execute("SELECT ip FROM devices WHERE name = %s OR mac = %s", (device, device))
            row = cur.fetchone()
            if not row or not row[0]:
                return {"error": f"Device {device} not found"}
            device_ip = row[0]
    except Exception as e:
        return {"error": f"DB error: {e}"}

    try:
        import httpx
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.post(
                f"http://{device_ip}/speak",
                content=body,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Sample-Rate": str(sample_rate),
                },
            )
            return {"status": "sent", "device": device, "ip": device_ip,
                    "bytes": len(body), "response": r.status_code}
    except Exception as e:
        return {"error": f"Send failed: {e}"}
