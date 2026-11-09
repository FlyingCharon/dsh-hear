"""把音频转成 16k 单声道并按秒切段，给「分段听」用。

用法：python split_wav.py <输入> <输出目录> [每段秒数]
输出一行 JSON：{"dir": "...", "duration": 12.3, "chunks": [{"path": "...", "start": 0.0, "dur": 60.0}]}
"""
import io
import json
import os
import sys

import numpy as np

SR = 16000


def load_audio(path):
    with open(path, "rb") as f:
        head = f.read(16)
    if b"SILK" in head:
        import pysilk

        out = io.BytesIO()
        with open(path, "rb") as f:
            pysilk.decode(f, out, 24000)
        data = np.frombuffer(out.getvalue(), dtype=np.int16).astype(np.float32) / 32768.0
        sr = 24000
    else:
        import soundfile as sf

        data, sr = sf.read(path, dtype="float32", always_2d=False)
    data = np.asarray(data, dtype=np.float32)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != SR:
        n = int(round(data.size * SR / sr))
        idx = np.linspace(0, data.size - 1, n)
        data = np.interp(idx, np.arange(data.size), data).astype(np.float32)
    return data


def main():
    src, out_dir = sys.argv[1], sys.argv[2]
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0
    data = load_audio(src)
    import soundfile as sf

    os.makedirs(out_dir, exist_ok=True)
    step = max(10, int(seconds * SR))
    chunks = []
    for i, start in enumerate(range(0, data.size, step)):
        piece = data[start:start + step]
        if piece.size < SR * 0.5:
            continue
        path = os.path.join(out_dir, f"chunk_{i:03d}.wav")
        sf.write(path, piece, SR, subtype="PCM_16")
        chunks.append({"path": path, "start": round(start / SR, 2), "dur": round(piece.size / SR, 2)})
    print(json.dumps({"dir": out_dir, "duration": round(data.size / SR, 2), "chunks": chunks}, ensure_ascii=False))


if __name__ == "__main__":
    main()
