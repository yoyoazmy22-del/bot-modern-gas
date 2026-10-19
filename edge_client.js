/* عميل Edge TTS: أصوات Microsoft المصرية العصبية (مجانية، بلا حصة يومية).
  ，几个 Python workers دائمين بيتكلموا JSON على stdin/stdout عشان ما نتحملش
   ~2s إقلاع Python مع كل مقطع.
   قياس حقيقي: 4 نصوص ورا بعض = 7.2ث، ونفس الـ4 بـ workers متوازيين = 2.1ث.
   عشان كده بنشغّل عدة workers، ومفيش أي spacing بينهم.
   يُصدّر: edgeTtsMp3(text, voice, outDir) و edgeTtsRate(...) للمعاينة. */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

/* مهلة المقطع الواحد. لو تجاوزها CrackEdge = dead request، فبنقتل الـworker
   (لازم نقتله عشان ردّه المتأخر ما يتنسبش لمقطع تاني) ونshedgedGGG 请求. */
const JOB_TIMEOUT_MS = Number(process.env.EDGE_TIMEOUT_MS || 20000);
const WORKERS = Math.max(1, Number(process.env.EDGE_WORKERS || 3));

const pool = [];
let started = false;

function makeWorker() {
  const script = path.join(__dirname, "edge_tts_worker.py");
  const proc = spawn("python", ["-u", script], { stdio: ["pipe", "pipe", "ignore"] });
  const w = { proc, busy: false, current: null, timer: null, queue: [], dead: false };
  let buf = "";

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const job = w.current;
      if (!job) continue;
      w.current = null;
      w.busy = false;
      if (job.timer) clearTimeout(job.timer);
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.ok) job.resolve();
        else job.reject(new Error("edge: " + ((parsed && parsed.err) || "bad response")));
      } catch (e) {
        job.reject(new Error("edge: invalid json"));
      }
      pump();
    }
  });

  proc.on("exit", () => { w.dead = true; });
  proc.on("error", () => { w.dead = true; });

  /* قتل الـworker = الرجوع للـqueue: ما نخسرش الطلب */
  w.kill = function () {
    if (w.dead) return;
    w.dead = true;
    try { proc.kill(); } catch (_) {}
    const job = w.current;
    w.current = null;
    w.busy = false;
    if (job && job.timer) clearTimeout(job.timer);
    if (job) requeue(job);
    w.queue.forEach(requeue);
    w.queue.length = 0;
    pump();
  };
  return w;
}

function requeue(job) {
  job.attempts = (job.attempts || 0) + 1;
  if (job.attempts > 4) { job.reject(new Error("edge: giving up")); return; }
  /* وزّع على أي worker تاني */
  pool.forEach(function (w) {
    if (!w.dead && !w.busy && !w.current) { w.queue.push(job); return; }
  });
  if (!pool.some(function (w) { return !w.dead && w.queue.indexOf(job) >= 0; })) {
    const w = pool.find(function (x) { return !x.dead; });
    if (w) w.queue.push(job);
    else job.reject(new Error("edge: no workers"));
  }
}

function ensurePool() {
  if (started) return;
  started = true;
  for (let i = 0; i < WORKERS; i++) pool.push(makeWorker());
}

/* وزّع شغل: أول worker فاضي، وإلا積مjob على أي worker */
function pump() {
  for (const w of pool) {
    if (w.dead) {
      if (w.proc && !w.proc.killed) continue;
      continue;
    }
    while (!w.busy && w.queue.length) {
      send(w, w.queue.shift());
    }
  }
}

function send(w, job) {
  w.busy = true;
  w.current = job;
  job.timer = setTimeout(function () {
    /* رد متأخر بعد ما عدّت المهلة: نقتل الـworker عشان ما يتلخبطش */
    job.timer = null;
    w.kill();
    job.reject(new Error("edge: timeout"));
  }, JOB_TIMEOUT_MS);
  try {
    w.proc.stdin.write(job.payload + "\n");
  } catch (e) {
    if (job.timer) clearTimeout(job.timer);
    w.current = null;
    w.busy = false;
    job.reject(new Error("edge: stdin closed"));
  }
}

function synth(voice, outPath, text, rate) {
  return new Promise(function (resolve, reject) {
    ensurePool();
    const job = {
      payload: JSON.stringify({ voice, out: outPath, text, rate: rate || null }),
      timer: null,
      resolve,
      reject,
    };
    /* فضّل worker فاضي فوراً، وإلا اتركه للـqueue */
    let target = pool.find(function (w) { return !w.dead && !w.busy && !w.current; });
    if (target) {
      target.queue.push(job);
      pump();
      return;
    }
    /* كلهم مشغولين → وزّع علىLeast queue عشان التوازن */
    let best = null;
    for (const w of pool) {
      if (w.dead) continue;
      if (!best || w.queue.length < best.queue.length) best = w;
    }
    if (!best) { reject(new Error("edge: no workers")); return; }
    best.queue.push(job);
    pump();
  });
}

function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function sha(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

/* يُرجع Buffer لـMP3، أو يرمي خطأ. الصوت يتخزّن على القرص بصيغة نهائية. */
async function edgeTtsMp3(text, voice, outDir) {
  const c = cleanText(text);
  if (!c) throw new Error("edge: empty text");
  const base = path.join(outDir, "edge_" + sha((voice || "Charon") + "::" + c));
  const finalPath = base + ".mp3";
  const tmpPath = base + ".part";

  if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 512) {
    return fs.readFileSync(finalPath);
  }
  try { fs.unlinkSync(tmpPath); } catch (_) {}

  await synth(voice || "Charon", tmpPath, c, null);

  let size = 0;
  try { size = fs.statSync(tmpPath).size; } catch (_) { size = 0; }
  if (size <= 512) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error("edge: empty audio (" + size + "B)");
  }
  try { fs.renameSync(tmpPath, finalPath); } catch (_) {
    fs.writeFileSync(finalPath, fs.readFileSync(tmpPath));
  }
  return fs.readFileSync(finalPath);
}

/* توليد بمعدّل صوتي محدد — للمعاينة والتجربة فقط (بيتجاوز الكاش) */
async function edgeTtsRate(text, mssVoice, rate, outDir) {
  const c = cleanText(text);
  if (!c) throw new Error("edge: empty text");
  const tmp = path.join(outDir, "try_" + sha(mssVoice + "|" + rate + "|" + c) + ".mp3");
  try { fs.unlinkSync(tmp); } catch (_) {}
  await synth(mssVoice, tmp, c, rate || "+0%");
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size <= 512) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error("edge: empty audio");
  }
  return fs.readFileSync(tmp);
}

function shutdown() {
  for (const w of pool) {
    try { w.proc.kill(); } catch (_) {}
  }
}
process.on("exit", shutdown);
process.on("SIGINT", function () { shutdown(); process.exit(0); });
process.on("SIGTERM", function () { shutdown(); process.exit(0); });

module.exports = { edgeTtsMp3, edgeTtsRate };