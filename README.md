# -PageChat-Radio
PageChat Radio Pro — secure voice &amp; text radio for clans and communities.
<p align="center">
  <h1 align="center">PageChat Radio Pro</h1>
  <p align="center">
    Secure P2P voice radio for clans and communities.
    <br />
    Works over the internet or local network. No accounts. No tracking.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js" />
  <img src="https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat&logo=google-chrome" />
  <img src="https://img.shields.io/badge/Voice-WebRTC_P2P-success?style=flat" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat" />
</p>

---

## What is this?

A structured voice chat where only authorized people speak. Think of it as a radio station: one admin controls who gets the mic, everyone else listens. No chaos, no background noise, no "who's talking?" confusion.

**The server never hears your voice.** Audio flows directly between browsers via WebRTC. The server only introduces peers to each other.

---

## Features

- **Roles** — Admin, Speaker (up to 10), Listener (up to 30)
- **Voice modes** — Push-to-Talk, VOX (voice activation), Toggle, Manual
- **Text chat** — Emojis, word triggers, blocked words filter
- **Moderation** — Kick, 30-min ban, vote-to-kick, admin transfer
- **Privacy** — P2P encrypted audio, no accounts, no logs, no database
- **Customization** — 11 themes, 8 fonts, 5 languages (EN/RU/UK/ES/DE)
- **Networks** — Internet or isolated LAN (no internet required)

---

## Architecture
Browser A (Speaker) ──── P2P Audio (WebRTC) ────► Browser B (Listener)
│ │
└────────── Signaling (Socket.io) ───────────────┘
│
Node.js Server
(never touches audio)

