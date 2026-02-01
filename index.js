import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.AI_API_KEY;

let offset = 0;

async function getUpdates() {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?timeout=30&offset=${offset}`
  );
  const data = await res.json();
  return data.result || [];
}

async function sendMessage(chatId, text) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    }
  );
}

async function askAI(userText) {
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
}

async function loop() {
  const updates = await getUpdates();

  for (const u of updates) {
    offset = u.update_id + 1;

    const msg = u.message;
    if (!msg?.text) continue;

    const reply = await askAI(msg.text);
    await sendMessage(msg.chat.id, reply);
  }
}

setInterval(loop, 1500);
