import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendTelegram, telegramWhoAmI, resolveChatId } from "./telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const raw of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
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

const me = await telegramWhoAmI();
console.log(`bot: @${me.username || me.first_name}`);
console.log(`chat: ${await resolveChatId()}`);
await sendTelegram(
  "Filter updated: ONLY new-chain alerts now (e.g. Robinhood). Coin bumps / ticker noise ignored."
);
console.log("notice_sent");
