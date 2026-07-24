// ==================================================
// Gọi Telegram Bot API — thay cho pyTelegramBotAPI
// ==================================================
export async function telegramApi(env, method, params) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[Telegram API] ${method} thất bại:`, data.description);
  }
  return data;
}

export function cho(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
