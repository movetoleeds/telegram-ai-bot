import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// Required env
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.AI_API_KEY;

// Optional env (only for London transport via TfL; can be empty)
const TFL_APP_ID = process.env.TFL_APP_ID || "";
const TFL_APP_KEY = process.env.TFL_APP_KEY || "";

/* =========================
   Helpers
========================= */
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN env var");

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    },
    15000
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(
      `Telegram sendMessage failed: ${res.status} ${JSON.stringify(data)}`
    );
  }
}

function safeText(s, max = 2000) {
  const t = (s ?? "").toString();
  return t.length > max ? t.slice(0, max) : t;
}

/* =========================
   Tool implementations
========================= */

// --- Weather: Open-Meteo (free, no key) ---
async function tool_get_weather({ location, when = "now" }) {
  const q = (location || "").trim();
  if (!q) return "你想查邊個地方天氣？例如：Leeds / London / Manchester。";

  // 1) Geocoding
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    q
  )}&count=1&language=en&format=json`;

  const geoRes = await fetchWithTimeout(geoUrl, {}, 15000);
  const geo = await geoRes.json().catch(() => ({}));
  const place = geo?.results?.[0];
  if (!place) return `搵唔到「${q}」嘅位置。你可唔可以打清楚啲？例如：Leeds, UK。`;

  const lat = place.latitude;
  const lon = place.longitude;
  const name = [place.name, place.admin1, place.country_code].filter(Boolean).join(", ");

  // 2) Current + daily
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code` +
    `&timezone=Europe%2FLondon`;

  const res = await fetchWithTimeout(url, {}, 20000);
  const data = await res.json().catch(() => ({}));

  const c = data?.current;
  const d = data?.daily;

  if (!c) return `暫時拎唔到 ${name} 天氣（Open-Meteo 可能忙緊）。你遲啲再試吖。`;

  const descNow = describeWeatherCode(c.weather_code);
  const nowLine =
    `${name}（${when}）：${descNow}。` +
    `氣溫 ${c.temperature_2m}°C（體感 ${c.apparent_temperature}°C），` +
    `降水 ${c.precipitation}mm，風速 ${c.wind_speed_10m} km/h。`;

  // If user asked "today/tomorrow" we can add daily summary
  let extra = "";
  const w = (when || "").toLowerCase();
  const wantDaily = ["today", "tomorrow", "weekend", "this week", "今日", "聽日", "週末", "星期"].some(x =>
    w.includes(x)
  );

  if (wantDaily && d?.time?.length) {
    const i = w.includes("tomorrow") || w.includes("聽日") ? 1 : 0;
    const date = d.time[i];
    const max = d.temperature_2m_max?.[i];
    const min = d.temperature_2m_min?.[i];
    const ps = d.precipitation_sum?.[i];
    const desc = describeWeatherCode(d.weather_code?.[i]);
    if (date != null) {
      extra =
        `\n${date}：${desc}，最高 ${max}°C / 最低 ${min}°C，總降水 ${ps}mm。`;
    }
  }

  return nowLine + extra;
}

function describeWeatherCode(code) {
  const c = Number(code);
  if (Number.isNaN(c)) return "天氣不明";
  if (c === 0) return "天晴";
  if (c >= 1 && c <= 3) return "多雲";
  if (c === 45 || c === 48) return "有霧";
  if (c >= 51 && c <= 67) return "毛毛雨/有雨";
  if (c >= 71 && c <= 77) return "落雪";
  if (c >= 80 && c <= 82) return "陣雨";
  if (c >= 95) return "雷暴";
  return "天氣有變";
}

