"use strict";
/* tts.js — 语音合成：浏览器自带 / ElevenLabs 克隆音色 / 自定义接口
   移动端要点：
   - iOS 要求本页面首次 speechSynthesis.speak() / audio.play() 必须发生在用户手势调用栈内，
     否则被静默丢弃（连回调都不触发）。FVA.unlockPlayback() 在任一点击手势里调用一次即解锁。
   - 所有失败路径都必须最终触发 onend，否则上层的"朗读中暂停识别"状态机会死锁。 */

var FVA = window.FVA = window.FVA || {};

FVA.DEFAULT_TTS = {
  engine: "browser",          // browser | elevenlabs | custom | off
  voiceURI: "",
  rate: 1.0,
  pitch: 1.0,
  autoSpeak: true,
  sttLang: "zh-CN",
  eleven: { apiKey: "", voiceId: "", modelId: "eleven_multilingual_v2" },
  customUrl: ""
};

FVA.loadTTS = function () {
  try {
    var raw = localStorage.getItem("fva_tts");
    if (raw) {
      var c = JSON.parse(raw);
      var d = FVA.DEFAULT_TTS;
      for (var k in d) {
        if (c[k] === undefined) c[k] = d[k];
        else if (k === "eleven") {
          for (var kk in d.eleven) { if (c.eleven[kk] === undefined) c.eleven[kk] = d.eleven[kk]; }
        }
      }
      return c;
    }
  } catch (e) { /* ignore */ }
  return JSON.parse(JSON.stringify(FVA.DEFAULT_TTS));
};

FVA.saveTTS = function (c) {
  localStorage.setItem("fva_tts", JSON.stringify(c));
};

/* ---------- 浏览器音色 ---------- */

var _voices = [];

FVA.initVoices = function (cb) {
  if (!window.speechSynthesis) { cb([]); return; }
  function load() {
    _voices = window.speechSynthesis.getVoices() || [];
    if (_voices.length) cb(_voices);
  }
  load();
  window.speechSynthesis.onvoiceschanged = load;
  // 有些浏览器 voiceschanged 不触发，兜底再试一次
  setTimeout(load, 800);
};

FVA.zhVoices = function () {
  var zh = _voices.filter(function (v) { return /^zh/i.test(v.lang); });
  return zh.length ? zh : _voices;
};

FVA.findVoice = function (uri) {
  for (var i = 0; i < _voices.length; i++) {
    if (_voices[i].voiceURI === uri || _voices[i].name === uri) return _voices[i];
  }
  return null;
};

/* 按性别猜一个默认中文音色 */
FVA.pickDefaultVoice = function (gender) {
  var zh = FVA.zhVoices();
  if (!zh.length) return null;
  var femaleRe = /(Xiaoxiao|Xiaoyi|Xiaochen|Xiaohan|Xiaomo|Xiaorui|Xiaoxuan|Huihui|Yaoyao|HiuGaai|HiuMaan|female|女)/i;
  var maleRe = /(Yunxi|Yunyang|Yunjian|Yunye|Kangkang|Danny|WanLung|male|男)/i;
  var re = gender === "male" ? maleRe : femaleRe;
  for (var i = 0; i < zh.length; i++) { if (re.test(zh[i].name)) return zh[i]; }
  return zh[0];
};

/* ---------- 播放控制 ---------- */

var _utter = null;        // 防止 utterance 被垃圾回收导致 onend 不触发
var _audioEl = null;      // 复用单个 <audio>：手势里"解锁"过的元素之后才允许程序化播放（iOS）
var _audioToken = 0;      // 递增令牌：让被打断的旧播放的回调失效

// 极短的静音 wav，用于手势内解锁音频元素
var SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";

function getAudioEl() {
  if (!_audioEl) _audioEl = new Audio();
  return _audioEl;
}

var _playbackUnlocked = false;

