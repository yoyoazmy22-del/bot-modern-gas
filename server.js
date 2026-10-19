/* Modern Gas × AI — Backend (zero dependencies, Node 18+)
   تشغيل:  node server.js
   الرابط: http://localhost:3456
   المفتاح مخفي في السيرفر فقط — مش بينزل للمتصفح أبداً.
*/
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { buildPrompt, buildRetrieved } = require("./knowledge.js");

const PORT = 3456;
const HOST = "127.0.0.1";
const ttsCache = new Map();
const ttsDir = path.join(__dirname, "tts_cache");
try { if (!fs.existsSync(ttsDir)) fs.mkdirSync(ttsDir); } catch (_) {}
const GEMINI_KEY = process.env.GEMINI_KEY || (function () { try { return fs.readFileSync(path.join(__dirname, "gemini_key.txt"), "utf-8").trim(); } catch (_) { return ""; } })();
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-3.6-flash"];

const SYSTEM_PROMPT = buildPrompt();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".webp": "image/webp",
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

/* ── Azure TTS: صوت مصري طبيعي (Salma/Shakir) — الأولوية القصوى ── */
const AZURE_KEY = "";                       // ضع مفتاح Azure هنا تفعّل الصوت المصري
const AZURE_REGION = "eastus";             // منطقة Speech resource تبعك
const AZURE_VOICES = { Charon: "ar-EG-ShakirNeural", Aoede: "ar-EG-SalmaNeural", Kore: "ar-EG-SalmaNeural" };

/* ── Gemini TTS: صوت طبيعي عبر التوليد المتوازي ── */
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const TTS_VOICE = "Charon";
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function geminiTtsPcm(text, voice) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + TTS_MODEL +
    ":generateContent?key=" + encodeURIComponent(GEMINI_KEY);
  const body = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || TTS_VOICE } } },
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || ("HTTP " + r.status));
  const part = d.candidates && d.candidates[0] && d.candidates[0].content &&
    d.candidates[0].content.parts && d.candidates[0].content.parts[0];
  if (!part || !part.inlineData) throw new Error("استجابة صوتية فارغة");
  const m = /rate=(\d+)/.exec(part.inlineData.mimeType || "");
  const rate = m ? parseInt(m[1], 10) : 24000;
  return { pcm: Buffer.from(part.inlineData.data, "base64"), rate: rate };
}
function geminiTtsChunks(text, max) {
  max = max || 100;
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return [clean];
  const parts = clean.split(/(?<=[.!؟?])\s+/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + " " + p).trim().length <= max) { cur = (cur + " " + p).trim(); }
    else {
      if (cur) out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}
/* Gemini TTS المجاني = 10 نداءات/يوم. أول ما يكتشف نفاد الحصة (429) بنعطّله
   لبقية عمر السيرفر عشان ما نضيّعش latency في كل طلب. */
let geminiTtsDeadUntil = 0;
function geminiTtsBlocked() {
  return Date.now() < geminiTtsDeadUntil;
}
function noteGeminiTtsFailure(err) {
  const msg = String((err && err.message) || "");
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    geminiTtsDeadUntil = Date.now() + 16 * 60 * 60 * 1000;
  }
}

async function geminiTtsWav(text, voice) {
  if (geminiTtsBlocked()) throw new Error("gemini tts quota blocked");
  try {
    const chunks = geminiTtsChunks(text, 100);
    const raws = await Promise.all(chunks.map((c) => geminiTtsPcm(c, voice)));
    const rate = raws[0] ? raws[0].rate : 24000;
    const pcm = Buffer.concat(raws.map((x) => x.pcm));
    return pcmToWav(pcm, rate);
  } catch (e) {
    noteGeminiTtsFailure(e);
    throw e;
  }
}

/* ── Azure TTS: صوت مصري طبيعي، بيُفعّل لو في مفتاح ── */
async function azureTtsMp3(text, voice) {
  const az_voice = AZURE_VOICES[voice] || "ar-EG-ShakirNeural";
  const ssml = '<?xml version="1.0" encoding="utf-8"?>' +
    '<speak version="1.0" xml:lang="ar-EG" xmlns="http://www.w3.org/2001/10/synthesis">' +
    '<voice name="' + az_voice + '">' + escapeHtsml(text) + '</voice></speak>';
  const url = "https://" + AZURE_REGION + ".tts.speech.microsoft.com/cognitiveservices/v1";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": AZURE_KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "ModernGasAIBot/1.0",
    },
    body: ssml,
  });
  if (!r.ok) throw new Error("Azure TTS " + r.status + " " + (r.statusText || ""));
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}
function escapeHtsml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function azureActive() {
  return typeof AZURE_KEY === "string" && AZURE_KEY.trim().length > 0;
}