// --- Stocks: Stooq (free, no key) ---
// Supports e.g. AAPL.US, TSLA.US, VOD.L, 0700.HK
async function tool_get_stock_quote({ symbol }) {
  const s = (symbol || "").trim();
  if (!s) return "你想查邊隻股票？例如：AAPL.US / TSLA.US / VOD.L / 0700.HK";

  const stooqSymbol = normalizeStooqSymbol(s);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(
    stooqSymbol
  )}&f=sd2t2ohlcv&h&e=csv`;

  const res = await fetchWithTimeout(url, {}, 15000);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return `暫時拎唔到 ${s} 報價（資料源可能忙緊）。`;

  const cols = lines[1].split(",");
  // Date,Time,Open,High,Low,Close,Volume
  const date = cols[0];
  const time = cols[1];
  const open = cols[2];
  const high = cols[3];
  const low = cols[4];
  const close = cols[5];
  const vol = cols[6];

  if (!close || close === "N/A") {
    return `我搵唔到「${s}」報價。你可唔可以用呢種格式：AAPL.US / VOD.L / 0700.HK？`;
  }

  return (
    `股票 ${s}（${date} ${time}）：\n` +
    `開 ${open}｜高 ${high}｜低 ${low}｜收 ${close}｜量 ${vol}`
  );
}

function normalizeStooqSymbol(sym) {
  const s = sym.trim().toLowerCase();

  // already has suffix
  if (s.includes(".")) return s;

  // numeric HK style: 0700 -> 0700.hk
  if (/^\d{1,5}$/.test(s)) return s.padStart(4, "0") + ".hk";

  // default to US
  return s + ".us";
}

// --- Transport: London (TfL) live; other cities give useful guidance ---
async function tool_get_transport_status({ city = "", mode = "", query = "" }) {
  const c = (city || "").trim().toLowerCase();
  const m = (mode || "").trim().toLowerCase();
  const q = (query || "").trim();

  // If London: try TfL line status
  if (c.includes("london") || q.toLowerCase().includes("london")) {
    const linePart =
      q && q.length < 40 ? q : "tube,dlr,overground,elizabeth-line";

    const auth =
      (TFL_APP_ID && TFL_APP_KEY)
        ? `?app_id=${encodeURIComponent(TFL_APP_ID)}&app_key=${encodeURIComponent(TFL_APP_KEY)}`
        : "";

    const url = `https://api.tfl.gov.uk/Line/${encodeURIComponent(
      linePart
    )}/Status${auth}`;

    const res = await fetchWithTimeout(url, {}, 15000);
    const data = await res.json().catch(() => null);

    if (!Array.isArray(data)) {
      return "我暫時拎唔到 TfL 即時狀態。你想查邊條線？例如：Central line / Elizabeth line。";
    }

    const top = data
      .slice(0, 6)
      .map((x) => {
        const name = x?.name || "Unknown line";
        const status = x?.lineStatuses?.[0]?.statusSeverityDescription || "Unknown";
        const reason = x?.lineStatuses?.[0]?.reason;
        return reason
          ? `- ${name}: ${status}（${trimOneLine(reason, 90)}）`
          : `- ${name}: ${status}`;
      })
      .join("\n");

    return `倫敦交通（TfL）即時狀態：\n${top}\n\n想查指定線就話我：例如「倫敦 Central line 點？」`;
  }

  // Non-London: provide practical steps + ask for details (since reliable live APIs often require keys)
  const cityText = city ? `（${city}）` : "";
  return (
    `交通${cityText}：我而家未有接入你當地嘅「即時交通 API」（好多英國 rail/bus API 需要另外申請 key）。\n` +
    `不過你可以用我以下方式即刻變得好有用：\n` +
    `1) 你講清楚：出發地 → 目的地、幾時出發（例如：今晚 7pm）、交通模式（火車/巴士/自駕）。\n` +
    `2) 我可以幫你：\n` +
    `   - 建議路線選擇同時間預留（轉車/塞車風險）\n` +
    `   - 幫你寫「查詢/改期」訊息（例如同公司/朋友）\n` +
    `   - 如果你想要「即時延誤/班次」，我可以加接 TransportAPI / National Rail（你提供 key 後就得）\n` +
    `\n你而家想查邊一段行程？（例：Leeds 去 Manchester，聽日早上）`
  );
}

function trimOneLine(s, max = 120) {
  const one = (s || "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/* =========================
   Tool Calling (2-step)
========================= */

const AI_ENDPOINTS = [
  "https://sfo1.aihub.zeabur.ai/v1/chat/completions",
  "https://hnd1.aihub.zeabur.ai/v1/chat/completions",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather (and optional today/tomorrow summary) for a location.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City or place name, e.g. Leeds, UK" },
          when: { type: "string", description: "now/today/tomorrow/weekend (optional)" }
        },
        required: ["location"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_stock_quote",
      description: "Get a stock quote for a ticker (supports .US, .L, .HK).",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "e.g. AAPL.US, TSLA.US, VOD.L, 0700.HK" }
        },
        required: ["symbol"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_transport_status",
      description: "Get transport status. London can return TfL live line status; other cities return guidance and asks for details.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name, e.g. London, Leeds (optional)" },
          mode: { type: "string", description: "tube/bus/train/drive (optional)" },
          query: { type: "string", description: "Free-form query, e.g. 'Central line' or 'Leeds to York train'" }
        }
      }
    }
  }
];

async function callAI(messages) {
  if (!AI_KEY) throw new Error("Missing AI_API_KEY env var");

  let lastErr = null;
  for (const endpoint of AI_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${AI_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages,
            tools: TOOLS,
            tool_choice: "auto"
          })
        },
        25000
      );

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          data?.error?.message || data?.message || `AI error HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    } catch (e) {
      lastErr = e;
      console.error("AI endpoint failed:", endpoint, e?.message || e);
    }
  }
  throw lastErr || new Error("All AI endpoints failed");
}

