"use strict";
/* persona.js — 亲人档案模型、人设提示词生成、离线回复引擎 */

var FVA = window.FVA = window.FVA || {};

FVA.PERSONALITY_PRESETS = [
  "温柔", "唠叨", "幽默", "严厉", "节俭", "操心", "乐观",
  "急性子", "慢性子", "刀子嘴豆腐心", "传统", "爱面子", "心软", "要强"
];

FVA.TOPIC_PRESETS = [
  "吃饭", "身体健康", "天气", "工作", "学习", "花钱",
  "找对象/催婚", "孩子", "邻里亲戚", "养生"
];

FVA.DEFAULT_PERSONA = {
  relation: "妈妈",
  name: "",
  gender: "female",
  age: "55",
  userCall: "宝贝",
  personality: ["温柔", "唠叨", "操心", "刀子嘴豆腐心"],
  personalityExtra: "",
  catchphrases: ["哎哟", "我跟你说", "听妈的没错"],
  dialect: "",
  speakStyle: "唠叨",
  topics: ["吃饭", "身体健康", "天气", "工作", "花钱"],
  memories: "小时候你最爱吃我做的红烧肉。\n家里养过一只叫大黄的狗。",
  habits: "爱转发养生文章，微信语音一发就是一分钟。",
  taboos: "",
  examples: [
    { q: "我最近好累", a: "哎哟，又熬夜了吧？工作是干不完的，身体要紧，晚上早点睡。" },
    { q: "我想吃你做的菜了", a: "那还不快回来，妈明天就给你炖红烧肉，管够！" }
  ],
  isSample: true
};

/* ---------- 存取 ---------- */

FVA.loadPersona = function () {
  try {
    var raw = localStorage.getItem("fva_persona");
    if (raw) {
      var p = JSON.parse(raw);
      // 补齐新增字段
      var d = FVA.DEFAULT_PERSONA;
      for (var k in d) { if (p[k] === undefined) p[k] = d[k]; }
      return p;
    }
  } catch (e) { /* ignore */ }
  return JSON.parse(JSON.stringify(FVA.DEFAULT_PERSONA));
};

FVA.savePersona = function (p) {
  localStorage.setItem("fva_persona", JSON.stringify(p));
};

/* 自称：妈妈→妈，爸爸→爸，其他保持原样 */
FVA.selfTitle = function (p) {
  var map = { "妈妈": "妈", "母亲": "妈", "爸爸": "爸", "父亲": "爸" };
  return map[p.relation] || p.relation || "我";
};

/* ---------- 人设提示词 ---------- */

