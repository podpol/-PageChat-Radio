const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e5 // 100KB max payload
});

// ===== LIMITS =====
const LIMITS = {
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
  RATE_LIMIT_MESSAGES: 10,       // max messages per window
  RATE_LIMIT_WINDOW: 5000,       // 5 seconds
  MAX_CONNECTIONS_PER_IP: 5,     // anti-abuse
  MAX_EVENTS_PER_SECOND: 20      // global rate limit per socket
};

// ===== STORAGE =====
const channels = new Map();
const users = new Map();
const bans = new Map();
const votes = new Map();

// ===== SECURITY: Rate Limiting =====
const ipConnections = new Map();   // ip -> count
const socketRates = new Map();     // socketId -> { count, lastReset }
const messageRates = new Map();    // userId -> { count, lastReset }

function checkSocketRate(socketId) {
  const now = Date.now();
  let rate = socketRates.get(socketId);
  if (!rate || now - rate.lastReset > 1000) {
    rate = { count: 0, lastReset: now };
    socketRates.set(socketId, rate);
  }
  rate.count++;
  if (rate.count > LIMITS.MAX_EVENTS_PER_SECOND) {
    return false; // rate limited
  }
  return true;
}

function checkMessageRate(userId) {
  const now = Date.now();
  let rate = messageRates.get(userId);
  if (!rate || now - rate.lastReset > LIMITS.RATE_LIMIT_WINDOW) {
    rate = { count: 0, lastReset: now };
    messageRates.set(userId, rate);
  }
  rate.count++;
  return rate.count <= LIMITS.RATE_LIMIT_MESSAGES;
}

function sanitize(str, maxLen) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, maxLen);
}

// ===== SECURITY: IP tracking on connect =====
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const count = ipConnections.get(ip) || 0;
  if (count >= LIMITS.MAX_CONNECTIONS_PER_IP) {
    return next(new Error('Too many connections from this IP'));
  }
  ipConnections.set(ip, count + 1);
  socket._clientIp = ip;
  next();
});

// ===== UTILITIES =====
function getUniqueName(channel, desiredName, excludeUserId = null) {
  const usedNames = new Set();
  channel.speakers.forEach((s, uid) => {
    if (uid !== excludeUserId) usedNames.add(s.name.toLowerCase());
  });
  channel.listeners.forEach((l, uid) => {
    if (uid !== excludeUserId) usedNames.add(l.name.toLowerCase());
  });
  let name = desiredName;
  let suffix = 1;
  while (usedNames.has(name.toLowerCase())) {
    name = `${desiredName}#${suffix}`;
    suffix++;
  }
  return name;
}

function findUser(userId) {
  for (const [sid, u] of users) {
    if (u.userId === userId) return { ...u, socketId: sid };
  }
  return null;
}

