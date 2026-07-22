/**
 * ═══════════════════════════════════════════════════════════
 * PageChat Radio Pro — Signaling & Coordination Server
 * ═══════════════════════════════════════════════════════════
 *
 * This server does NOT process, store, or listen to voice.
 * Audio flows directly between browsers via WebRTC (P2P).
 * The server only introduces peers and relays text/events.
 *
 * Security: Server-generated IDs, IP bans, rate limiting,
 *           prototype pollution protection, CORS lockdown.
 *
 * Stack: Node.js + Express + Socket.io
 * License: AGPL-3.0
 * Version: 3.0.0
 */

'use strict';

// ─── Dependencies ───────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

// ─── App Setup ──────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ✅ CORS: только расширение и localhost
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const allowed = ['chrome-extension://', 'http://localhost', 'http://127.0.0.1', 'null'];
      if (!origin || allowed.some(a => String(origin).startsWith(a))) callback(null, true);
      else { securityLog('CORS_BLOCKED', { origin }); callback(new Error('CORS blocked')); }
    }
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e5
});

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  port: process.env.PORT || 3000,
  host: '0.0.0.0',
  apiKey: process.env.API_KEY || '',

  limits: {
    MAX_CHANNELS: 1000,
    MAX_CHANNELS_PER_USER: 1,
    MAX_SPEAKERS: 10,
    MAX_LISTENERS: 30,
    MAX_USERS: 40,
    BAN_DURATION: 30 * 60 * 1000,
    VOTE_DURATION: 60 * 1000,
    VOTE_THRESHOLD: 0.5,
    MAX_MESSAGE_LENGTH: 500,
    MAX_NAME_LENGTH: 20,
    MAX_CHANNEL_NAME_LENGTH: 30,
    MESSAGE_HISTORY: 200,
    REQUEST_EXPIRY: 5 * 60 * 1000,
    MAX_PAYLOAD_SIZE: 4096
  },

  security: {
    MAX_CONNECTIONS_PER_IP: 5,
    MAX_EVENTS_PER_SECOND: 20,
    RATE_LIMIT_MESSAGES: 10,
    RATE_LIMIT_WINDOW: 5000,
    LIKE_COOLDOWN: 400,
    BOT_TOKENS: (process.env.BOT_TOKENS || 'default-bot-token').split(',')
  }
};

// ═══════════════════════════════════════════════════════════
// STORAGE (In-Memory)
// ═══════════════════════════════════════════════════════════

const channels = new Map();
const users = new Map();
const bans = new Map();
const votes = new Map();

// Security tracking
const ipConnections = new Map();
const socketRates = new Map();
const messageRates = new Map();

// Channel live status
const channelSpeaking = new Map();
const channelScreenShare = new Map();
const channelLikes = new Map();

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function getUniqueName(channel, desiredName, excludeUserId = null) {
  const usedNames = new Set();
  channel.speakers.forEach((s, uid) => { if (uid !== excludeUserId) usedNames.add(s.name.toLowerCase()); });
  channel.listeners.forEach((l, uid) => { if (uid !== excludeUserId) usedNames.add(l.name.toLowerCase()); });
  let name = desiredName; let suffix = 1;
  while (usedNames.has(name.toLowerCase())) { name = `${desiredName}#${suffix}`; suffix++; }
  return name;
}

function findUser(userId) {
  for (const [socketId, u] of users) { if (u.userId === userId) return { ...u, socketId }; }
  return null;
}

function sanitize(str, maxLen) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, maxLen);
}

// ✅ Защита от prototype pollution
function safeData(data) {
  if (!data || typeof data !== 'object') return {};
  const clean = {};
  for (const key of Object.keys(data)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = data[key];
  }
  return clean;
}

