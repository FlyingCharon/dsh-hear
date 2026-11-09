"""鱼鱼的耳朵 · 听音频的后端服务

一个进程只加载一个模型，引擎由 HEAR_ENGINE 决定：

  qwen2audio   Qwen2-Audio-7B-Instruct（已实测）
  qwen2omni    Qwen2.5-Omni-3B / 7B（按官方用法写的，没实测）
  minicpm      MiniCPM-o-2_6 / int4（按官方用法写的，没实测）

环境变量：
  HEAR_ENGINE     引擎名，默认 qwen2audio
  HEAR_MODEL_DIR  模型目录
  HEAR_BITS       "4" / "8" / 空 = 不量化
"""

import os
import time

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MODEL_DIR = os.environ.get("HEAR_MODEL_DIR") or os.environ.get("QWEN_AUDIO_DIR") or ""
ENGINE = (os.environ.get("HEAR_ENGINE") or "qwen2audio").strip().lower()
try:
    BITS = int(os.environ.get("HEAR_BITS") or os.environ.get("QWEN_AUDIO_BITS") or "0")
except ValueError:
    BITS = 0
USE_4BIT = BITS == 4

app = FastAPI()
state = {"model": None, "processor": None, "load_error": None, "device": None}


class Unsupported(Exception):
    """这个模型还没接推理，不是坏了。"""


def quant_kwargs():
    """量化配置：4bit 用 nf4，8bit 跳过音频塔。"""
    if USE_4BIT:
        from transformers import BitsAndBytesConfig

        return {
            "quantization_config": BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
        }
    if BITS == 8:
        from transformers import BitsAndBytesConfig

        return {
            "quantization_config": BitsAndBytesConfig(
                load_in_8bit=True,
                llm_int8_skip_modules=["audio_tower", "multi_modal_projector", "thinker.audio_tower"],
            )
        }
    return {}


# ---------- 加载 ----------


def load_qwen2audio():
    from transformers import AutoProcessor, Qwen2AudioForConditionalGeneration

    model = Qwen2AudioForConditionalGeneration.from_pretrained(
        MODEL_DIR, device_map="auto", torch_dtype=torch.bfloat16, **quant_kwargs()
    )
    processor = AutoProcessor.from_pretrained(MODEL_DIR)
    return model, processor


def load_qwen2omni():
    from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor

    model = Qwen2_5OmniForConditionalGeneration.from_pretrained(
        MODEL_DIR, device_map="auto", torch_dtype=torch.bfloat16, **quant_kwargs()
    )
    processor = Qwen2_5OmniProcessor.from_pretrained(MODEL_DIR)
    return model, processor


def load_minicpm():
    from transformers import AutoModel, AutoTokenizer

    model = AutoModel.from_pretrained(
        MODEL_DIR,
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        init_vision=True,
        init_audio=True,
        init_tts=False,
        **quant_kwargs(),
    )
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
    return model, tokenizer


def load_glm4voice():
    raise Unsupported(
        "GLM-4-Voice 还没接：它要自带的 GlmTokenizer 和音频 tokenizer，接口跟通用 AutoProcessor 不一样，"
        "得单独写一层。模型可以先下载。"
    )


def load_stepaudio():
    raise Unsupported(
        "Step-Audio-2-mini 还没接：它的推理入口是自带的 chat 函数，输入格式也不同，需要单独适配。模型可以先下载。"
    )


def load_kimiaudio():
    raise Unsupported(
        "Kimi-Audio 还没接：它要装官方仓库那套 kimi-audio 包才能推，体积也大（42.6G）。模型可以先下载。"
    )


def load_unsupported():
    raise Unsupported("这个模型还没接推理，现在只支持下载和体检")


LOADERS = {
    "qwen2audio": load_qwen2audio,
    "qwen2omni": load_qwen2omni,
    "minicpm": load_minicpm,
    "glm4voice": load_glm4voice,
    "stepaudio": load_stepaudio,
    "kimiaudio": load_kimiaudio,
    "unsupported": load_unsupported,
}


def load():
    if state["model"] is not None:
        return
    if not MODEL_DIR or not os.path.isdir(MODEL_DIR):
        raise Unsupported(f"模型目录不存在或没配置：{MODEL_DIR or '（空）'}，去「模型」页下载并选中一个")
    loader = LOADERS.get(ENGINE)
    if loader is None:
        raise Unsupported(f"不认识的引擎：{ENGINE}")
    model, processor = loader()
    state["model"] = model
    state["processor"] = processor
    try:
        state["device"] = str(next(model.parameters()).device)
    except Exception:  # noqa: BLE001
        state["device"] = "cuda" if torch.cuda.is_available() else "cpu"


# ---------- 音频 ----------


