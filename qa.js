/* Modern Gas — مطابق الأسئلة والأجوبة (فهم بالمعنى مش بالحرف)
   البيانات في qa_data.json بالشكل:
   [
     {
       "q": ["إزاي أتعاقد على الغاز؟", "عايز اشترك غاز لبيتك", "طريقة التعاقد"],
       "a": "الإجابة بالعامية المصرية..."
     }
   ]
   المطابقة بتشمل: مرادفات، تصريف، إعادة ترتيب، وغلط إملائي بسيط.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const K = require("./knowledge.js");

const QA_FILE = path.join(__dirname, "qa_data.json");
let QA = [];
let INDEX = [];

function reload() {
  let raw = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(QA_FILE, "utf-8"));
    if (Array.isArray(parsed)) raw = parsed;
  } catch (_) {
    raw = [];
  }
  QA = raw.filter((x) => x && x.a && String(x.a).trim() &&
    ((Array.isArray(x.q) && x.q.length) || (typeof x.s === "string" && x.s.trim())));
  INDEX = QA.map((entry, i) => {
    const questions = Array.isArray(entry.q) ? entry.q.slice() : [entry.s];
    if (entry.q && entry.s) questions.push(entry.s);
    const forms = questions
      .filter((q) => typeof q === "string" && q.trim())
      .map((q) => {
        const norm = K.normalizeAr(q);
        return { text: q, norm: norm, tokens: K.tokenize(q), set: K.docTokenSet(q) };
      });
    return { i, entry, forms };
  });
  watchFile();
}

/* إعادة قراءة تلقائية لما تتبدّل الداتا من غير ما نعيد تشغيل السيرفر */
let watching = false;
function watchFile() {
  if (watching) return;
  watching = true;
  try {
    const watcher = fs.watch(QA_FILE, () => {
      clearTimeout(reload._t);
      reload._t = setTimeout(reload, 200);
    });
    /* عشان الـ watch ما يخليش أي سكربت/اختبار شغال بعد ما يخلص */
    if (watcher && typeof watcher.unref === "function") watcher.unref();
  } catch (_) { /* بعض الأنظمة مش بتدعم watch — كافي إننا بنقرأ عند الإقلاع */ }
}

function weight(t) {
  return 1 + Math.log(1 + t.length);
}

/* الأكواد القصيرة زي E-3 / E-03 / E3: التطبيع العادي بيشيل الشرطة
   فيبقى e 3 والـ 3 حرف واحد فتتجاهل — هنا بنقارنها ككود مباشر. */
function codeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]/g, "")
    .replace(/([a-z])0+(?=\d)/g, "$1");
}

/* نتيجة المطابقة: answer + score + confidence */
function match(query, options) {
  options = options || {};
  const minScore = typeof options.minScore === "number" ? options.minScore : 2.8;
  const minCover = typeof options.minCover === "number" ? options.minCover : 0.5;
  const q = String(query || "").trim();
  if (!q || !INDEX.length) return null;

  /* مطابقة مباشرة للأكواد القصيرة قبل تحليل الكلمات */
  const ck = codeKey(q);
  if (/^[a-z0-9]{2,6}$/.test(ck)) {
    for (const item of INDEX) {
      for (const form of item.forms) {
        const fk = codeKey(form.text);
        if (/^[a-z0-9]{2,6}$/.test(fk) && fk === ck) {
          return {
            score: 12,
            cover: 1,
            answer: String(item.entry.a).trim(),
            question: item.entry.q || item.entry.s,
            entry: item.entry,
          };
        }
      }
    }
  }

  const qTokens = Array.from(new Set(K.tokenize(q)));
  if (!qTokens.length) return null;
  const nq = K.normalizeAr(q);
  let best = null;

  for (const item of INDEX) {
    let entryBest = 0, entryCover = 0;
    for (const form of item.forms) {
      let raw = 0, hits = 0;
      for (const t of qTokens) {
        const m = K.termMatchWeight(t, form.set);
        if (!m) continue;
        hits++;
        raw += weight(t) * m;
      }
      if (!hits) continue;
      const cover = hits / qTokens.length;
      const phrase = nq.length >= 4 && form.norm.indexOf(nq) !== -1 ? 1.6 : 1;
      const reverse = nq.length >= 4 && form.norm.length >= 4 && nq.indexOf(form.norm) !== -1 ? 1.75 : 1;
      /* كلمات السؤال الأصلية اللي ما اتقابلتش في صيغة السؤال = عقوبة بسيطة،
         مش رفض — عشان الأسئلة المطوّلة تفضل شغّالة */
      const score = raw * (0.35 + cover) * Math.max(phrase, reverse);
      if (score > entryBest) { entryBest = score; entryCover = cover; }
    }
    if (!entryBest) continue;
    if (!best || entryBest > best.score) best = {
      score: entryBest,
      cover: entryCover,
      answer: String(item.entry.a).trim(),
      question: item.entry.q || item.entry.s,
      entry: item.entry,
    };
  }

  if (!best) return null;
  if (best.score < minScore || best.cover < minCover) return null;
  return best;
}

/* نص يتحط في الـ system prompt عشان Gemini يستخدم نفس الداتا
   لو السؤال فيه جزء مش متغطّى بمطابقتنا المباشرة. */
function promptBlock() {
  if (!QA.length) return "";
  const lines = QA.map((e, i) => {
    const qs = Array.isArray(e.q) ? e.q : [e.s];
    return "[" + (i + 1) + "] سؤال: " + qs.join(" | ") + "\nالجواب: " + e.a;
  });
  return "قاعدة بيانات الأسئلة والأجوبة الرسمية (لو السؤال شبيه لأي سؤال هنا، أعطِ الجواب ده بعد تعديل بسيط في الصياغة فقط):\n\n" + lines.join("\n\n");
}

function count() { return QA.length; }

reload();

module.exports = { match, promptBlock, count, reload, QA: () => QA.slice() };
