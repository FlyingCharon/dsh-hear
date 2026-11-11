"""尺子：用小模型（SenseVoice 转写 + emotion2vec 判情绪）跑五条测试音频，
再拿 测试音频/标准答案.json 对照打分。

用法：
    <venv>\python.exe scripts\bench.py            # 跑全部
    <venv>\python.exe scripts\bench.py 01 03      # 只跑名字里含这些的

结果同时写 tmp/bench-<时间>.json，方便前后两轮对比。
"""

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "测试音频"
ANSWER = MEDIA / "标准答案.json"
OUT_DIR = ROOT / "tmp"


def load_engines():
    from funasr import AutoModel  # noqa: WPS433

    asr = AutoModel(
        model="iic/SenseVoiceSmall",
        hub="ms",
        device="cuda:0",
        disable_update=True,
        vad_model="fsmn-vad",
        vad_kwargs={"max_single_segment_time": 30000},
    )
    ser = AutoModel(model="iic/emotion2vec_plus_large", hub="ms", device="cuda:0", disable_update=True)
    return asr, ser


TAG = re.compile(r"<\|[^|]*\|>")


def transcribe(asr, path):
    res = asr.generate(
        input=str(path), language="auto", use_itn=True, merge_vad=True, merge_length_s=15, batch_size_s=60
    )
    raw = res[0].get("text", "") if res else ""
    # SenseVoice 会在句首塞 <|zh|><|NEUTRAL|><|Speech|> 这种标记，先摘出来再清掉
    marks = TAG.findall(raw)
    text = " ".join(TAG.sub("", raw).split())
    return text, marks


def emotion(ser, path):
    res = ser.generate(input=str(path), granularity="utterance", extract_embedding=False)
    if not res:
        return {}
    row = res[0]
    labels = row.get("labels") or []
    scores = row.get("scores") or []
    pairs = sorted(zip(labels, scores), key=lambda x: -x[1]) if labels and scores else []
    return {"labels": labels, "scores": scores, "top": pairs[0][0] if pairs else ""}


def score(answer, text, emo, duration):
    keywords = answer.get("期望转写关键词") or []
    hit = [k for k in keywords if k.replace(" ", "") in text.replace(" ", "")]
    tone_ok = None
    if answer.get("期望情绪") and emo.get("top"):
        tone_ok = any(k in emo["top"] for k in answer["期望情绪"])
    return {
        "关键词命中": f"{len(hit)}/{len(keywords)}" if keywords else "—",
        "命中项": hit,
        "情绪是否对上": tone_ok,
        "时长": round(duration, 2) if duration else None,
    }


def main(argv):
    answers = json.loads(ANSWER.read_text(encoding="utf-8"))
    picks = argv[1:]
    files = [p for p in sorted(MEDIA.iterdir()) if p.suffix.lower() in {".wav", ".mp3", ".silk"}]
    if picks:
        files = [p for p in files if any(k in p.name for k in picks)]
    if not files:
        print("没找到音频")
        return 1
    if not any(w in sys.executable for w in ("python",)):
        pass

    print("加载模型…", flush=True)
    started = time.time()
    asr, ser = load_engines()
    print(f"模型就绪，用了 {time.time() - started:.1f} 秒\n", flush=True)

    rows = []
    for path in files:
        t0 = time.time()
        text, marks = transcribe(asr, path)
        took_asr = time.time() - t0
        t1 = time.time()
        emo = emotion(ser, path)
        took_ser = time.time() - t1
        ans = answers.get(path.name, {})
        row = {
            "文件": path.name,
            "模式（标准）": ans.get("模式", ""),
            "转写": text,
            "句首标记": marks,
            "情绪": emo.get("top", ""),
            "情绪分布": list(zip(emo.get("labels", [])[:4], [round(s, 3) for s in emo.get("scores", [])[:4]])),
            "打分": score(ans, text, emo, None),
            "耗时": {"转写": round(took_asr, 2), "情绪": round(took_ser, 2)},
        }
        rows.append(row)
        print("=" * 60)
        print(f"{path.name}  （{row['耗时']['转写']}s 转写 / {row['耗时']['情绪']}s 情绪）")
        print(f"  期望：{ans.get('模式', '')}｜{ans.get('期望情绪', [])}｜关键词 {ans.get('期望转写关键词', [])}")
        print(f"  实际转写：{text}")
        print(f"  实际情绪：{row['情绪']}  {row['情绪分布']}")
        print(f"  打分：{row['打分']}")

    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / f"bench-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n结果存到 {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
