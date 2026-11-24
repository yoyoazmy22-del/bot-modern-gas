/* Modern Gas × AI — Backend (بدون صوت، بدون تبعيات، Node 18+)
   تشغيل:  node server.js
   الرابط: http://localhost:3456
   المفتاح مخفي في السيرفر فقط — مش بينزل للمتصفح أبداً.
*/
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildPrompt, buildRetrieved } = require("./knowledge.js");
const QA = require("./qa.js");

const PORT = 3456;
const HOST = "127.0.0.1";
const GEMINI_KEY = process.env.GEMINI_KEY || (function () {
  try { return fs.readFileSync(path.join(__dirname, "gemini_key.txt"), "utf-8").trim(); }
  catch (_) { return ""; }
})();
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

const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "X-Accel-Buffering": "no",
};

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

function logChat(user, bot) {
  if (!bot || !String(bot).trim()) return;
  try {
    fs.appendFileSync(path.join(__dirname, "chat_log.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), user: user, bot: String(bot).trim() }) + "\n");
  } catch (_) {}
}

/* ── خادم الملفات الثابتة ── */
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/" || urlPath === "/bot") urlPath = "/bot.html";
  const root = path.resolve(__dirname);
  const filePath = path.resolve(root, "." + urlPath);
  const rel = path.relative(root, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
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

async function askGemini(msg, history, res) {
  const qaBlock = QA.promptBlock();
  const retrieved = buildRetrieved(msg);
  const systemText = SYSTEM_PROMPT +
    (qaBlock ? "\n\n" + qaBlock : "") +
    (retrieved ? "\n\n" + retrieved : "");
  const contents = history.concat([{ role: "user", content: msg }])
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const body = {
    systemInstruction: { role: "system", parts: [{ text: systemText }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 450, topP: 0.92 },
  };

  let g = null, lastErr = "";
  for (const model of GEMINI_MODELS) {
    const streamUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + model +
      ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(GEMINI_KEY);
    try {
      g = await fetch(streamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (g.ok) break;
      const errBody = await g.json().catch(() => ({}));
      lastErr = (errBody.error && errBody.error.message) || ("HTTP " + g.status);
    } catch (e) {
      lastErr = e.message;
    }
  }
  if (!g || !g.ok) {
    throw new Error(lastErr || "Gemini unavailable");
  }

  const reader = g.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
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
        const txt = ((j.candidates && j.candidates[0] && j.candidates[0].content &&
          j.candidates[0].content.parts) || []).map((p) => p.text || "").join("");
        if (txt) { full += txt; res.write(txt); }
      } catch (_) {}
    }
  }
  return full.trim();
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

        /* 1) داتا الأسئلة: إجابة مؤكدة حتى لو السؤال اتسأل بصياغة تانية */
        const hit = QA.match(msg);
        if (hit && hit.answer) {
          res.writeHead(200, TEXT_HEADERS);
          res.end(hit.answer);
          logChat(msg, hit.answer);
          return;
        }

        /* 2) Gemini + استرجاع من المستندات */
        res.writeHead(200, TEXT_HEADERS);
        let full = "";
        try {
          full = await askGemini(msg, history, res);
        } catch (e) {
          /* الهيدرز اتبعتت بالفعل عشان البث — نكتب رسالة في الـ body */
        }
        if (!full) {
          full = "عذراً، خدمة الذكاء مشغولة دلوقتي. جرّب تاني بعد شوية.";
          res.write(full);
        }
        res.end();
        logChat(msg, full);
      } catch (e) {
        if (res.headersSent) { try { res.end(); } catch (_) {} }
        else sendJSON(res, 200, { reply: "عذراً، حصل خطأ: " + e.message, status: "error" });
      }
    });
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

  if (urlPath === "/ping") {
    sendJSON(res, 200, { status: "ok", qa: QA.count() });
    return;
  }

  if (urlPath === "/api/qa/reload" && req.method === "POST") {
    QA.reload();
    sendJSON(res, 200, { status: "ok", qa: QA.count() });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") { serveStatic(req, res); return; }

  res.writeHead(405); res.end("Method Not Allowed");
});

process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection:", (e && e.message) || e);
});
process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", (e && e.message) || e);
});

server.listen(PORT, HOST, () => {
  console.log("Modern Gas × AI bot running (text only):");
  console.log("  http://localhost:" + PORT);
  console.log("  Q&A pairs loaded: " + QA.count());
});
