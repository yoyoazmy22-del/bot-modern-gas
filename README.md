<div align="center">

# 🤖 Modern Gas Bot

### مساعد شركة الحديثة للغاز الطبيعي — بالعامية المصرية وبصوت طبيعي

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.8%2B-3776AB?logo=python&logoColor=white)](https://python.org)
[![Gemini](https://img.shields.io/badge/Gemini-Flash%20Lite-4285F4?logo=googlegemini&logoColor=white)](https://ai.google.dev)
[![Edge TTS](https://img.shields.io/badge/Voice-ar--EG%20Neural-0078D4)](https://github.com/rany2/edge-tts)
[![License](https://img.shields.io/badge/%D8%B9%D9%84%D8%A7%D9%85%D8%A9-%D9%85%D8%AD%D9%84%D9%8A%D8%A9%20%D9%84%D9%84%D8%B4%D8%B1%D9%83%D8%A9-lightgrey)](#)

</div>

---

## ✨ المميزات

| | |
|:--|:--|
| 🇪🇬 **صوت مصري طبيعي** | أصوات Edge Neural (`ar-EG-Shakir` / `Salma`) — من غير Google الآلي |
| ⚡ **أول كلمة بسرعة** | أول جملة بتتولّد وتتشغّل والباقي لسه بيولّد (بالتوازي) |
| 🔗 **ترتيب متواصل** | قطع الصوت بتتولّد بوابة ≤2 مع بعض فتظلّل الكلام متسلسل من غير وقفات |
| 🧠 **ردود من مستندات الشركة** | استرجاع تلقائي (RAG) من قاعدة المعرفة + Gemini |
| 📡 **بث فوري** | الرد بيظهر حرف حرف (SSE) والصوت يبدأ قبل ما الرد يخلص |
| 💾 **كاش صوت** | نفس الجملة مرة تانية = استجابة فورية (SHA-1 cache) |
| 🔄 **احتياطيات متعددة** | Edge → Azure (اختياري) → Gemini TTS → متصفح — مفيش مسار ميت |
| 🪶 **بدون فريمورك** | Node http عادي + عامل بايثون خفيف — لا Express ولا قاعدة بيانات |

## 🏗️ المعمارية

```mermaid
flowchart LR
    U["🧑 المستخدم"] --> W["bot.html<br/>واجهة + قطع صوت"]
    W -->|"POST /api/chat"| S["server.js"]
    S --> R["knowledge.js<br/>استرجاع BM25 عربي"]
    S -->|"SSE"| G["Gemini API"]
    W -->|"GET /api/speak"| T["مولّد الصوت"]
    T --> P["edge_client.js<br/>3 workers"]
    P --> PY["🐍 Python × 3<br/>edge-tts"]
    PY --> V["أصوات مصرية"]
    T --> C["tts_cache/"]
```

**دورة الرد:** سؤال → استرجاع المستندات المرتبطة → برومبت لـ Gemini → بث النص → تقطيعه لقطع صوتية متوازية → تشغيل مرتّب بالترتيب.

## 🚀 التشغيل

```bash
# 1) المتطلبات
pip install edge-tts

# 2) مفتاح Gemini (ملف محلي — مش على Git)
echo "YOUR_KEY_HERE" > gemini_key.txt

# 3) شغّل
node server.js          # أو: start-bot.bat
```

ثم افتح 👉 **http://localhost:3456**

> الملف الأساسي `bot.html` — لو مستضيف مع جيت هوب Pages أو cPanel، ارفع المجلد كله واكتب مفتاحك في `gemini_key.txt`.

## ⚙️ الإعداد

| متغير بيئة | الافتراضي | الوصف |
|:--|:--:|:--|
| `GEMINI_KEY` | — | مفتاح Gemini (أو ضعه في `gemini_key.txt`) |
| `EDGE_WORKERS` | `3` | عدد ووركرز توليد الصوت المتوازية |
| `EDGE_TIMEOUT_MS` | `20000` | مهلة المقطع الواحد قبل إعادة المحاولة |
| `EDGE_GRACE_MS` | `20000` | مهلة الصوت الطويل على المسار الاحتياطي |

**الأصوات:** `Charon` → رجالي · `Aoede`/`Kore` → نسائي — تتحدد من شريط الصوت في الواجهة.

## 📚 تحديث المعرفة

البوت مش مدرّب — بيقرأ من ملفاتك، وتحديثها فوري:

1. `knowledge.js` — الأسئلة/الأجوبة القصيرة (`KG` + `CS`)
2. `knowledge_docs.json` — نص المستندات الطويلة (التقارير السنوية… إلخ)

أي إضافة هنا تظهر في ردود البوت في نفس اللحظة — **بدون أي تدريب**.

## 📁 هيكل المشروع

```
├── bot.html              # الواجهة + منطق الصوت (تقطيع، بوابة، ترتيب)
├── server.js             # سيرفر HTTP + Gemini + توليد الصوت
├── knowledge.js          # قاعدة المعرفة + الاسترجاع (BM25 عربي)
├── knowledge_docs.json   # نصوص المستندات
├── edge_client.js        # بركة ووركرز الصوت (JSON على stdin/stdout)
├── edge_tts_worker.py    # عامل Edge TTS دائم
├── start-bot.bat         # تشغيل بنقرة واحدة (ويندوز)
└── gemini_key.txt        # 🔑 محلي فقط — خارج Git
```

## 🔐 أمان

- ✅ المفاتيح خارج الكود (متغيّرات بيئة / ملفات محجوبة)
- ✅ Push Protection مفعّل — Git يرفض رفع أي سر
- ⚠️ `chat_log.jsonl` محجوب عن Git — سجلات المحادثات تبقى محليًا

---

<div align="center">
<sub>صُنع بـ ❤️ لخدمة عملاء مودرن جاز</sub>
</div>
