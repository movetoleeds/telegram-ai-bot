import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// ===== 必須的環境變數 =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.AI_API_KEY;

// ===== Whitelist（只准指定 user id）=====
const WHITELIST = (process.env.WHITELIST_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function isAllowed(userId) {
  if (WHITELIST.length === 0) return true; // 未設 whitelist 時方便 debug
  return WHITELIST.includes(String(userId));
}

// ===== 共用工具 =====
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
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    },
    15000
  );
}

// ================= AI Tool Calling =================

const AI_ENDPOINTS = [
  "https://sfo1.aihub.zeabur.ai/v1/chat/completions",
  "https://hnd1.aihub.zeabur.ai/v1/chat/completions"
];

// --- 天氣（Open-Meteo，免費）---
async function tool_get_weather({ location }) {
  if (!location) return "你想查邊個地方天氣？例如：Leeds、London。";

  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    location
  )}&count=1&language=en&format=json`;

  const geoRes = await fetchWithTimeout(geoUrl, {}, 15000);
  const geo = await geoRes.json();
  const place = geo?.results?.[0];
  if (!place) return `搵唔到「${location}」嘅位置。`;

  const { latitude, longitude, name, admin1, country_code } = place;

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,precipitation,weather_code` +
    `&timezone=Europe%2FLondon`;

  const res = await fetchWithTimeout(url, {}, 20000);
  const data = await res.json();
  const c = data.current;

  const desc =
    c.weather_code === 0 ? "天晴" :
    c.weather_code <= 3 ? "多雲" :
    c.weather_code >= 51 && c.weather_code <= 67 ? "有雨" :
    c.weather_code >= 80 ? "陣雨" :
    "天氣有變";

  return `${name}, ${admin1 || ""}：${desc}，${c.temperature_2m}°C（體感 ${c.apparent_temperature}°C），降水 ${c.precipitation}mm。`;
}

// --- 股票（Stooq，免費）---
async function tool_get_stock_quote({ symbol }) {
  if (!symbol) return "請提供股票代號，例如：AAPL.US / VOD.L / 0700.HK";

  const s = symbol.toLowerCase().includes(".")
    ? symbol.toLowerCase()
    : /^\d+$/.test(symbol)
      ? symbol.padStart(4, "0") + ".hk"
      : symbol.toLowerCase() + ".us";

  const url = `https://stooq.com/q/l/?s=${s}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetchWithTimeout(url, {}, 15000);
  const csv = await res.text();
  const lines = csv.split("\n");
  if (lines.length < 2) return `搵唔到 ${symbol} 報價。`;

  const [, date, time, open, high, low, close] = lines[1].split(",");
  return `股票 ${symbol}（${date} ${time}）：開 ${open}｜高 ${high}｜低 ${low}｜收 ${close}`;
}

// --- 交通（暫時提供智能建議）---
async function tool_get_transport_status({ city, query }) {
  return `我而家未接入 ${city || "該地"} 即時交通 API。\n你可以提供：\n- 出發地 → 目的地\n- 出發時間\n- 交通方式（火車/巴士/駕車）\n我可以即刻幫你規劃同風險提醒。`;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" }
        },
        required: ["location"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_stock_quote",
      description: "Get stock quote",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" }
        },
        required: ["symbol"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_transport_status",
      description: "Get transport advice",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          query: { type: "string" }
        }
      }
    }
  }
];

async function callAI(messages) {
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
      return await res.json();
    } catch (e) {
      console.error("AI endpoint failed:", endpoint, e.message);
    }
  }
  throw new Error("AI unavailable");
}

async function runTool(name, args) {
  if (name === "get_weather") return tool_get_weather(args);
  if (name === "get_stock_quote") return tool_get_stock_quote(args);
  if (name === "get_transport_status") return tool_get_transport_status(args);
  return "未知工具";
}

async function assistantReply(text) {
  const system = {
    role: "system",
    content: "你係一個用廣東話回覆嘅私人 AI 助手，可使用工具提供準確答案。"
  };

  const first = await callAI([system, { role: "user", content: text }]);
  const msg = first.choices[0].message;

  if (!msg.tool_calls) return msg.content;

  const toolMsgs = [];
  for (const tc of msg.tool_calls) {
    const args = JSON.parse(tc.function.arguments || "{}");
    const result = await runTool(tc.function.name, args);
    toolMsgs.push({
      role: "tool",
      tool_call_id: tc.id,
      content: result
    });
  }

  const second = await callAI([system, { role: "user", content: text }, msg, ...toolMsgs]);
  return second.choices[0].message.content;
}

// ================= Routes =================

app.get("/", (_, res) => res.send("OK"));

app.post("/webhook", (req, res) => {
  res.send("OK");

  (async () => {
    const msg = req.body?.message || req.body?.edited_message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // ===== /id（一定要最早攔截）=====
    if (/^\/id(\s|$|@)/.test(text)) {
      await sendTelegramMessage(chatId, `你的 Telegram user id 係：${userId}`);
      return;
    }

    // ===== whitelist 檢查 =====
    if (!isAllowed(userId)) {
      return; // 靜靜 ignore
    }

    // ===== /start =====
    if (/^\/start(\s|$|@)/.test(text)) {
      await sendTelegramMessage(
        chatId,
        "我已經 ready ✅\n你可以問：\n- 列斯天氣\n- AAPL.US 幾錢\n- Leeds 去 Manchester 交通"
      );
      return;
    }

    // ===== 正常對話 =====
    try {
      const reply = await assistantReply(text);
      await sendTelegramMessage(chatId, reply);
    } catch {
      await sendTelegramMessage(chatId, "（系統繁忙，遲啲再試 🙇）");
    }
  })();
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