/* ── توليد في الخلفية: الصوت الطبيعي يتحضّر ويُحفظ في الكاش ── */
const backgroundJobs = new Set();
async function generateAndCache(text, voice) {
  const key = (voice + "::" + text.trim()).slice(0, 240);
  const hashKey = crypto.createHash("sha1").update(key).digest("hex");
  const df = path.join(ttsDir, hashKey + ".bin");
  if (fs.existsSync(df)) return;
  try {
    const ctype = (voice !== "google" && azureActive()) ? "audio/mpeg" : "audio/wav";
    const buf = (voice !== "google" && azureActive())
      ? await azureTtsMp3(text.trim(), voice)
      : await geminiTtsWav(text.trim(), voice);
    fs.writeFileSync(df, buf);
    fs.writeFileSync(path.join(ttsDir, hashKey + ".mime"), ctype);
    ttsCache.set(key, buf);
  } catch (_) {
    /* حصة مش متاحة — الحصة المجانية بتتعافى مرة في اليوم، فنجرب كل 30 دقيقة */
    setTimeout(() => generateAndCache(text, voice), 30 * 60 * 1000);
  }
}
function queueBackground(text, voice) {
  const jobKey = voice + "::" + text;
  if (backgroundJobs.has(jobKey)) return;
  backgroundJobs.add(jobKey);
  generateAndCache(text, voice).finally(() => backgroundJobs.delete(jobKey));
}

/* تسخين مسبق: Edge TTS مالوش حصة يومية، فبنحضّر أهم جُمل عند الإقلاع
   عشان أول مرة تسمعها تبقى فورية بدل 2-4 ثواني.
   الترحيبات دي بنتحملها بالكاش لأن أول جملة في كل رد بتكون ترحيب،
   فبتخبط في الكاش → الصوت بيبدأ في ~30ms بدل 2.4ث. */
const WARMUP_GREETINGS = [
  "أهلاً بيك في مودرن جاز!",
  "أهلاً بحضرتك!",
  "أهلاً بيك يا فندم!",
  "أهلاً وسهلاً بيك في مودرن جاز!",
  "أهلاً بك في مودرن جاز.",
  "تحت أمرك في أي استفسار تاني.",
];
const WARMUP_PHRASES = [];
for (const g of WARMUP_GREETINGS) WARMUP_PHRASES.push(["Charon", g]);
for (const g of WARMUP_GREETINGS) WARMUP_PHRASES.push(["Aoede", g]);
setTimeout(() => {
  (async () => {
    for (const [v, t] of WARMUP_PHRASES) {
      try { await prefetchSpeak(v, t); } catch (_) {}
    }
  })();
}, 1200);
async function googleTtsMp3(text) {
  const url = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ar&q=" +
    encodeURIComponent(text.slice(0, 180));
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Referer": "https://translate.google.com/",
      "Accept": "audio/mpeg, */*",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error("google tts HTTP " + r.status);
  return Buffer.from(await r.arrayBuffer());
}
/* تحضير مسبق: يملأ نفس مفاتيح كاش /api/speak بالترتيب Edge ← Azure.
   مهم: Gemini مش في الترتيب هنا — ح cappته 10 نداءات/يوم وهنحرقها
   لو التسخين مرّ عليها. التسخين للEdge المجاني بس. */
async function prefetchSpeak(voice, text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  const key = (voice + "::" + clean).slice(0, 240);
  const hashKey = crypto.createHash("sha1").update(key).digest("hex");
  const bin = path.join(ttsDir, hashKey + ".bin");
  const mime = path.join(ttsDir, hashKey + ".mime");
  if (fs.existsSync(bin) && fs.existsSync(mime) && fs.statSync(bin).size > 512) return;
  let buf = null, ctype = "audio/mpeg";
  if (voice !== "google") {
    try { buf = await edgeTtsMp3(clean, voice, ttsDir); ctype = "audio/mpeg"; } catch (_) {}
  }
  if (!buf && voice !== "google" && azureActive()) {
    try { buf = await azureTtsMp3(clean, voice); ctype = "audio/mpeg"; } catch (_) {}
  }
  if (!buf || buf.length <= 512) return;
  try {
    fs.writeFileSync(bin, buf);
    fs.writeFileSync(mime, ctype);
    ttsCache.set(key, buf);
  } catch (_) {}
}

