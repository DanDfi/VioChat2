// ── STATE ──
let myToken = '';
let myUser = null;
let ws = null;
let pendingImageUrl = null;
let uploadInProgress = false;
let emojiPickerOpen = false;
let soundEnabled = true;
let currentDM = null;
let allUsers = [];
let dmHistory = {};
let typingTimeout = null;
let serverHasPassword = false;

const EMOJIS = ['😀','😂','😍','🥰','😎','🤔','😅','🙄','😢','😡','🥳','😴','👍','👎','❤️','🔥','✨','🎉','💯','🙏','👏','💪','🤝','✅','❌','⚡','🌟','💬','😊','🤣','😇','🥹','😏','🤯','😱','🤗','😙','🤭','🥸','😬','🫶','💖','💀','👀','🫠','🤌','🎯','💡','🚀','🌈'];
const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥','🎉','💯'];

// ── SOUND ──
function playNotif() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.start(ctx.currentTime);
    o.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

function saveSoundPref() {
  soundEnabled = document.getElementById('sound-toggle').checked;
  localStorage.setItem('soundEnabled', soundEnabled);
}

// ── TYPING ──
let _typingTimeout = null;
function sendTyping() {
  if (!ws || ws.readyState !== WebSocket.OPEN || currentDM) return;
  ws.send(JSON.stringify({ type: 'typing' }));
  clearTimeout(_typingTimeout);
  _typingTimeout = setTimeout(() => {}, 2500);
}

