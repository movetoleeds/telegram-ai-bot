import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.AI_API_KEY;

// ====== fetch timeout helper ======
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ====== Telegram sendMessage ======
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

// ====== AI (with endpoint fallback + timeout) ======
const AI_ENDPOINTS = [
  "https://aihub.zeabur.com/v1/chat/completions",
  "https://sfo1.aihub.zeabur.ai/v1/chat/completions",
];

async function askAI(userText) {
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
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [
              { role: "system", content: "你係一個用廣東話回覆嘅私人 AI 助手。" },
              { role: "user", content: userText },
            ],
          }),
        },
        20000
      );

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          data?.error?.message ||
          data?.message ||
          `AI error HTTP ${res.status}`;
        throw new Error(msg);
      }

      const content = data?.choices?.[0]?.message?.content;
      return content?.trim() || "（AI 暫時無回覆 🙏）";
    } catch (err) {
      lastErr = err;
      console.error("askAI endpoint failed:", endpoint, err?.message || err);
      // 試下一個 endpoint
    }
  }

  throw lastErr || new Error("AI endpoints all failed");
}

// ====== Optional: simple concurrency limit (avoid overload) ======
let inFlight = 0;
const MAX_IN_FLIGHT = 2;

async function runLimited(fn) {
  if (inFlight >= MAX_IN_FLIGHT) {
    throw new Error("BUSY");
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
  }
}

// ====== Health check ======
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ====== Telegram Webhook ======
app.post("/webhook", (req, res) => {
  // ✅ 最重要：立即回 OK，Telegram 就唔會 retry
  res.status(200).send("OK");

  // 背後再處理
  (async () => {
    try {
      // Telegram 可能係 message / edited_message / channel_post
      const msg =
        req.body?.message ||
        req.body?.edited_message ||
        req.body?.channel_post ||
        req.body?.edited_channel_post;

      const chatId = msg?.chat?.id;
      const text = msg?.text;

      // 只處理文字
      if (!chatId || !text) return;

      // /start 指令
      if (text === "/start") {
        await sendTelegramMessage(chatId, "我已經 ready ✅ 直接問我啦～");
        return;
      }

      // 過長文字保護（避免一次塞爆）
      const trimmed = text.length > 2000 ? text.slice(0, 2000) : text;

      // 限流：同一時間太多 request 就直接回繁忙
      const reply = await runLimited(async () => {
        return await askAI(trimmed);
      }).catch((e) => {
        if (String(e?.message) === "BUSY") return "（而家多人用緊🙇 你遲啲再試）";
        throw e;
      });

      await sendTelegramMessage(chatId, reply);
    } catch (err) {
      console.error("Webhook handler error:", err?.message || err);

      // 出錯都嘗試回覆一段（避免用戶以為冇反應）
      try {
        const msg =
          req.body?.message ||
          req.body?.edited_message ||
          req.body?.channel_post ||
          req.body?.edited_channel_post;
        const chatId = msg?.chat?.id;
        if (chatId) {
          await sendTelegramMessage(chatId, "（系統繁忙，遲啲再試 🙇）");
        }
      } catch (e) {
        console.error("Failed to send fallback message:", e?.message || e);
      }
    }
  })();
});

// ====== 防 crash：全局保底 ======
process.on("unhandledRejection", (reason) => {
  console.error("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("ENV OK?", {
    TELEGRAM_BOT_TOKEN: !!TELEGRAM_TOKEN,
    AI_API_KEY: !!AI_KEY,
  });
});