function log(icon, message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${time}] ${icon} ${message}`);
}

// ✅ Security logging
function securityLog(event, details) {
  const time = new Date().toISOString();
  console.warn(`[SECURITY] [${time}] ${event}: ${JSON.stringify(details)}`);
}

// ═══════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════

// ✅ IP connection limit
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const count = ipConnections.get(ip) || 0;
  if (count >= CONFIG.security.MAX_CONNECTIONS_PER_IP) {
    securityLog('IP_LIMIT', { ip, count });
    return next(new Error('Too many connections'));
  }
  ipConnections.set(ip, count + 1);
  socket._clientIp = ip;
  next();
});

function checkSocketRate(socketId) {
  const now = Date.now();
  let rate = socketRates.get(socketId);
  if (!rate || now - rate.lastReset > 1000) { rate = { count: 0, lastReset: now }; socketRates.set(socketId, rate); }
  rate.count++;
  if (rate.count > CONFIG.security.MAX_EVENTS_PER_SECOND) {
    securityLog('RATE_LIMIT', { socketId, count: rate.count });
    return false;
  }
  return true;
}

function checkMessageRate(userId) {
  const now = Date.now();
  let rate = messageRates.get(userId);
  if (!rate || now - rate.lastReset > CONFIG.security.RATE_LIMIT_WINDOW) { rate = { count: 0, lastReset: now }; messageRates.set(userId, rate); }
  rate.count++;
  return rate.count <= CONFIG.security.RATE_LIMIT_MESSAGES;
}

// ✅ API key protection
function apiAuth(req, res, next) {
  if (!CONFIG.apiKey) return next();
  if (req.headers['x-api-key'] === CONFIG.apiKey) return next();
  res.status(403).json({ error: 'Forbidden' });
}

// ═══════════════════════════════════════════════════════════
// HTTP ENDPOINTS
// ═══════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  let ts = 0, tl = 0;
  channels.forEach(ch => { ts += ch.speakers.size; tl += ch.listeners.size; });
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>PageChat Radio Pro</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px}.c{max-width:480px;width:100%}.h{text-align:center;margin-bottom:28px}.h h1{font-size:24px;font-weight:800;background:linear-gradient(135deg,#6366f1,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:10px}.sb{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:20px;font-size:12px;color:#10b981;font-weight:600}.sd{width:7px;height:7px;background:#10b981;border-radius:50%;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.4}}.cd{background:#111114;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:22px;margin-bottom:14px}.cd h2{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:rgba(250,250,250,.4);margin-bottom:14px;font-weight:700}.sg{display:grid;grid-template-columns:1fr 1fr;gap:10px}.st{background:#1a1a1f;border-radius:10px;padding:14px;text-align:center}.sv{font-size:22px;font-weight:800}.sl{font-size:10px;color:rgba(250,250,250,.4);margin-top:3px;text-transform:uppercase;letter-spacing:.5px}.ll{list-style:none}.ll li{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px}.ll li:last-child{border-bottom:none}.ll .lb{color:rgba(250,250,250,.6)}.ll .vl{font-weight:700;font-family:monospace}.ub{background:#1a1a1f;border:1px solid rgba(99,102,241,.3);border-radius:10px;padding:14px;text-align:center;font-family:monospace;font-size:12px;color:#6366f1;word-break:break-all}.ft{text-align:center;font-size:10px;color:rgba(250,250,250,.25);margin-top:20px}</style></head>
<body><div class="c"><div class="h"><h1>PageChat Radio Pro</h1><div class="sb"><div class="sd"></div>Server Online</div></div>
<div class="cd"><h2>Live Statistics</h2><div class="sg">
<div class="st"><div class="sv">${channels.size}</div><div class="sl">Channels</div></div>
<div class="st"><div class="sv">${users.size}</div><div class="sl">Online</div></div>
<div class="st"><div class="sv">${ts}</div><div class="sl">Speakers</div></div>
<div class="st"><div class="sv">${tl}</div><div class="sl">Listeners</div></div></div></div>
<div class="cd"><h2>Configuration</h2><ul class="ll">
<li><span class="lb">Max channels</span><span class="vl">${CONFIG.limits.MAX_CHANNELS}</span></li>
<li><span class="lb">Speakers / channel</span><span class="vl">${CONFIG.limits.MAX_SPEAKERS}</span></li>
<li><span class="lb">Listeners / channel</span><span class="vl">${CONFIG.limits.MAX_LISTENERS}</span></li>
<li><span class="lb">Total / channel</span><span class="vl">${CONFIG.limits.MAX_USERS}</span></li>
<li><span class="lb">Ban duration</span><span class="vl">30 min</span></li>
<li><span class="lb">Connections / IP</span><span class="vl">${CONFIG.security.MAX_CONNECTIONS_PER_IP}</span></li></ul></div>
<div class="cd"><h2>Connection URL</h2><div class="ub">ws://${req.headers.host}</div></div>
<div class="ft">PageChat Radio Pro — P2P Voice. Server never hears you.</div></div></body></html>`);
});

app.get('/api/channels', apiAuth, (req, res) => {
  const list = [];
  channels.forEach((ch, id) => { list.push({ id, name: ch.name, admin: ch.adminName, speakers: ch.speakers.size, listeners: ch.listeners.size, totalLikes: ch.totalLikes || 0 }); });
  res.json(list);
});

app.get('/api/stats', apiAuth, (req, res) => {
  let ts = 0, tl = 0;
  channels.forEach(ch => { ts += ch.speakers.size; tl += ch.listeners.size; });
  res.json({ channels: channels.size, users: users.size, speakers: ts, listeners: tl });
});

// ═══════════════════════════════════════════════════════════
// PERIODIC TASKS
// ═══════════════════════════════════════════════════════════

// Broadcast channel statuses every 3s
setInterval(() => {
  const statuses = {};
  channels.forEach((ch, id) => {
    const speaking = channelSpeaking.get(id)?.size || 0;
    const screen = channelScreenShare.get(id)?.size || 0;
    const likes = channelLikes.get(id) || 0;
    if (speaking > 0 || screen > 0 || likes > 0) statuses[id] = { speaking, screen, likes };
  });
  if (Object.keys(statuses).length > 0) io.emit('channel-statuses', statuses);
  channelLikes.clear();
}, 3000);

