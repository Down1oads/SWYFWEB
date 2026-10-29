// The game's own voice (Pocket TTS) running in the browser, in a background thread.
// It follows the game's PocketTTS implementation step by step: text -> tokens -> text conditioner -> language model
// (conditioned on the caller's voice) -> flow decoder -> Mimi audio decoder, 24 kHz mono.
'use strict';

var BASE = new URL('.', self.location.href).href;
importScripts(BASE + 'ort.wasm.min.js');

var D = 1024, LAT = 32, MAX_FRAMES = 500, STEPS = 4, TEMP = 0.7, FIRST_CHUNK = 6, NEXT_CHUNK = 12, GAP_SEC = 0.25, SR = 24000;
var decPort = null;   // the audio decoder runs in its own thread (pocket-decoder.js); finished frames go to it from here

var sp = null, bos = null;
var textCond = null, flowMain = null, flowFlow = null, mimiDec = null;
var zeroKV = null, zeroPos = null, emptySeq = null, emptyText = null;
var ready = false, loading = false;
var currentId = 0, cancelledId = 0;

function post(m, tr) { self.postMessage(m, tr || []); }
function status(stage, frac) { post({ t: 'status', stage: stage, frac: frac }); }

// ---------- download with a persistent copy, so the models are fetched once ----------
async function getBytes(name, label, f0, f1) {
  var url = BASE + name, cache = null;
  try { cache = await caches.open('swyf-pocket-v1'); var hit = await cache.match(url); if (hit) { status(label, f1); return new Uint8Array(await hit.arrayBuffer()); } } catch (e) { cache = null; }
  var r = await fetch(url);
  if (!r.ok) throw new Error('could not load ' + name);
  var total = +r.headers.get('Content-Length') || 0, got = 0, parts = [];
  var rd = r.body.getReader();
  for (;;) {
    var x = await rd.read();
    if (x.done) break;
    parts.push(x.value); got += x.value.length;
    if (total) status(label, f0 + (f1 - f0) * got / total);
  }
  var out = new Uint8Array(got), o = 0;
  parts.forEach(function (p) { out.set(p, o); o += p.length; });
  if (cache) { try { await cache.put(url, new Response(out.slice(), { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) {} }
  status(label, f1);
  return out;
}

// ---------- SentencePiece (unigram) ----------
function SentencePiece(bytes) {
  var p = 0, b = bytes;
  function varint() { var r = 0, s = 0, x; do { x = b[p++]; r += (x & 127) * Math.pow(2, s); s += 7; } while (x & 128); return r; }
  var pieces = [], addDummy = true, removeExtra = true;
  var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (p < b.length) {
    var tag = varint(), f = tag >> 3, w = tag & 7;
    if (w === 2) {
      var n = varint(), end = p + n;
      if (f === 1) {
        var q = p, piece = '', score = 0, type = 1;
        while (q < end) {
          var t2 = b[q++], f2 = t2 >> 3, w2 = t2 & 7;
          if (w2 === 2) { var l = 0, s = 0, x; do { x = b[q++]; l += (x & 127) * Math.pow(2, s); s += 7; } while (x & 128); if (f2 === 1) piece = new TextDecoder().decode(b.subarray(q, q + l)); q += l; }
          else if (w2 === 5) { if (f2 === 2) score = dv.getFloat32(b.byteOffset + q, true); q += 4; }
          else if (w2 === 0) { var v = 0, s2 = 0, y; do { y = b[q++]; v += (y & 127) * Math.pow(2, s2); s2 += 7; } while (y & 128); if (f2 === 3) type = v; }
          else if (w2 === 1) q += 8; else break;
        }
        pieces.push({ piece: piece, score: score, type: type });
      } else if (f === 3) {
        var q3 = p;
        while (q3 < end) {
          var t3 = b[q3++], f3 = t3 >> 3, w3 = t3 & 7;
          if (w3 === 2) { var l3 = 0, s3 = 0, x3; do { x3 = b[q3++]; l3 += (x3 & 127) * Math.pow(2, s3); s3 += 7; } while (x3 & 128); q3 += l3; }
          else if (w3 === 0) { var v3 = 0, s4 = 0, y3; do { y3 = b[q3++]; v3 += (y3 & 127) * Math.pow(2, s4); s4 += 7; } while (y3 & 128); if (f3 === 3) addDummy = !!v3; if (f3 === 4) removeExtra = !!v3; }
          else break;
        }
      }
      p = end;
    } else if (w === 0) varint(); else if (w === 1) p += 8; else if (w === 5) p += 4; else break;
  }
  this.addDummy = addDummy; this.removeExtra = removeExtra;
  this.map = new Map(); this.scores = []; this.unk = 0; this.maxLen = 1; this.list = pieces;
  var minScore = 0;
  for (var i = 0; i < pieces.length; i++) {
    var pc = pieces[i];
    if (pc.type === 2) this.unk = i;
    else if (pc.type === 1 || pc.type === 4) {
      this.map.set(pc.piece, i);
      var len = Array.from(pc.piece).length; if (len > this.maxLen) this.maxLen = len;
      if (pc.score < minScore) minScore = pc.score;
    }
  }
  this.unkScore = minScore - 10;
}
SentencePiece.prototype.encode = function (text) {
  var s = text.normalize('NFKC');
  if (this.removeExtra) s = s.replace(/\s+/g, ' ').trim();
  if (this.addDummy) s = ' ' + s;
  s = s.replace(/ /g, '▁');
  var ch = Array.from(s), n = ch.length;
  var best = new Float64Array(n + 1).fill(-1e18), from = new Int32Array(n + 1), id = new Int32Array(n + 1);
  best[0] = 0;
  for (var i = 0; i < n; i++) {
    if (best[i] <= -1e17) continue;
    var found1 = false, str = '';
    for (var l = 1; l <= this.maxLen && i + l <= n; l++) {
      str += ch[i + l - 1];
      var k = this.map.get(str);
      if (k !== undefined) {
        var sc = best[i] + this.list[k].score;
        if (sc > best[i + l]) { best[i + l] = sc; from[i + l] = i; id[i + l] = k; }
        if (l === 1) found1 = true;
      }
    }
    if (!found1) {
      var sc2 = best[i] + this.unkScore;
      if (sc2 > best[i + 1]) { best[i + 1] = sc2; from[i + 1] = i; id[i + 1] = this.unk; }
    }
  }
  var out = [], pos = n;
  while (pos > 0) { out.push(id[pos]); pos = from[pos]; }
  out.reverse();
  // neighbouring unknowns count once
  var res = [];
  for (var j = 0; j < out.length; j++) { if (out[j] === this.unk && res.length && res[res.length - 1] === this.unk) continue; res.push(out[j]); }
  return res;
};
SentencePiece.prototype.decodePieces = function (ids) { var self = this; return ids.map(function (i) { return self.list[i].piece; }).join(''); };

// ---------- text preparation (as in the game's TextProcessor) ----------
var ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
var ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
function cardinal(n) {
  if (n < 0) return 'minus ' + cardinal(-n);
  if (n < 20) return n === 0 ? 'zero' : ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + cardinal(n % 100) : '');
  var units = [[1e12, ' trillion'], [1e9, ' billion'], [1e6, ' million'], [1e3, ' thousand']];
  for (var i = 0; i < units.length; i++) {
    if (n >= units[i][0]) { var q = Math.floor(n / units[i][0]), r = n % units[i][0]; return cardinal(q) + units[i][1] + (r ? ' ' + cardinal(r) : ''); }
  }
  return String(n);
}
function ordinal(n) {
  var w = cardinal(n).split(' '), last = w.pop();
  if (ORD[last]) last = ORD[last]; else if (/y$/.test(last)) last = last.slice(0, -1) + 'ieth'; else last += 'th';
  w.push(last); return w.join(' ');
}
function digitsToWords(s) { return s.split('').map(function (c) { return c === '0' ? 'zero' : ONES[+c]; }).join(' '); }
function year(n) {
  if (n >= 2000 && n < 2010) return cardinal(n);
  var a = Math.floor(n / 100), b = n % 100;
  return cardinal(a) + ' ' + (b === 0 ? 'hundred' : (b < 10 ? 'oh ' + ONES[b] : cardinal(b)));
}
var ABBR = [['mrs', 'misuss'], ['ms', 'miss'], ['mr', 'mister'], ['dr', 'doctor'], ['st', 'saint'], ['co', 'company'], ['jr', 'junior'], ['maj', 'major'], ['gen', 'general'], ['drs', 'doctors'], ['rev', 'reverend'], ['lt', 'lieutenant'], ['hon', 'honorable'], ['sgt', 'sergeant'], ['capt', 'captain'], ['esq', 'esquire'], ['ltd', 'limited'], ['col', 'colonel'], ['ft', 'fort']];
var TERMS = [['TTS', 'text to speech'], ['kHz', 'kilohertz'], ['Hz', 'hertz'], ['KBs', 'kilobytes'], ['KB', 'kilobyte'], ['MBs', 'megabytes'], ['MB', 'megabyte'], ['GBs', 'gigabytes'], ['GB', 'gigabyte'], ['TBs', 'terabytes'], ['TB', 'terabyte'], ['APIs', "a p i's"], ['API', 'a p i'], ['CLIs', "c l i's"], ['CLI', 'c l i'], ['CPUs', "c p u's"], ['CPU', 'c p u'], ['GPUs', "g p u's"], ['GPU', 'g p u'], ['Ave', 'avenue'], ['etc', 'etcetera']];
var UMAP = { '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '–': '-', '—': '-', ' ': ' ', 'é': 'e', 'è': 'e', 'à': 'a', 'á': 'a', 'ñ': 'n', 'ü': 'u', 'ö': 'o', 'ç': 'c' };
function normalizeNumbers(t) {
  t = t.replace(/#(\d)/g, 'number $1');
  t = t.replace(/(\d)([KMBT])\b/g, function (m, d, u) { return d + ' ' + { K: 'thousand', M: 'million', B: 'billion', T: 'trillion' }[u]; });
  t = t.replace(/(\d)([a-z])|([a-z])(\d)/gi, function (m, a, b, c, d) { return a ? a + ' ' + b : c + ' ' + d; });
  t = t.replace(/(\d[\d,]+\d)/g, function (m) { return m.replace(/,/g, ''); });
  t = t.replace(/(\d\d?):(\d\d)(?::(\d\d))?/g, function (m, h, mi, s) { var r = cardinal(+h) + ' ' + (mi === '00' ? "o'clock" : (+mi < 10 ? 'oh ' + cardinal(+mi) : cardinal(+mi))); if (s) r += ' and ' + cardinal(+s) + ' seconds'; return r; });
  t = t.replace(/\(?(\d{3})\)?[-.\s](\d{3})[-.\s]?(\d{4})/g, function (m, a, b, c) { return digitsToWords(a) + ', ' + digitsToWords(b) + ', ' + digitsToWords(c); });
  t = t.replace(/£([\d,]*\d+)/g, function (m, n) { return cardinal(+n.replace(/,/g, '')) + ' pounds'; });
  t = t.replace(/\$([\d.,]*\d+)/g, function (m, n) {
    n = n.replace(/,/g, ''); var parts = n.split('.'), d = +parts[0], c = parts[1] ? +(parts[1] + '0').slice(0, 2) : 0;
    return cardinal(d) + (d === 1 ? ' dollar' : ' dollars') + (c ? ' and ' + cardinal(c) + (c === 1 ? ' cent' : ' cents') : '');
  });
  t = t.replace(/(\d+(?:\.\d+)+)/g, function (m) { var p = m.split('.'); return cardinal(+p[0]) + ' point ' + p.slice(1).map(digitsToWords).join(' point '); });
  t = t.replace(/(\d)\s?\*\s?(\d)/g, '$1 times $2').replace(/(\d)\s?\/\s?(\d)/g, '$1 over $2').replace(/(\d)\s?\+\s?(\d)/g, '$1 plus $2');
  t = t.replace(/(\d)?\s?-\s?(\d)/g, function (m, a, b) { return (a ? a + ' minus ' : 'minus ') + b; });
  t = t.replace(/(\d+)(st|nd|rd|th)\b/g, function (m, n) { return ordinal(+n); });
  t = t.replace(/\d+/g, function (m) { var n = +m; return (m.length === 4 && n >= 1100 && n < 2100 && n % 1000 !== 0) ? year(n) : (m.length > 15 ? digitsToWords(m) : cardinal(n)); });
  return t;
}
function prepareText(t) {
  t = (t || '').trim();
  if (!t) return '';
  t = t.split('').map(function (c) { return UMAP[c] !== undefined ? UMAP[c] : c; }).join('').normalize('NFKC').replace(/[̀-ͯ]/g, '');
  t = normalizeNumbers(t);
  t = t.replace(/https?:\/\//g, 'h t t p s colon slash slash ').replace(/(.) - (.)/g, '$1, $2').replace(/([A-Z])\.([A-Z])/g, '$1 dot $2').replace(/[\(\[\{][^\)\]\}]*[\)\]\}](.)?/g, function (m, c) { return c ? c : ''; });
  ABBR.forEach(function (a) { t = t.replace(new RegExp('\\b' + a[0] + '\\.', 'gi'), a[1]); });
  TERMS.forEach(function (a) { t = t.replace(new RegExp('\\b' + a[0] + '\\b', 'g'), a[1]); });
  t = t.replace(/@/g, ' at ').replace(/&/g, ' and ').replace(/%/g, ' percent ').replace(/:/g, '.').replace(/;/g, ',').replace(/\+/g, ' plus ').replace(/\\/g, ' backslash ').replace(/~/g, ' about ').replace(/(^| )<3/g, ' heart ').replace(/<=/g, ' less than or equal to ').replace(/>=/g, ' greater than or equal to ').replace(/</g, ' less than ').replace(/>/g, ' greater than ').replace(/=/g, ' equals ').replace(/\//g, ' slash ').replace(/_/g, ' ');
  t = t.replace(/\s+/g, ' ').replace(/ \./g, '.').replace(/ \?/g, '?').replace(/ !/g, '!').replace(/ ,/g, ',');
  t = t.replace(/\.\.\.+/g, '[ELLIPSIS]').replace(/,+/g, ',').replace(/[.,]*\.[.,]*/g, '.').replace(/[.,!]*![.,!]*/g, '!').replace(/[.,!?]*\?[.,!?]*/g, '?').replace(/\[ELLIPSIS\]/g, '...').trim();
  if (t.length && /[A-Za-z0-9À-ɏ]/.test(t[t.length - 1])) t += '.';
  if (t.length && t[0] !== t[0].toUpperCase()) t = t[0].toUpperCase() + t.slice(1);
  return t;
}
function splitIntoBestSentences(text) {
  var t = prepareText(text);
  if (!t) return [];
  var sentences = (t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).map(function (s) { return s.trim(); }).filter(Boolean);
  var out = [], cur = '';
  sentences.forEach(function (s) {
    var ids = sp.encode(s);
    if (ids.length > 80) {
      if (cur) { out.push(cur.trim()); cur = ''; }
      for (var i = 0; i < ids.length; i += 80) { var piece = sp.decodePieces(ids.slice(i, i + 80)).replace(/▁/g, ' ').replace(/[\s]+$/, ''); if (piece) out.push(piece); }
      return;
    }
    if (!cur) { cur = s; return; }
    var joined = cur + ' ' + s;
    if (sp.encode(joined).length > 80) { out.push(cur.trim()); cur = s; } else cur = joined;
  });
  if (cur) out.push(cur.trim());
  return out;
}

// ---------- tensors and states ----------
function T(type, data, dims) { return new ort.Tensor(type, data, dims); }
function zeros(type, dims) {
  var n = dims.reduce(function (a, b) { return a * b; }, 1);
  if (type === 'float32') return T('float32', new Float32Array(n), dims);
  if (type === 'float16') return T('float16', new (typeof Float16Array !== 'undefined' ? Float16Array : Uint16Array)(n), dims);
  if (type === 'int64') return T('int64', new BigInt64Array(n), dims);
  if (type === 'bool') return T('bool', new Uint8Array(n).fill(1), dims);
  throw new Error('type ' + type);
}
function initFlowState() {
  var s = {};
  for (var i = 0; i < 18; i += 3) { s['state_' + i] = zeroKV; s['state_' + (i + 1)] = zeroKV; s['state_' + (i + 2)] = zeroPos; }
  return s;
}
function takeState(state, out, count) { for (var i = 0; i < count; i++) state['state_' + i] = out['out_state_' + i]; }

function randn() { var u = 1 - Math.random(), v = 1 - Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function yieldNow() { return new Promise(function (r) { var c = new MessageChannel(); c.port1.onmessage = function () { r(); }; c.port2.postMessage(0); }); }

// ---------- loading ----------
async function load() {
  if (ready || loading) return;
  loading = true;
  try {
    ort.env.wasm.wasmPaths = BASE;
    ort.env.wasm.proxy = false;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (self.navigator.hardwareConcurrency || 4) - 1)) : 1;
    var opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: true, enableMemPattern: true };
    sp = new SentencePiece(await getBytes('tokenizer.model', 'Voice models', 0, 0.01));
    var npy = await getBytes('bos_before_voice.npy', 'Voice models', 0.01, 0.02);
    var hl = npy[8] | (npy[9] << 8);
    bos = new Float32Array(npy.slice(10 + hl).buffer);
    textCond = await ort.InferenceSession.create(await getBytes('text_conditioner.onnx', 'Voice models', 0.02, 0.15), opts);
    flowMain = await ort.InferenceSession.create(await getBytes('flow_lm_main_int8.onnx', 'Voice models', 0.15, 0.85), opts);
    flowFlow = await ort.InferenceSession.create(await getBytes('flow_lm_flow_int8.onnx', 'Voice models', 0.85, 1.0), opts);
    zeroKV = zeros('float16', [1, 1000, 16, 64]);
    zeroPos = zeros('int64', [1]);
    emptySeq = zeros('float32', [1, 0, LAT]);
    emptyText = zeros('float32', [1, 0, D]);
    // run one short line through everything once, so the first real line does not pay the start-up cost (about 5 s on a cold engine)
    try {
      status('Warming up', 1);
      var wv = new Float32Array(await (await fetch(BASE + 'voices/boss_normal.f32')).arrayBuffer());
      ready = true;
      await speak(2000000000, 'Hello there, this is a short test line.', wv, 'boss_normal', true);
    } catch (e) {}
    ready = true;
    post({ t: 'ready', threads: ort.env.wasm.numThreads });
  } catch (e) {
    post({ t: 'error', message: String(e && e.message || e) });
  }
  loading = false;
}

// ---------- speaking ----------
var prof = { main: 0, flow: 0, dec: 0, prefill: 0, steps: 0, yld: 0, voice: 0 };
async function timed(key, f) { var t = performance.now(); var r = await f(); prof[key] += performance.now() - t; return r; }
var voiceStates = new Map();   // voice key -> language-model state right after the voice was read in (saves about a second per line)
async function speak(id, text, voice, voiceKey, quiet) {
  currentId = id;
  var t0 = performance.now(), audioSec = 0, frameCount = 0; prof = { main: 0, flow: 0, dec: 0, prefill: 0, steps: 0, yld: 0, voice: 0 };
  var segments = splitIntoBestSentences(text);
  if (!segments.length) { if (!quiet) post({ t: 'done', id: id, audioSec: 0, elapsed: 0 }); return; }
  var nv = voice.length / D;
  var voiceEmb = new Float32Array((nv + 1) * D);
  voiceEmb.set(bos.subarray(0, D), 0);
  voiceEmb.set(voice, D);
  var voiceTensor = T('float32', voiceEmb, [1, nv + 1, D]);
  var flowState = null;

  async function feedVoice() {
    var cached = voiceKey && voiceStates.get(voiceKey);
    if (cached) { flowState = Object.assign({}, cached); voiceStates.delete(voiceKey); voiceStates.set(voiceKey, cached); return; }
    flowState = initFlowState();
    var feed = Object.assign({ sequence: emptySeq, text_embeddings: voiceTensor }, flowState);
    var out = await flowMain.run(feed);
    takeState(flowState, out, 18);
    if (voiceKey) {
      voiceStates.set(voiceKey, Object.assign({}, flowState));
      if (voiceStates.size > 5) voiceStates.delete(voiceStates.keys().next().value);
    }
  }
  var firstChunkDone = false;
  function decode(lats) {
    var n = lats.length;
    if (!n || quiet) return;
    var flat = new Float32Array(n * LAT);
    for (var i = 0; i < n; i++) flat.set(lats[i], i * LAT);
    decPort.postMessage({ cmd: 'decode', id: id, flat: flat, n: n }, [flat.buffer]);
  }
  function silence(sec) { if (!quiet) decPort.postMessage({ cmd: 'silence', id: id, sec: sec }); }

  if (!quiet) decPort.postMessage({ cmd: 'begin', id: id });
  var tv = performance.now(); await feedVoice(); prof.voice += performance.now() - tv;
  var std = Math.sqrt(TEMP);
  for (var k = 0; k < segments.length; k++) {
    if (cancelledId >= id) break;
    if (k > 0) { await feedVoice(); if (!quiet) decPort.postMessage({ cmd: 'reset', id: id }); }
    var ids = sp.encode(segments[k]);
    var tp0 = performance.now(); var tok = await textCond.run({ token_ids: T('int64', BigInt64Array.from(ids.map(function (x) { return BigInt(x); })), [1, ids.length]) });
    var out0 = await flowMain.run(Object.assign({ sequence: emptySeq, text_embeddings: tok.embeddings }, flowState));
    takeState(flowState, out0, 18); prof.prefill += performance.now() - tp0;
    var cur = new Float32Array(LAT).fill(NaN);
    var eosStep = -1, lats = [];
    for (var step = 0; step < MAX_FRAMES; step++) {
      if (cancelledId >= id) break;
      var o = await timed('main', function () { return flowMain.run(Object.assign({ sequence: T('float32', cur, [1, 1, LAT]), text_embeddings: emptyText }, flowState)); }); prof.steps++;
      var cond = o.conditioning.data, eos = o.eos_logit.data[0];
      if (eosStep < 0 && eos > -4) eosStep = step;
      // flow decoding: Euler integration from noise to the next latent frame
      var x = new Float32Array(LAT);
      for (var j = 0; j < LAT; j++) x[j] = randn() * std;
      var c = T('float32', new Float32Array(cond), [D]);
      for (var s = 0; s < STEPS; s++) {
        var fo = await timed('flow', function () { return flowFlow.run({ c: c, s: T('float32', Float32Array.of(s / STEPS), [1, 1]), t: T('float32', Float32Array.of((s + 1) / STEPS), [1, 1]), x: T('float32', x, [1, LAT]) }); });
        var dir = fo.flow_dir.data;
        x = new Float32Array(x);
        for (var q = 0; q < LAT; q++) x[q] += dir[q] / STEPS;
      }
      cur = x;
      lats.push(x);
      frameCount++;
      if (lats.length >= (firstChunkDone ? NEXT_CHUNK : FIRST_CHUNK)) { decode(lats); lats = []; firstChunkDone = true; }
      if (eosStep >= 0 && step >= eosStep + 3) break;
      takeState(flowState, o, 18);
      var ty = performance.now(); await yieldNow(); prof.yld += performance.now() - ty;
    }
    if (cancelledId < id) decode(lats);
    if (cancelledId < id && k < segments.length - 1) silence(GAP_SEC);
  }
  if (quiet) return;
  decPort.postMessage({ cmd: 'end', id: id, cancelled: cancelledId >= id, gen: { elapsed: (performance.now() - t0) / 1000, frames: frameCount, prof: Object.assign({}, prof) } });
  prof = { main: 0, flow: 0, dec: 0, prefill: 0, steps: 0, yld: 0, voice: 0 };
}

var queue = Promise.resolve();
self.onmessage = function (ev) {
  var m = ev.data;
  if (m.cmd === 'load') { decPort = m.dec; load(); }
  else if (m.cmd === 'cancel') { cancelledId = m.id; if (decPort) decPort.postMessage({ cmd: 'cancel', id: m.id }); }
  else if (m.cmd === 'speak') {
    cancelledId = Math.max(cancelledId, m.id - 1);
    queue = queue.then(function () {
      if (cancelledId >= m.id) { post({ t: 'done', id: m.id, audioSec: 0, elapsed: 0, cancelled: true }); return; }
      return speak(m.id, m.text, m.voice, m.voiceKey).catch(function (e) { post({ t: 'error', id: m.id, message: String(e && e.stack || e) }); if (decPort) decPort.postMessage({ cmd: 'end', id: m.id, cancelled: true }); post({ t: 'done', id: m.id, audioSec: 0, elapsed: 0, cancelled: true }); });
    });
  }
};