async function runTool(name, args) {
  if (name === "get_weather") return await tool_get_weather(args);
  if (name === "get_stock_quote") return await tool_get_stock_quote(args);
  if (name === "get_transport_status") return await tool_get_transport_status(args);
  return `Unknown tool: ${name}`;
}

async function assistantReply(userText) {
  const system = {
    role: "system",
    content: [
      "你係一個用廣東話回覆嘅私人 AI 助手。",
      "你可以用工具（天氣/股票/交通）去提供更準確答案。",
      "如果需要即時資料而工具暫時拎唔到，要清楚講原因，再提供可行建議，唔好一句叫用戶上網就算。",
      "回覆要短、直接、實用。"
    ].join("\n")
  };

  const messages1 = [
    system,
    { role: "user", content: safeText(userText, 2000) }
  ];

  const first = await callAI(messages1);
  const msg1 = first?.choices?.[0]?.message;

  // If no tool calls, return direct content
  const toolCalls = msg1?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    return msg1?.content?.trim() || "（我而家答唔到，試下再問）";
  }

  // Execute tools
  const toolMessages = [];
  for (const tc of toolCalls) {
    const name = tc?.function?.name;
    const rawArgs = tc?.function?.arguments || "{}";
    let args = {};
    try { args = JSON.parse(rawArgs); } catch { args = {}; }

    const result = await runTool(name, args);
    toolMessages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: typeof result === "string" ? result : JSON.stringify(result)
    });
  }

  // Second call: give tool results back to AI for final response
  const messages2 = [
    system,
    { role: "user", content: safeText(userText, 2000) },
    msg1,
    ...toolMessages
  ];

  const second = await callAI(messages2);
  const msg2 = second?.choices?.[0]?.message;
  return msg2?.content?.trim() || "（我而家答唔到，試下再問）";
}

/* =========================
   Routes
========================= */

// Health check
app.get("/", (_, res) => res.status(200).send("OK"));

// Telegram webhook
app.post("/webhook", (req, res) => {
  // IMPORTANT: respond immediately
  res.status(200).send("OK");

  (async () => {
    try {
      const msg =
        req.body?.message ||
        req.body?.edited_message ||
        req.body?.channel_post ||
        req.body?.edited_channel_post;

      const chatId = msg?.chat?.id;
      const text = msg?.text;

      if (!chatId || !text) return;

      // /start
      if (/^\/start(\s|$|@)/.test(text)) {
        await sendTelegramMessage(
          chatId,
          "我已經 ready ✅\n你可以問：\n- 列斯今日天氣？\n- AAPL.US 幾錢？\n- 倫敦 Central line 有冇延誤？"
        );
        return;
      }

      const reply = await assistantReply(text);
      await sendTelegramMessage(chatId, reply);
    } catch (err) {
      console.error("Webhook error:", err?.message || err);
      // Best-effort fallback
      try {
        const msg = req.body?.message || req.body?.edited_message;
        const chatId = msg?.chat?.id;
        if (chatId) {
          await sendTelegramMessage(chatId, "（系統繁忙，遲啲再試 🙇）");
        }
      } catch {}
    }
  })();
});

// Crash guards
process.on("unhandledRejection", (reason) => console.error("UnhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("ENV OK?", {
    TELEGRAM_BOT_TOKEN: !!TELEGRAM_TOKEN,
    AI_API_KEY: !!AI_KEY
  });
});
