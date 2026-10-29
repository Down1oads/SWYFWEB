// The audio half of the game's voice: turns the language model's latent frames into sound (Mimi decoder), in its own thread
// so the language model (pocket-worker.js) can already be working on the next frame.
'use strict';

var BASE = new URL('.', self.location.href).href;
importScripts(BASE + 'ort.wasm.min.js');

var LAT = 32, SR = 24000;
var session = null, state = null, cur = null, cancelledId = 0, port = null;

function post(m, tr) { self.postMessage(m, tr || []); }

async function getBytes(name, f0, f1) {
  var url = BASE + name, cache = null;
  try { cache = await caches.open('swyf-pocket-v1'); var hit = await cache.match(url); if (hit) { post({ t: 'status', stage: 'Voice models', frac: f1 }); return new Uint8Array(await hit.arrayBuffer()); } } catch (e) { cache = null; }
  var r = await fetch(url);
  if (!r.ok) throw new Error('could not load ' + name);
  var total = +r.headers.get('Content-Length') || 0, got = 0, parts = [], rd = r.body.getReader();
  for (;;) {
    var x = await rd.read();
    if (x.done) break;
    parts.push(x.value); got += x.value.length;
    if (total) post({ t: 'status', stage: 'Voice models', frac: f0 + (f1 - f0) * got / total });
  }
  var out = new Uint8Array(got), o = 0;
  parts.forEach(function (p) { out.set(p, o); o += p.length; });
  if (cache) { try { await cache.put(url, new Response(out.slice(), { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) {} }
  post({ t: 'status', stage: 'Voice models', frac: f1 });
  return out;
}

function T(type, data, dims) { return new ort.Tensor(type, data, dims); }
function zeros(type, dims) {
  var n = dims.reduce(function (a, b) { return a * b; }, 1);
  if (type === 'float32') return T('float32', new Float32Array(n), dims);
  if (type === 'float16') return T('float16', new (typeof Float16Array !== 'undefined' ? Float16Array : Uint16Array)(n), dims);
  if (type === 'int64') return T('int64', new BigInt64Array(n), dims);
  if (type === 'bool') return T('bool', new Uint8Array(n).fill(1), dims);
  throw new Error('type ' + type);
}
// the decoder's states (type, shape), in the order the model lists them; the flags start true, everything else empty
var KV8 = ['float16', [1, 250, 8, 64]], POS = ['int64', [1]], FLAG = ['bool', [1]];
var MIMI = [FLAG, ['float32', [1, 512, 6]], FLAG, ['float32', [1, 64, 2]], ['float32', [1, 256, 6]], FLAG, ['float32', [1, 256, 2]], FLAG, ['float32', [1, 128, 0]], ['float32', [1, 128, 5]], FLAG,
  ['float32', [1, 128, 2]], FLAG, ['float32', [1, 64, 0]], ['float32', [1, 64, 4]], FLAG, ['float32', [1, 64, 2]], FLAG, ['float32', [1, 32, 0]], KV8, KV8, POS, KV8, KV8, POS, FLAG,
  ['float32', [1, 512, 16]], FLAG, ['float32', [1, 1, 6]], FLAG, ['float32', [1, 64, 2]], FLAG, ['float32', [1, 32, 0]], FLAG, ['float32', [1, 512, 2]], FLAG, ['float32', [1, 64, 4]], FLAG,
  ['float32', [1, 128, 2]], FLAG, ['float32', [1, 64, 0]], FLAG, ['float32', [1, 128, 5]], FLAG, ['float32', [1, 256, 2]], FLAG, ['float32', [1, 128, 0]], FLAG, ['float32', [1, 256, 6]],
  KV8, KV8, POS, KV8, KV8, POS, ['float32', [1, 512, 16]]];
function initState() { var s = {}; MIMI.forEach(function (m, i) { s['state_' + i] = zeros(m[0], m[1]); }); return s; }

async function decode(flat, n, quiet) {
  var out = await session.run(Object.assign({ latent: T('float32', flat, [1, n, LAT]) }, state));
  for (var i = 0; i < MIMI.length; i++) state['state_' + i] = out['out_state_' + i];
  return new Float32Array(out.audio_frame.data);
}

function emit(pcm) {
  cur.audioSec += pcm.length / SR;
  post({ t: 'audio', id: cur.id, pcm: pcm, audioSec: cur.audioSec, elapsed: (performance.now() - cur.t0) / 1000 }, [pcm.buffer]);
}

var chain = Promise.resolve();   // messages are handled strictly in order
function handle(m) {
  if (m.cmd === 'begin') { cur = { id: m.id, t0: performance.now(), audioSec: 0 }; state = initState(); return; }
  if (m.cmd === 'reset') { state = initState(); return; }
  if (m.cmd === 'cancel') { cancelledId = Math.max(cancelledId, m.id); return; }
  if (!cur || cur.id !== m.id) return;
  if (m.cmd === 'decode') {
    if (cancelledId >= m.id) return;
    return decode(m.flat, m.n).then(function (pcm) { if (cancelledId < m.id) emit(pcm); });
  }
  if (m.cmd === 'silence') {
    if (cancelledId >= m.id) return;
    var n = Math.round(m.sec * SR), z = new Float32Array(n);
    for (var i = 0; i < n; i++) z[i] = (Math.random() - 0.5) * 0.0004;
    emit(z); return;
  }
  if (m.cmd === 'end') {
    var info = cur; cur = null;
    post({ t: 'done', id: m.id, audioSec: info.audioSec, elapsed: (performance.now() - info.t0) / 1000, cancelled: !!m.cancelled || cancelledId >= m.id, gen: m.gen });
  }
}
function enqueue(m) {
  chain = chain.then(function () { return handle(m); }).catch(function (e) { post({ t: 'error', message: String(e && e.stack || e) }); });
}

async function load() {
  try {
    ort.env.wasm.wasmPaths = BASE;
    ort.env.wasm.proxy = false;
    ort.env.wasm.numThreads = 1;
    var bytes = await getBytes('mimi_decoder_int8.onnx', 0, 1);
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: true, enableMemPattern: true });
    // warm-up: one pass of random frames, so the first real line does not pay the start-up cost
    state = initState();
    var wf = new Float32Array(6 * LAT);
    for (var i = 0; i < wf.length; i++) wf[i] = (Math.random() - 0.5) * 0.8;
    await decode(wf, 6);
    state = null;
    post({ t: 'dready' });
  } catch (e) {
    post({ t: 'error', message: 'decoder: ' + String(e && e.message || e) });
  }
}

self.onmessage = function (ev) {
  var m = ev.data;
  if (m.cmd === 'load') {
    port = m.main;
    port.onmessage = function (e) { enqueue(e.data); };
    load();
  } else if (m.cmd === 'cancel') { cancelledId = Math.max(cancelledId, m.id); }
};
