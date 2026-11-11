"""鱼鱼的耳朵 · 快速对话区（小模型常驻，不碰大模型显存）

跟 hear_server.py（理解区，8779，大模型按需）分开跑：
  8779  理解区：要解释、要描述素材时才叫起来
  8780  快速对话区：日常每条语音走这里，秒级

这里只做「事实层」，不做解释：
  SenseVoiceSmall  转写原文 + 声音事件（BGM / 笑声 / 掌声 / 哭声 …）
  本机数值          时长 / 音量 / 语速 / 停顿时长 / 基频中位数
  情绪标签          默认不用 emotion2vec（实测坏的）；要试就 HEAR_FAST_SER=1

环境变量：
  HEAR_FAST_PORT      默认 8780
  HEAR_FAST_DEVICE    默认 cuda:0；没有显卡会自动退 cpu
  HEAR_ASR_MODEL      默认 iic/SenseVoiceSmall
  HEAR_SER_MODEL      默认 iic/emotion2vec_plus_large
  HEAR_FAST_SER       1 = 同时跑情绪模型（默认关，见 测试记录 第 9 轮）
"""

import math
import os
import re
import time

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

PORT = int(os.environ.get("HEAR_FAST_PORT") or "8780")
DEVICE = os.environ.get("HEAR_FAST_DEVICE") or "cuda:0"
ASR_MODEL = os.environ.get("HEAR_ASR_MODEL") or "iic/SenseVoiceSmall"
SER_MODEL = os.environ.get("HEAR_SER_MODEL") or "iic/emotion2vec_plus_large"
SER_ON = os.environ.get("HEAR_FAST_SER") == "1"

app = FastAPI()
state = {"asr": None, "ser": None, "error": None, "ser_error": None, "loaded_at": 0, "device": DEVICE}

TAG = re.compile(r"<\|([^|]*)\|>")

EMO_ZH = {
    "angry": "生气",
    "happy": "开心",
    "sad": "难过",
    "neutral": "中性",
    "fearful": "害怕",
    "disgusted": "厌恶",
    "surprised": "惊讶",
    "other": "其他",
    "unknown": "不确定",
    "<unk>": "不确定",
}

EVENT_ZH = {
    "bgm": "背景音乐",
    "music": "音乐",
    "laughter": "笑声",
    "applause": "掌声",
    "cry": "哭声",
    "cough": "咳嗽",
    "sneeze": "喷嚏",
    "breath": "呼吸声",
    "speech": "",
}

LANGS = {"zh", "en", "ja", "ko", "yue"}


def load():
    if state["asr"] or state["error"]:
        return
    t0 = time.time()
    try:
        from funasr import AutoModel

        device = DEVICE
        try:
            import torch

            if device.startswith("cuda") and not torch.cuda.is_available():
                device = "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"
        state["device"] = device
        state["asr"] = AutoModel(
            model=ASR_MODEL,
            hub="ms",
            device=device,
            disable_update=True,
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
        )
        if SER_ON:
            try:
                state["ser"] = AutoModel(model=SER_MODEL, hub="ms", device=device, disable_update=True)
            except Exception as exc:  # noqa: BLE001
                state["ser_error"] = f"{type(exc).__name__}: {exc}"
        state["loaded_at"] = time.time()
        print(f"快速对话区就绪，{time.time() - t0:.1f}s，设备 {device}", flush=True)
    except Exception as exc:  # noqa: BLE001
        state["error"] = f"{type(exc).__name__}: {exc}"
        print(f"快速对话区加载失败：{state['error']}", flush=True)


