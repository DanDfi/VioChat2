const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_USERS = 20;
const MAX_STORAGE_PER_USER = 50 * 1024 * 1024;

// On Render.com the project src is read-only — use /tmp for mutable data.
// Set DATA_DIR=/data env var if you add a Render Persistent Disk.
const DATA_DIR = process.env.DATA_DIR || '/tmp/chatdata';
const uploadsDir = path.join(DATA_DIR, 'uploads');
const avatarsDir = path.join(DATA_DIR, 'avatars');
[DATA_DIR, uploadsDir, avatarsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const users = new Map();
const sessions = new Map();
const bannedTokens = new Set();
const uploadSizes = new Map();
const MAX_MESSAGES = 200;
let messageHistory = [];

// reactions: msgId -> { emoji -> Set(shortToken) }
const reactions = new Map();
// typing: shortToken -> timeout handle
const typingUsers = new Map();

const USERS_FILE = path.join(DATA_DIR, 'users.json');
function saveUsers() {
  const obj = {};
  users.forEach((v, k) => obj[k] = v);
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
}
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const obj = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      Object.entries(obj).forEach(([k, v]) => {
        users.set(k, v);
        uploadSizes.set(k, v.storageUsed || 0);
      });
    } catch {}
  }
}

const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
function saveMessages() {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messageHistory, null, 2));
}
function loadMessages() {
  if (fs.existsSync(MESSAGES_FILE)) {
    try {
      messageHistory = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    } catch { messageHistory = []; }
  }
}

loadUsers();
loadMessages();

function generateShortToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 4; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}
function generateLoginToken() {
  return uuidv4().replace(/-/g, '').substring(0, 24).toUpperCase();
}

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${uuidv4().substring(0, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  }
});

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${req.userToken}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use('/avatars', express.static(avatarsDir));

function adminMiddleware(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin not configured. Set ADMIN_PASSWORD env var.' });
  if (pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid admin password' });
  next();
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !users.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  if (bannedTokens.has(token)) return res.status(403).json({ error: 'Banned' });
  req.userToken = token;
  req.user = users.get(token);
  next();
}

app.post('/api/register', (req, res) => {
  const { nick } = req.body;
  if (!nick || nick.trim().length < 1 || nick.trim().length > 20)
    return res.status(400).json({ error: 'Nick must be 1-20 characters' });
  if (users.size >= MAX_USERS)
    return res.status(403).json({ error: 'Server is full (max 5 users)' });
  const loginToken = generateLoginToken();
  const shortToken = generateShortToken();
  const user = { nick: nick.trim(), loginToken, shortToken, avatar: null, createdAt: Date.now(), storageUsed: 0 };
  users.set(loginToken, user);
  uploadSizes.set(loginToken, 0);
  saveUsers();
  res.json({ loginToken, shortToken, nick: user.nick });
});

app.post('/api/login', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  const user = users.get(token.toUpperCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  res.json({ ok: true, nick: user.nick, avatar: user.avatar, shortToken: user.shortToken });
});

app.get('/api/find/:shortToken', authMiddleware, (req, res) => {
  const short = req.params.shortToken.toUpperCase();
  let found = null;
  users.forEach((u) => {
    if (u.shortToken === short) found = { nick: u.nick, shortToken: u.shortToken, avatar: u.avatar };
  });
  if (!found) return res.status(404).json({ error: 'User not found' });
  res.json(found);
});

app.post('/api/nick', authMiddleware, (req, res) => {
  const { nick } = req.body;
  if (!nick || nick.trim().length < 1 || nick.trim().length > 20)
    return res.status(400).json({ error: 'Nick must be 1-20 characters' });
  const user = users.get(req.userToken);
  user.nick = nick.trim();
  saveUsers();
  broadcast({ type: 'user_update', shortToken: user.shortToken, nick: user.nick, avatar: user.avatar });
  res.json({ ok: true, nick: user.nick });
});

app.post('/api/avatar', authMiddleware, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const user = users.get(req.userToken);
    user.avatar = `/avatars/${req.file.filename}`;
    saveUsers();
    broadcast({ type: 'user_update', shortToken: user.shortToken, nick: user.nick, avatar: user.avatar });
    res.json({ ok: true, avatar: user.avatar });
  });
});