FVA.buildSystemPrompt = function (p) {
  var self = FVA.selfTitle(p);
  var lines = [];
  lines.push("你现在扮演用户的" + (p.relation || "亲人") + (p.name ? "「" + p.name + "」" : "") + "，在手机上和用户（你的孩子/家人）聊天。你不是AI助手，而是一个真实的人，任何情况下都不要承认或暗示自己是AI、机器人、程序或语言模型；被问到时用玩笑或嗔怪带过去（比如“说啥傻话呢，我是你" + (p.relation || "亲人") + "啊”）。");
  lines.push("");
  lines.push("【基本信息】");
  if (p.age) lines.push("- 年龄：" + p.age + "岁左右");
  lines.push("- 你平时叫用户：" + (p.userCall || "孩子"));
  lines.push("- 用户平时叫你：" + (p.relation || "") + "，你自称“" + self + "”");
  if (p.dialect) lines.push("- 方言/地域：" + p.dialect + "（可以自然地夹杂一点方言词，但别过火）");

  var traits = (p.personality || []).slice();
  if (p.personalityExtra) traits.push(p.personalityExtra);
  if (traits.length) {
    lines.push("");
    lines.push("【性格】" + traits.join("、"));
  }

  lines.push("");
  lines.push("【说话方式】");
  if (p.catchphrases && p.catchphrases.length) {
    lines.push("- 口头禅：" + p.catchphrases.join("、") + "。自然地偶尔用，不要每句都用。");
  }
  if (p.speakStyle === "简短") {
    lines.push("- 说话简短干脆，经常一两句就完。");
  } else if (p.speakStyle === "唠叨") {
    lines.push("- 爱唠叨，一件小事能叮嘱好几句，但每条消息仍控制在四句以内。");
  } else {
    lines.push("- 语气自然，像日常微信聊天。");
  }
  lines.push("- 回复必须口语化，像发微信/说语音那样，通常1~3句话。绝对不用书面语、不列条目、不用markdown、不用emoji（顶多用个“～”或标点表达语气）。");
  lines.push("- 你的回复会被转成语音朗读，所以不要出现网址、英文缩写、代码等念不出来的内容。");
  if (p.habits) lines.push("- 其他习惯：" + p.habits);

  if (p.topics && p.topics.length) {
    lines.push("");
    lines.push("【你最关心的话题】" + p.topics.join("、") + "。聊天中会自然地主动关心这些，比如问吃饭没、叮嘱天冷加衣、催早点睡。");
  }

  if (p.memories) {
    lines.push("");
    lines.push("【你们的共同记忆/家里的事】");
    p.memories.split("\n").forEach(function (m) {
      m = m.trim();
      if (m) lines.push("- " + m);
    });
    lines.push("聊到相关话题时可以自然提起这些；对于你不知道的家事细节，含糊带过或反问用户，绝不编造具体的人名、地名、事件。");
  }

  if (p.taboos) {
    lines.push("");
    lines.push("【避免】不要主动提起：" + p.taboos);
  }

  if (p.examples && p.examples.length) {
    lines.push("");
    lines.push("【对话示例（模仿这种语气）】");
    p.examples.forEach(function (ex) {
      if (ex.q && ex.a) {
        lines.push("用户：" + ex.q);
        lines.push("你：" + ex.a);
      }
    });
  }

  lines.push("");
  lines.push("【底线】你始终是关心用户的家人：不训斥过头、不冷暴力；用户情绪低落时先安慰；涉及健康/安全的严肃问题，劝用户找专业的人看看，别只顾着宽心。");

  return lines.join("\n");
};

/* ---------- 离线回复引擎 ---------- */

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function chance(p) { return Math.random() < p; }

function timeGreeting() {
  var h = new Date().getHours();
  if (h < 5) return "大半夜的";
  if (h < 9) return "一大早";
  if (h < 12) return "上午";
  if (h < 14) return "中午";
  if (h < 18) return "下午";
  return "晚上";
}

var FOLLOWUPS = {
  "吃饭": ["你吃饭了没？", "今天吃的啥？别老点外卖啊。"],
  "身体健康": ["最近身体咋样？", "别老熬夜，听见没？"],
  "天气": ["你那边天气怎么样？冷不冷？", "降温了记得加衣服啊。"],
  "工作": ["工作忙不忙？别太拼了。", "累了就歇歇，钱是挣不完的。"],
  "学习": ["最近学习跟得上不？", "别老玩手机，正事要紧。"],
  "花钱": ["钱够不够花？不够跟家里说。", "省着点花，别乱买没用的。"],
  "找对象/催婚": ["有没有处对象啊？有合适的带回来看看。"],
  "孩子": ["孩子最近乖不乖？"],
  "邻里亲戚": ["你二姨前两天还问起你呢。"],
  "养生": ["多喝点热水，少喝那些冰的。"]
};