def read_audio(path):
    data = None
    sr = None
    try:
        raw = open(path, "rb").read(16)
    except OSError:
        raw = b""
    if b"SILK" in raw:
        import io

        import pysilk

        out = io.BytesIO()
        with open(path, "rb") as f:
            pysilk.decode(f, out, 24000)
        arr = np.frombuffer(out.getvalue(), dtype=np.int16).astype("float32") / 32768.0
        data, sr = arr, 24000
    if data is None:
        data, sr = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        n = int(round(len(data) * 16000 / sr))
        idx = np.linspace(0, len(data) - 1, n)
        data = np.interp(idx, np.arange(len(data)), data).astype("float32")
    # 音量归一化：录音太小时模型容易把情绪听偏。
    rms = float(np.sqrt(np.mean(data ** 2) + 1e-12))
    if rms > 1e-6:
        data = data * (10 ** (-20 / 20) / rms)
        peak = float(np.max(np.abs(data)))
        if peak > 0.98:
            data = data * (0.98 / peak)
    return data


# ---------- 推理 ----------


def ask_qwen2audio(model, processor, path, audio, question):
    conversation = [
        {
            "role": "user",
            "content": [
                {"type": "audio", "audio_url": path},
                {"type": "text", "text": question},
            ],
        }
    ]
    prompt = processor.apply_chat_template(conversation, add_generation_prompt=True, tokenize=False)
    inputs = processor(text=prompt, audio=[audio], return_tensors="pt", padding=True)
    inputs = {k: v.to(model.device) for k, v in inputs.items() if hasattr(v, "to")}
    with torch.no_grad():
        out = model.generate(**inputs, max_new_tokens=256, do_sample=False)
    gen = out[:, inputs["input_ids"].shape[1]:]
    return processor.batch_decode(gen, skip_special_tokens=True)[0].strip()


def ask_qwen2omni(model, processor, path, audio, question):
    from qwen_omni_utils import process_mm_info

    conversation = [
        {
            "role": "user",
            "content": [
                {"type": "audio", "audio": path},
                {"type": "text", "text": question},
            ],
        }
    ]
    text = processor.apply_chat_template(
        conversation, add_generation_prompt=True, tokenize=False, use_audio_in_video=False
    )
    audios, images, videos = process_mm_info(conversation, use_audio_in_video=False)
    inputs = processor(
        text=text,
        audio=audios,
        images=images,
        videos=videos,
        return_tensors="pt",
        padding=True,
        use_audio_in_video=False,
    )
    inputs = inputs.to(model.device).to(model.dtype)
    with torch.no_grad():
        ids = model.generate(
            **inputs,
            use_audio_in_video=False,
            max_new_tokens=256,
            do_sample=False,
        )
    if isinstance(ids, tuple):
        ids = ids[0]
    prompt_len = inputs["input_ids"].shape[1] if "input_ids" in inputs else 0
    return processor.batch_decode(ids[:, prompt_len:], skip_special_tokens=True)[0].strip()


def ask_minicpm(model, processor, path, audio, question):
    msgs = [{"role": "user", "content": [path, question]}]
    res = model.chat(
        msgs=msgs,
        tokenizer=processor,
        sampling=False,
        max_new_tokens=256,
        use_tts_template=False,
        generate_audio=False,
    )
    return str(res).strip()


ASKERS = {
    "qwen2audio": ask_qwen2audio,
    "qwen2omni": ask_qwen2omni,
    "minicpm": ask_minicpm,
}


# ---------- 接口 ----------


@app.get("/health")
def health():
    return {
        "ok": state["model"] is not None,
        "engine": ENGINE,
        "supported": ENGINE in ASKERS,
        "device": state["device"],
        "four_bit": USE_4BIT,
        "error": state["load_error"],
        "model_dir": MODEL_DIR,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }


@app.post("/hear")
async def hear(req: Request):
    try:
        if ENGINE not in ASKERS:
            raise Unsupported(f"这个引擎还没接：{ENGINE}")
        if state["model"] is None:
            load()
    except Unsupported as e:
        state["load_error"] = str(e)
        return JSONResponse({"ok": False, "unsupported": True, "error": str(e)}, status_code=501)
    except Exception as e:  # noqa: BLE001
        state["load_error"] = repr(e)
        return JSONResponse({"ok": False, "error": repr(e)}, status_code=500)

    body = await req.json()
    path = body.get("path")
    question = body.get("question") or "这段音频说了什么？请把原话转写出来，并说说说话人的语气与情绪。"
    if not path or not os.path.exists(path):
        return JSONResponse({"ok": False, "error": f"no such file: {path}"}, status_code=400)

    audio = read_audio(path)
    t0 = time.time()
    try:
        answer = ASKERS[ENGINE](state["model"], state["processor"], path, audio, question)
    except torch.cuda.OutOfMemoryError:
        state["model"] = None
        state["processor"] = None
        torch.cuda.empty_cache()
        return JSONResponse({"ok": False, "error": "显存不够，模型已卸下；换个小的模型或者先关掉语音合成"}, status_code=507)
    return {
        "ok": True,
        "engine": ENGINE,
        "answer": answer,
        "secs": round(time.time() - t0, 2),
        "sample_seconds": round(len(audio) / 16000, 2),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("HEAR_PORT") or os.environ.get("QWEN_AUDIO_PORT", "8779")), log_level="info")