app.post('/api/upload', authMiddleware, (req, res) => {
  const user = users.get(req.userToken);
  const used = uploadSizes.get(req.userToken) || 0;
  chatUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileSize = req.file.size;
    if (used + fileSize > MAX_STORAGE_PER_USER) {
      fs.unlinkSync(req.file.path);
      return res.status(413).json({ error: 'Storage limit exceeded (50MB per user)' });
    }
    const newUsed = used + fileSize;
    uploadSizes.set(req.userToken, newUsed);
    user.storageUsed = newUsed;
    saveUsers();
    res.json({ url: `/uploads/${req.file.filename}`, size: fileSize, used: newUsed });
  });
});

app.get('/api/users', authMiddleware, (req, res) => {
  const list = [];
  users.forEach((u, token) => {
    const isOnline = [...sessions.values()].includes(token);
    list.push({ nick: u.nick, shortToken: u.shortToken, avatar: u.avatar, online: isOnline, storageUsed: u.storageUsed || 0 });
  });
  res.json(list);
});

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function broadcastUserList() {
  const list = [];
  users.forEach((u, token) => {
    const isOnline = [...sessions.values()].includes(token);
    list.push({ nick: u.nick, shortToken: u.shortToken, avatar: u.avatar, online: isOnline });
  });
  const msg = JSON.stringify({ type: 'user_list', users: list });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// Send DM to specific user only
function sendToUser(shortToken, data) {
  const msg = JSON.stringify(data);
  sessions.forEach((token, ws) => {
    const u = users.get(token);
    if (u && u.shortToken === shortToken && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastTyping() {
  const nickList = [];
  typingUsers.forEach((_, shortToken) => {
    users.forEach(u => { if (u.shortToken === shortToken) nickList.push(u.nick); });
  });
  const msg = JSON.stringify({ type: 'typing', users: nickList });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── PING/PONG keepalive ──
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── TYPING ──
    if (data.type === 'typing') {
      const token = sessions.get(ws);
      if (!token) return;
      const user = users.get(token);
      if (!user) return;
      // clear previous timeout for this user
      if (typingUsers.has(user.shortToken)) {
        clearTimeout(typingUsers.get(user.shortToken));
      }
      // set timeout to remove after 3s of inactivity
      const t = setTimeout(() => {
        typingUsers.delete(user.shortToken);
        broadcastTyping();
      }, 3000);
      typingUsers.set(user.shortToken, t);
      broadcastTyping();
      return;
    }

    // ── AUTH ──
    if (data.type === 'auth') {
      const token = (data.token || '').toUpperCase().trim();
      const user = users.get(token);
      if (!user) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
        ws.close();
        return;
      }
      if (bannedTokens.has(token)) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Zbanowany' }));
        ws.close();
        return;
      }
      sessions.set(ws, token);
      ws.send(JSON.stringify({ type: 'auth_ok', nick: user.nick, shortToken: user.shortToken, avatar: user.avatar }));
      if (messageHistory.length > 0) {
        ws.send(JSON.stringify({ type: 'history', messages: messageHistory }));
      }
      broadcastUserList();
      broadcast({ type: 'system', text: `${user.nick} dołączył do czatu` }, ws);
    }

    // ── PUBLIC MESSAGE ──
    if (data.type === 'message') {
      const token = sessions.get(ws);
      if (!token) return;
      const user = users.get(token);
      if (!user) return;
      const text = (data.text || '').substring(0, 2000);
      if (!text.trim() && !data.imageUrl) return;
      const msg = {
        type: 'message',
        id: uuidv4(),
        nick: user.nick,
        shortToken: user.shortToken,
        avatar: user.avatar,
        text,
        imageUrl: data.imageUrl || null,
        ts: Date.now()
      };
      const msgStr = JSON.stringify(msg);
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msgStr); });
      messageHistory.push(msg);
      if (messageHistory.length > MAX_MESSAGES) messageHistory = messageHistory.slice(-MAX_MESSAGES);
      saveMessages();
    }

    // ── DIRECT MESSAGE ──
    if (data.type === 'dm') {
      const token = sessions.get(ws);
      if (!token) return;
      const user = users.get(token);
      if (!user) return;
      const text = (data.text || '').substring(0, 2000);
      if (!text.trim()) return;
      const toShort = (data.to || '').toUpperCase();
      if (!toShort) return;

      const dm = {
        type: 'dm',
        id: uuidv4(),
        nick: user.nick,
        shortToken: user.shortToken,
        avatar: user.avatar,
        toShortToken: toShort,
        text,
        ts: Date.now()
      };
      // send to recipient and sender
      sendToUser(toShort, dm);
      ws.send(JSON.stringify(dm)); // echo back to sender
    }

    // ── REACTION ──
    if (data.type === 'reaction') {
      const token = sessions.get(ws);
      if (!token) return;
      const user = users.get(token);
      if (!user) return;
      const { msgId, emoji } = data;
      if (!msgId || !emoji) return;

      if (!reactions.has(msgId)) reactions.set(msgId, {});
      const msgReactions = reactions.get(msgId);
      if (!msgReactions[emoji]) msgReactions[emoji] = [];

      const idx = msgReactions[emoji].indexOf(user.shortToken);
      if (idx === -1) {
        msgReactions[emoji].push(user.shortToken); // add
      } else {
        msgReactions[emoji].splice(idx, 1); // toggle off
        if (msgReactions[emoji].length === 0) delete msgReactions[emoji];
      }

      // broadcast updated reactions for this message
      const update = { type: 'reaction_update', msgId, reactions: msgReactions };
      const updateStr = JSON.stringify(update);
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(updateStr); });
    }
  });

  ws.on('close', () => {
    const token = sessions.get(ws);
    if (token) {
      const user = users.get(token);
      sessions.delete(ws);
      // remove from typing
      if (user && typingUsers.has(user.shortToken)) {
        clearTimeout(typingUsers.get(user.shortToken));
        typingUsers.delete(user.shortToken);
        broadcastTyping();
      }
      broadcastUserList();
      if (user) broadcast({ type: 'system', text: `${user.nick} opuścił czat` });
    }
  });
});

