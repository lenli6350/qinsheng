"use strict";
/* llm.js — 聊天大脑：离线 / Anthropic Claude / OpenAI兼容 / Ollama */

var FVA = window.FVA = window.FVA || {};

FVA.DEFAULT_LLM = {
  provider: "offline",
  anthropic: { apiKey: "", model: "claude-opus-4-8" },
  openai: { baseUrl: "", apiKey: "", model: "" },
  ollama: { baseUrl: "http://localhost:11434", model: "" },
  maxHistory: 12
};

FVA.OPENAI_PRESETS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
};

FVA.loadLLM = function () {
  try {
    var raw = localStorage.getItem("fva_llm");
    if (raw) {
      var c = JSON.parse(raw);
      var d = FVA.DEFAULT_LLM;
      for (var k in d) {
        if (c[k] === undefined) c[k] = d[k];
        else if (typeof d[k] === "object") {
          for (var kk in d[k]) { if (c[k][kk] === undefined) c[k][kk] = d[k][kk]; }
        }
      }
      return c;
    }
  } catch (e) { /* ignore */ }
  return JSON.parse(JSON.stringify(FVA.DEFAULT_LLM));
};

FVA.saveLLM = function (c) {
  localStorage.setItem("fva_llm", JSON.stringify(c));
};

/* 把聊天记录整理成发给模型的 messages：
   - 只留最近 maxHistory 条
   - 必须以 user 开头 */
function trimHistory(history, maxN) {
  var msgs = history.slice(-maxN).map(function (m) {
    return { role: m.role === "assistant" ? "assistant" : "user", content: m.text };
  });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

async function readErrorText(resp) {
  var text = "";
  try { text = await resp.text(); } catch (e) { /* ignore */ }
  try {
    var j = JSON.parse(text);
    if (j.error && j.error.message) return j.error.message;
    if (j.message) return j.message;
  } catch (e) { /* not json */ }
  return text.slice(0, 200);
}

/* ---------- Anthropic（浏览器直连） ---------- */
async function anthropicReply(sys, msgs, cfg) {
  var a = cfg.anthropic;
  if (!a.apiKey) throw new Error("还没有填 Claude 的 API Key（在「大脑」页填写）");
  var resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": a.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: a.model || "claude-opus-4-8",
      max_tokens: 500,
      system: sys,
      messages: msgs
    })
  });
  if (!resp.ok) throw new Error("Claude 接口报错(" + resp.status + ")：" + (await readErrorText(resp)));
  var data = await resp.json();
  if (data.stop_reason === "refusal") throw new Error("Claude 拒绝了这条消息，换个说法试试");
  var out = "";
  (data.content || []).forEach(function (b) { if (b.type === "text") out += b.text; });
  if (!out) throw new Error("Claude 没有返回文本内容");
  return out.trim();
}

/* ---------- OpenAI 兼容 ---------- */
async function openaiReply(sys, msgs, cfg) {
  var o = cfg.openai;
  if (!o.baseUrl) throw new Error("还没有填接口地址（在「大脑」页选择服务商）");
  if (!o.apiKey) throw new Error("还没有填 API Key（在「大脑」页填写）");
  var url = o.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  var resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + o.apiKey
    },
    body: JSON.stringify({
      model: o.model || "deepseek-chat",
      messages: [{ role: "system", content: sys }].concat(msgs),
      temperature: 0.9,
      max_tokens: 500
    })
  });
  if (!resp.ok) throw new Error("接口报错(" + resp.status + ")：" + (await readErrorText(resp)));
  var data = await resp.json();
  var out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out) throw new Error("接口没有返回文本内容");
  return out.trim();
}

/* ---------- Ollama ---------- */
async function ollamaReply(sys, msgs, cfg) {
  var o = cfg.ollama;
  if (!o.model) throw new Error("还没有选择 Ollama 模型（在「大脑」页点检测）");
  var url = (o.baseUrl || "http://localhost:11434").replace(/\/+$/, "") + "/api/chat";
  var resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.model,
      messages: [{ role: "system", content: sys }].concat(msgs),
      stream: false
    })
  });
  if (!resp.ok) throw new Error("Ollama 报错(" + resp.status + ")：" + (await readErrorText(resp)));
  var data = await resp.json();
  var out = data.message && data.message.content;
  if (!out) throw new Error("Ollama 没有返回文本内容");
  return out.trim();
}

FVA.detectOllama = async function (baseUrl) {
  var url = (baseUrl || "http://localhost:11434").replace(/\/+$/, "") + "/api/tags";
  var resp = await fetch(url);
  if (!resp.ok) throw new Error("连不上 Ollama (" + resp.status + ")");
  var data = await resp.json();
  return (data.models || []).map(function (m) { return m.name; });
};

/* ---------- 统一入口 ----------
   persona: 亲人档案
   history: [{role, text}, ...]（含最新一条用户消息）
   cfg:     大脑配置
   返回:    回复文本；provider 报错时抛异常，由 app.js 兜底 */
FVA.chatReply = async function (persona, history, cfg) {
  if (cfg.provider === "offline") {
    var last = history[history.length - 1];
    return FVA.offlineReply(persona, last ? last.text : "");
  }
  var sys = FVA.buildSystemPrompt(persona);
  var msgs = trimHistory(history, cfg.maxHistory || 12);
  if (!msgs.length) throw new Error("没有可发送的消息");
  if (cfg.provider === "anthropic") return anthropicReply(sys, msgs, cfg);
  if (cfg.provider === "openai") return openaiReply(sys, msgs, cfg);
  if (cfg.provider === "ollama") return ollamaReply(sys, msgs, cfg);
  throw new Error("未知的大脑类型：" + cfg.provider);
};

/* 测试当前大脑配置 */
FVA.testBrain = async function (persona, cfg) {
  return FVA.chatReply(persona, [{ role: "user", text: "喂？在吗？" }], cfg);
};
