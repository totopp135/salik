// Reads a plate number (OCR) or a QR code from a photo sent by the staff app.
// Libraries are loaded on first use, so the server still starts if they are missing.
const path = require('path');
function lib(name) {
  try { return require(name); } catch (e) {
    throw Object.assign(new Error(`Scanner package "${name}" is not installed. Run update_all.bat again.`), { status: 503 });
  }
}

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      lib('@tesseract.js-data/eng');
      const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
      const { createWorker } = lib('tesseract.js');
      return createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

function decodeBase64(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!clean) throw Object.assign(new Error('image is required'), { status: 400 });
  return Buffer.from(clean, 'base64');
}

async function loadImage(buf) {
  const { Jimp } = lib('jimp');
  let img;
  try {
    img = await Jimp.read(buf);
  } catch (e) {
    throw Object.assign(new Error('Could not open the photo. Please take it again (JPG or PNG).'), { status: 422 });
  }
  if (img.bitmap.width > 1600) img.resize({ w: 1600 });
  return img;
}

// Picks plate-looking strings like "ABC 1234", "MSR2026", "1234 ABC".
function plateCandidates(text) {
  const t = String(text).toUpperCase().replace(/[^A-Z0-9\n ]/g, ' ');
  const found = new Map();
  const add = (s, score) => {
    const k = s.replace(/\s+/g, '');
    if (k.length < 4 || k.length > 10) return;
    if (!/[0-9]/.test(k)) return;
    found.set(k, Math.max(found.get(k) || 0, score));
  };
  for (const m of t.matchAll(/\b([A-Z]{1,3})\s?([0-9]{1,4})\b/g)) add(m[1] + ' ' + m[2], 3);
  for (const m of t.matchAll(/\b([0-9]{1,4})\s?([A-Z]{1,3})\b/g)) add(m[1] + ' ' + m[2], 2);
  for (const m of t.matchAll(/\b[A-Z0-9]{4,8}\b/g)) add(m[0], 1);
  return [...found.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([k]) => k);
}

async function readPlate(base64) {
  const img = await loadImage(decodeBase64(base64));
  const original = await img.clone().getBuffer('image/png');
  const enhanced = await img.clone().greyscale().contrast(0.3).getBuffer('image/png');
  const worker = await getWorker();
  const passes = [];
  let candidates = [];
  let best = { text: '', confidence: 0 };
  for (const [name, buf] of [['original', original], ['enhanced', enhanced]]) {
    const { data } = await worker.recognize(buf);
    passes.push({ name, raw: data.text.trim(), confidence: data.confidence });
    candidates = plateCandidates(data.text);
    best = data;
    if (candidates.length) break;
  }
  return {
    plate: candidates[0] || null,
    candidates: candidates.slice(0, 5),
    raw: String(best.text || '').trim(),
    confidence: (best.confidence || 0) / 100,
    passes,
  };
}

// Phone photos of a QR (often of another screen) are noisy. Downscaling smooths the noise,
// so we try several sizes, a light blur, and centre crops until one decodes.
async function readQr(base64) {
  const jsQR = lib('jsqr');
  const decode = (img) => {
    const { data, width, height } = img.bitmap;
    const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height,
      { inversionAttempts: 'attemptBoth' });
    return code ? code.data : null;
  };
  const g = (await loadImage(decodeBase64(base64))).greyscale().normalize();
  if (g.bitmap.width > 1200) g.resize({ w: 1200 });
  const W = g.bitmap.width, H = g.bitmap.height;
  const crop = (f) => g.clone().crop({ x: Math.round(W * (1 - f) / 2), y: Math.round(H * (1 - f) / 2),
                                       w: Math.round(W * f), h: Math.round(H * f) });
  const tries = [];
  for (const w of [800, 600, 450, 350]) if (w < W) tries.push(() => g.clone().resize({ w }));
  tries.push(() => g.clone().resize({ w: Math.min(900, W) }).blur(1));
  tries.push(() => g.clone().resize({ w: Math.min(600, W) }).blur(1));
  for (const f of [0.6, 0.4]) for (const w of [700, 450]) tries.push(() => crop(f).resize({ w }));
  tries.push(() => g.clone());
  for (const make of tries) {
    const text = decode(make());
    if (text) return text;
  }
  return null;
}

// Self-test: draws a plate with Jimp and reads it back, collecting tesseract logs.
async function diagnose() {
  const out = { node: process.versions.node, platform: process.platform, logs: [] };
  try {
    const { Jimp, loadFont, HorizontalAlign } = lib('jimp');
    const { SANS_64_BLACK } = require('jimp/fonts');
    const img = new Jimp({ width: 900, height: 500, color: 0x808080ff });
    const plate = new Jimp({ width: 420, height: 130, color: 0xffffffff });
    plate.print({ font: await loadFont(SANS_64_BLACK), x: 0, y: 30,
      text: { text: 'MSR 2026', alignmentX: HorizontalAlign.CENTER }, maxWidth: 420 });
    img.composite(plate, 240, 200);
    const buf = await img.getBuffer('image/png');
    out.imageBytes = buf.length;
    const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    out.langPath = langPath;
    out.langExists = require('fs').existsSync(path.join(langPath, 'eng.traineddata.gz'));
    const { createWorker } = lib('tesseract.js');
    const w = await createWorker('eng', 1, {
      langPath, gzip: true, cacheMethod: 'none',
      logger: (m) => { if (out.logs.length < 40 && m.status !== 'recognizing text') out.logs.push(m.status); },
      errorHandler: (e) => out.logs.push('ERROR ' + (e && e.message ? e.message : String(e))),
    });
    const { data } = await w.recognize(buf);
    out.text = data.text;
    out.confidence = data.confidence;
    await w.terminate();
  } catch (e) {
    out.error = e.stack || String(e);
  }
  return out;
}

module.exports = { readPlate, readQr, plateCandidates, diagnose };
