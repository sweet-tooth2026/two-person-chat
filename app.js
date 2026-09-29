/* =========================================================
 * 二人聊天室 · 前端逻辑
 * 后端：LeanCloud 国际版（数据存储 + 即时通信）
 * ========================================================= */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var realtime = null;

  var state = {
    session: null,   // { role, code, pass, name, clientId, roomId, roomName }
    client: null,
    conversation: null,
    room: null,      // AV.Object Room
    seen: new Set(), // 已渲染消息去重
    rec: null,
    recStream: null,
    recChunks: [],
    sending: false
  };

  var LS_SESSION = 'tpc_session';
  var LS_ROOMS = 'tpc_rooms';

  /* ---------------- 工具 ---------------- */
  function $(s) { return document.querySelector(s); }

  function isConfigured() {
    return CFG.APP_ID && CFG.APP_KEY && CFG.SERVER_URL &&
      CFG.APP_ID.indexOf('REPLACE') === -1 &&
      CFG.APP_KEY.indexOf('REPLACE') === -1 &&
      CFG.SERVER_URL.indexOf('REPLACE') === -1;
  }

  var CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var PASS_ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function randFrom(alpha, len) {
    var out = '';
    for (var i = 0; i < len; i++) {
      out += alpha.charAt(Math.floor(Math.random() * alpha.length));
    }
    return out;
  }

  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  function showLoading(on) { $('#loading').hidden = !on; }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(d) {
    if (!d) return '';
    if (typeof d === 'string') d = new Date(d);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function readSession() {
    try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch (e) { return null; }
  }
  function saveSession() { localStorage.setItem(LS_SESSION, JSON.stringify(state.session)); }
  function clearSession() { localStorage.removeItem(LS_SESSION); }

  function readRooms() {
    try { return JSON.parse(localStorage.getItem(LS_ROOMS) || '[]'); } catch (e) { return []; }
  }
  function saveRooms(rooms) { localStorage.setItem(LS_ROOMS, JSON.stringify(rooms)); }
  function rememberRoom(room) {
    var rooms = readRooms();
    rooms = rooms.filter(function (r) { return r.code !== room.code; });
    rooms.unshift(room);
    saveRooms(rooms.slice(0, 20));
  }

  function scrollBottom() {
    var list = $('#msg-list');
    requestAnimationFrame(function () { list.scrollTop = list.scrollHeight; });
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || '已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ---------------- 初始化 ---------------- */
  function initBackend() {
    if (!window.AV) throw new Error('SDK 加载失败');
    AV.init({ appId: CFG.APP_ID, appKey: CFG.APP_KEY, serverURL: CFG.SERVER_URL });
    if (!AV.Realtime || !AV.TypedMessagesPlugin) {
      throw new Error('即时通信 SDK 加载不完整');
    }
    realtime = new AV.Realtime({
      appId: CFG.APP_ID,
      appKey: CFG.APP_KEY,
      server: CFG.SERVER_URL,
      plugins: [AV.TypedMessagesPlugin]
    });
    realtime.on('disconnect', function () { setStatus('off', '连接断开，重连中'); });
    realtime.on('reconnect', function () { setStatus('on', '在线'); toast('已重新连接'); });
    realtime.on('connect', function () { setStatus('on', '在线'); });
  }

  function setStatus(cls, text) {
    var dot = $('#status-dot');
    dot.className = 'dot ' + cls;
    $('#status-text').textContent = text;
  }

  function showScreen(id) {
    ['screen-enter', 'screen-invite', 'screen-chat'].forEach(function (s) {
      $('#' + s).hidden = (s !== id);
    });
  }

  /* 未配置时给出指引 */
  function showConfigNeeded() {
    var card = document.querySelector('.enter-wrap .card');
    var div = document.createElement('div');
    div.className = 'card';
    div.innerHTML =
      '<h2 style="margin-top:0">尚未配置后端</h2>' +
      '<p class="hint">网站代码已就绪，还需要填写 LeanCloud（国际版）的应用凭证：</p>' +
      '<ol class="hint" style="padding-left:18px;line-height:1.9">' +
      '<li>注册 leancloud.app 账号并创建应用（免费开发版）</li>' +
      '<li>在「设置 &gt; 应用凭证」复制 App ID / App Key / 服务器地址</li>' +
      '<li>把三个值填入仓库 js/config.js 后重新发布</li>' +
      '</ol>';
    if (card) card.replaceWith(div);
    var rooms = document.querySelector('.my-rooms');
    if (rooms) rooms.hidden = true;
  }

  /* ---------------- 房间：创建 / 加入 / 房主回归 ---------------- */
  async function createRoom(roomName, nick) {
    var code = randFrom(CODE_ALPHA, 10);
    var pass = randFrom(PASS_ALPHA, 8);
    var ownerId = 'owner-' + code;
    var guestId = 'guest-' + code;

    var client = await realtime.createIMClient(ownerId);
    var conv = await client.createConversation({
      members: [ownerId, guestId],
      name: roomName,
      attributes: { inviteCode: code }
    });

    var Room = AV.Object.extend('Room');
    var room = new Room();
    room.set('inviteCode', code);
    room.set('conversationId', conv.id);
    room.set('ownerClientId', ownerId);
    room.set('guestClientId', guestId);
    room.set('ownerName', nick);
    room.set('ownerPass', pass);
    room.set('roomName', roomName);
    room.set('guestJoined', false);
    await room.save();

    state.session = { role: 'owner', code: code, pass: pass, name: nick, clientId: ownerId, roomId: conv.id, roomName: roomName };
    state.room = room;
    saveSession();
    rememberRoom({ code: code, pass: pass, roomName: roomName });

    $('#invite-code').textContent = code;
    $('#invite-pass').textContent = pass;
    showScreen('screen-invite');
  }

  async function findRoomByCode(code) {
    var q = new AV.Query('Room');
    q.equalTo('inviteCode', code.toUpperCase());
    return await q.first();
  }

  async function joinRoom(code, nick) {
    var room = await findRoomByCode(code);
    if (!room) throw new Error('邀请码不存在，请检查后重试');
    if (room.get('guestJoined')) throw new Error('这个房间已有人加入，人数已满');
    var guestId = room.get('guestClientId');

    var client = await realtime.createIMClient(guestId);
    var conv = await client.getConversation(room.get('conversationId'));

    room.set('guestName', nick);
    room.set('guestJoined', true);
    await room.save();

    state.session = {
      role: 'guest', code: code.toUpperCase(), pass: '', name: nick,
      clientId: guestId, roomId: room.get('conversationId'),
      roomName: room.get('roomName')
    };
    state.room = room;
    saveSession();
    await enterChat();
  }

  async function ownerRejoin(code, pass, nick) {
    var room = await findRoomByCode(code);
    if (!room) throw new Error('邀请码不存在，请检查后重试');
    if (room.get('ownerPass') !== pass) throw new Error('房主凭证错误');

    var ownerId = room.get('ownerClientId');
    var client = await realtime.createIMClient(ownerId);
    var conv = await client.getConversation(room.get('conversationId'));

    state.session = {
      role: 'owner', code: code.toUpperCase(), pass: pass,
      name: nick || room.get('ownerName') || '房主',
      clientId: ownerId, roomId: room.get('conversationId'),
      roomName: room.get('roomName')
    };
    state.room = room;
    saveSession();
    await enterChat();
  }

  /* 页面刷新后自动回到上次的房间 */
  async function restoreSession() {
    var s = readSession();
    if (!s) return;
    showLoading(true);
    try {
      var room = await findRoomByCode(s.code);
      if (!room) throw new Error('房间不存在');
      var client = await realtime.createIMClient(s.clientId);
      var conv = await client.getConversation(s.roomId);
      state.session = s;
      state.room = room;
      await enterChat();
    } catch (e) {
      clearSession();
      toast('上次的会话已失效，请重新进入');
    } finally {
      showLoading(false);
    }
  }

  /* ---------------- 进入聊天 ---------------- */
  async function enterChat() {
    state.client = await realtime.createIMClient(state.session.clientId);
    state.conversation = await state.client.getConversation(state.session.roomId);
    state.seen = new Set();

    var room = state.room;
    $('#chat-room-name').textContent = room.get('roomName') || '聊天室';
    $('#chat-meta').textContent = '邀请码 ' + state.session.code +
      (state.session.role === 'owner'
        ? (room.get('guestJoined') ? ' · 对方：' + (room.get('guestName') || '已加入') : ' · 对方尚未加入')
        : ' · 房主：' + (room.get('ownerName') || '房主'));

    $('#msg-list').innerHTML = '';
    $('#msg-empty').hidden = false;
    showScreen('screen-chat');

    bindConversation();
    await loadHistory();
    setStatus('on', '在线');
  }

  function otherName() {
    if (state.session.role === 'owner') return state.room.get('guestName') || '对方';
    return state.room.get('ownerName') || '房主';
  }

  function bindConversation() {
    var conv = state.conversation;

    conv.on('message', function (msg) {
      renderMessage(msg);
    });

    conv.on('membersjoined', function (payload) {
      var members = payload && payload.members;
      if (members && members.indexOf(state.room.get('guestClientId')) !== -1) {
        refreshRoomMeta();
        toast('对方已加入房间');
      }
    });

    conv.on('membersleft', function () { refreshRoomMeta(); });
  }

  async function refreshRoomMeta() {
    try {
      var room = await findRoomByCode(state.session.code);
      if (room) state.room = room;
      if (state.session.role === 'owner') {
        $('#chat-meta').textContent = '邀请码 ' + state.session.code +
          (room.get('guestJoined') ? ' · 对方：' + (room.get('guestName') || '已加入') : ' · 对方尚未加入');
      }
    } catch (e) {}
  }

  async function loadHistory() {
    var msgs = await state.conversation.queryMessages({ limit: 50 });
    msgs.reverse().forEach(function (m) { renderMessage(m); });
    scrollBottom();
  }

  /* ---------------- 渲染消息 ---------------- */
  function msgKey(m) {
    if (m && m.id) return m.id;
    var f = getMsgFile(m);
    return (m.from || '') + '|' + (m.timestamp ? +m.timestamp : '') + '|' + (m.text || '') + '|' + (f ? f.name() : '');
  }

  function getMsgFile(m) {
    if (!m) return null;
    try { return m.getFile ? m.getFile() : (m.file || null); } catch (e) { return null; }
  }

  function msgKind(m) {
    var t = (m && m.type) || '';
    if (m instanceof AV.ImageMessage) return 'image';
    if (m instanceof AV.AudioMessage) return 'audio';
    if (m instanceof AV.FileMessage) return 'file';
    if (m instanceof AV.TextMessage) return 'text';
    return t === 'image' ? 'image' : t === 'audio' ? 'audio' : t === 'file' ? 'file' : 'text';
  }

  function renderMessage(m) {
    var key = msgKey(m);
    if (state.seen.has(key)) return;
    state.seen.add(key);

    var mine = (m.from === state.session.clientId);
    var name = mine ? state.session.name : otherName();
    var kind = msgKind(m);
    var content = '';

    if (kind === 'text') {
      content = '<div class="msg-bubble">' + esc(m.text || '') + '</div>';
    } else if (kind === 'image') {
      var f1 = getMsgFile(m);
      var url1 = f1 ? f1.url() : '';
      content = '<div class="msg-bubble"><img class="msg-img" src="' + esc(url1) +
        '" alt="图片" onclick="window.open(this.src)"></div>';
    } else if (kind === 'file') {
      var f2 = getMsgFile(m);
      var name2 = f2 ? f2.name() : '文件';
      var url2 = f2 ? f2.url() : '#';
      var meta = f2 && f2.metaData ? (f2.metaData().size ? fmtSize(f2.metaData().size) : '') : '';
      content =
        '<div class="msg-bubble"><a class="msg-file-card" href="' + esc(url2) + '" target="_blank" rel="noopener" download="' + esc(name2) + '">' +
        '<svg class="msg-file-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
        '<span><span class="msg-file-name">' + esc(name2) + '</span><br><span class="msg-file-size">' + esc(meta || '文档') + '</span></span>' +
        '</a></div>';
    } else if (kind === 'audio') {
      var f3 = getMsgFile(m);
      var url3 = f3 ? f3.url() : '';
      content = '<div class="msg-bubble msg-audio"><audio controls preload="none" src="' + esc(url3) + '"></audio></div>';
    } else {
      content = '<div class="msg-bubble">' + esc(m.text || m.summary || '消息') + '</div>';
    }

    var row = document.createElement('div');
    row.className = 'msg-row' + (mine ? ' mine' : '');
    row.innerHTML =
      '<div class="msg-avatar">' + esc((name || '?').slice(0, 1)) + '</div>' +
      '<div class="msg-body">' +
      '<span class="msg-sender">' + esc(name) + '</span>' + content +
      '<span class="msg-time">' + fmtTime(m.timestamp) + '</span>' +
      '</div>';

    $('#msg-empty').hidden = true;
    $('#msg-list').appendChild(row);
    scrollBottom();
  }

  /* ---------------- 发送 ---------------- */
  function setSending(on) {
    state.sending = on;
    $('#btn-send').disabled = on;
    $('#btn-image').disabled = on;
    $('#btn-doc').disabled = on;
    $('#btn-mic').disabled = on;
  }

  async function sendMessage(msg) {
    if (state.sending) return;
    setSending(true);
    try {
      await state.conversation.send(msg);
      renderMessage(msg); // 发送方本地即时显示（服务端回包后事件可能重复，用 seen 去重）
    } catch (e) {
      toast('发送失败：' + (e && e.message ? e.message : '网络错误'));
    } finally {
      setSending(false);
    }
  }

  async function sendText() {
    var input = $('#text-input');
    var text = input.value.trim();
    if (!text) return;
    if (text.length > 2000) { toast('消息过长'); return; }
    input.value = '';
    await sendMessage(new AV.TextMessage(text));
  }

  async function uploadAndSend(file, kind) {
    if (state.sending) return;
    setSending(true);
    showLoading(true);
    try {
      var avFile;
      if (kind === 'image' && file.type.indexOf('image') === 0) {
        var blob = await compressImage(file);
        avFile = new AV.File('img_' + Date.now() + '.jpg', blob);
      } else {
        var safeName = (file.name || 'file_' + Date.now()).replace(/[\\/:*?"<>|]/g, '_');
        avFile = new AV.File(safeName, file);
      }
      await avFile.save();
      if (kind === 'image') {
        await sendMessage(new AV.ImageMessage(avFile));
      } else {
        await sendMessage(new AV.FileMessage(avFile));
      }
    } catch (e) {
      toast('发送失败：' + (e && e.message ? e.message : '文件过大或网络错误'));
    } finally {
      showLoading(false);
      setSending(false);
    }
  }

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (file.size <= 1.5 * 1048576 && !file.type.match(/image\/(png|jpe?g|webp)/i)) { resolve(file); return; }
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var MAX = 1920;
        var w = img.width, h = img.height;
        if (w <= MAX && h <= MAX && file.size <= 1.5 * 1048576) { URL.revokeObjectURL(url); resolve(file); return; }
        var scale = Math.min(1, MAX / Math.max(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob); else reject(new Error('图片压缩失败'));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  /* ---------------- 语音 ---------------- */
  function micSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  async function toggleMic() {
    if (state.rec) { stopRec(); return; }
    if (!micSupported()) { toast('当前浏览器不支持录音（请用电脑版 Chrome / Edge）'); return; }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      var rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      state.recChunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size > 0) state.recChunks.push(e.data); };
      rec.onstop = function () {
        var blob = new Blob(state.recChunks, { type: rec.mimeType || 'audio/webm' });
        state.recStream.getTracks().forEach(function (t) { t.stop(); });
        state.rec = null;
        state.recStream = null;
        $('#btn-mic').classList.remove('recording');
        sendVoice(blob);
      };
      rec.start();
      state.rec = rec;
      state.recStream = stream;
      $('#btn-mic').classList.add('recording');
      toast('正在录音，点击停止并发送');
    } catch (e) {
      toast('无法使用麦克风，请检查浏览器权限');
    }
  }

  function stopRec() {
    try { state.rec.stop(); } catch (e) {}
  }

  async function sendVoice(blob) {
    if (state.sending) { toast('正在发送上一条消息'); return; }
    setSending(true);
    showLoading(true);
    try {
      var avFile = new AV.File('voice_' + Date.now() + '.webm', blob);
      await avFile.save();
      await sendMessage(new AV.AudioMessage(avFile));
    } catch (e) {
      toast('语音发送失败：' + (e && e.message ? e.message : '网络错误'));
    } finally {
      showLoading(false);
      setSending(false);
    }
  }

  /* ---------------- 界面事件 ---------------- */
  function bindUI() {
    // 标签页切换
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        $('#form-' + tab.dataset.tab).classList.add('active');
      });
    });

    $('#form-create').addEventListener('submit', async function (e) {
      e.preventDefault();
      var roomName = $('#create-room-name').value.trim();
      var nick = $('#create-nick').value.trim();
      if (!roomName) { toast('请填写房间名称'); return; }
      if (!nick) { toast('请填写昵称'); return; }
      showLoading(true);
      try { await createRoom(roomName, nick); }
      catch (err) { toast('创建失败：' + (err && err.message ? err.message : '网络错误')); }
      finally { showLoading(false); }
    });

    $('#form-join').addEventListener('submit', async function (e) {
      e.preventDefault();
      var code = $('#join-code').value.trim().toUpperCase();
      var nick = $('#join-nick').value.trim();
      if (!code) { toast('请填写邀请码'); return; }
      if (!nick) { toast('请填写昵称'); return; }
      showLoading(true);
      try { await joinRoom(code, nick); }
      catch (err) { toast(err && err.message ? err.message : '加入失败'); }
      finally { showLoading(false); }
    });

    $('#form-owner').addEventListener('submit', async function (e) {
      e.preventDefault();
      var code = $('#owner-code').value.trim().toUpperCase();
      var pass = $('#owner-pass').value.trim();
      var nick = $('#owner-nick').value.trim();
      if (!code) { toast('请填写邀请码'); return; }
      if (!pass) { toast('请填写房主凭证'); return; }
      showLoading(true);
      try { await ownerRejoin(code, pass, nick); }
      catch (err) { toast(err && err.message ? err.message : '进入失败'); }
      finally { showLoading(false); }
    });

    $('#btn-copy-code').addEventListener('click', function () {
      copyText($('#invite-code').textContent, '邀请码已复制');
    });
    $('#btn-copy-pass').addEventListener('click', function () {
      copyText($('#invite-pass').textContent, '房主凭证已复制');
    });
    $('#btn-go-chat').addEventListener('click', function () {
      showLoading(true);
      enterChat().catch(function (err) {
        toast('进入失败：' + (err && err.message ? err.message : '网络错误'));
      }).finally(function () { showLoading(false); });
    });

    $('#btn-send').addEventListener('click', sendText);
    $('#text-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
    });

    $('#btn-image').addEventListener('click', function () { $('#file-image').click(); });
    $('#file-image').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) uploadAndSend(f, 'image');
      this.value = '';
    });

    $('#btn-doc').addEventListener('click', function () { $('#file-doc').click(); });
    $('#file-doc').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) {
        if (f.size > 20 * 1048576) { toast('文件过大（服务上限约 10MB），发送可能失败'); }
        uploadAndSend(f, 'file');
      }
      this.value = '';
    });

    $('#btn-mic').addEventListener('click', toggleMic);

    $('#btn-leave').addEventListener('click', function () {
      try { if (state.client && state.client.close) state.client.close(); } catch (e) {}
      state.client = null;
      state.conversation = null;
      state.seen = new Set();
      showScreen('screen-enter');
      $('#my-rooms').hidden = readRooms().length === 0;
      renderMyRooms();
    });
  }

  function renderMyRooms() {
    var rooms = readRooms();
    var wrap = $('#my-rooms');
    var list = $('#my-rooms-list');
    if (rooms.length === 0) { wrap.hidden = true; return; }
    wrap.hidden = false;
    list.innerHTML = '';
    rooms.forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'room-item';
      item.innerHTML =
        '<span class="room-name">' + esc(r.roomName || '聊天室') + '</span>' +
        '<span class="room-code">' + esc(r.code) + '</span>' +
        '<button type="button" class="btn ghost small">进入</button>';
      item.querySelector('button').addEventListener('click', async function () {
        showLoading(true);
        try {
          await ownerRejoin(r.code, r.pass, '');
        } catch (err) {
          toast(err && err.message ? err.message : '进入失败');
        } finally { showLoading(false); }
      });
      list.appendChild(item);
    });
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    bindUI();
    if (!isConfigured()) { showConfigNeeded(); return; }
    try {
      initBackend();
    } catch (e) {
      toast('初始化失败：' + e.message);
      showConfigNeeded();
      return;
    }
    renderMyRooms();
    await restoreSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
