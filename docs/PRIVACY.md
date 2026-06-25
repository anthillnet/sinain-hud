# Sinain Privacy Policy

_Last updated: 2026-06-25. Draft for publication at `https://sinain.com/privacy`._

Sinain is a privacy-first context layer that runs on your own computer. This policy
explains what Sinain collects and, more importantly, what it does **not**.

## The short version

- Sinain runs on **your machine**. Your screen text, audio transcripts, and memory stay
  on your device.
- If you connect Sinain to **ChatGPT**, that context is sent **from your device to your
  own ChatGPT** — only while you have Sinain running and the connector enabled.
- The only data Sinain stores on its servers is your **email** and **which devices are
  yours** (so ChatGPT can reach the right machine). **Never** your screen, audio, or memory.

## What we collect

**Account (server-side, only if you create one for ChatGPT):**
- Your **email address**, obtained when you sign in through our identity provider (Auth0).
- A mapping of your **account to your device(s)** (an opaque device identifier).

That is the complete list of what Sinain stores on its servers.

**On your device (never sent to Sinain's servers):**
- Screen text (OCR), audio transcripts, and your local knowledge graph — used by Sinain
  locally to assist you. Audio is transcribed in memory and not persisted to disk.

## The ChatGPT connector

When you add the Sinain connector in ChatGPT and authorize it:
- ChatGPT can call Sinain tools that read your **current local context** (screen text,
  recent audio transcript, a region you flagged, your memory) and write notes/notifications
  back to your overlay.
- This data travels **from your device to your ChatGPT**, relayed through Sinain's
  connection service. The relay terminates TLS to route the request to your machine and
  **does not store** the content — it only ever carries what you have chosen to send to
  ChatGPT, while the connector is on.
- It works **only while your Sinain app is running**. Disconnect the device or turn the
  connector off and the path closes immediately.

## Data minimization

- Text you wrap in `<private>` tags is stripped before it leaves your device.
- Credit-card numbers, API keys, bearer/AWS tokens, and passwords are auto-redacted.
- Sinain does **not** collect or process government IDs, health information, or payment
  data, and never returns authentication secrets.

## Third parties

- **Auth0 (identity):** handles sign-in. It receives your email/login to authenticate you.
- **OpenAI / ChatGPT:** your own ChatGPT receives the context you choose to send via the
  connector, under OpenAI's terms.

Sinain does not sell your data and does not use your context to train models.

## Security

- Connections use TLS. Devices authenticate with per-device cryptographic keys; account
  sign-in uses OAuth 2.1 with PKCE.

## Your controls & retention

- **Disconnect** a device any time from the Sinain settings panel — it removes the
  account↔device mapping.
- **Delete your account** by contacting us; we remove your email and device mapping.
- We retain the account record only while your account exists.

## Contact

Questions or deletion requests: **contact@sinain.com**.
