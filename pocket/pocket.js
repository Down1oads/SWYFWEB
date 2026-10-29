// Page side of the game's own voices: starts the voice thread, hands it what to say, and plays the audio it makes.
// window.PortPocket.speak(text, voicePath, role) returns true when it took the line; false means "use the browser voice instead".
(function () {
  'use strict';
  var BASE = (function () { var s = document.currentScript; return s && s.src ? new URL('.', s.src).href : new URL('pocket/', location.href).href; })();
  var SR = 24000, GAIN = 2.6;
  var worker = null, decoder = null, mainReady = false, decReady = false, loadFrac = [0, 0], state = 'idle', seq = 0, utt = null, voiceIndex = null, voiceCache = new Map();
  var ctx = null, out = null, slowCount = 0, tooSlow = false;

  function toast(t, ms) { try { if (window.__portToast) window.__portToast(t, ms || 5000); } catch (e) {} }
  function log(m) { try { console.log('[Port] voice: ' + m); } catch (e) {} }

  function keyOf(p) {
    p = String(p || '').replace(/\\/g, '/').toLowerCase().replace(/^.*kolkata-voices\//, '').replace(/\.wav$/, '');
    return p.replace(/[^a-z0-9\/_-]+/g, '_');
  }
  var SKIP = /^(boss|yell|audio|victim|.*boss.*|.*kid.*|connor\/alien|connor\/astronaut)/;
  var FEMALE = /^(connor\/dorothy_mayfield|connor\/shanice_dee_bishop|connor\/sloane_park_voss|jake\/newest_voices\/troyana_blassingan|rees\/reesvalleygurl)$/;
  function findKey(path, role, gender) {
    if (!voiceIndex) return null;
    var parts = String(path || '').split('|'), file = parts[0], who = parts[1] || file;
    var k = keyOf(file);
    if (voiceIndex[k]) return k;
    var hh = (String(file).toLowerCase().match(/[0-9a-f]{64}/) || [])[0];
    if (hh && voiceIndex['callers/defaults/' + hh + '/voice']) return 'callers/defaults/' + hh + '/voice';
    var base = k.split('/').pop(), hit = null;
    Object.keys(voiceIndex).forEach(function (x) { if (!hit && base && x.split('/').pop() === base) hit = x; });
    if (hit) return hit;
    if (role === 1) return 'boss_normal';
    // an unknown caller still gets one of the game's own voices (matching their gender when known), always the same one for the same caller
    var pool = Object.keys(voiceIndex).filter(function (x) { return !SKIP.test(x); });
    if (gender === 2) { var f = pool.filter(function (x) { return FEMALE.test(x); }); if (f.length) pool = f; }
    else if (gender === 1) { var m = pool.filter(function (x) { return !FEMALE.test(x); }); if (m.length) pool = m; }
    var h = 17;
    for (var i = 0; i < who.length; i++) h = (h * 31 + who.charCodeAt(i)) | 0;
    log('no voice file for "' + file + '", using a stand-in');
    return pool.length ? pool[Math.abs(h) % pool.length] : null;
  }

  function start() {
    if (worker || state === 'error') return;
    if (typeof Worker === 'undefined' || !window.WebAssembly) { state = 'error'; return; }
    state = 'loading';
    fetch(BASE + 'voices/index.json').then(function (r) { return r.json(); }).then(function (j) { voiceIndex = j; }).catch(function () {});
    try {
      worker = new Worker(BASE + 'pocket-worker.js');
      decoder = new Worker(BASE + 'pocket-decoder.js');
    } catch (e) { state = 'error'; log('cannot start: ' + e); return; }
    var ch = new MessageChannel();
    worker.onmessage = function (ev) { onMessage(ev, 0); };
    decoder.onmessage = function (ev) { onMessage(ev, 1); };
    worker.onerror = decoder.onerror = function (e) { log('thread error ' + (e && e.message)); if (state !== 'ready') state = 'error'; };
    decoder.postMessage({ cmd: 'load', main: ch.port2 }, [ch.port2]);
    worker.postMessage({ cmd: 'load', dec: ch.port1 }, [ch.port1]);
  }

  var lastThreads = 1;
  function onMessage(ev, who) {
    var m = ev.data;
    if (m.t === 'status') { loadFrac[who] = m.frac; window.__pocketLoad = 0.84 * loadFrac[0] + 0.16 * loadFrac[1]; }
    else if (m.t === 'ready' || m.t === 'dready') {
      if (m.t === 'ready') { mainReady = true; lastThreads = m.threads; } else decReady = true;
      if (mainReady && decReady && state !== 'ready') { state = 'ready'; log('ready'); toast("The game's own caller voices are ready", 4000); }
    }
    else if (m.t === 'error') { log('error ' + m.message); if (state !== 'ready') { state = 'error'; toast('Original voices could not start - using the browser voice', 6000); } }
    else if (m.t === 'audio') onAudio(m);
    else if (m.t === 'done') onDone(m);
  }

  function ensureContext() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      try { ctx = new AC({ sampleRate: SR, latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
      var g = ctx.createGain(); g.gain.value = GAIN;
      var lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -8; lim.knee.value = 6; lim.ratio.value = 14; lim.attack.value = 0.003; lim.release.value = 0.12;
      g.connect(lim); lim.connect(ctx.destination);
      out = g;
    }
    if (ctx.state !== 'running') ctx.resume().catch(function () {});
    return ctx;
  }

  function schedule(u) {
    var c = ctx;
    while (u.q.length) {
      var pcm = u.q.shift();
      var buf = c.createBuffer(1, pcm.length, SR);
      buf.getChannelData(0).set(pcm);
      var src = c.createBufferSource();
      src.buffer = buf; src.connect(out);
      var at = Math.max(c.currentTime + 0.03, u.next);
      src.start(at);
      u.next = at + buf.duration;
      u.sources.push(src);
      (function (data, delay, owner) { setTimeout(function () { if (owner.cancelled) return; var q = window.__portTtsQ || (window.__portTtsQ = []); q.push(data); while (q.length > 60) q.shift(); }, Math.max(0, delay * 1000)); })(pcm, at - c.currentTime, u);
    }
  }

  function maybeStart(u) {
    if (u.started) { schedule(u); return; }
    // start once enough is buffered that playback will not run dry, given how fast the lines are being made
    var rate = u.rate > 0 ? u.rate : 0.8;
    var estTotal = Math.min(40, Math.max(1.5, u.text.length / 14));
    var need = rate >= 1.1 ? 0.3 : Math.min(3, estTotal * (1 - Math.min(rate, 1)) * 0.5 + 0.4);
    if (u.done || u.buffered >= need || (performance.now() - u.t0) > 16000) {
      u.started = true; u.next = 0; u.startMs = Math.round(performance.now() - u.t0); schedule(u);
    }
  }

  function onAudio(m) {
    if (window.__pocketTap) try { window.__pocketTap(m); } catch (e) {}
    var u = utt;
    if (!u || u.id !== m.id || u.cancelled) return;
    u.q.push(m.pcm); u.buffered += m.pcm.length / SR;
    if (u.lastElapsed !== undefined && m.elapsed > u.lastElapsed + 0.01) {
      var r = (m.audioSec - u.lastAudio) / (m.elapsed - u.lastElapsed);
      u.rate = u.rate ? u.rate * 0.5 + r * 0.5 : r;
    }
    u.lastElapsed = m.elapsed; u.lastAudio = m.audioSec;
    maybeStart(u);
  }

  function finish(u) {
    if (utt === u) { utt = null; window.__ttsSpeaking = false; }
  }

  function onDone(m) {
    var u = utt;
    if (!u || u.id !== m.id) return;
    u.done = true;
    if (u.cancelled || m.cancelled) { finish(u); return; }
    try { var st = window.__pocketStats || (window.__pocketStats = []); st.push({ chars: u.text.length, audioSec: +m.audioSec.toFixed(2), genSec: +m.elapsed.toFixed(2), startMs: u.startMs, key: u.key, gen: m.gen }); if (st.length > 20) st.shift(); } catch (e) {}
    if (m.audioSec > 4 && m.elapsed > 0) {
      var overall = m.audioSec / m.elapsed;
      if (overall < 0.5) { slowCount++; if (slowCount >= 2 && !tooSlow) { tooSlow = true; log('too slow here (' + overall.toFixed(2) + 'x), using the browser voice'); toast('This device is too slow for the original voices - using the browser voice', 7000); } }
      else slowCount = 0;
    }
    maybeStart(u);
    if (!u.started) { u.started = true; u.next = 0; schedule(u); }
    var wait = Math.max(0, (u.next - ctx.currentTime)) * 1000 + 200;
    setTimeout(function () { if (utt === u) finish(u); }, wait);
  }

  function cancel() {
    var u = utt;
    if (u) {
      u.cancelled = true;
      u.sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
      u.q.length = 0;
      if (worker) worker.postMessage({ cmd: 'cancel', id: u.id });
      if (decoder) decoder.postMessage({ cmd: 'cancel', id: u.id });
      utt = null;
    }
    window.__ttsSpeaking = false;
  }

  function loadVoice(key) {
    if (voiceCache.has(key)) return Promise.resolve(voiceCache.get(key));
    return fetch(BASE + 'voices/' + key + '.f32').then(function (r) { if (!r.ok) throw new Error('voice ' + key); return r.arrayBuffer(); }).then(function (b) {
      var f = new Float32Array(b); voiceCache.set(key, f); return f;
    });
  }

  function speak(text, voicePath, role, lang, gender) {
    if (state !== 'ready' || tooSlow || !text) return false;
    if (lang && !/^en/i.test(lang)) return false;
    var key = findKey(voicePath, role, gender | 0);
    if (!key) return false;
    ensureContext();
    cancel();
    var id = ++seq;
    var u = { key: key, id: id, text: String(text), q: [], sources: [], started: false, done: false, cancelled: false, buffered: 0, next: 0, rate: 0, t0: performance.now() };
    utt = u;
    window.__ttsSpeaking = true;
    loadVoice(key).then(function (voice) {
      if (utt !== u || u.cancelled) return;
      worker.postMessage({ cmd: 'speak', id: id, text: u.text, voice: voice, voiceKey: key });
    }).catch(function (e) { log('voice file missing: ' + key); if (utt === u) finish(u); });
    setTimeout(function () { if (utt === u) { cancel(); } }, 120000);
    return true;
  }

  window.PortPocket = {
    start: start,
    speak: speak,
    cancel: cancel,
    isSpeaking: function () { return !!utt; },
    state: function () { return state; },
    keyOf: keyOf
  };
})();
