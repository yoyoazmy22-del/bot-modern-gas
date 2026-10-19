"""
عامل صوت دائم لأصوات Microsoft المصرية العصبية (Edge TTS).

بروتوكول الاتصال: كل سطر على stdin = طلب JSON، وكل سطر على stdout = رد JSON.
يعيش طويلاً عشان ما نتحملش تكلفة إقلاع Python (~2.9 ثانية) مع كل طلب.

    {"voice": "Charon", "out": "C:/path/x.mp3", "text": "..."}
    -> {"ok": true}
    -> {"ok": false, "err": "..."}
"""
import asyncio
import json
import os
import sys

import edge_tts

# أسماؤنا -> أصوات Microsoft المصرية
VOICE_MAP = {
    "Charon": "ar-EG-ShakirNeural",   # ذكر
    "Aoede": "ar-EG-SalmaNeural",     # أنثى
    "Kore": "ar-EG-SalmaNeural",      # أنثى
    "google": "ar-EG-ShakirNeural",   # احتياطي
}
DEFAULT_VOICE = "ar-EG-ShakirNeural"
RATE = "+0%"   # المعدّل الافتراضي — closer to natural than a speed boost


def synth(voice_key: str, out_path: str, text: str, rate: str | None) -> None:
    # voice_key ممكن يكون اسم Microsoft كامل (ar-EG-...) أو اسم ours
    name = voice_key if str(voice_key).startswith("ar-") else VOICE_MAP.get(voice_key, DEFAULT_VOICE)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    async def run() -> None:
        comm = edge_tts.Communicate(text, name, rate=rate or RATE)
        await comm.save(out_path)

    asyncio.run(run())
    if not os.path.exists(out_path) or os.path.getsize(out_path) < 512:
        raise RuntimeError("empty audio")


def main() -> None:
    # على ويندوز الافتراضي cp1256/cp1252 — لازم نقرا ونكتب UTF-8 صراحةً،
    # وإلا النص العربي بيتفكّ لـ surrogates مش صالحة ويرفضه encoder.
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="strict", newline="\n")
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    except Exception:
        pass

    while True:
        line = sys.stdin.readline()
        if not line:
            return  # the parent process died
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            synth(
                str(req.get("voice", "Charon")),
                str(req["out"]),
                str(req.get("text", "")),
                req.get("rate"),
            )
            sys.stdout.write(json.dumps({"ok": True}) + "\n")
        except Exception as e:  # noqa: BLE001 - نبلّغ الخطأ للـJS بدل ما نموت
            sys.stdout.write(json.dumps({"ok": False, "err": str(e)[:200]}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()