/* احتياطي كامل: Google يقبل 180 حرف لكل طلب — نقسم ونولّد متوازي ثم نجمع */
async function googleTtsFull(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("empty");
  const parts = [];
  for (let i = 0; i < clean.length; i += 170) parts.push(clean.slice(i, i + 170));
  const bufs = await Promise.all(parts.map((p) => googleTtsMp3(p)));
  return Buffer.concat(bufs);
}

/* ── Edge TTS: أصوات Microsoft المصرية العصبية (مجانية، بلا حصة يومية) ── */
const { edgeTtsMp3, edgeTtsRate } = require("./edge_client");

/* لو Edge ما وصلش قبل جوجل، نحضّره في الخلفية المرة دي عشان المرة الجاية
   تطلع فوراً. بنحمي نفس الجملة من التكرار، وبنجدد الكاش الأصلي بصوت Edge. */
const edgeBgBusy = new Set();
function queueEdgeInBackground(text, voice) {
  const key = voice + "::" + text;
  if (edgeBgBusy.has(key)) return;
  edgeBgBusy.add(key);
  const crypto = require("crypto");
  const hashKey = crypto.createHash("sha1").update(key).digest("hex");
  setTimeout(async () => {
    try {
      const buf = await edgeTtsMp3(text, voice, ttsDir);
      if (buf && buf.length > 512) {
        fs.writeFileSync(path.join(ttsDir, hashKey + ".bin"), buf);
        fs.writeFileSync(path.join(ttsDir, hashKey + ".mime"), "audio/mpeg");
        ttsCache.set(key, buf);
      }
    } catch (_) {
      /* فشلت — المرة الجاية هيحاول تاني */
    } finally {
      edgeBgBusy.delete(key);
    }
  }, 60);
}

/* مهلة Edge قبل ما نرجع لجوجل: Edge لو مش هيتعبّط بيلفّ بسرعة، ولو
   Microsoft's بتخنقه (throttle) مش هنعطّل المستخدم. */
const EDGE_GRACE_MS = Number(process.env.EDGE_GRACE_MS || 20000);

/* chain = ترتيب التفضيل (بنجربهم بالتوازي). أول واحد يرد بنجاح هو الفائز.
   فشل واحد ما بيوقّش الباقي. لو فشلوا كلهم أو عدّت المهلة → يرمي. */
async function raceChain(chain, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    let pending = chain.length;
    let lastErr = new Error("tts: no providers");
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(lastErr);
    }, ms);
    for (const p of chain) {
      p.then(
        (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        (e) => {
          lastErr = e;
          if (done) return;
          pending -= 1;
          if (pending === 0) { done = true; clearTimeout(timer); reject(e); }
        }
      );
    }
  });
}