// ── ADMIN API ──

// Verify admin password
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin not configured. Set ADMIN_PASSWORD env var.' });
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid password' });
  res.json({ ok: true });
});

// Get all users with full details
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const list = [];
  users.forEach((u, token) => {
    const isOnline = [...sessions.values()].includes(token);
    const isBanned = bannedTokens.has(token);
    list.push({
      nick: u.nick,
      shortToken: u.shortToken,
      avatar: u.avatar,
      online: isOnline,
      banned: isBanned,
      storageUsed: u.storageUsed || 0,
      createdAt: u.createdAt || null,
      loginToken: token
    });
  });
  res.json(list);
});

// Get message history
app.get('/api/admin/messages', adminMiddleware, (req, res) => {
  res.json(messageHistory);
});

// Delete user
app.delete('/api/admin/users/:shortToken', adminMiddleware, (req, res) => {
  const short = req.params.shortToken.toUpperCase();
  let targetToken = null;
  users.forEach((u, token) => { if (u.shortToken === short) targetToken = token; });
  if (!targetToken) return res.status(404).json({ error: 'User not found' });
  const user = users.get(targetToken);
  users.delete(targetToken);
  uploadSizes.delete(targetToken);
  bannedTokens.delete(targetToken);
  saveUsers();
  // kick active WS session
  sessions.forEach((token, ws) => {
    if (token === targetToken) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Twoje konto zostało usunięte' }));
      ws.close();
    }
  });
  broadcast({ type: 'system', text: `Konto ${user.nick} zostało usunięte przez admina` });
  broadcastUserList();
  res.json({ ok: true });
});

// Ban user
app.post('/api/admin/users/:shortToken/ban', adminMiddleware, (req, res) => {
  const short = req.params.shortToken.toUpperCase();
  let targetToken = null;
  users.forEach((u, token) => { if (u.shortToken === short) targetToken = token; });
  if (!targetToken) return res.status(404).json({ error: 'User not found' });
  const user = users.get(targetToken);
  bannedTokens.add(targetToken);
  // kick active session
  sessions.forEach((token, ws) => {
    if (token === targetToken) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Zostałeś zbanowany' }));
      ws.close();
    }
  });
  broadcast({ type: 'system', text: `${user.nick} został zbanowany` });
  broadcastUserList();
  res.json({ ok: true });
});

// Unban user
app.post('/api/admin/users/:shortToken/unban', adminMiddleware, (req, res) => {
  const short = req.params.shortToken.toUpperCase();
  let targetToken = null;
  users.forEach((u, token) => { if (u.shortToken === short) targetToken = token; });
  if (!targetToken) return res.status(404).json({ error: 'User not found' });
  bannedTokens.delete(targetToken);
  const user = users.get(targetToken);
  broadcast({ type: 'system', text: `${user.nick} został odbanowany` });
  res.json({ ok: true });
});

// Server stats
app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const onlineCount = new Set(sessions.values()).size;
  let totalStorage = 0;
  users.forEach(u => { totalStorage += u.storageUsed || 0; });
  res.json({
    totalUsers: users.size,
    onlineUsers: onlineCount,
    bannedUsers: bannedTokens.size,
    totalMessages: messageHistory.length,
    totalStorage
  });
});

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`✅ Chat server running on http://localhost:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
});
