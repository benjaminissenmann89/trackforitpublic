import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_FILE = path.join(__dirname, "logs", "telegram-chat.json");

function token() {
  return (process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

function configuredChatId() {
  const fromEnv = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const j = JSON.parse(fs.readFileSync(CHAT_FILE, "utf8"));
    if (j?.chatId != null) return String(j.chatId);
  } catch {
    /* ignore */
  }
  return "";
}

function saveChatId(chatId) {
  fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true });
  fs.writeFileSync(
    CHAT_FILE,
    JSON.stringify({ chatId: String(chatId), savedAt: new Date().toISOString() }, null, 2)
  );
}

async function api(method, body) {
  const t = token();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!j.ok) {
    throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  }
  return j.result;
}

export async function telegramEnabled() {
  return Boolean(token());
}

export async function telegramWhoAmI() {
  return api("getMe", {});
}

/**
 * Prefer TELEGRAM_CHAT_ID, else saved file, else latest private chat from getUpdates
 * (message the bot once with /start).
 */
export async function resolveChatId() {
  let id = configuredChatId();
  if (id) return id;
  // Telegram allows only one getUpdates caller at a time; the listener owns it.
  if (listening) return "";

  const updates = await api("getUpdates", { limit: 20, timeout: 0 });
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i]?.message || updates[i]?.edited_message;
    const chat = msg?.chat;
    if (chat?.id != null) {
      saveChatId(chat.id);
      return String(chat.id);
    }
  }
  return "";
}

let listening = false;

/** Long-poll for /start and /status so the bot answers while the tracker runs. */
export function startCommandListener(getStatusText) {
  if (listening || !token()) return;
  listening = true;
  let offset = 0;

  (async () => {
    for (;;) {
      try {
        const updates = await api("getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message"],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          const text = (msg?.text || "").trim().toLowerCase();
          if (!msg?.chat?.id || !/^\/(start|status)\b/.test(text)) continue;
          if (!configuredChatId()) saveChatId(msg.chat.id);
          await api("sendMessage", {
            chat_id: msg.chat.id,
            text: getStatusText(),
            disable_web_page_preview: true,
          });
        }
      } catch (err) {
        console.error(`\ntelegram listener: ${err.message || err}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}

export async function sendTelegram(text) {
  const chatId = await resolveChatId();
  if (!chatId) {
    throw new Error(
      "No Telegram chat yet. Open your bot in Telegram, send /start, then retry (or set TELEGRAM_CHAT_ID)."
    );
  }
  const chunks = [];
  const s = String(text);
  for (let i = 0; i < s.length; i += 3500) chunks.push(s.slice(i, i + 3500));
  for (const chunk of chunks) {
    await api("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
  return chatId;
}
