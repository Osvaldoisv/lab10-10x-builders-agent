import dns from "node:dns";

// Turbopack worker threads don't inherit --dns-result-order; force IPv4 so
// WSL2 (which has no IPv6 routes) can reach api.telegram.org.
dns.setDefaultResultOrder("ipv4first");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

export async function sendTelegramMessage(chatId: number, text: string, retries = 3): Promise<void> {
  if (!BOT_TOKEN) return;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`Telegram sendMessage failed (attempt ${attempt}):`, res.status, body);
        lastError = new Error(`HTTP ${res.status}: ${body}`);
      } else {
        return;
      }
    } catch (err) {
      lastError = err;
      console.warn(`Telegram sendMessage attempt ${attempt}/${retries} failed:`, err);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}
