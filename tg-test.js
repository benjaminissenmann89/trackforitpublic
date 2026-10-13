import { resolveChatId, sendTelegram, telegramWhoAmI } from "./telegram.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}

loadEnvFile();

const me = await telegramWhoAmI();
console.log(`bot: @${me.username || me.first_name}`);
const chatId = await resolveChatId();
if (!chatId) {
  console.log("NO_CHAT — open your bot in Telegram and send /start, then rerun this test");
  process.exit(2);
}
console.log(`chat: ${chatId}`);
await sendTelegram("ansem.io tracker test — if you see this, Telegram alerts work.");
console.log("TEST_SENT");
