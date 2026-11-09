"""
dsh-hear 的数值块：用硬件证据核对模型的主观听感。

只依赖 numpy + soundfile（silk 走 pysilk），输出一行 JSON 到 stdout：
基频、能量、频谱重心、停顿分布、首尾静音。

用法：python analyze.py <音频路径>
"""
import io
import json
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
    if data.size == 0:
        raise ValueError("空音频")
    if sr != SR:
        n = int(round(data.size * SR / sr))
        idx = np.linspace(0, data.size - 1, n)
        data = np.interp(idx, np.arange(data.size), data).astype(np.float32)
    return data


def frames(signal, size, hop):
    if signal.size < size:
        signal = np.pad(signal, (0, size - signal.size))
    count = 1 + (signal.size - size) // hop
    idx = np.arange(size)[None, :] + hop * np.arange(count)[:, None]
    return signal[idx]


def rms_db(signal):
    win = frames(signal, 400, 160)
    rms = np.sqrt(np.mean(win ** 2, axis=1) + 1e-12)
    return 20.0 * np.log10(rms + 1e-12), 160


def pitch_track(signal):
    size, hop = 1024, 320
    win = frames(signal, size, hop)
    win = win * np.hanning(size)[None, :]
    spec = np.fft.rfft(win, n=2048, axis=1)
    ac = np.fft.irfft(np.abs(spec) ** 2, axis=1)[:, :size]
    ac = ac / (ac[:, :1] + 1e-9)
    lo, hi = int(SR / 450), int(SR / 60)
    seg = ac[:, lo:hi]
    lag = np.argmax(seg, axis=1) + lo
    conf = seg[np.arange(seg.shape[0]), np.argmax(seg, axis=1)]
    f0 = SR / lag.astype(np.float32)
    return f0, conf, hop


def centroid_track(signal):
    size, hop = 512, 160
    win = frames(signal, size, hop) * np.hanning(512)[None, :]
    spec = np.abs(np.fft.rfft(win, axis=1))
    freqs = np.fft.rfftfreq(size, 1.0 / SR)
    total = spec.sum(axis=1) + 1e-9
    cent = (spec * freqs[None, :]).sum(axis=1) / total
    return cent


def pauses(rms, hop, floor_db):
    quiet = rms < floor_db
    runs = []
    start = None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        elif not q and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(quiet)))
    found = []
    for a, b in runs:
        dur = (b - a) * hop / SR
        if dur >= 0.22:
            found.append({"start": round(a * hop / SR, 2), "end": round(b * hop / SR, 2), "dur": round(dur, 2)})
    return found


def text_of(signal, rms_db_track):
    peak = float(np.max(np.abs(signal)))
    return 20.0 * np.log10(peak + 1e-12)


def main():
    path = sys.argv[1]
    signal = load_audio(path)
    duration = signal.size / SR

    rms, hop = rms_db(signal)
    floor = max(float(np.percentile(rms, 95)) - 35.0, -55.0)
    pause_list = pauses(rms, hop, floor)

    f0, conf, fhop = pitch_track(signal)
    n = conf.size
    idx = np.minimum((np.arange(n) * fhop) // hop, rms.size - 1)
    speech = rms[idx]
    voiced = (conf > 0.45) & (speech > floor)
    f0v = f0[voiced]
    if f0v.size:
        f0v = f0v[(f0v >= 60) & (f0v <= 450)]

    cent = centroid_track(signal)

    result = {
        "ok": True,
        "duration_s": round(duration, 2),
        "peak_db": round(text_of(signal, rms), 1),
        "rms_db_mean": round(float(np.mean(rms)), 1),
        "rms_db_std": round(float(np.std(rms)), 1),
        "floor_db": round(floor, 1),
        "f0_median_hz": round(float(np.median(f0v)), 1) if f0v.size else None,
        "f0_std_hz": round(float(np.std(f0v)), 1) if f0v.size else None,
        "f0_min_hz": round(float(np.min(f0v)), 1) if f0v.size else None,
        "f0_max_hz": round(float(np.max(f0v)), 1) if f0v.size else None,
        "voiced_ratio": round(float(np.mean(voiced)), 3) if voiced.size else 0.0,
        "centroid_mean_hz": round(float(np.mean(cent)), 0),
        "centroid_std_hz": round(float(np.std(cent)), 0),
        "centroid_p95_hz": round(float(np.percentile(cent, 95)), 0),
        "pause_count": len(pause_list),
        "pause_total_s": round(sum(p["dur"] for p in pause_list), 2),
        "pause_ratio": round(sum(p["dur"] for p in pause_list) / duration, 3) if duration else 0.0,
        "longest_pause_s": round(max([p["dur"] for p in pause_list], default=0.0), 2),
        "pauses": pause_list[:10],
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
        sys.exit(0)
