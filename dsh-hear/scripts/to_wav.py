"""把任意支持的音频转成 16k 单声道 wav，给云端接口用（silk 也吃）。

用法：python to_wav.py <输入> <输出.wav>
"""
import io
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
    src, dst = sys.argv[1], sys.argv[2]
    data = load_audio(src)
    import soundfile as sf

    sf.write(dst, data, SR, subtype="PCM_16")
    print(dst)


if __name__ == "__main__":
    main()