var INTENTS = [
  {
    re: /(你是谁|机器人|是不是AI|人工智能|是AI|程序|假的)/,
    replies: [
      "说啥傻话呢，{u}，我是你{rel}啊。",
      "净瞎说，快跟{self}说说你今天咋样。"
    ]
  },
  {
    re: /^(喂|哈喽|hello|hi|嗨|在吗|在不在|你好)/i,
    replies: [
      "哎，{u}！{time}想起来找{self}啦？",
      "在呢在呢，正想你呢。{time}吃了没？",
      "哎哟，{u}来啦。最近咋样啊？"
    ]
  },
  {
    re: /(吃了|吃饭|早饭|午饭|晚饭|夜宵|外卖|饿)/,
    replies: [
      "可别老吃外卖，没营养。有空自己做点，实在不行回家{self}给你做。",
      "按时吃饭啊{u}，胃坏了遭罪的是自己。",
      "想吃啥跟{self}说，回来{self}给你做。"
    ]
  },
  {
    re: /(累|好烦|压力|难受|不开心|烦死|心情不好|委屈|哭)/,
    replies: [
      "咋啦{u}？跟{self}说说，别一个人闷着。",
      "累了就歇歇，天大的事也没有身体要紧。",
      "别往心里去，{u}。日子长着呢，过了这阵就好了。"
    ]
  },
  {
    re: /(感冒|生病|发烧|头疼|肚子疼|不舒服|咳嗽|医院)/,
    replies: [
      "哎哟，严不严重？别硬扛，赶紧去看看医生。",
      "多喝点热水，早点睡。明天还不舒服一定去医院，听见没？",
      "吃药了没？{u}你这孩子，身体的事不能拖。"
    ]
  },
  {
    re: /(加班|上班|工作|老板|同事|项目|开会|裁员)/,
    replies: [
      "工作是干不完的，{u}，别把自己累垮了。",
      "受委屈了跟{self}说，咱不怕，大不了换一家。",
      "好好干，但也别太拼，按时吃饭按时睡觉。"
    ]
  },
  {
    re: /(天气|下雨|好冷|好热|降温|下雪|台风)/,
    replies: [
      "你那边冷的话记得加衣服，别为了好看冻着。",
      "出门带伞啊{u}。",
      "屋里开空调也别对着吹，容易着凉。"
    ]
  },
  {
    re: /(钱|工资|花|买了|贵|穷|房租|还贷)/,
    replies: [
      "钱够不够花？不够跟家里说，别在外面借。",
      "该花的花，不该花的省着点，{u}。",
      "别买那些没用的，攒点钱心里踏实。"
    ]
  },
  {
    re: /(想你|想家|想回家|回家)/,
    replies: [
      "{self}也想你。家里都好，你在外面照顾好自己。",
      "想家就常打电话，有假就回来，{self}给你做好吃的。",
      "哎哟，说得{self}心里怪暖的。啥时候回来？"
    ]
  },
  {
    re: /(睡了|晚安|去睡|困了)/,
    replies: [
      "早点睡，别玩手机了。晚安{u}。",
      "去吧去吧，好好睡一觉，明天又是精神的一天。",
      "晚安，被子盖好。"
    ]
  },
  {
    re: /(拜拜|再见|先这样|挂了|不聊了|去忙)/,
    replies: [
      "去吧，忙你的。照顾好自己，有事给{self}打电话。",
      "好，记得按时吃饭啊。",
      "去吧{u}，别太累了。"
    ]
  },
  {
    re: /(对象|男朋友|女朋友|相亲|结婚|脱单)/,
    replies: [
      "有合适的就处处看，人品最要紧。",
      "缘分的事急不来，但{u}你也上点心啊。",
      "找个知冷知热的就行，{self}不图别的，就图你过得好。"
    ]
  }
];

var FALLBACKS = [
  "嗯，{u}你说的这个{self}不太懂，你再跟{self}说说？",
  "是嘛？后来呢？",
  "哦哦，那你自己心里有数就行，{self}相信你。",
  "{self}老了，这些新鲜玩意儿不太懂，不过你开心就好。",
  "嗯呢，{self}听着呢，你接着说。",
  "行，这事你看着办，拿不准再问{self}。"
];

FVA.offlineReply = function (p, userText) {
  var self = FVA.selfTitle(p);
  var u = p.userCall || "孩子";
  var rel = p.relation || "亲人";
  var templates = null;

  for (var i = 0; i < INTENTS.length; i++) {
    if (INTENTS[i].re.test(userText)) { templates = INTENTS[i].replies; break; }
  }
  if (!templates) templates = FALLBACKS;

  var reply = pick(templates)
    .replace(/\{u\}/g, u)
    .replace(/\{self\}/g, self)
    .replace(/\{rel\}/g, rel)
    .replace(/\{time\}/g, timeGreeting());

  // 口头禅：35% 概率加在开头
  if (p.catchphrases && p.catchphrases.length && chance(0.35)) {
    var c = pick(p.catchphrases);
    if (reply.indexOf(c) === -1) reply = c + "，" + reply;
  }

  // 追问：30% 概率追加一个 TA 关心的话题（回复本身不是问句时）
  if (p.topics && p.topics.length && chance(0.3) && reply.indexOf("？") === -1 && reply.indexOf("?") === -1) {
    var topic = pick(p.topics);
    var pool = FOLLOWUPS[topic];
    if (pool) reply += " " + pick(pool);
  }

  return reply;
};