function renderTyping(users) {
  const bar = document.getElementById('typing-bar');
  const others = users.filter(s => s !== myUser.shortToken);
  if (!others.length) { bar.innerHTML = ''; return; }
  const names = others.map(s => {
    const u = allUsers.find(u => u.shortToken === s);
    return u ? u.nick : s;
  });
  const text = names.length === 1
    ? `${names[0]} pisze...`
    : `${names.join(', ')} piszą...`;
  bar.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>${text}`;
}

// ── THEME ──
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.getElementById('theme-light').classList.toggle('active', theme === 'light');
  document.getElementById('theme-dark').classList.toggle('active', theme === 'dark');
}

function loadTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  setTheme(saved);
}

// ── TABS ──
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='register')));
  document.getElementById('tab-login').classList.toggle('active', tab==='login');
  document.getElementById('tab-register').classList.toggle('active', tab==='register');
}

// ── AUTH ──
async function doRegister() {
  const nick = document.getElementById('reg-nick').value.trim();
  const err = document.getElementById('reg-err');
  err.textContent = '';
  if (!nick) { err.textContent = 'Podaj nick'; return; }
  try {
    const password = document.getElementById('reg-password') ? document.getElementById('reg-password').value : '';
    const r = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({nick, password}) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; return; }
    document.getElementById('res-login-token').textContent = d.loginToken;
    document.getElementById('res-short-token').textContent = d.shortToken;
    document.getElementById('reg-result').classList.add('show');
    myToken = d.loginToken;
    myUser = { nick: d.nick, shortToken: d.shortToken, avatar: null, loginToken: d.loginToken };
    localStorage.setItem('chatToken', d.loginToken);
  } catch(e) { err.textContent = 'Błąd połączenia'; }
}

function loginWithNewToken() { enterChat(); }

async function doLogin() {
  const token = document.getElementById('login-token').value.trim().toUpperCase();
  const err = document.getElementById('login-err');
  err.textContent = '';
  if (!token) { err.textContent = 'Wpisz token'; return; }
  try {
    const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token}) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; return; }
    myToken = token;
    myUser = { nick: d.nick, shortToken: d.shortToken, avatar: d.avatar, loginToken: token };
    localStorage.setItem('chatToken', token);
    enterChat();
  } catch(e) { err.textContent = 'Błąd połączenia'; }
}

function enterChat() {
  const saved = localStorage.getItem('soundEnabled');
  if (saved !== null) soundEnabled = saved === 'true';
  document.getElementById('sound-toggle').checked = soundEnabled;

  loadTheme();
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('chat-screen').classList.add('active');
  initMeDisplay();
  connectWS();
  buildEmojiPicker();
  checkAdminAvailable();
}

// ── ME DISPLAY ──
function initMeDisplay() {
  document.getElementById('me-nick-display').textContent = myUser.nick;
  document.getElementById('me-tag-display').textContent = myUser.shortToken;
  renderAvatarMini('me-avatar-mini', myUser.avatar, myUser.nick);
}

function renderAvatarMini(id, avatar, nick) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = avatar ? `<img src="${avatar}" alt="">` : (nick ? nick[0].toUpperCase() : '?');
}

// ── WEBSOCKET ──
let _pingInterval = null;
let _reconnectDelay = 1500;

function connectWS() {
  if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    _reconnectDelay = 1500;
    ws.send(JSON.stringify({ type: 'auth', token: myToken }));
    // keepalive co 30s — Render rozłącza po ~55s braku aktywności
    _pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'pong') return;

    if (data.type === 'auth_ok') {
      myUser.nick = data.nick; myUser.shortToken = data.shortToken; myUser.avatar = data.avatar;
      initMeDisplay();
    }
    else if (data.type === 'auth_error') { location.reload(); }
    else if (data.type === 'message') {
      if (currentDM === null) {
        appendMessage(data);
        if (data.shortToken !== myUser.shortToken) playNotif();
      }
    }
    else if (data.type === 'history') {
      data.messages.forEach(msg => appendMessage(msg, true));
      scrollToBottom();
    }
    else if (data.type === 'dm') {
      const partner = data.shortToken === myUser.shortToken ? data.toShortToken : data.shortToken;
      if (!dmHistory[partner]) dmHistory[partner] = [];
      dmHistory[partner].push(data);
      if (currentDM === partner) {
        appendMessage(data);
      } else {
        // show unread badge
        markDMUnread(partner);
        if (data.shortToken !== myUser.shortToken) playNotif();
      }
    }
    else if (data.type === 'typing') { renderTyping(data.users); }
    else if (data.type === 'system') { appendSystem(data.text); }
    else if (data.type === 'user_list') {
      allUsers = data.users;
      renderUserList(data.users);
    }
    else if (data.type === 'user_update') {
      if (data.shortToken === myUser.shortToken) {
        myUser.nick = data.nick; myUser.avatar = data.avatar; initMeDisplay();
      }
    }
    else if (data.type === 'reaction_update') {
      updateReactions(data.msgId, data.reactions);
    }
  };

  ws.onclose = () => {
    if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
    appendSystem(`Połączenie zerwane, reconnect za ${Math.round(_reconnectDelay/1000)}s...`);
    setTimeout(connectWS, _reconnectDelay);
    _reconnectDelay = Math.min(_reconnectDelay * 1.5, 15000); // max 15s
  };

  ws.onerror = () => {
    ws.close();
  };
}

// ── DM ──
function openDM(shortToken) {
  if (shortToken === myUser.shortToken) return;
  currentDM = shortToken;
  const user = allUsers.find(u => u.shortToken === shortToken);
  document.getElementById('chat-title').textContent = `💬 DM z ${user ? user.nick : shortToken}`;
  document.getElementById('dm-close-btn').style.display = 'flex';
  document.getElementById('msg-input').placeholder = `Napisz do ${user ? user.nick : shortToken}...`;

  const msgs = document.getElementById('messages');
  msgs.innerHTML = '';
  (dmHistory[shortToken] || []).forEach(msg => appendMessage(msg, true));
  scrollToBottom();
  clearDMUnread(shortToken);
}

function closeDM() {
  currentDM = null;
  document.getElementById('chat-title').textContent = '# ogólny';
  document.getElementById('dm-close-btn').style.display = 'none';
  document.getElementById('msg-input').placeholder = 'Napisz wiadomość...';
  const msgs = document.getElementById('messages');
  msgs.innerHTML = '';
  // reload public history
  fetch('/api/users', { headers: {'x-auth-token': myToken} }).then(() => {});
  ws.send(JSON.stringify({ type: 'auth', token: myToken }));
}

function markDMUnread(shortToken) {
  const el = document.querySelector(`.user-item[data-short="${shortToken}"] .dm-badge`);
  if (el) { el.style.display = 'flex'; }
}
function clearDMUnread(shortToken) {
  const el = document.querySelector(`.user-item[data-short="${shortToken}"] .dm-badge`);
  if (el) { el.style.display = 'none'; }
}

// ── MESSAGES ──
function appendMessage(msg, isHistory = false) {
  const msgs = document.getElementById('messages');
  const isSelf = msg.shortToken === myUser.shortToken;
  const div = document.createElement('div');
  div.className = 'msg-group';
  div.dataset.msgId = msg.id;

  const time = new Date(msg.ts).toLocaleTimeString('pl', {hour:'2-digit',minute:'2-digit'});
  const avatarHtml = msg.avatar ? `<img src="${msg.avatar}" alt="">` : `${(msg.nick||'?')[0].toUpperCase()}`;
  const isDM = msg.type === 'dm';
  const dmBadge = isDM ? `<span class="dm-tag">DM</span>` : '';

  div.innerHTML = `
    <div class="msg-header">
      <div class="msg-avatar">${avatarHtml}</div>
      <span class="msg-nick">${esc(msg.nick)}</span>
      ${dmBadge}
      <span class="msg-time">${time}</span>
    </div>
    ${msg.text ? `<div class="msg-bubble${isSelf?' self':''}">${parseText(msg.text)}</div>` : ''}
    ${msg.imageUrl ? `<div class="msg-image"><img src="${msg.imageUrl}" alt="" onclick="openLightbox('${msg.imageUrl}')"></div>` : ''}
    <div class="msg-reactions" id="reactions-${msg.id}"></div>
    <div class="msg-action-bar">
      <button class="react-btn" onclick="toggleReactionPicker('${msg.id}', this)">😊 +</button>
      ${!isDM && msg.shortToken !== myUser.shortToken ? `<button class="reply-dm-btn" onclick="openDM('${msg.shortToken}')">💬 DM</button>` : ''}
    </div>
    <div class="reaction-picker" id="rpicker-${msg.id}">
      ${REACTION_EMOJIS.map(e => `<button class="emoji-btn" onclick="sendReaction('${msg.id}','${e}');closeAllReactionPickers()">${e}</button>`).join('')}
    </div>
  `;

  msgs.appendChild(div);
  if (!isHistory) msgs.scrollTop = msgs.scrollHeight;
}

function scrollToBottom() {
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
}

function appendSystem(text) {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── REACTIONS ──
function sendReaction(msgId, emoji) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'reaction', msgId, emoji }));
}

function toggleReactionPicker(msgId, btn) {
  closeAllReactionPickers();
  const picker = document.getElementById(`rpicker-${msgId}`);
  if (picker) picker.classList.toggle('show');
}

function closeAllReactionPickers() {
  document.querySelectorAll('.reaction-picker.show').forEach(p => p.classList.remove('show'));
}

function updateReactions(msgId, reactions) {
  const container = document.getElementById(`reactions-${msgId}`);
  if (!container) return;
  container.innerHTML = '';
  Object.entries(reactions).forEach(([emoji, users]) => {
    if (users.length === 0) return;
    const isMine = users.includes(myUser.shortToken);
    const btn = document.createElement('button');
    btn.className = `reaction-chip${isMine ? ' mine' : ''}`;
    btn.textContent = `${emoji} ${users.length}`;
    btn.title = users.join(', ');
    btn.onclick = () => sendReaction(msgId, emoji);
    container.appendChild(btn);
  });
}

// ── MENTION (@nick) ──
function handleMention(el) {
  const val = el.value;
  const pos = el.selectionStart;
  const before = val.slice(0, pos);
  const match = before.match(/@(\w*)$/);
  const list = document.getElementById('mention-list');
  if (!match) { list.style.display = 'none'; return; }

  const query = match[1].toLowerCase();
  const matches = allUsers.filter(u => u.shortToken !== myUser.shortToken && u.nick.toLowerCase().startsWith(query));
  if (!matches.length) { list.style.display = 'none'; return; }

  list.innerHTML = '';
  list.style.display = 'block';
  matches.forEach(u => {
    const item = document.createElement('div');
    item.className = 'mention-item';
    const av = u.avatar ? `<img src="${u.avatar}" alt="">` : u.nick[0].toUpperCase();
    item.innerHTML = `<div class="mention-avatar">${av}</div><span>${esc(u.nick)}</span><span class="mention-tag">${u.shortToken}</span>`;
    item.onclick = () => {
      const before2 = val.slice(0, pos - match[1].length - 1);
      const after2 = val.slice(pos);
      el.value = before2 + '@' + u.nick + ' ' + after2;
      el.focus();
      list.style.display = 'none';
    };
    list.appendChild(item);
  });
}

document.addEventListener('click', e => {
  if (!e.target.closest('.input-wrap')) document.getElementById('mention-list').style.display = 'none';
  if (!e.target.closest('.emoji-picker') && !e.target.closest('.icon-btn')) document.getElementById('emoji-picker').classList.remove('show');
  if (!e.target.closest('.reaction-picker') && !e.target.closest('.react-btn')) closeAllReactionPickers();
});

// ── PARSE TEXT (highlight @mentions) ──
function parseText(text) {
  return esc(text)
    .replace(/\n/g, '<br>')
    .replace(/@(\S+)/g, (match, nick) => {
      const isMe = nick.toLowerCase() === myUser.nick.toLowerCase();
      return `<span class="mention${isMe ? ' mention-me' : ''}">${match}</span>`;
    });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── USER LIST ──
function renderUserList(users) {
  const list = document.getElementById('users-list');
  const online = users.filter(u => u.online).length;
  document.getElementById('online-count').textContent = `${online} online`;
  document.getElementById('header-count').textContent = `${users.length} w pokoju`;

  list.innerHTML = '';
  users.sort((a,b) => b.online - a.online || a.nick.localeCompare(b.nick));
  users.forEach(u => {
    const div = document.createElement('div');
    div.className = 'user-item';
    div.dataset.short = u.shortToken;
    const avatarContent = u.avatar ? `<img src="${u.avatar}" alt="">` : u.nick[0].toUpperCase();
    const isMe = u.shortToken === myUser.shortToken;
    div.innerHTML = `
      <div class="avatar-wrap">
        <div class="avatar">${avatarContent}</div>
        <div class="status-dot${u.online?' online':''}"></div>
      </div>
      <div class="user-info">
        <div class="user-nick">${esc(u.nick)}${isMe ? ' <span style="font-size:9px;color:var(--text3)">(ty)</span>' : ''}</div>
        <div class="user-tag">${u.shortToken}</div>
      </div>
      ${!isMe ? `<button class="dm-icon-btn" title="Wyślij DM" onclick="openDM('${u.shortToken}')">💬</button>` : ''}
      <div class="dm-badge" style="display:none">●</div>
    `;
    list.appendChild(div);
  });
}

// ── SEND ──
function handleKey(e) {
  const list = document.getElementById('mention-list');
  if (list.style.display !== 'none') {
    if (e.key === 'Escape') { list.style.display = 'none'; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && !pendingImageUrl) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (uploadInProgress) { alert('Poczekaj na zakończenie uploadu...'); return; }

  if (currentDM) {
    ws.send(JSON.stringify({ type: 'dm', to: currentDM, text }));
  } else {
    ws.send(JSON.stringify({ type: 'message', text, imageUrl: pendingImageUrl }));
  }
  input.value = '';
  input.style.height = 'auto';
  removeImage();
}

// ── IMAGES ──
async function handleImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('image-preview-row').style.display = 'block';
  document.getElementById('preview-img').src = URL.createObjectURL(file);
  document.getElementById('upload-indicator').classList.add('show');
  uploadInProgress = true;
  const form = new FormData();
  form.append('image', file);
  try {
    const r = await fetch('/api/upload', { method:'POST', headers:{'x-auth-token': myToken}, body: form });
    const d = await r.json();
    if (r.ok) { pendingImageUrl = d.url; updateStorage(d.used); }
    else { alert(d.error); removeImage(); }
  } catch { alert('Błąd przesyłania'); removeImage(); }
  uploadInProgress = false;
  document.getElementById('upload-indicator').classList.remove('show');
  e.target.value = '';
}

function removeImage() {
  pendingImageUrl = null;
  document.getElementById('image-preview-row').style.display = 'none';
  document.getElementById('preview-img').src = '';
}

// ── EMOJI PICKER ──
function buildEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  EMOJIS.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = e;
    btn.onclick = () => {
      const input = document.getElementById('msg-input');
      const pos = input.selectionStart;
      input.value = input.value.slice(0,pos) + e + input.value.slice(pos);
      input.selectionStart = input.selectionEnd = pos + e.length;
      input.focus();
    };
    picker.appendChild(btn);
  });
}

function toggleEmoji() {
  document.getElementById('emoji-picker').classList.toggle('show');
}

// ── SETTINGS ──
function openSettings() {
  document.getElementById('settings-nick').value = myUser.nick;
  document.getElementById('settings-login-token').textContent = myToken;
  document.getElementById('settings-short-token').textContent = myUser.shortToken;
  document.getElementById('sound-toggle').checked = soundEnabled;
  refreshSettingsAvatar();
  fetch('/api/users', { headers: {'x-auth-token': myToken} })
    .then(r => r.json())
    .then(users => {
      const me = users.find(u => u.shortToken === myUser.shortToken);
      if (me) updateStorage(me.storageUsed);
    });
  document.getElementById('settings-overlay').classList.add('show');
}

function refreshSettingsAvatar() {
  const p = document.getElementById('settings-avatar-preview');
  if (myUser.avatar) { p.innerHTML = `<img src="${myUser.avatar}" alt="">`; }
  else { p.textContent = myUser.nick ? myUser.nick[0].toUpperCase() : '?'; }
}

function closeSettings(e) {
  if (!e || e.target === document.getElementById('settings-overlay')) {
    document.getElementById('settings-overlay').classList.remove('show');
  }
}

async function saveSettings() {
  const nick = document.getElementById('settings-nick').value.trim();
  const err = document.getElementById('nick-err');
  err.textContent = '';
  if (!nick) { err.textContent = 'Nick nie może być pusty'; return; }
  try {
    const r = await fetch('/api/nick', { method:'POST', headers:{'Content-Type':'application/json','x-auth-token': myToken}, body: JSON.stringify({nick}) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; return; }
    myUser.nick = d.nick;
    initMeDisplay();
    closeSettings();
  } catch { err.textContent = 'Błąd połączenia'; }
}

async function uploadAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('avatar', file);
  try {
    const r = await fetch('/api/avatar', { method:'POST', headers:{'x-auth-token': myToken}, body: form });
    const d = await r.json();
    if (r.ok) { myUser.avatar = d.avatar + '?t=' + Date.now(); initMeDisplay(); refreshSettingsAvatar(); }
    else { alert(d.error); }
  } catch { alert('Błąd przesyłania avatara'); }
  e.target.value = '';
}

function updateStorage(bytes) {
  const mb = bytes / 1024 / 1024;
  const pct = Math.min(100, (mb / 50) * 100);
  document.getElementById('storage-fill').style.width = pct + '%';
  document.getElementById('storage-text').textContent = `${mb.toFixed(2)} MB / 50 MB`;
}

// ── LIGHTBOX ──
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('show');
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('show'); }

// ── COPY ──
function copyText(text) { navigator.clipboard.writeText(text).catch(()=>{}); }

// ── LOGOUT ──
function doLogout() {
  if (!confirm('Czy na pewno chcesz się wylogować?')) return;
  localStorage.removeItem('chatToken');
  if (ws) { ws.close(); ws = null; }
  myToken = '';
  myUser = null;
  currentDM = null;
  document.getElementById('messages').innerHTML = '';
  document.getElementById('users-list').innerHTML = '';
  document.getElementById('chat-screen').classList.remove('active');
  document.getElementById('auth-screen').classList.add('active');
  document.getElementById('login-token').value = '';
  document.getElementById('login-err').textContent = '';
  // zamknij panel ustawień jeśli otwarty
  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.classList.remove('active');
  switchTab('login');
}

// Enter key on auth
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (document.getElementById('tab-login').classList.contains('active') && document.getElementById('auth-screen').classList.contains('active')) doLogin();
  }
});

// ── AUTO LOGIN ──
// Przy starcie strony sprawdź czy token jest zapisany w localStorage i zaloguj automatycznie
async function checkAdminAvailable() {
  try {
    const r = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '' })
    });
    // 503 = not configured, hide button; 403 = wrong pwd but admin exists, show button
    const btn = document.getElementById('admin-btn');
    if (btn) btn.style.display = r.status === 503 ? 'none' : 'flex';
  } catch {}
}

async function autoLogin() {
  loadTheme();
  const savedToken = localStorage.getItem('chatToken');
  if (!savedToken) return; // brak tokenu – pokaż ekran logowania

  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: savedToken })
    });
    if (!r.ok) {
      // Token nieważny – wyczyść i zostań na ekranie logowania
      localStorage.removeItem('chatToken');
      return;
    }
    const d = await r.json();
    myToken = savedToken;
    myUser = { nick: d.nick, shortToken: d.shortToken, avatar: d.avatar, loginToken: savedToken };
    enterChat();
  } catch (e) {
    // Błąd sieci – zostań na ekranie logowania (nie usuwaj tokenu)
  }
}

// Uruchom auto-login zaraz po załadowaniu DOM
document.addEventListener('DOMContentLoaded', autoLogin);

// ── ADMIN PANEL ──
let adminAuthenticated = false;
let adminPassword = '';

function openAdmin() {
  document.getElementById('admin-overlay').classList.add('show');
  if (!adminAuthenticated) {
    document.getElementById('admin-login-section').style.display = 'block';
    document.getElementById('admin-content').style.display = 'none';
    setTimeout(() => document.getElementById('admin-password-input').focus(), 100);
  } else {
    loadAdminData();
  }
}

function closeAdmin(e) {
  if (e && e.target !== document.getElementById('admin-overlay')) return;
  document.getElementById('admin-overlay').classList.remove('show');
}

async function verifyAdmin() {
  const pwd = document.getElementById('admin-password-input').value;
  const errEl = document.getElementById('admin-login-err');
  errEl.textContent = '';
  if (!pwd) { errEl.textContent = 'Wpisz hasło'; return; }

  try {
    const r = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    if (!r.ok) {
      const d = await r.json();
      errEl.textContent = d.error || 'Błędne hasło';
      return;
    }
    adminPassword = pwd;
    adminAuthenticated = true;
    document.getElementById('admin-login-section').style.display = 'none';
    document.getElementById('admin-content').style.display = 'block';
    document.getElementById('admin-password-input').value = '';
    loadAdminData();
  } catch {
    errEl.textContent = 'Błąd połączenia';
  }
}

function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(t => t.style.display = 'none');
  btn.classList.add('active');
  document.getElementById(`admin-tab-${tab}`).style.display = 'block';
}

async function loadAdminData() {
  const headers = { 'x-admin-password': adminPassword };
  try {
    const [statsRes, usersRes, msgsRes] = await Promise.all([
      fetch('/api/admin/stats', { headers }),
      fetch('/api/admin/users', { headers }),
      fetch('/api/admin/messages', { headers })
    ]);
    if (statsRes.status === 403) { adminAuthenticated = false; openAdmin(); return; }
    const stats = await statsRes.json();
    const users = await usersRes.json();
    const msgs = await msgsRes.json();
    renderAdminStats(stats);
    renderAdminUsers(users);
    renderAdminMessages(msgs);
  } catch {
    console.error('Admin load failed');
  }
}

function renderAdminStats(s) {
  const fmt = n => n >= 1024*1024 ? (n/1024/1024).toFixed(1)+'MB' : n >= 1024 ? (n/1024).toFixed(0)+'KB' : n+'B';
  document.getElementById('admin-stats').innerHTML = `
    <div class="admin-stat-card"><div class="admin-stat-val">${s.totalUsers}</div><div class="admin-stat-label">Użytkownicy</div></div>
    <div class="admin-stat-card"><div class="admin-stat-val" style="color:var(--teal)">${s.onlineUsers}</div><div class="admin-stat-label">Online</div></div>
    <div class="admin-stat-card"><div class="admin-stat-val" style="color:var(--danger)">${s.bannedUsers}</div><div class="admin-stat-label">Bany</div></div>
    <div class="admin-stat-card"><div class="admin-stat-val" style="color:var(--text2)">${fmt(s.totalStorage)}</div><div class="admin-stat-label">Storage</div></div>
  `;
}

function renderAdminUsers(users) {
  const container = document.getElementById('admin-users-list');
  if (!users.length) { container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px">Brak użytkowników</div>'; return; }

  container.innerHTML = users.map(u => {
    const fmtStorage = u.storageUsed >= 1024*1024
      ? (u.storageUsed/1024/1024).toFixed(1)+'MB'
      : u.storageUsed >= 1024 ? (u.storageUsed/1024).toFixed(0)+'KB' : u.storageUsed+'B';
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString('pl-PL') : '—';
    const statusBadge = u.banned
      ? '<span class="admin-badge badge-banned">ZBAN</span>'
      : u.online
        ? '<span class="admin-badge badge-online">ONLINE</span>'
        : '<span class="admin-badge badge-offline">offline</span>';

    const avatarHtml = u.avatar
      ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : (u.nick[0] || '?').toUpperCase();

    const banBtn = u.banned
      ? `<button class="admin-action-btn success" onclick="adminUnban('${u.shortToken}')">Odbanuj</button>`
      : `<button class="admin-action-btn danger" onclick="adminBan('${u.shortToken}', '${u.nick.replace(/'/g,"\\'")}')">Banuj</button>`;

    return `
      <div class="admin-user-row ${u.banned ? 'banned' : ''}" id="admin-user-${u.shortToken}">
        <div class="avatar">${avatarHtml}</div>
        <div class="admin-user-info">
          <div class="admin-user-nick">${esc(u.nick)} ${statusBadge}</div>
          <div class="admin-user-meta">#${u.shortToken} · ${fmtStorage} · od ${created}</div>
        </div>
        <div class="admin-actions">
          ${banBtn}
          <button class="admin-action-btn danger" onclick="adminDelete('${u.shortToken}', '${u.nick.replace(/'/g,"\\'")}')">Usuń</button>
        </div>
      </div>`;
  }).join('');
}

