<p align="center">
  <h1 align="center">Wave 🌊</h1>
  <p align="center">
    <i>Find your wave. Be on the same wave.</i>
    <br />
    Structured P2P voice radio for teams, communities, and friends.
    <br />
    No accounts. No tracking. No chaos on the airwaves.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat&logo=google-chrome" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/Voice-WebRTC_P2P-success?style=flat" alt="WebRTC P2P" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat" alt="License" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/acbc61d6-ebd1-40d3-a108-cd0c5028e9b9" alt="Wave Interface Preview" width="800" />
</p>

---

## 🌊 What is Wave?

Imagine the internet as an ocean, and people as ships. Sometimes ships meet to talk, and then they sail away, perhaps never to meet again. 

**Wave** is a lightweight browser extension that turns any tab into a structured voice "radio station". There is no chaos, no talking over each other, and no background noise. Just like on a real ship: there is a **Captain** (admin), **Navigators** (those with speaking rights), and **Travelers** (listeners). 

**The Golden Rule:** The server (Lighthouse) never hears your voice. Audio flows directly between browsers via an encrypted P2P channel (WebRTC). The server only helps ships find each other.

---

## ⚓ Features

- **Clear Roles** — Captain (1), Navigators (up to 10), Travelers (up to 30).
- **Voice Modes** — Push-to-Talk, VOX (voice activation), Toggle, Manual.
- **Ship's Logbook (Chat)** — Text chat with emojis, word triggers, and auto-hiding of unwanted content.
- **Airwave Discipline** — Vote-to-kick, 30-minute blacklist (ban), Captain rights transfer.
- **Absolute Privacy** — No registration, no database, no logs. Your conversations belong only to you.
- **Customization** — 11 themes (from "Ocean" to "Cyberpunk"), custom fonts, and 5 interface languages.
- **Network Flexibility** — Works over the global Open Ocean (Internet) or an isolated Local Harbor (LAN) without internet access.

---

## 🗺️ Architecture

```text
  Browser A (Navigator) ──────── P2P Audio (WebRTC) ───────► Browser B (Traveler)
         │                                                      │
         └──────────────────── Signaling (Socket.io) ───────────┘
                                      │
                              🗼 Lighthouse (Node.js Server)
                      (Only introduces browsers. Never touches audio.)


## 🧭 Interface Compass (Quick Guide)

| Icon / Button | Action |
|---------------|--------|
| ⛵ Set Sail | Create a new Wave. You automatically become its Captain. |
| 📡 Hail a Ship | Enter an 8-digit code to join an existing Wave. |
| 🎤 Broadcast | Turn on your microphone (Navigators and Captains only). |
| ✋ Hand | Raise your hand. The Captain will see your request and may grant you the floor. |
| ⚓ Drop Anchor | (Captain only) Close the Wave. All crew members are sent to shore. |
| 🔒/🔓 Wave Mode | (Captain only) Toggle between free boarding and approval-required boarding. |

---

## 🛡️ Privacy & Security

- **Zero-Knowledge:** The server does not store chat history, does not record audio, and does not know who you are.
- **P2P Encryption:** Voice traffic is protected by standard WebRTC DTLS-SRTP encryption.
- **Anti-Spam:** Built-in rate limits, flood protection, and a community voting system against disruptors.

---

## 🤝 Support & Community

Found a bug in the compass? Want to suggest a new theme?

- Open an **Issue** on GitHub.
- We always welcome constructive suggestions to improve the voyage!

---

## 📱 Android App (Coming Soon)

Wave is not just for desktop! We're actively developing an **Android application** that will bring the same P2P voice experience to your mobile devices. The app is currently in development and will be available soon. Stay connected for the announcement!

---

<p align="center">
  <sub>Made with ❤️ for those who value silence and order on the airwaves.</sub>
  <br />
  <sub>License: MIT — Use freely, but remember good manners at sea.</sub>
</p>
