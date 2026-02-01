import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.AI_API_KEY;
const PORT = process.env.PORT || 8080;

/* === AI 問答 === */
async function askAI(userText) {
  try {
    const res = await fetch("https://aihub.zeabur.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${AI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "你係一個用廣東話回覆嘅私人 AI 助手。" },
          { role: "user", content: userText }
        ]
      })
    });

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "（我而家答唔到，試下再問）";
  } catch (err) {
    console.error("AI error:", err);
    return "（系統暫時有問題，遲啲再試 🙏）";
  }
}

/* === Telegram Webhook === */
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg?.text) return res.send("ok");

    const reply = await askAI(msg.text);

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: reply
      })
    });

    res.send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    res.send("ok"); // 一定要回 ok，唔好比 Telegram retry
  }
});

/* === 健康檢查（比 Zeabur 用） === */
app.get("/", (req, res) => {
  res.send("Telegram bot is running");
});

/* === 啟動 Server === */
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
