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
  };

  /* ===== 小工具 ===== */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  function showLoading(on, text) {
    if (on) {
      loadingEl.querySelector(".loading-box").textContent = text || "正在处理…";
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
        return res.json().catch(function () { return { ok: false, error: "响应解析失败 (" + res.status + ")" }; });
      })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || "请求失败");
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
        '<div class="room-name">' + esc(r.name || "未命名房间") + '</div>' +
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
      var name = $("create-room-name").value.trim() || "聊天室";
      var nick = $("create-nick").value.trim() || "房主";
      showLoading(true, "正在创建房间…");
      api("/api/room/create", { method: "POST" })
        .then(function (d) {
          showLoading(false);
          S.room = { code: d.code, roomId: d.roomId, role: "owner", token: d.ownerToken, name: name, myNick: nick, otherNick: "受邀者" };
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
      var nick = $("join-nick").value.trim() || "受邀者";
      if (!code) { toast("请输入邀请码"); return; }
      showLoading(true, "正在加入房间…");
      api("/api/room/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) })
        .then(function (d) {
          showLoading(false);
          S.room = { code: code, roomId: d.roomId, role: "guest", token: d.guestToken, name: "聊天室", myNick: nick, otherNick: "房主" };
          saveSession();
          saveRoom(code, "聊天室", "guest", d.guestToken);
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
      if (!code || !pass) { toast("请输入邀请码和房主凭证"); return; }
      showLoading(true, "正在验证…");
      api("/api/room/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code, ownerToken: pass }) })
        .then(function (d) {
          showLoading(false);
          var prev = loadSession();
          S.room = { code: code, roomId: d.roomId, role: "owner", token: pass, name: prev && prev.name || "聊天室", myNick: nick || (prev && prev.myNick) || "房主", otherNick: "受邀者" };
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
      copyText($("invite-code").textContent, "邀请码已复制");
    });
    $("btn-copy-pass").addEventListener("click", function () {
      copyText($("invite-pass").textContent, "房主凭证已复制");
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
    try { document.execCommand("copy"); toast(tip); } catch (e) { toast("复制失败，请手动复制"); }
    document.body.removeChild(ta);
  }

  /* ===== 房主回归（我的房间点击） ===== */
  function ownerRecover(code, token, name) {
    showLoading(true, "正在进入房间…");
    api("/api/room/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code, ownerToken: token }) })
      .then(function (d) {
        showLoading(false);
        var prev = loadSession();
        S.room = { code: code, roomId: d.roomId, role: "owner", token: token, name: name || "聊天室", myNick: (prev && prev.myNick) || "房主", otherNick: "受邀者" };
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
    $("chat-room-name").textContent = S.room.name || "聊天室";
    $("chat-meta").textContent = (S.room.role === "owner" ? "房主" : "受邀者") + " · " + esc(S.room.myNick || "");
    setStatus("connecting", "连接中…");
    showScreen("chat");
    connectWs();
  }

  function leaveChat() {
    S.closedByUser = true;
    closeWs();
    clearSession();
    S.room = null;
    msgList.innerHTML = "";
    msgEmpty.hidden = false;
    showScreen("enter");
    renderMyRooms();
  }

  function setStatus(mode, text) {
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
    setStatus("", "连接中…");
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
      setStatus("on", "已连接");
      loadHistory();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.seq) {
        S.lastSeq = Math.max(S.lastSeq, msg.seq);
        renderMessage(msg, false);
      }
    };
    ws.onclose = function () {
      S.wsReady = false;
      if (S.ws !== ws) return;
      setStatus("off", "连接断开，重连中…");
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
          if (m.seq > S.lastSeq) S.lastSeq = m.seq;
          renderMessage(m, false);
        });
        if (!msgs.length) {
          msgEmpty.hidden = false;
        }
      })
      .catch(function () {});
  }

  function sendText() {
    var input = $("text-input");
    var text = input.value.trim();
    if (!text) return;
    if (!S.wsReady) { toast("尚未连接，请稍候"); return; }
    try {
      S.ws.send(JSON.stringify({ type: "text", text: text }));
      input.value = "";
    } catch (e) {
      toast("发送失败");
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
        if (!d.ok) throw new Error("上传失败");
        return { id: id, name: name, mime: mime, size: blob.size };
      });
  }

  function sendMedia(type, blob, name, mime) {
    if (!S.wsReady) { toast("尚未连接，请稍候"); return; }
    showLoading(true, "正在上传…");
    uploadMedia(blob, name, mime)
      .then(function (media) {
        showLoading(false);
        S.ws.send(JSON.stringify({ type: type, media: media }));
      })
      .catch(function (err) {
        showLoading(false);
        toast(err.message || "上传失败");
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
          if (!blob) { reject(new Error("图片处理失败")); return; }
          resolve({ blob: blob, name: (needsJpeg ? "photo.jpg" : (file.name || "图片.png")), mime: mime });
        }, mime, 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("图片读取失败")); };
      img.src = url;
    });
  }

  /* ===== 语音录制（按住说话） ===== */
  var recorder = {
    mediaRecorder: null,
    chunks: [],
    timer: null,
  };

  function startRecord(e) {
    if (e) { e.preventDefault(); }
    if (recorder.mediaRecorder) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前浏览器不支持录音");
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        var mime = (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm")) ? "audio/webm" : "";
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
          var blob = new Blob(recorder.chunks, { type: mime || "audio/webm" });
          recorder.chunks = [];
          recorder.mediaRecorder = null;
          if (blob.size > 0) {
            sendMedia("voice", blob, "语音消息.webm", blob.type || "audio/webm");
          } else {
            toast("录音太短");
          }
        };
        mr.start();
        $("btn-mic").classList.add("recording");
        $("btn-mic").title = "松开结束";
        recorder.timer = setTimeout(stopRecord, 60000); // 最长 60 秒
      })
      .catch(function () {
        toast("无法使用麦克风（请允许权限）");
      });
  }

  function stopRecord() {
    if (recorder.mediaRecorder && recorder.mediaRecorder.state !== "inactive") {
      try { recorder.mediaRecorder.stop(); } catch (e) {}
    }
    if (recorder.timer) { clearTimeout(recorder.timer); recorder.timer = null; }
    $("btn-mic").classList.remove("recording");
    $("btn-mic").title = "按住说话";
  }

  /* ===== 消息渲染 ===== */
  function fileUrl(media) {
    return WORKER + "/api/file/" + encodeURIComponent(S.room.roomId) + "/" + encodeURIComponent(media.id);
  }

  function renderMessage(msg, prepend) {
    var isMine = msg.from === S.room.role;
    var row = document.createElement("div");
    row.className = "msg-row" + (isMine ? " mine" : "");
    var nick = isMine ? (S.room.myNick || "我") : (S.room.otherNick || "对方");
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
      img.alt = msg.media.name || "图片";
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
        '<span><div class="msg-file-name">' + esc(msg.media.name || "文件") + "</div>" +
        '<div class="msg-file-size">' + fmtSize(msg.media.size) + "</div></span>";
      bubble.appendChild(a);
    } else if (msg.type === "voice") {
      var audio = document.createElement("div");
      audio.className = "msg-audio";
      audio.innerHTML = '<audio controls preload="metadata" src="' + esc(fileUrl(msg.media)) + '"></audio>';
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
      showLoading(true, "正在处理图片…");
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
      if (f.size > MAX_FILE) { toast("文件超过 15MB 上限"); return; }
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

    // 上次会话自动续接
    var prev = loadSession();
    if (prev && prev.code && prev.roomId && prev.role && prev.token !== undefined) {
      var p = prev;
      if (p.role === "owner") {
        api("/api/room/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: p.code, ownerToken: p.token }) })
          .then(function (d) {
            S.room = { code: p.code, roomId: d.roomId, role: "owner", token: p.token, name: p.name || "聊天室", myNick: p.myNick || "房主", otherNick: p.otherNick || "受邀者" };
            saveSession();
            enterChat();
          })
          .catch(function () {
            clearSession();
          });
      } else {
        api("/api/room/guest-recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: p.code, guestToken: p.token }) })
          .then(function (d) {
            S.room = { code: p.code, roomId: d.roomId, role: "guest", token: p.token, name: p.name || "聊天室", myNick: p.myNick || "受邀者", otherNick: p.otherNick || "房主" };
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
