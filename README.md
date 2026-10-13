# ansem.io chain watcher

Alerts **only** when a **new chain** shows up on [ansem.io](https://ansem.io/) (e.g. Robinhood) — not when coins get bumped in the live ticker.

## Alerts

Telegram + console **only** for:

- New chain name mentions (includes `robinhood`, `robin hood`, `rhood`, Solana, Ethereum, Base, …)
- New / changed `chain` · `network` · `rpc` fields in `/api/config`

## Ignored (was causing spam)

- Live nav / leaderboard coin bumps  
- Timeframe buttons (5M / 1H / …)  
- Boost package price wobble  

## Run on Windows

Double-click `START.bat` (or run `START.bat <unlock key>`). On first run it finds or downloads Node.js into `.node\`,
installs dependencies and Chromium into `.playwright\`, and decrypts the secrets from `secrets.enc`.
Keep the window open; closing it stops the tracker. Only one copy runs at a time (`data\tracker.pid`).

Secrets (`.env`, `logs/telegram-chat.json`) are git-ignored and committed only encrypted:

```
node src/secrets.js lock <key>     # after changing .env
node src/secrets.js unlock <key>
```

DM the bot `/start` once if the chat isn't linked; `/status` shows the watcher state.
