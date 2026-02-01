import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Zeabur 會提供 PORT；本機冇就用 8080
const PORT = process.env.PORT || 8080;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.AI_API_KEY;

// ===== 小工具：安全回覆 Telegram =====
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN env var");

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // 可選：避免 markdown 出事
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(
      `Telegram sendMessage failed: ${res.status} ${JSON.stringify(data)}`
    );
  }
}

// ===== AI：防 crash + 清晰 log =====
async function askAI(userText) {
  if (!AI_KEY) throw new Error("Missing AI_API_KEY env var");

  const endpoint = "https://sfo1.aihub.zeabur.ai/v1/chat/completions";

  const res = await fetch(endpoint, {
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
  });

  const data = await res.json().catch(() => ({}));

  // 把錯誤講清楚，唔好只係「繁忙」
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      `AI request failed: HTTP ${res.status}`;
    throw new Error(msg);
  }

  const content = data?.choices?.[0]?.message?.content;
  return content?.trim() || "（AI 暫時無回覆 🙏）";
}

// ===== Health Check =====
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ===== Telegram Webhook =====
app.post("/webhook", async (req, res) => {
  // ✅ 重要：先回 OK，避免 Telegram 因慢而重試
  res.status(200).send("OK");

  try {
    const chatId = req.body?.message?.chat?.id;
    const text = req.body?.message?.text;

    // 只處理文字訊息
    if (!chatId || !text) return;

    // 可選：簡單指令
    if (text === "/start") {
      await sendTelegramMessage(chatId, "我已經 ready ✅ 你可以直接問我問題。");
      return;
    }

    const reply = await askAI(text);
    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error("Webhook handler error:", err?.message || err);

    // 出錯都回一段（避免 user 覺得無反應）
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          "（系統繁忙或 AI 暫時唔得，遲啲再試 🙇）"
        );
      }
    } catch (e) {
      console.error("Failed to send error message:", e?.message || e);
    }
  }
});

// ===== 防 crash：全局保底 =====
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
