import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  resolveChatId,
  sendTelegram,
  startCommandListener,
  telegramEnabled,
  telegramWhoAmI,
} from "./telegram.js";

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

const SITE = "https://ansem.io";
const INTERVAL_MS = Number(process.env.POLL_MS || 5000);
const HEADLESS = process.env.HEADLESS === "1";

/**
 * Chain / network labels only — no short ambiguous tokens like "sol" / "op"
 * (those matched tickers like $SOLANGELES and caused spam).
 */
const CHAIN_PATTERNS = [
  "robinhood",
  "robin hood",
  "rhood",
  "hood chain",
  "solana",
  "ethereum",
  "bitcoin",
  "binance smart chain",
  "binance",
  "arbitrum",
  "optimism",
  "polygon",
  "avalanche",
  "hyperliquid",
  "hyperevm",
  "berachain",
  "zk sync",
  "zksync",
  "base chain",
  "base network",
  // common chain names (still whole-word; avoid 2–3 letter tickers)
  "base",
  "bsc",
  "bnb chain",
  "matic",
  "avax",
  "sui",
  "aptos",
  "ton",
  "tron",
  "blast",
  "linea",
  "scroll",
  "monad",
  "sonic",
  "abstract",
  "sei",
  "near",
  "cosmos",
];

const DATA_DIR = path.join(__dirname, "data");
const USER_DATA_DIR = path.join(DATA_DIR, "browser-profile");
const LOCK_FILE = path.join(DATA_DIR, "tracker.pid");
const LOG_DIR = path.join(__dirname, "logs");
const SNAPSHOT_FILE = path.join(LOG_DIR, "last-snapshot.json");
const ALERT_LOG = path.join(LOG_DIR, "alerts.jsonl");

/** START.bat stops its restart loop on this exit code. */
const EXIT_ALREADY_RUNNING = 3;

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

function stamp() {
  return new Date().toISOString();
}