// Expire old join requests every 60s
setInterval(() => {
  const now = Date.now();
  channels.forEach((channel) => {
    if (!channel.joinRequests) return;
    const expired = [];
    channel.joinRequests.forEach((req, userId) => { if (now - req.timestamp > CONFIG.limits.REQUEST_EXPIRY) expired.push(userId); });
    expired.forEach(userId => {
      channel.joinRequests.delete(userId);
      const target = findUser(userId);
      if (target) io.to(target.socketId).emit('join-request-expired', { channelId: channel.id });
    });
    if (expired.length > 0) log('🧹', `Expired ${expired.length} request(s) in "${channel.name}"`);
  });
}, 60000);

// ═══════════════════════════════════════════════════════════
// SOCKET.IO — MAIN HANDLER
// ═══════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  // ✅ Сервер ГЕНЕРИРУЕТ userId — клиент не может подменить
  const serverUserId = 'u_' + uuidv4().slice(0, 12);
  socket._userId = serverUserId;

  log('✅', `Connected: ${socket.id} → ${serverUserId} (${users.size + 1} online)`);

  // ✅ Rate limiter + payload size check + prototype pollution
  socket.use((packet, next) => {
    if (!checkSocketRate(socket.id)) return next(new Error('Rate limit'));
    if (JSON.stringify(packet).length > CONFIG.limits.MAX_PAYLOAD_SIZE) {
      securityLog('PAYLOAD_TOO_LARGE', { socketId: socket.id });
      return next(new Error('Payload too large'));
    }
    const data = packet[1];
    if (data && typeof data === 'object') { delete data.__proto__; delete data.constructor; delete data.prototype; }
    next();
  });

  // ✅ Отправляем userId клиенту
  socket.emit('your-id', { userId: serverUserId });

  // ─────────────────────────────────────────────────────────
  // CHANNEL: Create
  // ─────────────────────────────────────────────────────────
  socket.on('create-channel', (rawData, cb) => {
    const data = safeData(rawData);
    const userId = socket._userId;
    const channelName = sanitize(data.channelName, CONFIG.limits.MAX_CHANNEL_NAME_LENGTH);
    const userName = sanitize(data.userName, CONFIG.limits.MAX_NAME_LENGTH) || 'Anonymous';

    let userCount = 0;
    channels.forEach(ch => { if (ch.admin === userId) userCount++; });

    if (channels.size >= CONFIG.limits.MAX_CHANNELS) return cb({ error: 'Server limit reached' });
    if (userCount >= CONFIG.limits.MAX_CHANNELS_PER_USER) return cb({ error: `Limit: ${CONFIG.limits.MAX_CHANNELS_PER_USER} per user` });
    if (!channelName) return cb({ error: 'Name required' });

    const channelId = uuidv4().slice(0, 8).toUpperCase();
    channels.set(channelId, {
      id: channelId, name: channelName, admin: userId, adminName: userName,
      requireApproval: !!data.requireApproval,
      speakers: new Map([[userId, { userId, name: userName, socketId: socket.id }]]),
      listeners: new Map(), messages: [],
      joinRequests: new Map(), raisedHands: new Set(),
      userLikes: new Map(), totalLikes: 0,
      created: Date.now()
    });
    bans.set(channelId, { users: new Map(), ips: new Map() });
    users.set(socket.id, { userId, userName, channelId, role: 'admin' });
    socket.join(channelId);

    log('📢', `Created: "${channelName}" (${channelId}) by ${userName}`);
    cb({ success: true, channelId, userId: serverUserId });
    io.emit('channels-updated');
  });

  // ─────────────────────────────────────────────────────────
  // CHANNEL: Join
  // ─────────────────────────────────────────────────────────
  socket.on('join-channel', (rawData, cb) => {
    const data = safeData(rawData);
    const userId = socket._userId;
    const userName = sanitize(data.userName, CONFIG.limits.MAX_NAME_LENGTH) || 'Anonymous';
    const channelId = sanitize(data.channelId, 20);
    const channel = channels.get(channelId);
    if (!channel) return cb({ error: 'Channel not found' });

    // ✅ Ban check (by userId AND by IP)
    const channelBans = bans.get(channelId);
    if (channelBans) {
      if (channelBans.users.has(userId)) {
        const until = channelBans.users.get(userId);
        if (Date.now() < until) return cb({ error: `Banned. ${Math.ceil((until - Date.now()) / 60000)} min left` });
        channelBans.users.delete(userId);
      }
      const ip = socket._clientIp;
      if (channelBans.ips.has(ip)) {
        const until = channelBans.ips.get(ip);
        if (Date.now() < until) return cb({ error: `Banned (IP). ${Math.ceil((until - Date.now()) / 60000)} min left` });
        channelBans.ips.delete(ip);
      }
    }

    const total = channel.speakers.size + channel.listeners.size;
    if (total >= CONFIG.limits.MAX_USERS) return cb({ error: `Full (${CONFIG.limits.MAX_USERS} max)` });

    let role = 'listener';
    if (channel.admin === userId) role = 'admin';
    else if (channel.speakers.has(userId)) role = 'speaker';

    const uniqueName = getUniqueName(channel, userName, userId);
    const nameChanged = uniqueName !== userName;

    if (role === 'admin' || role === 'speaker') channel.speakers.set(userId, { userId, name: uniqueName, socketId: socket.id });
    else channel.listeners.set(userId, { name: uniqueName, socketId: socket.id });

    users.set(socket.id, { userId, userName: uniqueName, channelId, role });
    socket.join(channelId);

    const speakersList = Array.from(channel.speakers.entries()).map(([uid, s]) => ({ userId: uid, name: s.name }));
    const listenersList = Array.from(channel.listeners.entries()).map(([uid, l]) => ({ userId: uid, name: l.name }));

    cb({
      success: true, channelName: channel.name, isAdmin: role === 'admin', role,
      adminId: channel.admin, speakers: speakersList, listeners: listenersList,
      messages: channel.messages.slice(-100),
      maxSpeakers: CONFIG.limits.MAX_SPEAKERS, maxListeners: CONFIG.limits.MAX_LISTENERS,
      yourName: uniqueName, nameChanged,
      userLikes: Object.fromEntries(channel.userLikes || new Map()),
      totalLikes: channel.totalLikes || 0
    });

    socket.to(channelId).emit('user-joined', { userId, userName: uniqueName, role });
    if (nameChanged) socket.emit('name-changed-by-server', { newName: uniqueName, reason: 'Name taken' });
    log('👤', `${uniqueName} → "${channel.name}" as ${role} [${total + 1}/${CONFIG.limits.MAX_USERS}]`);
  });

  // ─────────────────────────────────────────────────────────
  // CHANNEL: List
  // ─────────────────────────────────────────────────────────
  socket.on('get-channels', (cb) => {
    const list = [];
    channels.forEach((ch, id) => {
      list.push({ id, name: ch.name, admin: ch.adminName, adminId: ch.admin, speakers: ch.speakers.size, listeners: ch.listeners.size, totalLikes: ch.totalLikes || 0 });
    });
    cb(list);
  });

  // ─────────────────────────────────────────────────────────
  // CHANNEL: Join Request
  // ─────────────────────────────────────────────────────────
  socket.on('request-join', (rawData, cb) => {
    const data = safeData(rawData);
    const userId = socket._userId;
    const channelId = sanitize(data.channelId, 20);
    const channel = channels.get(channelId);
    if (!channel) return cb({ error: 'Channel not found' });

    if (channel.admin === userId) return cb({ approved: true });
    if (channel.speakers.has(userId)) return cb({ approved: true });
    if (!channel.requireApproval) return cb({ approved: true });

    channel.joinRequests.set(userId, { userId, userName: sanitize(data.userName, 20), timestamp: Date.now() });
    const adminSocket = findUser(channel.admin);
    if (adminSocket) io.to(adminSocket.socketId).emit('join-request', { userId, userName: data.userName, channelId, timestamp: Date.now() });
    cb({ approved: false, message: 'Request sent to admin' });
  });

  socket.on('respond-join-request', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });
    if (!channel.joinRequests.has(data.targetUserId)) return cb({ error: 'Not found' });
    channel.joinRequests.delete(data.targetUserId);
    const target = findUser(data.targetUserId);
    if (target) io.to(target.socketId).emit('join-request-response', { approved: !!data.approved, channelId: userData.channelId });
    cb({ success: true });
  });

  // ─────────────────────────────────────────────────────────
  // CHANNEL: Switch (multi-channel)
  // ─────────────────────────────────────────────────────────
  socket.on('switch-channel', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData) return cb({ error: 'Not connected' });
    const newId = sanitize(data.channelId, 20);
    const newChannel = channels.get(newId);
    if (!newChannel) return cb({ error: 'Channel not found' });

    const oldId = userData.channelId;
    if (oldId && oldId !== newId) {
      socket.leave(oldId);
      socket.to(oldId).emit('user-away', { userId: userData.userId, userName: userData.userName });
    }
    socket.join(newId);
    userData.channelId = newId;

    let role = 'listener';
    if (newChannel.admin === userData.userId) role = 'admin';
    else if (newChannel.speakers.has(userData.userId)) role = 'speaker';
    userData.role = role;

    socket.to(newId).emit('user-back', { userId: userData.userId, userName: userData.userName, role });
    cb({ success: true, channelId: newId, role });
  });

  // ─────────────────────────────────────────────────────────
  // TEXT CHAT
  // ─────────────────────────────────────────────────────────
  socket.on('send-message', (rawData) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData || !checkMessageRate(userData.userId)) return;
    const channel = channels.get(userData.channelId);
    if (!channel) return;
    const text = sanitize(data.text, CONFIG.limits.MAX_MESSAGE_LENGTH);
    if (!text) return;
    const msg = { id: uuidv4().slice(0, 10), userId: userData.userId, userName: userData.userName, text, timestamp: Date.now() };
    channel.messages.push(msg);
    if (channel.messages.length > CONFIG.limits.MESSAGE_HISTORY) channel.messages.shift();
    io.to(userData.channelId).emit('new-message', msg);
  });

  // ─────────────────────────────────────────────────────────
  // USER: Rename
  // ─────────────────────────────────────────────────────────
  socket.on('update-username', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData) return cb({ error: 'Not in channel' });
    const channel = channels.get(userData.channelId);
    if (!channel) return cb({ error: 'Channel not found' });
    const newName = sanitize(data.newName, CONFIG.limits.MAX_NAME_LENGTH);
    if (!newName) return cb({ error: 'Name empty' });
    const uniqueName = getUniqueName(channel, newName, userData.userId);
    const nameChanged = uniqueName !== newName;
    const oldName = userData.userName;
    userData.userName = uniqueName;
    if (channel.speakers.has(userData.userId)) channel.speakers.get(userData.userId).name = uniqueName;
    if (channel.listeners.has(userData.userId)) channel.listeners.get(userData.userId).name = uniqueName;
    if (channel.admin === userData.userId) channel.adminName = uniqueName;
    io.to(userData.channelId).emit('user-renamed', { userId: userData.userId, oldName, newName: uniqueName });
    cb({ success: true, newName: uniqueName, nameChanged });
    if (nameChanged) socket.emit('name-changed-by-server', { newName: uniqueName, reason: 'Name taken' });
  });

  // ─────────────────────────────────────────────────────────
  // USER: Make Speaker
  // ─────────────────────────────────────────────────────────
  socket.on('make-speaker', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });
    if (channel.speakers.size >= CONFIG.limits.MAX_SPEAKERS) return cb({ error: `Max ${CONFIG.limits.MAX_SPEAKERS}` });
    const listener = channel.listeners.get(data.targetUserId);
    if (!listener) return cb({ error: 'Not found' });
    channel.listeners.delete(data.targetUserId);
    channel.speakers.set(data.targetUserId, { userId: data.targetUserId, name: listener.name, socketId: listener.socketId });
    channel.raisedHands.delete(data.targetUserId);
    const target = findUser(data.targetUserId);
    if (target) users.get(target.socketId).role = 'speaker';
    io.to(userData.channelId).emit('role-changed', { userId: data.targetUserId, role: 'speaker', userName: listener.name });
    cb({ success: true });
  });

  // ─────────────────────────────────────────────────────────
  // USER: Remove Speaker
  // ─────────────────────────────────────────────────────────
  socket.on('remove-speaker', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });
    const speaker = channel.speakers.get(data.targetUserId);
    if (!speaker) return cb({ error: 'Not found' });
    if (data.targetUserId === channel.admin) return cb({ error: 'Cannot demote admin' });
    channel.speakers.delete(data.targetUserId);
    channel.listeners.set(data.targetUserId, { name: speaker.name, socketId: speaker.socketId });
    const target = findUser(data.targetUserId);
    if (target) users.get(target.socketId).role = 'listener';
    io.to(userData.channelId).emit('role-changed', { userId: data.targetUserId, role: 'listener', userName: speaker.name });
    cb({ success: true });
  });

  // ─────────────────────────────────────────────────────────
  // USER: Kick
  // ─────────────────────────────────────────────────────────
  socket.on('kick-user', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });
    const target = findUser(data.targetUserId);
    if (target) { io.to(target.socketId).emit('kicked', { reason: sanitize(data.reason, 100) || 'Kicked' }); io.sockets.sockets.get(target.socketId)?.disconnect(); }
    const name = channel.speakers.get(data.targetUserId)?.name || channel.listeners.get(data.targetUserId)?.name || 'User';
    channel.speakers.delete(data.targetUserId); channel.listeners.delete(data.targetUserId); channel.raisedHands.delete(data.targetUserId);
    channelSpeaking.get(userData.channelId)?.delete(data.targetUserId);
    channelScreenShare.get(userData.channelId)?.delete(data.targetUserId);
    io.to(userData.channelId).emit('user-left', { userId: data.targetUserId, userName: name });
    cb({ success: true });
  });

  // ─────────────────────────────────────────────────────────
  // USER: Ban (userId + IP)
  // ─────────────────────────────────────────────────────────
  socket.on('ban-user', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });
    const until = Date.now() + CONFIG.limits.BAN_DURATION;
    const channelBans = bans.get(userData.channelId);

    // ✅ Бан по userId
    channelBans.users.set(data.targetUserId, until);

    // ✅ Бан по IP
    const targetSocket = findUser(data.targetUserId);
    if (targetSocket) {
      const targetIp = io.sockets.sockets.get(targetSocket.socketId)?._clientIp;
      if (targetIp) channelBans.ips.set(targetIp, until);
      io.to(targetSocket.socketId).emit('banned', { until, reason: sanitize(data.reason, 100) || 'Banned 30 min' });
      io.sockets.sockets.get(targetSocket.socketId)?.disconnect();
    }

    const name = channel.speakers.get(data.targetUserId)?.name || channel.listeners.get(data.targetUserId)?.name || 'User';
    channel.speakers.delete(data.targetUserId); channel.listeners.delete(data.targetUserId); channel.raisedHands.delete(data.targetUserId);
    channelSpeaking.get(userData.channelId)?.delete(data.targetUserId);
    channelScreenShare.get(userData.channelId)?.delete(data.targetUserId);
    io.to(userData.channelId).emit('user-banned', { userId: data.targetUserId, userName: name, until });
    log('🔒', `${name} banned in "${channel.name}" (userId + IP)`);
    cb({ success: true });
  });

  // ─────────────────────────────────────────────────────────
  // USER: Transfer Admin
  // ─────────────────────────────────────────────────────────
  socket.on('transfer-admin', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });
    const target = channel.speakers.get(data.targetUserId) || channel.listeners.get(data.targetUserId);
    if (!target) return cb({ error: 'Not found' });
    const oldAdminId = channel.admin;
    channel.admin = data.targetUserId; channel.adminName = target.name;
    if (channel.listeners.has(data.targetUserId)) { channel.speakers.set(data.targetUserId, channel.listeners.get(data.targetUserId)); channel.listeners.delete(data.targetUserId); }
    const ns = findUser(data.targetUserId); if (ns) users.get(ns.socketId).role = 'admin';
    const os = findUser(oldAdminId); if (os) users.get(os.socketId).role = 'speaker';
    io.to(userData.channelId).emit('admin-transferred', { oldAdminId, newAdminId: data.targetUserId, newAdminName: target.name });
    cb({ success: true });
  });

  // ─────────────────────────────────────────────────────────
  // SPEAKING STATUS
  // ─────────────────────────────────────────────────────────
  socket.on('speaking-status', (rawData) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData) return;
    const chId = userData.channelId;
    if (!channelSpeaking.has(chId)) channelSpeaking.set(chId, new Set());
    if (data.isSpeaking) channelSpeaking.get(chId).add(userData.userId);
    else channelSpeaking.get(chId).delete(userData.userId);
    socket.to(chId).emit('user-speaking', { userId: userData.userId, userName: userData.userName, isSpeaking: !!data.isSpeaking });
  });

  // ─────────────────────────────────────────────────────────
  // SCREEN SHARE / CAMERA
  // ─────────────────────────────────────────────────────────
  socket.on('screen-share-start', (rawData) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData) return;
    const chId = userData.channelId;
    if (!channelScreenShare.has(chId)) channelScreenShare.set(chId, new Set());
    channelScreenShare.get(chId).add(userData.userId);
    socket.to(chId).emit('screen-share-started', { userId: userData.userId, userName: userData.userName, mediaType: data.mediaType || 'screen' });
  });

  socket.on('screen-share-stop', () => {
    const userData = users.get(socket.id);
    if (!userData) return;
    channelScreenShare.get(userData.channelId)?.delete(userData.userId);
    socket.to(userData.channelId).emit('screen-share-stopped', { userId: userData.userId });
  });

  // ─────────────────────────────────────────────────────────
  // RAISE HAND
  // ─────────────────────────────────────────────────────────
  socket.on('raise-hand', () => {
    const userData = users.get(socket.id);
    if (!userData) return;
    const channel = channels.get(userData.channelId);
    if (!channel) return;
    channel.raisedHands.add(userData.userId);
    const admin = findUser(channel.admin);
    if (admin) io.to(admin.socketId).emit('hand-raised', { userId: userData.userId, userName: userData.userName, timestamp: Date.now() });
  });

  socket.on('lower-hand', () => {
    const userData = users.get(socket.id);
    if (!userData) return;
    const channel = channels.get(userData.channelId);
    if (!channel) return;
    channel.raisedHands.delete(userData.userId);
    const admin = findUser(channel.admin);
    if (admin) io.to(admin.socketId).emit('hand-lowered', { userId: userData.userId });
  });

  // ─────────────────────────────────────────────────────────
  // LIKES (stored on server)
  // ─────────────────────────────────────────────────────────
  socket.on('send-like', (rawData) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData) return;
    const chId = userData.channelId;
    const channel = channels.get(chId);
    if (!channel) return;
    const now = Date.now();
    if (!userData.lastLikeTime || now - userData.lastLikeTime > CONFIG.security.LIKE_COOLDOWN) {
      userData.lastLikeTime = now;
      const targetId = data.targetUserId || userData.userId;
      const current = channel.userLikes.get(targetId) || 0;
      channel.userLikes.set(targetId, current + 1);
      channel.totalLikes = (channel.totalLikes || 0) + 1;
      channelLikes.set(chId, (channelLikes.get(chId) || 0) + 1);
      socket.to(chId).emit('receive-like', { userId: userData.userId, userName: userData.userName, targetUserId: targetId, count: current + 1 });
    }
  });

  // ─────────────────────────────────────────────────────────
  // VOTE TO KICK (1 IP = 1 vote)
  // ─────────────────────────────────────────────────────────
  socket.on('start-vote', (rawData, cb) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel) return cb({ error: 'Not found' });
    if (data.targetUserId === channel.admin) return cb({ error: 'Cannot vote admin' });
    const voteId = uuidv4().slice(0, 8);
    votes.set(voteId, { id: voteId, channelId: userData.channelId, targetUserId: data.targetUserId, targetName: sanitize(data.targetName, CONFIG.limits.MAX_NAME_LENGTH), startedBy: userData.userId, yes: new Set([userData.userId]), no: new Set(), votedIps: new Set([socket._clientIp]), expiresAt: Date.now() + CONFIG.limits.VOTE_DURATION });
    io.to(userData.channelId).emit('vote-started', { voteId, targetUserId: data.targetUserId, targetName: data.targetName, expiresAt: Date.now() + CONFIG.limits.VOTE_DURATION });
    setTimeout(() => finishVote(voteId), CONFIG.limits.VOTE_DURATION);
    cb({ success: true, voteId });
  });

  socket.on('cast-vote', (rawData) => {
    const data = safeData(rawData);
    const vote = votes.get(data.voteId);
    if (!vote) return;
    const userData = users.get(socket.id);
    if (!userData) return;
    // ✅ 1 IP = 1 vote
    const ip = socket._clientIp;
    if (vote.votedIps.has(ip)) return;
    vote.votedIps.add(ip);
    if (data.vote === 'yes') { vote.yes.add(userData.userId); vote.no.delete(userData.userId); }
    else { vote.no.add(userData.userId); vote.yes.delete(userData.userId); }
    io.to(vote.channelId).emit('vote-updated', { voteId: vote.id, yes: vote.yes.size, no: vote.no.size });
  });

  function finishVote(voteId) {
    const vote = votes.get(voteId);
    if (!vote) return;
    const channel = channels.get(vote.channelId);
    if (!channel) { votes.delete(voteId); return; }
    const total = channel.speakers.size + channel.listeners.size;
    const needed = Math.max(2, Math.ceil(total * CONFIG.limits.VOTE_THRESHOLD));
    if (vote.yes.size >= needed) {
      const target = findUser(vote.targetUserId);
      if (target) { io.to(target.socketId).emit('kicked', { reason: 'Community vote' }); io.sockets.sockets.get(target.socketId)?.disconnect(); }
      channel.speakers.delete(vote.targetUserId); channel.listeners.delete(vote.targetUserId); channel.raisedHands.delete(vote.targetUserId);
      channelSpeaking.get(vote.channelId)?.delete(vote.targetUserId);
      channelScreenShare.get(vote.channelId)?.delete(vote.targetUserId);
      io.to(vote.channelId).emit('vote-result', { voteId, kicked: true, targetName: vote.targetName });
    } else {
      io.to(vote.channelId).emit('vote-result', { voteId, kicked: false, targetName: vote.targetName });
    }
    votes.delete(voteId);
  }

  // ─────────────────────────────────────────────────────────
  // WEBRTC SIGNALING
  // ─────────────────────────────────────────────────────────
  socket.on('webrtc-offer', (d) => { const t = findUser(d.toUserId); if (t) io.to(t.socketId).emit('webrtc-offer', d); });
  socket.on('webrtc-answer', (d) => { const t = findUser(d.toUserId); if (t) io.to(t.socketId).emit('webrtc-answer', d); });
  socket.on('webrtc-ice', (d) => { const t = findUser(d.toUserId); if (t) io.to(t.socketId).emit('webrtc-ice', d); });

  // ─────────────────────────────────────────────────────────
  // BOT API
  // ─────────────────────────────────────────────────────────
  socket.on('bot-auth', (rawData, cb) => {
    const data = safeData(rawData);
    if (!CONFIG.security.BOT_TOKENS.includes(data.token)) { securityLog('BOT_AUTH_FAIL', { ip: socket._clientIp }); return cb({ error: 'Invalid token' }); }
    const channel = channels.get(data.channelId);
    if (!channel) return cb({ error: 'Channel not found' });
    const botId = 'bot_' + uuidv4().slice(0, 8);
    const name = sanitize(data.botName, 20) || 'Bot';
    channel.listeners.set(botId, { name, socketId: socket.id, isBot: true });
    users.set(socket.id, { userId: botId, userName: name, channelId: data.channelId, role: 'bot', isBot: true });
    socket.join(data.channelId);
    socket.to(data.channelId).emit('user-joined', { userId: botId, userName: name, role: 'listener', isBot: true });
    log('🤖', `Bot "${name}" → "${channel.name}"`);
    cb({ success: true, botId, channelId: data.channelId });
  });

  socket.on('bot-message', (rawData) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData || !userData.isBot) return;
    const channel = channels.get(userData.channelId);
    if (!channel) return;
    const msg = { id: uuidv4().slice(0, 10), userId: userData.userId, userName: userData.userName, text: sanitize(data.text, CONFIG.limits.MAX_MESSAGE_LENGTH), timestamp: Date.now(), isBot: true, meta: data.meta || null };
    channel.messages.push(msg);
    if (channel.messages.length > CONFIG.limits.MESSAGE_HISTORY) channel.messages.shift();
    io.to(userData.channelId).emit('new-message', msg);
  });

  socket.on('bot-media', (rawData) => {
    const data = safeData(rawData);
    const userData = users.get(socket.id);
    if (!userData || !userData.isBot) return;
    const channel = channels.get(userData.channelId);
    if (!channel) return;
    const msg = { id: uuidv4().slice(0, 10), userId: userData.userId, userName: userData.userName, text: sanitize(data.caption, 200) || '', timestamp: Date.now(), isBot: true, meta: { type: data.type || 'image', url: data.url, title: data.title || '', description: data.description || '' } };
    channel.messages.push(msg);
    if (channel.messages.length > CONFIG.limits.MESSAGE_HISTORY) channel.messages.shift();
    io.to(userData.channelId).emit('new-message', msg);
  });

  // ─────────────────────────────────────────────────────────
  // DISCONNECT & CLEANUP
  // ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const ip = socket._clientIp;
    if (ip) { const count = ipConnections.get(ip) || 1; if (count <= 1) ipConnections.delete(ip); else ipConnections.set(ip, count - 1); }
    socketRates.delete(socket.id);

    const userData = users.get(socket.id);
    if (!userData) { delete socket._userId; delete socket._clientIp; return; }

    const channel = channels.get(userData.channelId);
    if (!channel) { users.delete(socket.id); delete socket._userId; delete socket._clientIp; return; }

    if (userData.isBot) {
      channel.listeners.delete(userData.userId); channel.speakers.delete(userData.userId);
      socket.to(userData.channelId).emit('user-left', { userId: userData.userId, userName: userData.userName });
      users.delete(socket.id); delete socket._userId; delete socket._clientIp; return;
    }

    channel.speakers.delete(userData.userId); channel.listeners.delete(userData.userId);
    channel.raisedHands.delete(userData.userId);
    if (channel.joinRequests) channel.joinRequests.delete(userData.userId);
    channelSpeaking.get(userData.channelId)?.delete(userData.userId);
    channelScreenShare.get(userData.channelId)?.delete(userData.userId);

    if (channel.speakers.size === 0 && channel.listeners.size === 0) {
      channels.delete(userData.channelId); bans.delete(userData.channelId);
      channelSpeaking.delete(userData.channelId); channelScreenShare.delete(userData.channelId); channelLikes.delete(userData.channelId);
      io.emit('channels-updated');
      log('🗑️', `"${channel.name}" destroyed [${channels.size} active]`);
    } else {
      socket.to(userData.channelId).emit('user-left', { userId: userData.userId, userName: userData.userName });
    }

    users.delete(socket.id); messageRates.delete(userData.userId);
    delete socket._userId; delete socket._clientIp;
    log('❌', `${userData.userName} left [${users.size} online]`);
  });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log('  │   PageChat Radio Pro — Server v3.0 (Hardened)   │');
  console.log('  └─────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Port:         ${CONFIG.port}`);
  console.log(`  Channels:     ${CONFIG.limits.MAX_CHANNELS} max`);
  console.log(`  Per channel:  ${CONFIG.limits.MAX_SPEAKERS} speakers / ${CONFIG.limits.MAX_LISTENERS} listeners`);
  console.log(`  Per IP:       ${CONFIG.security.MAX_CONNECTIONS_PER_IP} connections`);
  console.log(`  Rate:         ${CONFIG.security.MAX_EVENTS_PER_SECOND} events/sec`);
  console.log(`  API Key:      ${CONFIG.apiKey ? 'ENABLED' : 'DISABLED (open)'}`);
  console.log('');
  console.log(`  Status:       http://localhost:${CONFIG.port}`);
  console.log(`  Client:       ws://YOUR_IP:${CONFIG.port}`);
  console.log('');
  console.log('  Security: Server-generated IDs, IP bans, CORS lock,');
  console.log('            rate limiting, prototype pollution guard.');
  console.log('');
  console.log('  Voice is P2P. This server never hears you.');
  console.log('');
});

process.on('SIGINT', () => { log('🛑', 'Shutting down...'); io.close(); server.close(() => { log('✅', 'Closed.'); process.exit(0); }); });