/* 在任一用户点击手势里调用一次：解锁 iOS 的 speechSynthesis 与 <audio> 程序化播放 */
FVA.unlockPlayback = function () {
  if (_playbackUnlocked) return;
  _playbackUnlocked = true;
  try {
    var a = getAudioEl();
    a.muted = true;
    a.src = SILENT_WAV;
    var p = a.play();
    if (p && p.then) {
      p.then(function () { a.muted = false; }).catch(function () { a.muted = false; });
    } else {
      a.muted = false;
    }
  } catch (e) { /* ignore */ }
  try {
    if (window.speechSynthesis && !window.speechSynthesis.speaking) {
      var u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch (e) { /* ignore */ }
};

FVA.isAudioPlaying = function () {
  return !!(_audioEl && _audioEl.src && !_audioEl.paused && !_audioEl.ended);
};

FVA.stopSpeak = function () {
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  _audioToken++;                       // 使旧播放回调全部失效
  if (_audioEl) {
    try { _audioEl.pause(); } catch (e) { /* ignore */ }
  }
};

function speakBrowser(text, cfg, h) {
  if (!window.speechSynthesis) { h.onerror(new Error("此浏览器不支持语音合成")); h.onend(); return; }
  window.speechSynthesis.cancel();
  var u = new SpeechSynthesisUtterance(text);
  var v = cfg.voiceURI ? FVA.findVoice(cfg.voiceURI) : null;
  if (!v) v = FVA.pickDefaultVoice(cfg._gender || "female");
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "zh-CN"; }
  u.rate = Math.min(2, Math.max(0.3, cfg.rate || 1));
  u.pitch = Math.min(2, Math.max(0.3, cfg.pitch || 1));

  var started = false, finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    if (_utter === u) _utter = null;
    h.onend();
  }
  u.onstart = function () { started = true; h.onstart(); };
  u.onend = finish;
  u.onerror = function (e) {
    // 被 cancel() 打断也会触发 error，视为正常结束
    if (!(e && (e.error === "canceled" || e.error === "interrupted"))) {
      h.onerror(new Error("语音合成失败：" + (e && e.error ? e.error : "未知")));
    }
    finish();
  };
  _utter = u;
  window.speechSynthesis.speak(u);

  // 看门狗：utterance 被系统静默丢弃时（如 iOS 未在手势内解锁），2 秒后兜底收尾，
  // 避免上层"朗读中"状态卡死、麦克风无法恢复
  setTimeout(function () {
    if (!started && !finished && _utter === u &&
        !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      finish();
    }
  }, 2000);
}

async function speakElevenLabs(text, cfg, h) {
  var e = cfg.eleven || {};
  if (!e.apiKey || !e.voiceId) throw new Error("ElevenLabs 的 Key 或 Voice ID 还没填（在「声音」页）");
  var url = "https://api.elevenlabs.io/v1/text-to-speech/" +
    encodeURIComponent(e.voiceId) + "?output_format=mp3_44100_64";
  var resp = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": e.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ text: text, model_id: e.modelId || "eleven_multilingual_v2" })
  });
  if (!resp.ok) {
    var msg = "";
    try { msg = (await resp.text()).slice(0, 150); } catch (err) { /* ignore */ }
    throw new Error("ElevenLabs 报错(" + resp.status + ")：" + msg);
  }
  var blob = await resp.blob();
  playBlob(blob, h);
}

async function speakCustom(text, cfg, h) {
  if (!cfg.customUrl) throw new Error("自定义 TTS 接口地址还没填（在「声音」页）");
  var resp = await fetch(cfg.customUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text })
  });
  if (!resp.ok) throw new Error("自定义 TTS 报错(" + resp.status + ")");
  var blob = await resp.blob();
  playBlob(blob, h);
}

/* 复用共享 <audio> 元素播放；所有失败路径都保证触发 onend */
function playBlob(blob, h) {
  var url = URL.createObjectURL(blob);
  var a = getAudioEl();
  var token = ++_audioToken;
  var done = false;

  function cleanup() {
    URL.revokeObjectURL(url);
    a.onplay = null; a.onended = null; a.onerror = null;
  }
  function finishOk() {
    if (done) return;
    done = true; cleanup(); h.onend();
  }
  function fail(err) {
    if (done) return;
    done = true; cleanup();
    h.onerror(err instanceof Error ? err : new Error("音频播放失败"));
    h.onend();
  }

  a.onplay = function () { if (token === _audioToken) h.onstart(); };
  a.onended = function () { if (token === _audioToken) finishOk(); else cleanup(); };
  a.onerror = function () { if (token === _audioToken) fail(new Error("音频播放失败")); else cleanup(); };
  a.src = url;
  var p = a.play();
  if (p && p.catch) {
    p.catch(function (err) { if (token === _audioToken) fail(err); });
  }
}

/* 统一入口。handlers: {onstart, onend, onerror}
   约定：无论成功失败，onend 必定最终被调用一次（上层靠它恢复语音识别）。
   engine 为 elevenlabs/custom 在请求阶段失败时自动降级为浏览器音色重读一次。 */
FVA.speak = function (text, cfg, handlers) {
  var h = {
    onstart: handlers.onstart || function () {},
    onend: handlers.onend || function () {},
    onerror: handlers.onerror || function () {}
  };
  FVA.stopSpeak();
  if (cfg.engine === "off") { h.onend(); return; }
  if (cfg.engine === "browser") { speakBrowser(text, cfg, h); return; }

  var fn = cfg.engine === "elevenlabs" ? speakElevenLabs : speakCustom;
  fn(text, cfg, h).catch(function (err) {
    console.warn("[FVA] 高级音色失败，降级为浏览器音色：", err);
    h.onerror(err);           // 通知上层显示原因
    speakBrowser(text, cfg, { onstart: h.onstart, onend: h.onend, onerror: function () { h.onend(); } });
  });
};
