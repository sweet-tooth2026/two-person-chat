/* =========================================================
 * 二人聊天室 · 前端逻辑
 * 后端：Cloudflare Worker（WebSocket 实时 + KV 媒体存储）
 * 依赖：js/config.js（CONFIG.WORKER_URL）
 * ========================================================= */

(function () {
  "use strict";

  var WORKER = (typeof CONFIG !== "undefined" && CONFIG.WORKER_URL) || "";
  var WS_BASE = WORKER.replace(/^http/, "ws");
  var MAX_FILE = 15 * 1024 * 1024; // 文档/文件客户端上限 15MB
  var SESSION_KEY = "tpc-session-v2";
  var ROOMS_KEY = "tpc-rooms-v2";

  /* ===== DOM ===== */
  function $(id) { return document.getElementById(id); }

  var screenEnter = $("screen-enter"),
    screenInvite = $("screen-invite"),
    screenChat = $("screen-chat"),
    toastEl = $("toast"),
    loadingEl = $("loading"),
    msgList = $("msg-list"),
    msgEmpty = $("msg-empty");

  /* ===== 全局状态 ===== */
  var S = {
    room: null,       // { code, roomId, role, token, name, myNick, otherNick }
    ws: null,
    wsReady: false,
    lastSeq: 0,
    reconnectTimer: null,
    reconnectDelay: 1000,
    closedByUser: false,
    pollTimer: null,
    localSeq: 0,      // 本地乐观回显用的临时序号
    localMsgs: [],    // 尚未被服务器确认的本地消息
    statusMode: "",   // 连接状态："" | "connecting" | "on" | "off"
  };

  /* ===== 小工具 ===== */
  function t(key) {
    return (window.I18N && I18N.t) ? I18N.t(key) : key;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  function showLoading(on, text) {
    if (on) {
      loadingEl.querySelector(".loading-box").textContent = text || t("loading_processing");
      loadingEl.hidden = false;
    } else {
      loadingEl.hidden = true;
    }
  }

  function showScreen(name) {
    screenEnter.hidden = name !== "enter";
    screenInvite.hidden = name !== "invite";
    screenChat.hidden = name !== "chat";
    if (name === "chat") {
      document.body.classList.add("in-chat");
    } else {
      document.body.classList.remove("in-chat");
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p(x) { return x < 10 ? "0" + x : "" + x; }
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function uid() {
    var s = "";
    for (var i = 0; i < 24; i++) s += "abcdef0123456789"[Math.floor(Math.random() * 16)];
    return s + Date.now().toString(36);
  }

  /* ===== API ===== */
  function api(path, opts) {
    opts = opts || {};
    return fetch(WORKER + path, opts)
      .then(function (res) {
        return res.json().catch(function () { return { ok: false, error: t("err_parse") + " (" + res.status + ")" }; });
      })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || t("err_request"));
        return data;
      });
  }

  /* ===== 本地记忆 ===== */
  function saveSession() {
    if (!S.room) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(S.room));
    } catch (e) {}
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function saveRoom(code, name, role, token) {
    try {
      var rooms = loadRooms();
      var item = { code: code, name: name, role: role, token: token, at: Date.now() };
      rooms = rooms.filter(function (r) { return r.code !== code; });
      rooms.unshift(item);
      rooms = rooms.slice(0, 8);
      localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
    } catch (e) {}
  }

  function loadRooms() {
    try {
      var raw = localStorage.getItem(ROOMS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  /* ===== 进入页 ===== */
  function initEnterTabs() {
    var tabs = document.querySelectorAll(".tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        ["form-create", "form-join", "form-owner"].forEach(function (id) {
          $(id).classList.remove("active");
        });
        $(t.dataset.tab === "create" ? "form-create" : t.dataset.tab === "join" ? "form-join" : "form-owner")
          .classList.add("active");
      });
    });
  }

  function renderMyRooms() {
    var wrap = $("my-rooms");
    var list = $("my-rooms-list");
    var rooms = loadRooms();
    if (!rooms.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    list.innerHTML = "";
    rooms.forEach(function (r) {
      var item = document.createElement("div");
      item.className = "room-item";
      item.innerHTML =
        '<div class="room-name">' + esc(r.name || t("room_unnamed")) + '</div>' +
        '<div class="room-code">' + esc(r.code) + "</div>";
      item.addEventListener("click", function () {
        if (r.role === "owner" && r.token) {
          ownerRecover(r.code, r.token, r.name);
        } else {
          $("join-code").value = r.code;
          document.querySelector('[data-tab="join"]').click();
          $("join-nick").focus();
        }
      });
      list.appendChild(item);
    });
  }

  function initEnterForms() {
    $("form-create").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = $("create-room-name").value.trim() || t("default_room_name");
      var nick = $("create-nick").value.trim() || t("default_owner_nick");
      showLoading(true, t("loading_creating"));
      api("/api/room/create", { method: "POST" })
        .then(function (d) {
          showLoading(false);
          S.room = { code: d.code, roomId: d.roomId, role: "owner", token: d.ownerToken, name: name, myNick: nick, otherNick: t("role_guest") };
          saveSession();
          saveRoom(d.code, name, "owner", d.ownerToken);
          $("invite-code").textContent = d.code;
          $("invite-pass").textContent = d.ownerToken;
          showScreen("invite");
        })
        .catch(function (err) {
          showLoading(false);
          toast(err.message);
        });
    });

    $("form-join").addEventListener("submit", function (e) {
      e.preventDefault();
      var code = $("join-code").value.trim().toUpperCase();
      var nick = $("join-nick").value.trim() || t("default_guest_nick");
      if (!code) { toast(t("toast_enter_code")); return; }
      showLoading(true, t("loading_joining"));
      api("/api/room/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) })
        .then(function (d) {
          showLoading(false);
          S.room = { code: code, roomId: d.roomId, role: "guest", token: d.guestToken, name: t("default_room_name"), myNick: nick, otherNick: t("role_owner") };
          saveSession();
          saveRoom(code, t("default_room_name"), "guest", d.guestToken);
          enterChat();
        })
        .catch(function (err) {
          showLoading(false);
          toast(err.message);
        });
    });

    $("form-owner").addEventListener("submit", function (e) {
      e.preventDefault();
      var code = $("owner-code").value.trim().toUpperCase();
      var pass = $("owner-pass").value.trim();
      var nick = $("owner-nick").value.trim();
      if (!code || !pass) { toast(t("toast_enter_both")); return; }
      showLoading(true, t("loading_verifying"));
      api("/api/room/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code, ownerToken: pass }) })
        .then(function (d) {
          showLoading(false);
          var prev = loadSession();
          S.room = { code: code, roomId: d.roomId, role: "owner", token: pass, name: prev && prev.name || t("default_room_name"), myNick: nick || (prev && prev.myNick) || t("default_owner_nick"), otherNick: t("role_guest") };
          saveSession();
          saveRoom(code, S.room.name, "owner", pass);
          enterChat();
        })
        .catch(function (err) {
          showLoading(false);
          toast(err.message);
        });
    });

    $("btn-copy-code").addEventListener("click", function () {
      copyText($("invite-code").textContent, t("toast_copied_code"));
    });
    $("btn-copy-pass").addEventListener("click", function () {
      copyText($("invite-pass").textContent, t("toast_copied_pass"));
    });
    $("btn-go-chat").addEventListener("click", enterChat);
    $("btn-leave").addEventListener("click", leaveChat);
  }

  function copyText(text, tip) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(tip); }).catch(function () { fallbackCopy(text, tip); });
    } else {
      fallbackCopy(text, tip);
    }
  }

  function fallbackCopy(text, tip) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast(tip); } catch (e) { toast(t("toast_copy_fail")); }
    document.body.removeChild(ta);
  }

  /* ===== 房主回归（我的房间点击） ===== */
  function ownerRecover(code, token, name) {
    showLoading(true, t("loading_entering"));
    api("/api/room/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code, ownerToken: token }) })
      .then(function (d) {
        showLoading(false);
        var prev = loadSession();
        S.room = { code: code, roomId: d.roomId, role: "owner", token: token, name: name || t("default_room_name"), myNick: (prev && prev.myNick) || t("default_owner_nick"), otherNick: t("role_guest") };
        saveSession();
        enterChat();
      })
      .catch(function (err) {
        showLoading(false);
        toast(err.message);
      });
  }

  /* ===== 聊天 ===== */
  function enterChat() {
    if (!S.room) return;
    S.localMsgs = [];
    refreshChatChrome();
    setStatus("connecting", t("status_connecting"));
    showScreen("chat");
    connectWs();
    startPolling();
  }

  // 语言切换后刷新界面文案（不碰聊天记录/昵称/房间名）
  function refreshChatChrome() {
    if (!S.room) return;
    var n = $("chat-room-name");
    if (n) n.textContent = S.room.name || t("default_room_name");
    var m = $("chat-meta");
    if (m) m.textContent = (S.room.role === "owner" ? t("role_owner") : t("role_guest")) + " · " + esc(S.room.myNick || "");
    if (S.statusMode) {
      var key = S.statusMode === "on" ? "status_connected" : S.statusMode === "off" ? "status_reconnecting" : "status_connecting";
      setStatus(S.statusMode, t(key));
    }
    var mic = $("btn-mic");
    if (mic && !recorder.mediaRecorder) mic.title = t("title_hold_talk");
  }

  function leaveChat() {
    S.closedByUser = true;
    stopPolling();
    closeWs();
    clearSession();
    S.room = null;
    msgList.innerHTML = "";
    msgEmpty.hidden = false;
    showScreen("enter");
    renderMyRooms();
  }

  function setStatus(mode, text) {
    S.statusMode = mode;
    var dot = $("status-dot");
    dot.className = "dot" + (mode === "on" ? " on" : mode === "off" ? " off" : "");
    $("status-text").textContent = text;
  }

  function wsUrl() {
    return WS_BASE + "/ws?room=" + encodeURIComponent(S.room.roomId) +
      "&role=" + encodeURIComponent(S.room.role) +
      "&token=" + encodeURIComponent(S.room.token || "");
  }

  function connectWs() {
    if (!S.room) return;
    if (S.closedByUser) return;
    closeWs();
    setStatus("", t("status_connecting"));
    var ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    S.ws = ws;
    ws.onopen = function () {
      S.wsReady = true;
      S.reconnectDelay = 1000;
      setStatus("on", t("status_connected"));
      loadHistory();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.seq) {
        // 按 seq 去重：只有比已见序号更新的消息才渲染
        if (msg.seq > S.lastSeq) {
          S.lastSeq = msg.seq;
          removeLocalMatch(msg);
          renderMessage(msg, false);
        }
      }
    };
    ws.onclose = function () {
      S.wsReady = false;
      if (S.ws !== ws) return;
      setStatus("off", t("status_reconnecting"));
      scheduleReconnect();
    };
    ws.onerror = function () {
      try { ws.close(); } catch (e) {}
    };
  }

  function closeWs() {
    if (S.ws) {
      try { S.ws.onclose = null; S.ws.close(); } catch (e) {}
      S.ws = null;
    }
    S.wsReady = false;
    if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
  }

  function scheduleReconnect() {
    if (!S.room || S.closedByUser) return;
    if (S.reconnectTimer) return;
    var delay = S.reconnectDelay;
    S.reconnectDelay = Math.min(S.reconnectDelay * 2, 10000);
    S.reconnectTimer = setTimeout(function () {
      S.reconnectTimer = null;
      if (S.room && !S.closedByUser) connectWs();
    }, delay);
  }

  function loadHistory() {
    api("/api/history?room=" + encodeURIComponent(S.room.roomId) + "&limit=100")
      .then(function (d) {
        var msgs = d.messages || [];
        msgs.forEach(function (m) {
          if (m.seq > S.lastSeq) {
            S.lastSeq = m.seq;
            removeLocalMatch(m);
            renderMessage(m, false);
          }
        });
        if (!msgs.length) {
          msgEmpty.hidden = false;
        }
      })
      .catch(function () {});
  }

  /* ===== 自动补拉：实时通道不可靠时兜底，保证消息不靠刷新就能出现 ===== */
  function startPolling() {
    stopPolling();
    S.pollTimer = setInterval(pollHistory, 15000);
  }

  function stopPolling() {
    if (S.pollTimer) {
      clearInterval(S.pollTimer);
      S.pollTimer = null;
    }
  }

  function pollHistory() {
    if (!S.room || S.closedByUser) return;
    api("/api/history?room=" + encodeURIComponent(S.room.roomId) + "&limit=100")
      .then(function (d) {
        var msgs = d.messages || [];
        var added = false;
        msgs.forEach(function (m) {
          if (m.seq > S.lastSeq) {
            S.lastSeq = m.seq;
            removeLocalMatch(m);
            renderMessage(m, false);
            added = true;
          }
        });
        if (added) scrollBottom();
      })
      .catch(function () {});
  }

  /* ===== 本地乐观回显 + 服务器确认后去重 ===== */
  function renderLocalEcho(msg) {
    S.localSeq += 1;
    var clientSeq = S.localSeq;
    S.localMsgs.push({
      clientSeq: clientSeq,
      match: msg,
    });
    var row = renderMessage(msg, false);
    if (row) row.setAttribute("data-client-seq", String(clientSeq));
  }

  function removeLocalMatch(serverMsg) {
    if (!S.localMsgs.length) return;
    var hit = null;
    for (var i = 0; i < S.localMsgs.length; i++) {
      var lm = S.localMsgs[i];
      var m = lm.match;
      var same = false;
      if (serverMsg.media && m.media && serverMsg.media.id === m.media.id) {
        same = true;
      } else if (m.type === "text" && serverMsg.type === "text" &&
                 serverMsg.from === m.from && serverMsg.text === m.text &&
                 Math.abs(serverMsg.ts - m.ts) < 20000) {
        same = true;
      }
      if (same) { hit = lm; break; }
    }
    if (hit) {
      S.localMsgs.splice(S.localMsgs.indexOf(hit), 1);
      var rows = msgList.querySelectorAll('[data-client-seq="' + hit.clientSeq + '"]');
      for (var j = 0; j < rows.length; j++) rows[j].remove();
    }
  }

  function sendText() {
    var input = $("text-input");
    var text = input.value.trim();
    if (!text) return;
    if (!S.wsReady) { toast(t("toast_not_connected")); return; }
    try {
      S.ws.send(JSON.stringify({ type: "text", text: text }));
      input.value = "";
      // 本地立即显示（服务器确认后自动去重替换）
      renderLocalEcho({ from: S.room.role, ts: Date.now(), type: "text", text: text });
    } catch (e) {
      toast(t("toast_send_fail"));
    }
  }

  function uploadMedia(blob, name, mime) {
    var id = uid();
    return fetch(WORKER + "/api/send?room=" + encodeURIComponent(S.room.roomId) +
      "&msgId=" + id + "&name=" + encodeURIComponent(name) + "&mime=" + encodeURIComponent(mime), {
        method: "POST",
        body: blob,
      })
      .then(function (res) {
        return res.json().catch(function () { return { ok: false }; });
      })
      .then(function (d) {
        if (!d.ok) throw new Error(t("toast_upload_fail"));
        return { id: id, name: name, mime: mime, size: blob.size };
      });
  }

  function sendMedia(type, blob, name, mime) {
    if (!S.wsReady) { toast(t("toast_not_connected")); return; }
    showLoading(true, t("loading_uploading"));
    uploadMedia(blob, name, mime)
      .then(function (media) {
        showLoading(false);
        S.ws.send(JSON.stringify({ type: type, media: media }));
        // 本地立即显示（服务器确认后按 media.id 去重替换）
        renderLocalEcho({ from: S.room.role, ts: Date.now(), type: type, media: media });
      })
      .catch(function (err) {
        showLoading(false);
        toast(err.message || t("toast_upload_fail"));
      });
  }

  /* ===== 图片压缩 ===== */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var MAX = 1920;
        var w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          var r = Math.min(MAX / w, MAX / h);
          w = Math.round(w * r);
          h = Math.round(h * r);
        }
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var needsJpeg = file.size > 1.5 * 1024 * 1024;
        var mime = needsJpeg ? "image/jpeg" : (file.type || "image/png");
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error(t("toast_img_fail"))); return; }
          resolve({ blob: blob, name: (needsJpeg ? "photo.jpg" : (file.name || "图片.png")), mime: mime });
        }, mime, 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(t("toast_img_read_fail"))); };
      img.src = url;
    });
  }

  /* ===== 语音录制（按住说话） ===== */
  var recorder = {
    mediaRecorder: null,
    chunks: [],
    timer: null,
  };

  // 优先选 MP4（自带时长信息，播放正常）；不支持才退回 webm
  function pickAudioMime() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    var cands = ["audio/mp4;codecs=opus", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    for (var i = 0; i < cands.length; i++) {
      if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    }
    return "";
  }

  function startRecord(e) {
    if (e) { e.preventDefault(); }
    if (recorder.mediaRecorder) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(t("toast_no_mic"));
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        var mime = pickAudioMime();
        var mr;
        try {
          mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        } catch (err) {
          mr = new MediaRecorder(stream);
        }
        recorder.mediaRecorder = mr;
        recorder.chunks = [];
        mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) recorder.chunks.push(ev.data); };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var usedMime = mime || (mr.mimeType || "audio/webm");
          var blob = new Blob(recorder.chunks, { type: usedMime });
          recorder.chunks = [];
          recorder.mediaRecorder = null;
          if (blob.size > 0) {
            var isMp4 = usedMime.indexOf("mp4") >= 0;
            sendMedia("voice", blob, isMp4 ? "语音消息.m4a" : "语音消息.webm", blob.type || usedMime);
          } else {
            toast(t("toast_short_record"));
          }
        };
        mr.start();
        $("btn-mic").classList.add("recording");
        $("btn-mic").title = t("release_talk");
        recorder.timer = setTimeout(stopRecord, 60000); // 最长 60 秒
      })
      .catch(function () {
        toast(t("toast_mic_denied"));
      });
  }

  function stopRecord() {
    if (recorder.mediaRecorder && recorder.mediaRecorder.state !== "inactive") {
      try { recorder.mediaRecorder.stop(); } catch (e) {}
    }
    if (recorder.timer) { clearTimeout(recorder.timer); recorder.timer = null; }
    $("btn-mic").classList.remove("recording");
    $("btn-mic").title = t("title_hold_talk");
  }

  /* ===== 消息渲染 ===== */
  function fileUrl(media) {
    return WORKER + "/api/file/" + encodeURIComponent(S.room.roomId) + "/" + encodeURIComponent(media.id);
  }

  function renderMessage(msg, prepend) {
    var isMine = msg.from === S.room.role;
    var row = document.createElement("div");
    row.className = "msg-row" + (isMine ? " mine" : "");
    var nick = isMine ? (S.room.myNick || t("default_me")) : (S.room.otherNick || t("default_them"));
    var avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = (nick || "?").slice(0, 1);
    var body = document.createElement("div");
    body.className = "msg-body";

    var bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    if (msg.type === "text") {
      bubble.textContent = msg.text || "";
    } else if (msg.type === "image") {
      var img = document.createElement("img");
      img.className = "msg-img";
      img.src = fileUrl(msg.media);
      img.alt = msg.media.name || t("label_image");
      img.addEventListener("click", function () {
        window.open(img.src, "_blank");
      });
      bubble.appendChild(img);
    } else if (msg.type === "file") {
      var a = document.createElement("a");
      a.className = "msg-file-card";
      a.href = fileUrl(msg.media);
      a.target = "_blank";
      a.rel = "noopener";
      a.innerHTML =
        '<svg class="msg-file-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v4h4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
        '<span><div class="msg-file-name">' + esc(msg.media.name || t("label_file")) + "</div>" +
        '<div class="msg-file-size">' + fmtSize(msg.media.size) + "</div></span>";
      bubble.appendChild(a);
    } else if (msg.type === "voice") {
      var audio = document.createElement("div");
      audio.className = "msg-audio";
      // preload=auto：让播放器完整下载音频，避免无时长元数据的 webm 显示 0:00
      audio.innerHTML = '<audio controls preload="auto" src="' + esc(fileUrl(msg.media)) + '"></audio>';
      bubble.appendChild(audio);
    } else {
      return;
    }

    var sender = document.createElement("div");
    sender.className = "msg-sender";
    sender.textContent = nick;
    var time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = fmtTime(msg.ts);

    body.appendChild(sender);
    body.appendChild(bubble);
    body.appendChild(time);
    row.appendChild(avatar);
    row.appendChild(body);

    if (prepend) {
      msgList.insertBefore(row, msgList.firstChild);
    } else {
      msgList.appendChild(row);
    }
    msgEmpty.hidden = true;
    if (!prepend) scrollBottom();
    return row;
  }

  function scrollBottom() {
    msgList.scrollTop = msgList.scrollHeight;
  }

  /* ===== 输入栏事件 ===== */
  function initChatInput() {
    $("btn-send").addEventListener("click", sendText);
    $("text-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendText();
      }
    });

    $("btn-image").addEventListener("click", function () { $("file-image").click(); });
    $("file-image").addEventListener("change", function () {
      var f = this.files && this.files[0];
      this.value = "";
      if (!f) return;
      showLoading(true, t("loading_image"));
      compressImage(f)
        .then(function (r) {
          showLoading(false);
          sendMedia("image", r.blob, r.name, r.mime);
        })
        .catch(function (err) {
          showLoading(false);
          toast(err.message);
        });
    });

    $("btn-doc").addEventListener("click", function () { $("file-doc").click(); });
    $("file-doc").addEventListener("change", function () {
      var f = this.files && this.files[0];
      this.value = "";
      if (!f) return;
      if (f.size > MAX_FILE) { toast(t("toast_file_too_large")); return; }
      sendMedia("file", f, f.name, f.type || "application/octet-stream");
    });

    var mic = $("btn-mic");
    mic.addEventListener("pointerdown", startRecord);
    mic.addEventListener("pointerup", stopRecord);
    mic.addEventListener("pointercancel", stopRecord);
    mic.addEventListener("pointerleave", function (e) {
      if (recorder.mediaRecorder && e.pointerType === "mouse" && !e.buttons) stopRecord();
    });
    mic.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }

  /* ===== 启动 ===== */
  function boot() {
    if (!WORKER || WORKER.indexOf("REPLACE_") === 0) {
      document.body.innerHTML =
        '<div style="max-width:460px;margin:80px auto;padding:0 20px;font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif">' +
        "<h2 style=\"font-size:20px\">尚未配置后端</h2>" +
        "<p style=\"color:#5c6b6b;font-size:14px;line-height:1.8\">网站的后端地址（Cloudflare Worker）还没有填写。" +
        "部署后端后，把地址填入 <code>js/config.js</code> 里的 <code>CONFIG.WORKER_URL</code> 并重新发布即可。</p>" +
        "</div>";
      return;
    }

    initEnterTabs();
    initEnterForms();
    initChatInput();
    renderMyRooms();

    // 语言切换按钮
    var langBtn = $("btn-lang");
    if (langBtn && window.I18N) {
      langBtn.addEventListener("click", function () {
        var next = I18N.current === "zh" ? "en" : "zh";
        I18N.set(next);
        toast(I18N.t(next === "zh" ? "lang_switched_zh" : "lang_switched_en"));
      });
    }
    // 语言切换后刷新动态界面文字（聊天记录/昵称/房间名不动）
    document.addEventListener("tpc:langchange", function () {
      refreshChatChrome();
    });

    // 上次会话自动续接
    var prev = loadSession();
    if (prev && prev.code && prev.roomId && prev.role && prev.token !== undefined) {
      var p = prev;
      if (p.role === "owner") {
        api("/api/room/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: p.code, ownerToken: p.token }) })
          .then(function (d) {
            S.room = { code: p.code, roomId: d.roomId, role: "owner", token: p.token, name: p.name || t("default_room_name"), myNick: p.myNick || t("default_owner_nick"), otherNick: p.otherNick || t("role_guest") };
            saveSession();
            enterChat();
          })
          .catch(function () {
            clearSession();
          });
      } else {
        api("/api/room/guest-recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: p.code, guestToken: p.token }) })
          .then(function (d) {
            S.room = { code: p.code, roomId: d.roomId, role: "guest", token: p.token, name: p.name || t("default_room_name"), myNick: p.myNick || t("default_guest_nick"), otherNick: p.otherNick || t("role_owner") };
            saveSession();
            enterChat();
          })
          .catch(function () {
            clearSession();
          });
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