function renderAdminMessages(msgs) {
  const container = document.getElementById('admin-messages-list');
  if (!msgs.length) { container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px">Brak wiadomości</div>'; return; }

  const recent = [...msgs].reverse().slice(0, 50);
  container.innerHTML = recent.map(m => {
    const time = new Date(m.ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const date = new Date(m.ts).toLocaleDateString('pl-PL');
    return `
      <div class="admin-msg-row">
        <div class="admin-msg-meta">${esc(m.nick)} · #${m.shortToken} · ${date} ${time}</div>
        <div class="admin-msg-text">${m.text ? esc(m.text) : '<em style="color:var(--text3)">[zdjęcie]</em>'}</div>
      </div>`;
  }).join('');
}

async function adminBan(shortToken, nick) {
  if (!confirm(`Zbanować użytkownika ${nick}?\nNie będzie mógł się zalogować.`)) return;
  try {
    const r = await fetch(`/api/admin/users/${shortToken}/ban`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    if (r.ok) loadAdminData();
    else { const d = await r.json(); alert(d.error); }
  } catch { alert('Błąd połączenia'); }
}

async function adminUnban(shortToken) {
  try {
    const r = await fetch(`/api/admin/users/${shortToken}/unban`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    if (r.ok) loadAdminData();
    else { const d = await r.json(); alert(d.error); }
  } catch { alert('Błąd połączenia'); }
}

async function adminDelete(shortToken, nick) {
  if (!confirm(`USUNĄĆ konto ${nick}?\nTej operacji nie można cofnąć.`)) return;
  try {
    const r = await fetch(`/api/admin/users/${shortToken}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword }
    });
    if (r.ok) loadAdminData();
    else { const d = await r.json(); alert(d.error); }
  } catch { alert('Błąd połączenia'); }
}