def load_audio(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import librosa

        audio = librosa.resample(np.asarray(audio, dtype=np.float32), orig_sr=sr, target_sr=16000)
        sr = 16000
    return np.asarray(audio, dtype=np.float32), sr


def db(x):
    return 20 * math.log10(max(float(x), 1e-9))


def numbers(audio, sr, text):
    """本机算的事实：时长、音量、语速、停顿、基频中位数。不依赖任何模型。"""
    out = {"duration": round(len(audio) / sr, 2) if sr else None}
    if audio.size == 0:
        return out
    rms = float(np.sqrt(np.mean(audio**2)))
    out["rmsDb"] = round(db(rms), 1)
    out["peak"] = round(float(np.max(np.abs(audio))), 3)

    # 停顿：25ms 窗，低于 -45 dBFS 视作静音，超过 200ms 记一次
    win = int(0.025 * sr)
    if len(audio) >= win:
        frames = audio[: len(audio) - len(audio) % win].reshape(-1, win)
        levels = np.array([db(np.sqrt(np.mean(f**2))) for f in frames])
        silent = levels < -45
        pauses, run = [], 0
        for flag in silent:
            if flag:
                run += 1
                continue
            if run * 0.025 >= 0.2:
                pauses.append(round(run * 0.025, 2))
            run = 0
        if run * 0.025 >= 0.2:
            pauses.append(round(run * 0.025, 2))
        out["pauses"] = pauses
        out["pauseCount"] = len(pauses)

    # 基频中位数（可能慢，音频太长就抽中间 30 秒）
    try:
        import librosa

        seg = audio
        if len(audio) > sr * 30:
            mid = len(audio) // 2
            seg = audio[max(0, mid - sr * 15) : mid + sr * 15]
        f0 = librosa.yin(seg, fmin=60, fmax=400, sr=sr)
        f0 = f0[np.isfinite(f0)]
        if f0.size:
            out["f0Median"] = round(float(np.median(f0)), 1)
            out["f0Range"] = [round(float(np.percentile(f0, 10)), 1), round(float(np.percentile(f0, 90)), 1)]
    except Exception as exc:  # noqa: BLE001
        out["f0Error"] = f"{type(exc).__name__}: {exc}"

    words = len(re.sub(r"\s+", "", text or ""))
    if out["duration"] and words:
        out["charsPerSec"] = round(words / out["duration"], 2)
    return out


def parse_sensevoice(raw):
    marks = TAG.findall(raw or "")
    text = " ".join(TAG.sub("", raw or "").split())
    events, emotion_hint, language = [], "", ""
    for mark in marks:
        low = mark.lower()
        if low in LANGS:
            language = low
        elif low in EVENT_ZH:
            if EVENT_ZH[low]:
                events.append(EVENT_ZH[low])
        elif low in EMO_ZH:
            emotion_hint = EMO_ZH[low]
    return text, events, emotion_hint, language


@app.get("/health")
def health():
    return {
        "ok": state["asr"] is not None,
        "area": "fast",
        "device": state["device"],
        "asr": ASR_MODEL,
        "ser": SER_MODEL if SER_ON else "",
        "serError": state["ser_error"],
        "error": state["error"],
        "loadedAt": state["loaded_at"],
    }


@app.post("/load")
def load_now():
    load()
    return health()


@app.post("/fast")
async def fast(request: Request):
    body = await request.json()
    path = str(body.get("path") or "")
    if not path or not os.path.exists(path):
        return JSONResponse({"ok": False, "error": f"文件不存在：{path}"}, status_code=400)
    load()
    if state["error"]:
        return JSONResponse({"ok": False, "error": state["error"]}, status_code=503)
    if not state["asr"]:
        return JSONResponse({"ok": False, "error": "模型没就绪"}, status_code=503)

    started = time.time()
    audio, sr = load_audio(path)

    try:
        asr_out = state["asr"].generate(
            input=path,
            language="auto",
            use_itn=True,
            merge_vad=True,
            merge_length_s=15,
            batch_size_s=60,
        )
        raw = asr_out[0].get("text", "") if asr_out else ""
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"转写失败：{type(exc).__name__}: {exc}"}, status_code=500)

    text, events, emotion_hint, language = parse_sensevoice(raw)
    events = list(dict.fromkeys(events))
    facts = numbers(audio, sr, text)

    emotion = {}
    if SER_ON and state["ser"]:
        try:
            ser_out = state["ser"].generate(input=path, granularity="utterance", extract_embedding=False)
            if ser_out:
                labels = ser_out[0].get("labels") or []
                scores = ser_out[0].get("scores") or []
                pairs = sorted(zip(labels, scores), key=lambda x: -x[1])
                emotion = {
                    "labels": labels,
                    "scores": [round(float(s), 4) for s in scores],
                    "top": pairs[0][0] if pairs else "",
                    "topZh": EMO_ZH.get(str(pairs[0][0]).split("/")[-1].lower(), pairs[0][0]) if pairs else "",
                    "topScore": round(float(pairs[0][1]), 4) if pairs else 0.0,
                    "experimental": True,
                }
        except Exception as exc:  # noqa: BLE001
            emotion = {"error": f"{type(exc).__name__}: {exc}", "experimental": True}

    return {
        "ok": True,
        "area": "fast",
        "path": path,
        "text": text,
        "events": events,
        "language": language,
        "emotionHint": emotion_hint,
        "emotion": emotion,
        "facts": facts,
        "ms": int((time.time() - started) * 1000),
    }


if __name__ == "__main__":
    import uvicorn

    load()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
