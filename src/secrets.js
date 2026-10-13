// Pack the git-ignored secret files into one encrypted file (secrets.enc) and restore them.
//   node src/secrets.js lock <key>     encrypt SECRET_FILES -> secrets.enc
//   node src/secrets.js unlock <key>   decrypt secrets.enc -> SECRET_FILES
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENC_FILE = path.join(ROOT, "secrets.enc");
const SECRET_FILES = [".env", "logs/telegram-chat.json"];

const MAGIC = Buffer.from("SEC1");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(key, salt) {
  return scryptSync(key, salt, 32, SCRYPT);
}

function lock(key) {
  const files = {};
  for (const rel of SECRET_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) files[rel] = fs.readFileSync(abs).toString("base64");
  }
  if (!Object.keys(files).length) throw new Error("No secret files found to lock.");

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ files })), cipher.final()]);
  fs.writeFileSync(ENC_FILE, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]));
  console.log(`Locked ${Object.keys(files).join(", ")} -> secrets.enc`);
}

function unlock(key) {
  if (!fs.existsSync(ENC_FILE)) throw new Error("secrets.enc not found.");
  const buf = fs.readFileSync(ENC_FILE);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("secrets.enc is not a valid secrets file.");

  let off = MAGIC.length;
  const salt = buf.subarray(off, (off += SALT_LEN));
  const iv = buf.subarray(off, (off += IV_LEN));
  const tag = buf.subarray(off, (off += TAG_LEN));
  const body = buf.subarray(off);

  let plain;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(key, salt), iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    const err = new Error("Wrong unlock key (or secrets.enc is damaged).");
    err.code = "BAD_KEY";
    throw err;
  }

  const { files } = JSON.parse(plain.toString("utf8"));
  for (const [rel, b64] of Object.entries(files)) {
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, "base64"));
  }
  console.log(`Unlocked ${Object.keys(files).join(", ")}`);
}

const [cmd, key] = process.argv.slice(2);
if (!["lock", "unlock"].includes(cmd) || !key) {
  console.error("Usage: node src/secrets.js lock|unlock <key>");
  process.exit(1);
}
try {
  if (cmd === "lock") lock(key);
  else unlock(key);
} catch (err) {
  console.error(err.message || err);
  process.exit(err.code === "BAD_KEY" ? 2 : 1);
}
