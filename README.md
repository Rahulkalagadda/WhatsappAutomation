# WhatsApp Bulk Messaging Backend

Production-oriented Express API around [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) for QR login, CSV ingestion, and sequential bulk sends with throttling.

## Prerequisites

- Node.js 18+
- A machine with Chrome/Chromium available to Puppeteer (bundled with the library)

## Setup

```bash
cd whatsapp-bulk-backend
cp .env.example .env
npm install
```

Edit `.env` as needed (`TEST_MODE`, `MAX_MESSAGES_PER_BATCH`, etc.).

## Run

```bash
npm start
```

For file-watching during development:

```bash
npm run dev
```

Server listens on `PORT` (default **3000**).

## Frontend (React + Vite)

Dashboard UI lives in `frontend/`. **Development** (API on `:3000`, UI on `:5173` with proxy):

```bash
# terminal 1
npm run dev

# terminal 2
npm run dev:frontend
```

Open **http://localhost:5173** — requests to `/health`, `/auth`, `/messages` are proxied to the API.

**Production** (single origin — Express serves the built UI when `frontend/dist` exists):

```bash
npm run build:frontend
npm start
```

Open **http://localhost:3000/** for the console. Override the build path with `FRONTEND_DIST` if needed.

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default `3000`) |
| `NODE_ENV` | `development` / `production` |
| `TEST_MODE` | `true` = parse CSV and log only; no WhatsApp sends |
| `MAX_MESSAGES_PER_BATCH` | Hard cap per `/messages/send` (default `100`) |
| `WHATSAPP_CLIENT_ID` | Optional `LocalAuth` client id for separate session folders |

Session data is stored under `.wwebjs_auth/` (gitignored).

## API

### Health

`GET /health` — uptime, env, `TEST_MODE`.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/qr` | `{ qrBase64, dataUrl?, state }` — raw PNG base64 + optional full data URL |
| `GET` | `/auth/status` | `{ connected, state, user, lastError }` |
| `POST` | `/auth/logout` | Log out, destroy client, reinitialize |

### Messages

Multipart form fields: `message` (string), `file` (`.csv`).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/messages/preview` | Parsed numbers + warnings, no sending |
| `POST` | `/messages/send` | Sequential send, 20–25s delay between messages |
| `GET` | `/messages/last-stats` | Last job counters + in-progress flag |

**CSV:** any column named `phone`, `mobile`, `number`, etc., or the first non-empty column per row. Numbers are digit-normalized and suffixed with `@c.us`.

**Concurrency:** only one `/messages/send` at a time (HTTP 409 if busy).

### Example: preview

```bash
curl -s -X POST http://localhost:3000/messages/preview \
  -F "message=Hello" \
  -F "file=@./samples/contacts.csv"
```

### Example: send

```bash
curl -s -X POST http://localhost:3000/messages/send \
  -F "message=Hello from API" \
  -F "file=@./samples/contacts.csv"
```

## Notes

- **WhatsApp ToS:** bulk or automated messaging may violate WhatsApp terms; use responsibly and only with consenting recipients.
- **Stability:** `whatsapp-web.js` depends on WhatsApp Web; breaking changes can occur upstream.
- **Production:** run behind a reverse proxy, restrict network access to admin clients, and consider process supervision (PM2, systemd).
# WhatsappAutomation
