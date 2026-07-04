"use strict";
/* app.js — 界面粘合层：聊天流程、语音识别、各设置页 */

(function () {

  /* ---------- 平台检测（移动端行为差异很大） ---------- */
  var IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var IS_ANDROID = /Android/i.test(navigator.userAgent);
  var IS_STANDALONE = (window.navigator.standalone === true) ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

  /* 语音识别失败时按平台给对的建议（iOS 上没有别的识别引擎，让人换 Edge 是无效指引） */
  function sttHint() {
    if (IS_IOS) return "请用 Safari 打开本页使用语音（并确认 设置→Siri与搜索 已开启听写）；打字聊不受影响";
    if (IS_ANDROID) return "建议用 Chrome 浏览器（其他浏览器通常没有语音识别服务）；打字聊不受影响";
    return "检查浏览器麦克风权限；识别服务连不上时换 Edge 试试";
  }

  var state = {
    persona: null,
    llm: null,
    tts: null,
    history: [],
    micOn: false,
    speaking: false,
    busy: false,
    rec: null,
    pending: "",
    pendTimer: null,
    sttSupported: false
  };

  function $(id) { return document.getElementById(id); }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 2600);
  }

  /* ==================== 标签页 ==================== */

  function initTabs() {
    var tabs = document.querySelectorAll(".tab");
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.addEventListener("click", function () {
        Array.prototype.forEach.call(tabs, function (b) { b.classList.remove("on"); });
        Array.prototype.forEach.call(document.querySelectorAll(".pane"), function (p) { p.classList.remove("on"); });
        btn.classList.add("on");
        $("tab-" + btn.dataset.tab).classList.add("on");
        if (btn.dataset.tab === "brain") refreshPromptPreview();
      });
    });
  }

  /* ==================== 聊天记录 ==================== */

  function loadHistory() {
    try { state.history = JSON.parse(localStorage.getItem("fva_history") || "[]"); }
    catch (e) { state.history = []; }
    if (!Array.isArray(state.history)) state.history = [];
  }

  function saveHistory() {
    if (state.history.length > 200) state.history = state.history.slice(-200);
    localStorage.setItem("fva_history", JSON.stringify(state.history));
  }

  function scrollChat() {
    var box = $("chatBox");
    box.scrollTop = box.scrollHeight;
  }

  function renderMsg(m) {
    var box = $("chatBox");
    var row = document.createElement("div");
    row.className = "msg " + (m.role === "user" ? "user" : "ai");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;
    if (m.role === "assistant") {
      row.appendChild(bubble);
      var btn = document.createElement("button");
      btn.className = "replay";
      btn.title = "重听这句";
      btn.textContent = "🔊";
      btn.addEventListener("click", function () { FVA.unlockPlayback(); speakReply(m.text); });
      row.appendChild(btn);
    } else {
      row.appendChild(bubble);
    }
    box.appendChild(row);
    scrollChat();
  }

  function addMsg(role, text) {
    var m = { role: role, text: text };
    state.history.push(m);
    saveHistory();
    renderMsg(m);
  }

  function sysNote(text) {
    var el = document.createElement("div");
    el.className = "sys-note";
    el.textContent = text;
    $("chatBox").appendChild(el);
    scrollChat();
  }

  var typingEl = null;
  function showTyping() {
    typingEl = document.createElement("div");
    typingEl.className = "msg ai";
    typingEl.innerHTML = '<div class="bubble typing">正在想<span class="dots"></span></div>';
    $("chatBox").appendChild(typingEl);
    scrollChat();
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }

  /* ==================== 状态行 ==================== */

  function setStatus(text, showStop) {
    $("statusText").textContent = text || "";
    $("stopSpeakBtn").classList.toggle("hidden", !showStop);
  }

  /* ==================== 发送 / 回复 ==================== */

  function sendText(text) {
    text = (text || "").trim();
    if (!text || state.busy) return;
    stopSpeakAll();
    $("textInput").value = "";
    addMsg("user", text);
    state.busy = true;
    showTyping();
    FVA.chatReply(state.persona, state.history, state.llm)
      .then(function (reply) { return reply; })
      .catch(function (err) {
        sysNote("大模型连接失败：" + err.message + "（本条已用离线模式代答）");
        return FVA.offlineReply(state.persona, text);
      })
      .then(function (reply) {
        hideTyping();
        state.busy = false;
        addMsg("assistant", reply);
        if (state.tts.autoSpeak) speakReply(reply);
      });
  }

  function speakReply(text) {
    var cfg = Object.assign({}, state.tts, { _gender: state.persona.gender });
    state.speaking = true;
    pauseSTT();
    setStatus("🔊 正在说话…", true);
    FVA.speak(text, cfg, {
      onstart: function () { setStatus("🔊 正在说话…", true); },
      onend: function () {
        state.speaking = false;
        setStatus(state.micOn ? "🎙 听着呢，你说…" : "");
        resumeSTT();
      },
      onerror: function (err) { sysNote("发声出了点问题：" + err.message); }
    });
  }

  function stopSpeakAll() {
    FVA.stopSpeak();
    state.speaking = false;
    setStatus(state.micOn ? "🎙 听着呢，你说…" : "");
    resumeSTT(); // 播报从未真正开始（如被系统拦截）时，onend 不会来，这里兜底恢复识别
  }

  /* ==================== 语音识别 ==================== */

  function sttCtor() { return window.SpeechRecognition || window.webkitSpeechRecognition; }

  /* 屏幕常亮：免提对话中防止手机自动锁屏杀掉识别（不支持的浏览器静默忽略） */
  var wakeLock = null;
  function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock.request("screen")
      .then(function (l) { wakeLock = l; })
      .catch(function () { /* ignore */ });
  }
  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) { /* ignore */ }
      wakeLock = null;
    }
  }

  function startMic() {
    if (!state.sttSupported) {
      toast("此浏览器不支持语音识别。" + sttHint());
      return;
    }
    if (IS_IOS && IS_STANDALONE) {
      // WebKit 限制：iOS 主屏 Web App（standalone）里语音识别不可用，构造器存在但 start 必失败
      toast("iPhone 主屏图标里暂用不了语音识别（系统限制），请在 Safari 里打开本页用语音；打字聊不受影响");
      return;
    }
    if (location.protocol === "file:") {
      toast("file:// 方式打不开麦克风，请用「启动语音助手.bat」启动");
      return;
    }
    stopSpeakAll();
    state.micOn = true;
    $("micBtn").classList.add("listening");
    setStatus("🎙 听着呢，你说…");
    acquireWakeLock();
    startRec();
  }

  function startRec() {
    if (state.rec) return;
    var C = sttCtor();
    var rec = new C();
    state.rec = rec;
    rec.lang = state.tts.sttLang || "zh-CN";
    // Android Chrome 的 continuous 模式有长期 bug：final 结果重复投递，一句话会被拼两遍；
    // 关掉 continuous，靠 onend 自动重启实现持续聆听
    rec.continuous = !IS_ANDROID;
    rec.interimResults = true;
    rec.onresult = function (ev) {
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) {
          state.pending += r[0].transcript;
          scheduleFlush();
        } else {
          interim += r[0].transcript;
        }
      }
      if (interim) setStatus("🎙 " + interim);
    };
    rec.onerror = function (ev) {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        stopMic();
        toast("用不了麦克风：权限被拒或识别服务不可用。" + sttHint());
      } else if (ev.error === "network") {
        stopMic();
        toast("语音识别服务连不上。" + sttHint());
      }
      /* no-speech / aborted 等忽略，onend 会自动重启 */
    };
    rec.onend = function () {
      if (state.rec !== rec || !state.micOn || state.speaking) return;
      try { rec.start(); } catch (e) {
        // 立即重启偶发 InvalidStateError：稍后重试一次，仍失败就明确告知，不留"假在听"状态
        setTimeout(function () {
          if (state.rec !== rec || !state.micOn || state.speaking) return;
          try { rec.start(); } catch (e2) {
            stopMic();
            toast("语音识别中断了，请再点一次 🎤");
          }
        }, 300);
      }
    };
    try { rec.start(); } catch (e) { /* ignore */ }
  }

  function scheduleFlush() {
    clearTimeout(state.pendTimer);
    state.pendTimer = setTimeout(function () {
      var t = state.pending.trim();
      state.pending = "";
      if (t) {
        setStatus("🎙 听着呢…");
        sendText(t);
      }
    }, 900);
  }

  function stopMic() {
    state.micOn = false;
    $("micBtn").classList.remove("listening");
    setStatus("");
    releaseWakeLock();
    var rec = state.rec;
    state.rec = null;
    if (rec) {
      rec.onend = null;
      try { rec.abort(); } catch (e) { /* ignore */ }
    }
  }

  /* 播报期间暂停识别，避免把自己的声音听进去 */
  function pauseSTT() {
    var rec = state.rec;
    state.rec = null;
    if (rec) {
      rec.onend = null;
      try { rec.abort(); } catch (e) { /* ignore */ }
    }
  }

  function resumeSTT() {
    if (state.micOn && !state.rec) startRec();
  }

  /* ==================== 亲人档案页 ==================== */

  function renderChips(containerId, presets, selected) {
    var c = $(containerId);
    c.innerHTML = "";
    var all = presets.slice();
    (selected || []).forEach(function (s) { if (all.indexOf(s) === -1) all.push(s); });
    all.forEach(function (name) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + ((selected || []).indexOf(name) >= 0 ? " on" : "");
      b.textContent = name;
      b.addEventListener("click", function () { b.classList.toggle("on"); });
      c.appendChild(b);
    });
  }

  function readChips(containerId) {
    return Array.prototype.map.call(
      document.querySelectorAll("#" + containerId + " .chip.on"),
      function (b) { return b.textContent; }
    );
  }

  function renderPersonaForm() {
    var p = state.persona;
    $("pRelation").value = p.relation || "";
    $("pName").value = p.name || "";
    $("pGender").value = p.gender || "female";
    $("pAge").value = p.age || "";
    $("pUserCall").value = p.userCall || "";
    $("pDialect").value = p.dialect || "";
    $("pPersonalityExtra").value = p.personalityExtra || "";
    $("pCatchphrases").value = (p.catchphrases || []).join("，");
    $("pSpeakStyle").value = p.speakStyle || "正常";
    $("pMemories").value = p.memories || "";
    $("pHabits").value = p.habits || "";
    $("pTaboos").value = p.taboos || "";
    $("pExamples").value = (p.examples || []).map(function (e) { return e.q + " || " + e.a; }).join("\n");
    renderChips("personalityChips", FVA.PERSONALITY_PRESETS, p.personality);
    renderChips("topicsChips", FVA.TOPIC_PRESETS, p.topics);
  }

  function readPersonaForm() {
    var p = state.persona;
    p.relation = $("pRelation").value.trim() || "亲人";
    p.name = $("pName").value.trim();
    p.gender = $("pGender").value;
    p.age = $("pAge").value.trim();
    p.userCall = $("pUserCall").value.trim() || "孩子";
    p.dialect = $("pDialect").value.trim();
    p.personality = readChips("personalityChips");
    p.personalityExtra = $("pPersonalityExtra").value.trim();
    p.catchphrases = $("pCatchphrases").value.split(/[，,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
    p.speakStyle = $("pSpeakStyle").value;
    p.topics = readChips("topicsChips");
    p.memories = $("pMemories").value.trim();
    p.habits = $("pHabits").value.trim();
    p.taboos = $("pTaboos").value.trim();
    p.examples = $("pExamples").value.split("\n").map(function (line) {
      var idx = line.indexOf("||");
      if (idx < 0) return null;
      return { q: line.slice(0, idx).trim(), a: line.slice(idx + 2).trim() };
    }).filter(function (e) { return e && e.q && e.a; });
    p.isSample = false;
    return p;
  }

  function updateBadge() {
    var p = state.persona;
    $("personaBadge").textContent = (p.relation || "TA") + (p.name ? "·" + p.name : "") + (p.isSample ? "（示例）" : "");
    var mode = "离线体验模式";
    if (state.llm.provider === "anthropic") mode = "Claude · " + state.llm.anthropic.model;
    else if (state.llm.provider === "openai") mode = (state.llm.openai.model || "OpenAI兼容");
    else if (state.llm.provider === "ollama") mode = "Ollama · " + (state.llm.ollama.model || "未选模型");
    $("modeBadge").textContent = mode;
  }

  function initPersonaTab() {
    renderPersonaForm();

    $("savePersonaBtn").addEventListener("click", function () {
      readPersonaForm();
      FVA.savePersona(state.persona);
      updateBadge();
      refreshPromptPreview();
      toast("档案已保存，现在 TA 就是这个样子了");
    });

    $("exportPersonaBtn").addEventListener("click", function () {
      readPersonaForm();
      var blob = new Blob([JSON.stringify(state.persona, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "亲人档案-" + (state.persona.relation || "备份") + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $("importPersonaFile").addEventListener("change", function (ev) {
      var f = ev.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var p = JSON.parse(reader.result);
          var d = FVA.DEFAULT_PERSONA;
          for (var k in d) { if (p[k] === undefined) p[k] = d[k]; }
          state.persona = p;
          FVA.savePersona(p);
          renderPersonaForm();
          updateBadge();
          toast("档案已导入");
        } catch (e) {
          toast("导入失败：文件格式不对");
        }
      };
      reader.readAsText(f, "utf-8");
      ev.target.value = "";
    });

    $("resetPersonaBtn").addEventListener("click", function () {
      if (!confirm("确定恢复成示例档案吗？当前档案会被覆盖（可先导出备份）")) return;
      state.persona = JSON.parse(JSON.stringify(FVA.DEFAULT_PERSONA));
      FVA.savePersona(state.persona);
      renderPersonaForm();
      updateBadge();
      toast("已恢复示例档案");
    });
  }

  /* ==================== 声音页 ==================== */

  function toggleTtsPanels() {
    var eng = state.tts.engine;
    $("panel-tts-browser").classList.toggle("hidden", eng !== "browser");
    $("panel-tts-elevenlabs").classList.toggle("hidden", eng !== "elevenlabs");
    $("panel-tts-custom").classList.toggle("hidden", eng !== "custom");
  }

  function populateVoices() {
    FVA.initVoices(function () {
      var sel = $("voiceSelect");
      var voices = FVA.zhVoices();
      sel.innerHTML = "";
      if (!voices.length) {
        var op = document.createElement("option");
        op.value = "";
        op.textContent = "（没有可用音色）";
        sel.appendChild(op);
        return;
      }
      voices.forEach(function (v) {
        var op = document.createElement("option");
        op.value = v.voiceURI;
        op.textContent = v.name + "（" + v.lang + "）";
        sel.appendChild(op);
      });
      if (state.tts.voiceURI && FVA.findVoice(state.tts.voiceURI)) {
        sel.value = state.tts.voiceURI;
      } else {
        var def = FVA.pickDefaultVoice(state.persona.gender);
        if (def) { sel.value = def.voiceURI; state.tts.voiceURI = def.voiceURI; FVA.saveTTS(state.tts); }
      }
    });
  }

  function initVoiceTab() {
    var t = state.tts;
    $("ttsEngine").value = t.engine;
    $("rateRange").value = t.rate;
    $("pitchRange").value = t.pitch;
    $("rateVal").textContent = Number(t.rate).toFixed(2).replace(/0$/, "");
    $("pitchVal").textContent = Number(t.pitch).toFixed(2).replace(/0$/, "");
    $("autoSpeak").checked = !!t.autoSpeak;
    $("sttLang").value = t.sttLang || "zh-CN";
    $("elKey").value = t.eleven.apiKey || "";
    $("elVoiceId").value = t.eleven.voiceId || "";
    $("elModel").value = t.eleven.modelId || "eleven_multilingual_v2";
    $("customTtsUrl").value = t.customUrl || "";
    toggleTtsPanels();
    populateVoices();

    $("ttsEngine").addEventListener("change", function () {
      t.engine = this.value; FVA.saveTTS(t); toggleTtsPanels();
    });
    $("voiceSelect").addEventListener("change", function () {
      t.voiceURI = this.value; FVA.saveTTS(t);
    });
    $("rateRange").addEventListener("input", function () {
      t.rate = parseFloat(this.value); $("rateVal").textContent = this.value; FVA.saveTTS(t);
    });
    $("pitchRange").addEventListener("input", function () {
      t.pitch = parseFloat(this.value); $("pitchVal").textContent = this.value; FVA.saveTTS(t);
    });
    $("autoSpeak").addEventListener("change", function () {
      t.autoSpeak = this.checked; FVA.saveTTS(t);
    });
    $("sttLang").addEventListener("change", function () {
      t.sttLang = this.value; FVA.saveTTS(t);
      if (state.micOn) { pauseSTT(); resumeSTT(); }
    });
    $("elKey").addEventListener("change", function () { t.eleven.apiKey = this.value.trim(); FVA.saveTTS(t); });
    $("elVoiceId").addEventListener("change", function () { t.eleven.voiceId = this.value.trim(); FVA.saveTTS(t); });
    $("elModel").addEventListener("change", function () { t.eleven.modelId = this.value.trim(); FVA.saveTTS(t); });
    $("customTtsUrl").addEventListener("change", function () { t.customUrl = this.value.trim(); FVA.saveTTS(t); });

    $("testVoiceBtn").addEventListener("click", function () {
      FVA.unlockPlayback();
      var p = state.persona;
      var c = (p.catchphrases && p.catchphrases[0]) ? p.catchphrases[0] + "，" : "";
      var sample = c + (p.userCall || "孩子") + "，吃饭了没？天冷了记得加衣服啊。";
      speakReply(sample);
    });

    $("sttSupportTip").textContent = state.sttSupported
      ? "✅ 当前浏览器支持语音识别。识别没反应时：" + sttHint()
      : "❌ 当前浏览器不支持语音识别。" + sttHint();
  }

  /* ==================== 大脑页 ==================== */

  function toggleBrainPanels() {
    var pv = state.llm.provider;
    $("panel-brain-anthropic").classList.toggle("hidden", pv !== "anthropic");
    $("panel-brain-openai").classList.toggle("hidden", pv !== "openai");
    $("panel-brain-ollama").classList.toggle("hidden", pv !== "ollama");
  }

  function refreshPromptPreview() {
    $("promptPreview").textContent = FVA.buildSystemPrompt(state.persona);
  }

  function initBrainTab() {
    var c = state.llm;
    $("providerSelect").value = c.provider;
    $("anthKey").value = c.anthropic.apiKey || "";
    $("anthModel").value = c.anthropic.model || "claude-opus-4-8";
    $("oaiBase").value = c.openai.baseUrl || "";
    $("oaiKey").value = c.openai.apiKey || "";
    $("oaiModel").value = c.openai.model || "";
    $("olBase").value = c.ollama.baseUrl || "http://localhost:11434";
    if (c.ollama.model) {
      var op = document.createElement("option");
      op.value = c.ollama.model;
      op.textContent = c.ollama.model;
      $("olModel").appendChild(op);
      $("olModel").value = c.ollama.model;
    }
    toggleBrainPanels();
    refreshPromptPreview();

    $("providerSelect").addEventListener("change", function () {
      c.provider = this.value; FVA.saveLLM(c); toggleBrainPanels(); updateBadge();
    });
    $("anthKey").addEventListener("change", function () { c.anthropic.apiKey = this.value.trim(); FVA.saveLLM(c); });
    $("anthModel").addEventListener("change", function () { c.anthropic.model = this.value; FVA.saveLLM(c); updateBadge(); });

    $("oaiPreset").addEventListener("change", function () {
      var pre = FVA.OPENAI_PRESETS[this.value];
      if (pre) {
        c.openai.baseUrl = pre.baseUrl;
        c.openai.model = pre.model;
        $("oaiBase").value = pre.baseUrl;
        $("oaiModel").value = pre.model;
        FVA.saveLLM(c); updateBadge();
      }
    });
    $("oaiBase").addEventListener("change", function () { c.openai.baseUrl = this.value.trim(); FVA.saveLLM(c); });
    $("oaiKey").addEventListener("change", function () { c.openai.apiKey = this.value.trim(); FVA.saveLLM(c); });
    $("oaiModel").addEventListener("change", function () { c.openai.model = this.value.trim(); FVA.saveLLM(c); updateBadge(); });

    $("olBase").addEventListener("change", function () { c.ollama.baseUrl = this.value.trim(); FVA.saveLLM(c); });
    $("olModel").addEventListener("change", function () { c.ollama.model = this.value; FVA.saveLLM(c); updateBadge(); });
    $("olDetect").addEventListener("click", function () {
      var btn = this;
      btn.disabled = true; btn.textContent = "检测中…";
      FVA.detectOllama($("olBase").value.trim())
        .then(function (models) {
          var sel = $("olModel");
          sel.innerHTML = "";
          models.forEach(function (m) {
            var op = document.createElement("option");
            op.value = m; op.textContent = m;
            sel.appendChild(op);
          });
          if (models.length) { c.ollama.model = models[0]; sel.value = models[0]; FVA.saveLLM(c); updateBadge(); }
          toast(models.length ? ("找到 " + models.length + " 个本地模型") : "Ollama 在跑，但没有已下载的模型");
        })
        .catch(function (err) { toast("检测失败：" + err.message); })
        .then(function () { btn.disabled = false; btn.textContent = "检测本机模型"; });
    });

    $("testBrainBtn").addEventListener("click", function () {
      var out = $("brainTestResult");
      out.className = "test-result";
      out.textContent = "测试中…";
      FVA.testBrain(state.persona, c)
        .then(function (reply) {
          out.className = "test-result ok";
          out.textContent = "✅ TA 回复：" + reply.slice(0, 60);
        })
        .catch(function (err) {
          out.className = "test-result err";
          out.textContent = "❌ " + err.message;
        });
    });
  }

  /* ==================== 聊天页 ==================== */

  function initChatUI() {
    // 状态行内部结构
    var line = $("statusLine");
    var span = document.createElement("span");
    span.id = "statusText";
    var stopBtn = document.createElement("button");
    stopBtn.id = "stopSpeakBtn";
    stopBtn.className = "mini-btn hidden";
    stopBtn.textContent = "🔇 别说了";
    stopBtn.addEventListener("click", stopSpeakAll);
    line.appendChild(span);
    line.appendChild(stopBtn);

    $("micBtn").addEventListener("click", function () {
      FVA.unlockPlayback(); // iOS：首次用户手势里解锁语音合成/音频播放
      if (state.micOn) stopMic();
      else startMic();
    });

    $("sendBtn").addEventListener("click", function () {
      FVA.unlockPlayback();
      sendText($("textInput").value);
    });
    $("textInput").addEventListener("keydown", function (ev) {
      // 忽略输入法组合中的回车（keyCode 229 兜底 Safari 在 compositionend 后才派发 keydown 的怪癖），
      // 否则外接键盘打中文时选词回车会把未上屏的拼音直接发出去
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Enter") {
        FVA.unlockPlayback();
        sendText(this.value);
      }
    });

    $("clearChatBtn").addEventListener("click", function () {
      if (!confirm("确定清空全部聊天记录吗？")) return;
      state.history = [];
      saveHistory();
      $("chatBox").innerHTML = "";
      addOpeningLine();
    });

    // 渲染历史
    state.history.forEach(renderMsg);
    if (!state.history.length) addOpeningLine();
  }

  function addOpeningLine() {
    var p = state.persona;
    var u = p.userCall || "孩子";
    var self = FVA.selfTitle(p);
    var openings = [
      "哎，" + u + "！可算来啦。跟" + self + "说说，最近咋样？",
      u + "，吃饭了没？" + self + "正惦记你呢。",
      "哎哟，" + u + "来啦。今天过得好不好？"
    ];
    addMsg("assistant", openings[Math.floor(Math.random() * openings.length)]);
  }

  /* ==================== 启动 ==================== */

  function init() {
    state.persona = FVA.loadPersona();
    state.llm = FVA.loadLLM();
    state.tts = FVA.loadTTS();
    loadHistory();

    state.sttSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

    if (location.protocol === "file:") $("fileBanner").classList.remove("hidden");

    initTabs();
    initChatUI();
    initPersonaTab();
    initVoiceTab();
    initBrainTab();
    updateBadge();

    if (!state.sttSupported) {
      $("micBtn").classList.add("disabled");
      $("chatHint").textContent = "此浏览器不支持语音识别（建议用 Edge / Chrome），可以先打字聊。";
    } else if (IS_IOS && IS_STANDALONE) {
      $("micBtn").classList.add("disabled");
      $("chatHint").textContent = "iPhone 主屏图标里暂不支持语音识别（系统限制）：用语音请在 Safari 里打开本页，这里打字聊不受影响。";
      sysNote("提示：iPhone 上从主屏图标打开时，系统不提供语音识别。想用语音对话请在 Safari 里打开本页；打字聊天和朗读不受影响。");
    }

    // 息屏/切后台会被系统中止识别与朗读；回到前台时恢复，避免"看着在听其实已经聋了"
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      if (!state.micOn) return;
      acquireWakeLock(); // 页面隐藏时系统会自动释放锁，回来重新申请
      if (state.speaking) {
        var synthIdle = !window.speechSynthesis ||
          (!window.speechSynthesis.speaking && !window.speechSynthesis.pending);
        var audioIdle = !FVA.isAudioPlaying();
        if (synthIdle && audioIdle) stopSpeakAll(); // 播报已被系统掐死但 onend 丢失：解除卡死并恢复识别
      } else if (!state.rec) {
        startRec();
      }
    });

    if (state.persona.isSample) {
      sysNote("当前是示例档案「妈妈」。到「亲人档案」页填成你自己亲人的样子，会更像 TA。");
    }
    if (state.llm.provider === "offline") {
      sysNote("当前是离线体验模式，回复比较简单。到「大脑」页接入大模型后，TA 才真正会聊天。");
    }
  }

  document.addEventListener("DOMContentLoaded", init);

})();