/* ── خادم الملفات الثابتة ── */
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/bot.html";
  if (urlPath === "/bot") urlPath = "/bot.html";
  const filePath = path.join(__dirname, urlPath);
  const root = path.resolve(__dirname);
  if (!filePath.startsWith(root)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ملف مش موجود: " + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "POST" && urlPath === "/api/chat") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 200000) req.destroy(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(raw || "{}");
        const msg = (data.message || "").trim();
        const history = Array.isArray(data.history) ? data.history.slice(-8) : [];
        if (!msg) {
          sendJSON(res, 200, { reply: "ممكن تبعتلي سؤالك عن خدمات مودرن جاس؟", status: "ok" });
          return;
        }
        /* ستريمينج الرد: أول الكلام يظهر خلال ثوانٍ */
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "X-Accel-Buffering": "no",
        });
        const contents = history.concat([{ role: "user", content: msg }])
          .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        const body = {
          systemInstruction: { role: "system", parts: [{ text: SYSTEM_PROMPT + "\n\n" + buildRetrieved(msg) }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 450, topP: 0.92 },
        };
        let g = null, usedModel = "", lastErr = "";
        for (const model of GEMINI_MODELS) {
          const streamUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + model +
            ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(GEMINI_KEY);
          try {
            g = await fetch(streamUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            usedModel = model;
            if (g.ok) break;
            const errBody = await g.json().catch(() => ({}));
            lastErr = (errBody.error && errBody.error.message) || ("HTTP " + g.status);
            /* جرّب النموذج اللي بعده */
            continue;
          } catch (e) { lastErr = e.message; continue; }
        }
        if (!g || !g.ok) {
          res.end("عذراً، خدمة الذكاء مشغولة دلوقتي. جرّب تاني بعد شوية.");
          return;
        }
        const reader = g.body.getReader();
        const dec = new TextDecoder();
        let buf = "", full = "";
        let sentHeader = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split(/\r?\n\r?\n/);
          buf = parts.pop();
          for (const part of parts) {
            const line = part.split(/\r?\n/).find((l) => l.startsWith("data: "));
            if (!line) continue;
            const rawData = line.slice(6).trim();
            if (!rawData || rawData === "[DONE]") continue;
            try {
              const j = JSON.parse(rawData);
              const txt = (j.candidates && j.candidates[0] && j.candidates[0].content &&
                j.candidates[0].content.parts || []).map((p) => p.text || "").join("");
              if (txt) { full += txt; res.write(txt); }
            } catch (_) {}
          }
        }
        res.end();
        /* تسجيل المحادثة محلياً */
        if (full.trim()) {
          try {
            fs.appendFileSync(path.join(__dirname, "chat_log.jsonl"),
              JSON.stringify({ ts: new Date().toISOString(), user: msg, bot: full.trim() }) + "\n");
          } catch (_) {}
        }
      } catch (e) {
        if (res.headersSent) { try { res.end(); } catch (_) {} }
        else sendJSON(res, 200, { reply: "عذراً، حصل خطأ: " + e.message, status: "error" });
      }
    });
    return;
  }

  if (req.method === "GET" && urlPath === "/api/speak") {
    const u = new URL(req.url, "http://x");
    const q = u.searchParams.get("text") || "";
    const voice = u.searchParams.get("voice") || TTS_VOICE;
    if (!q) { sendJSON(res, 400, { error: "missing text" }); return; }
    const edgeVoice = u.searchParams.get("edgeVoice") || "";
    if (edgeVoice) {
      try {
        const b = await edgeTtsRate(q.trim(), edgeVoice, u.searchParams.get("rate") || "+0%", ttsDir);
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": b.length,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "X-TTS-Provider": "edge-test",
        });
        res.end(b);
        return;
      } catch (e) {
        res.writeHead(502); res.end("tts error: " + e.message);
        return;
      }
    }
    const realKey = (voice + "::" + q.trim()).slice(0, 240);
    let cacheKey = realKey;
    /* لو الصوت المطلوب طبيعي لكن اللي موجود هو احتياطي جوجل: مفتاح مختلف */
    if (voice !== "google") {
      const diskTry = fs.existsSync(path.join(ttsDir, crypto.createHash("sha1").update(realKey).digest("hex") + ".bin"));
      if (!diskTry && !ttsCache.has(realKey) && ttsCache.has("google::" + q.trim().slice(0, 240))) {
        cacheKey = "google::" + q.trim().slice(0, 240);
      }
    }
    const hashKey = crypto.createHash("sha1").update(cacheKey).digest("hex");
    const diskFile = path.join(ttsDir, hashKey + ".bin");
    const diskMeta = path.join(ttsDir, hashKey + ".mime");
    /* 1) كاش القرص */
    if (fs.existsSync(diskFile) && fs.existsSync(diskMeta)) {
      const buf = fs.readFileSync(diskFile);
      const ctype = fs.readFileSync(diskMeta, "utf-8").trim() || "audio/wav";
      res.writeHead(200, {
        "Content-Type": ctype,
        "Content-Length": buf.length,
        "Cache-Control": "public, max-age=604800",
        "Access-Control-Allow-Origin": "*",
        "X-From-Cache": "1",
        "X-TTS-Provider": "cache",
      });
      res.end(buf);
      return;
    }
    /* 2) كاش الذاكرة */
    if (ttsCache.has(cacheKey)) {
      const buf = ttsCache.get(cacheKey);
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": buf.length,
        "Cache-Control": "public, max-age=604800",
        "Access-Control-Allow-Origin": "*",
        "X-From-Cache": "1",
      });
      res.end(buf);
      return;
    }
    let buf = null, ctype = "audio/wav";
    let provider = "none";
    /* 3) السلسلة: Edge (مجاني، أصوات مصرية عصبية) ← Gemini (بسقف يومي)
          ← Azure. جوجل آخر ملجأ بسSpeed بتاعه أعلى من كلهم.
          لو Edge اتأخر أكتر من EDGE_GRACE_MS بنسلّم جوجل فوراً. */
    const useAzure = voice !== "google" && azureActive();
    if (voice === "google") {
      try {
        buf = await googleTtsFull(q.trim());
        ctype = "audio/mpeg";
        provider = "google";
      } catch (e2) {
        res.writeHead(502); res.end("tts error: " + e2.message);
        return;
      }
    } else {
      /* Edge (المصري العصبي) هو الأساس. بنستناه لحد EDGE_GRACE_MS — لو ردّ
         رجع صوته الطبيعي. لو اتأخر بنسلّم جوجل فورًا بدل ما نخلي المستخدم
         يستنى، وبنخزّن Edge بالخلفية للمرة الجاية. */
      let googleP = null;
      const needGoogle = () => {
        if (!googleP) {
          googleP = googleTtsFull(q.trim()).then((b) => ({
            buf: b, provider: "google", ctype: "audio/mpeg",
          }));
        }
        return googleP;
      };
      const chain = useAzure
        ? [azureTtsMp3(q.trim(), voice).then((b) => ({ buf: b, provider: "azure", ctype: "audio/mpeg" }))]
        : [edgeTtsMp3(q.trim(), voice, ttsDir).then((b) => ({ buf: b, provider: "edge", ctype: "audio/mpeg" }))];
      try {
        const win = await raceChain(chain, EDGE_GRACE_MS);
        buf = win.buf;
        ctype = win.ctype;
        provider = win.provider;
      } catch (e) {
        /* Edge فشل أو اتأخر → Gemini (لو الحصة لسه موجودة) → جوجل.
           ملاحظة: Gemini حارّصوت مختلف، فخليها آخر حاجة مش منافسة. */
        try {
          buf = await geminiTtsWav(q.trim(), voice);
          ctype = "audio/wav";
          provider = "gemini";
        } catch (e1) {
          try {
            const g = await needGoogle();
            buf = g.buf; ctype = g.ctype; provider = g.provider;
          } catch (e2) {
            res.writeHead(502); res.end("tts error: " + (e2.message || e.message));
            return;
          }
        }
      }
      if (provider === "google") queueEdgeInBackground(q.trim(), voice);
    }
    /* حفظ في كلا الكاشين (بالنوع الصح) */
    try {
      fs.writeFileSync(diskFile, buf);
      fs.writeFileSync(diskMeta, ctype);
    } catch (_) {}
    if (ttsCache.size >= 500) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
    ttsCache.set(cacheKey, buf);
    res.writeHead(200, {
      "Content-Type": ctype,
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=604800",
      "Access-Control-Allow-Origin": "*",
      "X-TTS-Provider": provider,
    });
    res.end(buf);
    return;
  }

  if (req.method === "GET" && urlPath === "/api/log") {
    try {
      const lines = fs.readFileSync(path.join(__dirname, "chat_log.jsonl"), "utf-8")
        .split("\n").filter(Boolean).slice(-50);
      sendJSON(res, 200, { count: lines.length, log: lines.map((l) => JSON.parse(l)) });
    } catch (_) {
      sendJSON(res, 200, { count: 0, log: [] });
    }
    return;
  }

  if (urlPath === "/ping") { sendJSON(res, 200, { status: "ok" }); return; }

  if (req.method === "GET" || req.method === "HEAD") { serveStatic(req, res); return; }

  res.writeHead(405); res.end("Method Not Allowed");
});

/* رفض promises مش متوقع ما يوقفلش السيرفر — خاصة مع سباق المزوّدات */
process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection:", (e && e.message) || e);
});
process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", (e && e.message) || e);
});

server.listen(PORT, HOST, () => {
  console.log("Modern Gas × AI bot running:");
  console.log("  http://localhost:" + PORT);
  if (azureActive()) console.log("  (TTS: Azure طبيعي + جوجل احتياطي)");
  else console.log("  (API key مخفي جوه السيرفر)");
});