// ===== HTTP: Status Page =====
app.get('/', (req, res) => {
  let totalS = 0, totalL = 0;
  channels.forEach(ch => { totalS += ch.speakers.size; totalL += ch.listeners.size; });
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PageChat Radio Pro — Server Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
    }
    .container { max-width: 520px; width: 100%; }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .header h1 {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 20px;
      font-size: 13px;
      color: #10b981;
      font-weight: 500;
    }
    .status-dot {
      width: 8px; height: 8px;
      background: #10b981;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .card {
      background: #13131a;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 16px;
    }
    .card h2 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #71717a;
      margin-bottom: 16px;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .stat {
      background: #1c1c26;
      border-radius: 10px;
      padding: 14px;
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #fff;
    }
    .stat-label {
      font-size: 11px;
      color: #71717a;
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .limits-list { list-style: none; }
    .limits-list li {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 13px;
    }
    .limits-list li:last-child { border-bottom: none; }
    .limits-list .label { color: #a1a1aa; }
    .limits-list .value { color: #fff; font-weight: 600; font-family: monospace; }
    .url-box {
      background: #1c1c26;
      border: 1px solid rgba(102, 126, 234, 0.3);
      border-radius: 10px;
      padding: 14px;
      text-align: center;
      font-family: monospace;
      font-size: 13px;
      color: #667eea;
      word-break: break-all;
    }
    .footer {
      text-align: center;
      font-size: 11px;
      color: #52525b;
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>PageChat Radio Pro</h1>
      <div class="status-badge">
        <div class="status-dot"></div>
        Server Online
      </div>
    </div>

    <div class="card">
      <h2>Live Statistics</h2>
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${channels.size}</div><div class="stat-label">Channels</div></div>
        <div class="stat"><div class="stat-value">${users.size}</div><div class="stat-label">Users Online</div></div>
        <div class="stat"><div class="stat-value">${totalS}</div><div class="stat-label">Speakers</div></div>
        <div class="stat"><div class="stat-value">${totalL}</div><div class="stat-label">Listeners</div></div>
      </div>
    </div>

    <div class="card">
      <h2>Configuration</h2>
      <ul class="limits-list">
        <li><span class="label">Max channels</span><span class="value">${LIMITS.MAX_CHANNELS}</span></li>
        <li><span class="label">Speakers per channel</span><span class="value">${LIMITS.MAX_SPEAKERS}</span></li>
        <li><span class="label">Listeners per channel</span><span class="value">${LIMITS.MAX_LISTENERS}</span></li>
        <li><span class="label">Total per channel</span><span class="value">${LIMITS.MAX_USERS}</span></li>
        <li><span class="label">Channels per user</span><span class="value">${LIMITS.MAX_CHANNELS_PER_USER}</span></li>
        <li><span class="label">Ban duration</span><span class="value">30 min</span></li>
        <li><span class="label">Connections per IP</span><span class="value">${LIMITS.MAX_CONNECTIONS_PER_IP}</span></li>
      </ul>
    </div>

    <div class="card">
      <h2>Connection URL</h2>
      <div class="url-box">ws://${req.headers.host}</div>
    </div>

    <div class="footer">
      PageChat Radio Pro — P2P Voice. Server never hears you.
    </div>
  </div>
</body>
</html>`);
});

app.get('/api/channels', (req, res) => {
  const list = [];
  channels.forEach((ch, id) => {
    list.push({ id, name: ch.name, admin: ch.adminName, adminId: ch.admin, speakers: ch.speakers.size, listeners: ch.listeners.size, created: ch.created });
  });
  res.json(list);
});

app.get('/api/stats', (req, res) => {
  let totalS = 0, totalL = 0;
  channels.forEach(ch => { totalS += ch.speakers.size; totalL += ch.listeners.size; });
  res.json({ channels: channels.size, users: users.size, speakers: totalS, listeners: totalL, limits: LIMITS });
});

// ===== MAIN LOGIC =====
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id} (total: ${users.size + 1})`);

  // Global rate limiter middleware
  socket.use((packet, next) => {
    if (!checkSocketRate(socket.id)) {
      return next(new Error('Rate limit exceeded'));
    }
    next();
  });

  // ===== CREATE CHANNEL =====
  socket.on('create-channel', (data, cb) => {
    const { channelName, userId, userName } = data;
    let userCount = 0;
    channels.forEach(ch => { if (ch.admin === userId) userCount++; });

    if (channels.size >= LIMITS.MAX_CHANNELS) return cb({ error: 'Server channel limit reached' });
    if (userCount >= LIMITS.MAX_CHANNELS_PER_USER) return cb({ error: `Limit: ${LIMITS.MAX_CHANNELS_PER_USER} channel per user` });

    const cleanName = sanitize(channelName, LIMITS.MAX_CHANNEL_NAME_LENGTH);
    if (!cleanName) return cb({ error: 'Channel name is required' });

    const cleanUser = sanitize(userName, LIMITS.MAX_NAME_LENGTH) || 'Anonymous';
    const channelId = uuidv4().slice(0, 8).toUpperCase();

    channels.set(channelId, {
      name: cleanName, admin: userId, adminName: cleanUser,
      speakers: new Map([[userId, { userId, name: cleanUser, socketId: socket.id }]]),
      listeners: new Map(), messages: [], created: Date.now()
    });
    bans.set(channelId, new Map());
    users.set(socket.id, { userId, userName: cleanUser, channelId, role: 'admin' });
    socket.join(channelId);

    console.log(`[CREATE] "${cleanName}" (${channelId}) by ${cleanUser} [${channels.size}/${LIMITS.MAX_CHANNELS}]`);
    cb({ success: true, channelId });
    io.emit('channels-updated');
  });

  // ===== JOIN CHANNEL =====
  socket.on('join-channel', (data, cb) => {
    const { channelId, userId } = data;
    const userName = sanitize(data.userName, LIMITS.MAX_NAME_LENGTH) || 'Anonymous';
    const channel = channels.get(channelId);
    if (!channel) return cb({ error: 'Channel not found' });

    const channelBans = bans.get(channelId);
    if (channelBans && channelBans.has(userId)) {
      const until = channelBans.get(userId);
      if (Date.now() < until) return cb({ error: `Banned. ${Math.ceil((until - Date.now()) / 60000)} min remaining` });
      else channelBans.delete(userId);
    }

    const total = channel.speakers.size + channel.listeners.size;
    if (total >= LIMITS.MAX_USERS) return cb({ error: `Channel full (${LIMITS.MAX_USERS} max)` });

    let role = 'listener';
    if (channel.admin === userId) role = 'admin';
    else if (channel.speakers.has(userId)) role = 'speaker';

    const uniqueName = getUniqueName(channel, userName, userId);
    const nameChanged = uniqueName !== userName;

    if (role === 'admin' || role === 'speaker') {
      channel.speakers.set(userId, { userId, name: uniqueName, socketId: socket.id });
    } else {
      channel.listeners.set(userId, { name: uniqueName, socketId: socket.id });
    }

    users.set(socket.id, { userId, userName: uniqueName, channelId, role });
    socket.join(channelId);

    const speakersList = Array.from(channel.speakers.entries()).map(([uid, s]) => ({ userId: uid, name: s.name }));
    const listenersList = Array.from(channel.listeners.entries()).map(([uid, l]) => ({ userId: uid, name: l.name }));

    cb({
      success: true, channelName: channel.name, isAdmin: role === 'admin', role,
      adminId: channel.admin, speakers: speakersList, listeners: listenersList,
      messages: channel.messages.slice(-100), maxSpeakers: LIMITS.MAX_SPEAKERS,
      maxListeners: LIMITS.MAX_LISTENERS, yourName: uniqueName, nameChanged
    });

    socket.to(channelId).emit('user-joined', { userId, userName: uniqueName, role });
    if (nameChanged) socket.emit('name-changed-by-server', { newName: uniqueName, reason: 'Name already taken' });
    console.log(`[JOIN] ${uniqueName} -> "${channel.name}" as ${role} [${total + 1}/${LIMITS.MAX_USERS}]`);
  });

  // ===== GET CHANNELS =====
  socket.on('get-channels', (cb) => {
    const list = [];
    channels.forEach((ch, id) => list.push({ id, name: ch.name, admin: ch.adminName, adminId: ch.admin, speakers: ch.speakers.size, listeners: ch.listeners.size }));
    cb(list);
  });

  // ===== TEXT MESSAGE =====
  socket.on('send-message', (data) => {
    const userData = users.get(socket.id);
    if (!userData) return;
    if (!checkMessageRate(userData.userId)) return; // rate limited

    const channel = channels.get(userData.channelId);
    if (!channel) return;

    const text = sanitize(data.text, LIMITS.MAX_MESSAGE_LENGTH);
    if (!text) return;

    const msg = { id: uuidv4().slice(0, 10), userId: userData.userId, userName: userData.userName, text, timestamp: Date.now() };
    channel.messages.push(msg);
    if (channel.messages.length > 200) channel.messages.shift();
    io.to(userData.channelId).emit('new-message', msg);
  });

  // ===== UPDATE USERNAME =====
  socket.on('update-username', (data, cb) => {
    const userData = users.get(socket.id);
    if (!userData) return cb({ error: 'Not in a channel' });
    const channel = channels.get(userData.channelId);
    if (!channel) return cb({ error: 'Channel not found' });

    const newName = sanitize(data.newName, LIMITS.MAX_NAME_LENGTH);
    if (!newName) return cb({ error: 'Name cannot be empty' });

    const uniqueName = getUniqueName(channel, newName, userData.userId);
    const nameChanged = uniqueName !== newName;
    const oldName = userData.userName;

    userData.userName = uniqueName;
    if (channel.speakers.has(userData.userId)) channel.speakers.get(userData.userId).name = uniqueName;
    if (channel.listeners.has(userData.userId)) channel.listeners.get(userData.userId).name = uniqueName;
    if (channel.admin === userData.userId) channel.adminName = uniqueName;

    io.to(userData.channelId).emit('user-renamed', { userId: userData.userId, oldName, newName: uniqueName });
    cb({ success: true, newName: uniqueName, nameChanged });
    if (nameChanged) socket.emit('name-changed-by-server', { newName: uniqueName, reason: 'Name already taken' });
  });

  // ===== MAKE SPEAKER =====
  socket.on('make-speaker', (data, cb) => {
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });
    if (channel.speakers.size >= LIMITS.MAX_SPEAKERS) return cb({ error: `Max ${LIMITS.MAX_SPEAKERS} speakers` });

    const listener = channel.listeners.get(data.targetUserId);
    if (!listener) return cb({ error: 'User not found' });

    channel.listeners.delete(data.targetUserId);
    channel.speakers.set(data.targetUserId, { userId: data.targetUserId, name: listener.name, socketId: listener.socketId });
    const target = findUser(data.targetUserId);
    if (target) users.get(target.socketId).role = 'speaker';

    io.to(userData.channelId).emit('role-changed', { userId: data.targetUserId, role: 'speaker', userName: listener.name });
    cb({ success: true });
  });

  // ===== REMOVE SPEAKER =====
  socket.on('remove-speaker', (data, cb) => {
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });

    const speaker = channel.speakers.get(data.targetUserId);
    if (!speaker) return cb({ error: 'User not found' });
    if (data.targetUserId === channel.admin) return cb({ error: 'Cannot demote admin' });

    channel.speakers.delete(data.targetUserId);
    channel.listeners.set(data.targetUserId, { name: speaker.name, socketId: speaker.socketId });
    const target = findUser(data.targetUserId);
    if (target) users.get(target.socketId).role = 'listener';

    io.to(userData.channelId).emit('role-changed', { userId: data.targetUserId, role: 'listener', userName: speaker.name });
    cb({ success: true });
  });

  // ===== KICK =====
  socket.on('kick-user', (data, cb) => {
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });

    const target = findUser(data.targetUserId);
    if (target) {
      io.to(target.socketId).emit('kicked', { reason: sanitize(data.reason, 100) || 'Kicked by admin' });
      io.sockets.sockets.get(target.socketId)?.disconnect();
    }

    const targetName = channel.speakers.get(data.targetUserId)?.name || channel.listeners.get(data.targetUserId)?.name || 'User';
    channel.speakers.delete(data.targetUserId);
    channel.listeners.delete(data.targetUserId);
    io.to(userData.channelId).emit('user-left', { userId: data.targetUserId, userName: targetName });
    cb({ success: true });
  });

  // ===== BAN 30 MIN =====
  socket.on('ban-user', (data, cb) => {
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });

    const until = Date.now() + LIMITS.BAN_DURATION;
    bans.get(userData.channelId).set(data.targetUserId, until);

    const target = findUser(data.targetUserId);
    if (target) {
      io.to(target.socketId).emit('banned', { until, reason: sanitize(data.reason, 100) || 'Banned for 30 minutes' });
      io.sockets.sockets.get(target.socketId)?.disconnect();
    }

    const targetName = channel.speakers.get(data.targetUserId)?.name || channel.listeners.get(data.targetUserId)?.name || 'User';
    channel.speakers.delete(data.targetUserId);
    channel.listeners.delete(data.targetUserId);
    io.to(userData.channelId).emit('user-banned', { userId: data.targetUserId, userName: targetName, until });
    cb({ success: true });
  });

  // ===== TRANSFER ADMIN =====
  socket.on('transfer-admin', (data, cb) => {
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel || channel.admin !== userData.userId) return cb({ error: 'Admin only' });

    const target = channel.speakers.get(data.targetUserId) || channel.listeners.get(data.targetUserId);
    if (!target) return cb({ error: 'User not found' });

    const oldAdminId = channel.admin;
    channel.admin = data.targetUserId;
    channel.adminName = target.name;

    if (channel.listeners.has(data.targetUserId)) {
      channel.speakers.set(data.targetUserId, channel.listeners.get(data.targetUserId));
      channel.listeners.delete(data.targetUserId);
    }

    const newAdminSocket = findUser(data.targetUserId);
    if (newAdminSocket) users.get(newAdminSocket.socketId).role = 'admin';
    const oldAdminSocket = findUser(oldAdminId);
    if (oldAdminSocket) users.get(oldAdminSocket.socketId).role = 'speaker';

    io.to(userData.channelId).emit('admin-transferred', { oldAdminId, newAdminId: data.targetUserId, newAdminName: target.name });
    cb({ success: true });
  });

  // ===== SPEAKING STATUS =====
  socket.on('speaking-status', (data) => {
    const userData = users.get(socket.id);
    if (!userData) return;
    socket.to(userData.channelId).emit('user-speaking', { userId: userData.userId, userName: userData.userName, isSpeaking: !!data.isSpeaking });
  });

  // ===== VOTE TO KICK =====
  socket.on('start-vote', (data, cb) => {
    const userData = users.get(socket.id);
    const channel = channels.get(userData?.channelId);
    if (!channel) return cb({ error: 'Channel not found' });
    if (data.targetUserId === channel.admin) return cb({ error: 'Cannot vote against admin' });

    const voteId = uuidv4().slice(0, 8);
    votes.set(voteId, {
      id: voteId, channelId: userData.channelId, targetUserId: data.targetUserId,
      targetName: sanitize(data.targetName, LIMITS.MAX_NAME_LENGTH), startedBy: userData.userId,
      yes: new Set([userData.userId]), no: new Set(), expiresAt: Date.now() + LIMITS.VOTE_DURATION
    });

    io.to(userData.channelId).emit('vote-started', { voteId, targetUserId: data.targetUserId, targetName: data.targetName, expiresAt: Date.now() + LIMITS.VOTE_DURATION });
    setTimeout(() => finishVote(voteId), LIMITS.VOTE_DURATION);
    cb({ success: true, voteId });
  });

  socket.on('cast-vote', (data) => {
    const vote = votes.get(data.voteId);
    if (!vote) return;
    const userData = users.get(socket.id);
    if (!userData) return;
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
    const needed = Math.max(2, Math.ceil(total * LIMITS.VOTE_THRESHOLD));
    if (vote.yes.size >= needed) {
      const target = findUser(vote.targetUserId);
      if (target) { io.to(target.socketId).emit('kicked', { reason: 'Community vote' }); io.sockets.sockets.get(target.socketId)?.disconnect(); }
      channel.speakers.delete(vote.targetUserId);
      channel.listeners.delete(vote.targetUserId);
      io.to(vote.channelId).emit('vote-result', { voteId, kicked: true, targetName: vote.targetName });
    } else {
      io.to(vote.channelId).emit('vote-result', { voteId, kicked: false, targetName: vote.targetName });
    }
    votes.delete(voteId);
  }

  // ===== WebRTC SIGNALING =====
  socket.on('webrtc-offer', (d) => { const t = findUser(d.toUserId); if (t) io.to(t.socketId).emit('webrtc-offer', d); });
  socket.on('webrtc-answer', (d) => { const t = findUser(d.toUserId); if (t) io.to(t.socketId).emit('webrtc-answer', d); });
  socket.on('webrtc-ice', (d) => { const t = findUser(d.toUserId); if (t) io.to(t.socketId).emit('webrtc-ice', d); });

  // ===== DISCONNECT =====
  socket.on('disconnect', () => {
    // Release IP slot
    const ip = socket._clientIp;
    if (ip) {
      const count = ipConnections.get(ip) || 1;
      if (count <= 1) ipConnections.delete(ip);
      else ipConnections.set(ip, count - 1);
    }
    socketRates.delete(socket.id);

    const userData = users.get(socket.id);
    if (!userData) return;

    const channel = channels.get(userData.channelId);
    if (!channel) { users.delete(socket.id); return; }

    channel.speakers.delete(userData.userId);
    channel.listeners.delete(userData.userId);

    if (channel.speakers.size === 0 && channel.listeners.size === 0) {
      channels.delete(userData.channelId);
      bans.delete(userData.channelId);
      io.emit('channels-updated');
      console.log(`[DELETE] "${channel.name}" — empty [${channels.size}/${LIMITS.MAX_CHANNELS}]`);
    } else {
      socket.to(userData.channelId).emit('user-left', { userId: userData.userId, userName: userData.userName });
    }

    users.delete(socket.id);
    messageRates.delete(userData.userId);
    console.log(`[-] Disconnected: ${userData.userName} [${users.size} online]`);
  });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  PageChat Radio Pro Server');
  console.log('  ─────────────────────────────────────');
  console.log(`  Port:        ${PORT}`);
  console.log(`  Channels:    ${LIMITS.MAX_CHANNELS} max`);
  console.log(`  Per channel: ${LIMITS.MAX_SPEAKERS} speakers / ${LIMITS.MAX_LISTENERS} listeners`);
  console.log(`  Per user:    ${LIMITS.MAX_CHANNELS_PER_USER} channel`);
  console.log(`  Per IP:      ${LIMITS.MAX_CONNECTIONS_PER_IP} connections`);
  console.log(`  Rate limit:  ${LIMITS.MAX_EVENTS_PER_SECOND} events/sec`);
  console.log('  ─────────────────────────────────────');
  console.log(`  Status:  http://localhost:${PORT}`);
  console.log(`  Client:  ws://YOUR_IP:${PORT}`);
  console.log('');
});