/** PIDs get reused after a reboot, so on Windows also require the PID to be a node.exe. */
function isTrackerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
      return /^"node\.exe"/im.test(out);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleInstanceLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const other = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (isTrackerAlive(other)) {
      console.error(`[${stamp()}] Already running (PID ${other}). Not starting a second copy.`);
      process.exit(EXIT_ALREADY_RUNNING);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  }
  process.on("exit", () => {
    try {
      if (fs.readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  });
}

/** Windows: keep the PC from sleeping while this process is alive. Best effort only. */
function keepAwake() {
  if (process.platform !== "win32") return;
  const ps = [
    `$k = Add-Type -Name K -Namespace W -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) {`,
    `  [void]$k::SetThreadExecutionState([uint32]2147483649)`,
    `  Start-Sleep -Seconds 30`,
    `}`,
  ].join("\n");
  const exe = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  try {
    const child = spawn(
      exe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { stdio: "ignore", windowsHide: true, detached: false }
    );
    child.on("error", (err) => console.error(`[${stamp()}] keep-awake unavailable: ${err.message}`));
    child.unref();
  } catch (err) {
    console.error(`[${stamp()}] keep-awake unavailable: ${err.message}`);
  }
}

function beep(times = 1) {
  try {
    for (let i = 0; i < times; i++) process.stdout.write("\x07");
  } catch {
    /* ignore */
  }
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function sha(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function alertChain(detail) {
  const row = {
    at: stamp(),
    kind: "CHAIN_CHANGE",
    section: "chains",
    detail,
  };
  fs.appendFileSync(ALERT_LOG, JSON.stringify(row) + "\n");
  console.log("");
  console.log("=".repeat(60));
  console.log(`[${row.at}] CHAIN_CHANGE`);
  for (const line of detail) console.log(`  ${line}`);
  console.log("=".repeat(60));
  beep(3);

  const tgText = [
    "🚨 ansem.io CHAIN CHANGE",
    ...detail.map((l) => `• ${l}`),
    `at: ${row.at}`,
    SITE,
  ].join("\n");

  sendTelegram(tgText).catch((err) => {
    console.error(`[${stamp()}] telegram send failed: ${err.message || err}`);
  });
}

async function waitForSite(page) {
  console.log(`[${stamp()}] Opening ${SITE} (Cloudflare / warm-up)...`);
  await page.goto(SITE + "/", { waitUntil: "domcontentloaded", timeout: 90000 });

  for (let i = 0; i < 60; i++) {
    const ready = await page.evaluate(async () => {
      const text = document.body?.innerText || "";
      if (/performing security verification|verify you are not a bot/i.test(text)) {
        return { ok: false, reason: "cloudflare" };
      }
      try {
        const r = await fetch("/api/config");
        if (!r.ok) return { ok: false, reason: `api ${r.status}` };
        return { ok: true, reason: "ok" };
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) };
      }
    });

    if (ready.ok) {
      console.log(`[${stamp()}] Site ready.`);
      return;
    }
    if (i % 5 === 0) console.log(`[${stamp()}] Waiting… (${ready.reason})`);
    await page.waitForTimeout(2000);
  }
  throw new Error("Timed out waiting for ansem.io (Cloudflare or API).");
}

/** Keep retrying instead of crash-looping; tell Telegram once if this machine is being blocked. */
async function waitForSiteUntilReady(page) {
  let warned = false;
  for (;;) {
    try {
      await waitForSite(page);
      if (warned) {
        sendTelegram("✅ ansem.io is reachable again — chain watcher resumed.").catch(() => {});
      }
      return;
    } catch (err) {
      status.lastError = `${stamp()} ${err.message || err}`;
      console.error(`[${stamp()}] ${err.message || err} Retrying in 60s...`);
      if (!warned) {
        warned = true;
        sendTelegram(
          `⚠️ ansem.io watcher can't get through to ${SITE} from this machine ` +
            `(${err.message || err}). Cloudflare may be blocking this IP. Still retrying every minute.`
        ).catch((e) => console.error(`[${stamp()}] telegram send failed: ${e.message || e}`));
      }
      await page.waitForTimeout(60000);
    }
  }
}

function extractChainMentions(text, configObj) {
  // Strip $TICKER noise so $SOLANGELES / $CATE don't fake chain hits
  let hay = `${text}\n${JSON.stringify(configObj || {})}`.toLowerCase();
  hay = hay.replace(/\$[a-z0-9]+/gi, " ");
  hay = hay.replace(/\b\d+[smhd]\b/gi, " "); // 5M 1H timeframe buttons

  const found = [];
  for (const name of CHAIN_PATTERNS) {
    const re = new RegExp(
      `(?:^|[^a-z0-9])${name.replace(/\s+/g, "\\s+")}(?:[^a-z0-9]|$)`,
      "i"
    );
    if (re.test(hay)) found.push(name);
  }
  return [...new Set(found)].sort();
}

function collectChainishKeys(obj, prefix = "", out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectChainishKeys(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (/chain|network|chainid|rpc|caip|evm|solana|ethereum|robinhood/i.test(k)) {
      out.push({ path: p, value: v });
    }
    if (v && typeof v === "object") collectChainishKeys(v, p, out);
  }
  return out;
}

/** Only chain-relevant snapshot — ignores coin tickers, nav churn, boost prices. */
async function captureSnapshot(page) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(async () => {
    await page.goto(SITE + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
  });
  await page.waitForTimeout(800);

  const raw = await page.evaluate(async () => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    // Stable copy only — not the live coin grid / ticker strip
    const title = document.title || "";
    const hero = clean(document.querySelector("h1")?.innerText || "");
    const headings = [...document.querySelectorAll("h1, h2, h3, h4")]
      .map((h) => clean(h.innerText))
      .filter(Boolean)
      .slice(0, 40);
    const faq = [...document.querySelectorAll("button, summary")]
      .map((el) => clean(el.innerText))
      .filter((t) => /\?$/.test(t))
      .slice(0, 30);

    // Prefer FAQ + hero + headings for text scan; also a light pass of body
    // but callers will strip $TICKERS
    const bodyText = clean(document.body?.innerText || "").slice(0, 25000);

    const fetchJson = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url} → ${r.status}`);
      return r.json();
    };

    const configRaw = await fetchJson("/api/config");
    return { title, hero, headings, faq, bodyText, configRaw };
  });

  const scanText = [
    raw.title,
    raw.hero,
    raw.headings.join("\n"),
    raw.faq.join("\n"),
    raw.bodyText,
  ].join("\n");

  const mentions = extractChainMentions(scanText, raw.configRaw);
  const configKeys = collectChainishKeys(raw.configRaw).map((x) => ({
    path: x.path,
    // stringify small so diffs are stable
    value: typeof x.value === "object" ? JSON.stringify(x.value) : x.value,
  }));

  return {
    chains: {
      mentions,
      configKeys,
    },
  };
}

function compareChains(prev, next) {
  const before = new Set(prev.chains?.mentions || []);
  const after = new Set(next.chains?.mentions || []);
  const added = [...after].filter((x) => !before.has(x));
  const removed = [...before].filter((x) => !after.has(x));

  const prevKeys = JSON.stringify(
    [...(prev.chains?.configKeys || [])].sort((a, b) => a.path.localeCompare(b.path))
  );
  const nextKeys = JSON.stringify(
    [...(next.chains?.configKeys || [])].sort((a, b) => a.path.localeCompare(b.path))
  );

  const detail = [];
  if (added.length) detail.push(`NEW chain mention(s): ${added.join(", ")}`);
  if (removed.length) detail.push(`removed chain mention(s): ${removed.join(", ")}`);
  if (prevKeys !== nextKeys) {
    detail.push("chain/network fields in /api/config changed");
    detail.push(`was: ${prevKeys.slice(0, 400)}`);
    detail.push(`now: ${nextKeys.slice(0, 400)}`);
  }
  return detail;
}

const status = {
  startedAt: stamp(),
  lastCheckAt: null,
  chains: [],
  lastError: null,
};

function statusText() {
  return [
    "✅ ansem.io chain watcher is running",
    `started: ${status.startedAt}`,
    `last check: ${status.lastCheckAt || "not yet"}`,
    `chains seen: ${status.chains.join(", ") || "(none yet)"}`,
    status.lastError ? `last error: ${status.lastError}` : null,
    "I only message you when a new chain (e.g. Robinhood) shows up.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  acquireSingleInstanceLock();
  keepAwake();

  console.log(`[${stamp()}] ansem.io CHAIN watcher (not coin ticker)`);
  console.log(`  poll every ${INTERVAL_MS}ms`);
  console.log(`  alerts ONLY when a chain mention / chain config key appears or changes`);
  console.log(`  includes robinhood / robin hood / rhood`);
  console.log(`  ignores: live nav, coin bumps, timeframes, boost package prices`);
  console.log(`  data dir ${USER_DATA_DIR}`);

  if (await telegramEnabled()) {
    try {
      const me = await telegramWhoAmI();
      const chatId = await resolveChatId();
      console.log(`  telegram: @${me.username || me.first_name} ready`);
      console.log(chatId ? `  telegram chat: ${chatId}` : "  telegram chat: send /start to the bot");
      startCommandListener(statusText);
    } catch (err) {
      console.error(`  telegram setup error: ${err.message || err}`);
    }
  } else {
    console.log("  telegram: off");
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] || (await context.newPage());
  await waitForSiteUntilReady(page);

  // Reset baseline — old snapshot tracked noisy nav/buttons
  let previous = null;
  let warm = true;

  console.log(`[${stamp()}] Tracking... Ctrl+C to stop.`);

  for (;;) {
    try {
      const snap = await captureSnapshot(page);
      const fingerprint = sha(snap.chains);
      const stored = { at: stamp(), fingerprint, ...snap };
      status.lastCheckAt = stored.at;
      status.chains = snap.chains.mentions || [];
      status.lastError = null;

      if (warm) {
        saveJson(SNAPSHOT_FILE, stored);
        console.log(
          `[${stamp()}] Warmup OK (${fingerprint}). Chains now: ${(snap.chains.mentions || []).join(", ") || "(none)"}`
        );
        console.log(`[${stamp()}] Telegram only if a NEW chain shows up (e.g. robinhood).`);
        sendTelegram(`🟢 ansem.io chain watcher online\n${statusText()}`).catch((err) => {
          console.error(`[${stamp()}] telegram send failed: ${err.message || err}`);
        });
        previous = stored;
        warm = false;
      } else if (previous.fingerprint !== fingerprint) {
        const detail = compareChains(previous, stored);
        if (detail.length) {
          alertChain(detail);
          saveJson(SNAPSHOT_FILE, stored);
          previous = stored;
        } else {
          // hash drift with no real chain diff — refresh baseline quietly
          saveJson(SNAPSHOT_FILE, stored);
          previous = stored;
        }
      } else {
        process.stdout.write(
          `\r[${stamp()}] watching chains — ${(snap.chains.mentions || []).join(",") || "-"} · no change   `
        );
      }

      await page.waitForTimeout(INTERVAL_MS);
    } catch (err) {
      console.error(`\n[${stamp()}] poll error: ${err.message || err}`);
      status.lastError = `${stamp()} ${err.message || err}`;
      await page.waitForTimeout(INTERVAL_MS);
      try {
        await waitForSite(page);
      } catch {
        /* ignore */
      }
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.log(`\n[${stamp()}] stopped.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
