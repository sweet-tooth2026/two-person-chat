/* =========================================================
 * 二人聊天室 · 界面语言（仅界面文字，不涉及聊天内容/昵称/房间名）
 * 支持：zh 中文 / en English
 * ========================================================= */
(function () {
  "use strict";

  var DICT = {
    zh: {
      app_name: "二人聊天室",
      app_subtitle: "只属于两个人的聊天空间 · 文字 / 图片 / 文件 / 语音",
      tab_create: "创建房间",
      tab_join: "加入房间",
      tab_owner: "房主回归",
      label_room_name: "房间名称",
      label_nick: "我的昵称",
      label_invite_code: "邀请码",
      label_owner_pass: "房主凭证",
      label_nick_optional: "昵称（可选）",
      ph_room_name: "例如：我和小明的秘密基地",
      ph_nick: "对方看到的名字",
      ph_invite_code: "对方发给你的邀请码",
      ph_owner_code: "创建时显示的邀请码",
      ph_owner_pass: "创建时显示的房主凭证",
      ph_owner_nick: "留空则沿用创建时昵称",
      btn_create: "创建房间",
      btn_join: "加入房间",
      btn_enter: "进入房间",
      hint_owner: "在其它设备重新进入自己创建的房间",
      my_rooms_title: "我创建过的房间",
      invite_title: "房间创建成功",
      invite_subtitle: "把下面的「邀请码」发给你想邀请的那个人。对方进入后，你们就可以开始聊天。",
      label_copy: "复制",
      hint_owner_pass: "房主凭证用于在其它设备重新进入房间，请自己保存，不要发给对方。",
      btn_go_chat: "进入聊天室",
      status_connecting: "连接中…",
      status_connected: "已连接",
      status_reconnecting: "连接断开，重连中…",
      btn_leave: "退出",
      msg_empty: "还没有消息<br>先打个招呼吧",
      ph_message: "输入消息，支持任何语言",
      title_send_image: "发送图片",
      title_send_doc: "发送文档",
      title_hold_talk: "按住说话",
      title_send: "发送",
      loading_connecting: "正在连接服务器…",
      loading_processing: "正在处理…",
      loading_creating: "正在创建房间…",
      loading_joining: "正在加入房间…",
      loading_verifying: "正在验证…",
      loading_entering: "正在进入房间…",
      loading_uploading: "正在上传…",
      loading_image: "正在处理图片…",
      role_owner: "房主",
      role_guest: "受邀者",
      default_room_name: "聊天室",
      default_owner_nick: "房主",
      default_guest_nick: "受邀者",
      default_me: "我",
      default_them: "对方",
      room_unnamed: "未命名房间",
      toast_copied_code: "邀请码已复制",
      toast_copied_pass: "房主凭证已复制",
      toast_copy_fail: "复制失败，请手动复制",
      toast_enter_code: "请输入邀请码",
      toast_enter_both: "请输入邀请码和房主凭证",
      toast_not_connected: "尚未连接，请稍候",
      toast_send_fail: "发送失败",
      toast_upload_fail: "上传失败",
      toast_no_mic: "当前浏览器不支持录音",
      toast_mic_denied: "无法使用麦克风（请允许权限）",
      toast_short_record: "录音太短",
      toast_file_too_large: "文件超过 15MB 上限",
      toast_img_fail: "图片处理失败",
      toast_img_read_fail: "图片读取失败",
      err_parse: "响应解析失败",
      err_request: "请求失败",
      label_image: "图片",
      label_file: "文件",
      lang_switched_zh: "已切换为中文",
      lang_switched_en: "已切换为 English",
      btn_lang_to_zh: "中文",
      btn_lang_to_en: "English",
      release_talk: "松开结束",
    },
    en: {
      app_name: "Two-Person Chat",
      app_subtitle: "A private space for two · Text / Image / File / Voice",
      tab_create: "Create Room",
      tab_join: "Join Room",
      tab_owner: "Owner Login",
      label_room_name: "Room Name",
      label_nick: "My Nickname",
      label_invite_code: "Invite Code",
      label_owner_pass: "Owner Key",
      label_nick_optional: "Nickname (Optional)",
      ph_room_name: "e.g. Our Secret Base",
      ph_nick: "Name shown to the other person",
      ph_invite_code: "The invite code from the other person",
      ph_owner_code: "The invite code shown when created",
      ph_owner_pass: "The owner key shown when created",
      ph_owner_nick: "Leave blank to keep the original",
      btn_create: "Create Room",
      btn_join: "Join Room",
      btn_enter: "Enter Room",
      hint_owner: "Re-enter a room you created from another device",
      my_rooms_title: "Rooms I Created",
      invite_title: "Room Created",
      invite_subtitle: "Send the invite code below to the person you want to invite. Once they join, you can start chatting.",
      label_copy: "Copy",
      hint_owner_pass: "Keep the owner key to re-enter the room from another device. Do not share it with anyone.",
      btn_go_chat: "Enter Chat",
      status_connecting: "Connecting…",
      status_connected: "Connected",
      status_reconnecting: "Disconnected, reconnecting…",
      btn_leave: "Leave",
      msg_empty: "No messages yet<br>Say hello first",
      ph_message: "Type a message in any language",
      title_send_image: "Send image",
      title_send_doc: "Send document",
      title_hold_talk: "Hold to talk",
      title_send: "Send",
      loading_connecting: "Connecting to server…",
      loading_processing: "Processing…",
      loading_creating: "Creating room…",
      loading_joining: "Joining room…",
      loading_verifying: "Verifying…",
      loading_entering: "Entering room…",
      loading_uploading: "Uploading…",
      loading_image: "Processing image…",
      role_owner: "Owner",
      role_guest: "Guest",
      default_room_name: "Chat Room",
      default_owner_nick: "Owner",
      default_guest_nick: "Guest",
      default_me: "Me",
      default_them: "Other",
      room_unnamed: "Unnamed Room",
      toast_copied_code: "Invite code copied",
      toast_copied_pass: "Owner key copied",
      toast_copy_fail: "Copy failed, please copy manually",
      toast_enter_code: "Please enter the invite code",
      toast_enter_both: "Please enter the invite code and owner key",
      toast_not_connected: "Not connected yet, please wait",
      toast_send_fail: "Send failed",
      toast_upload_fail: "Upload failed",
      toast_no_mic: "This browser does not support recording",
      toast_mic_denied: "Cannot use microphone (please allow permission)",
      toast_short_record: "Recording too short",
      toast_file_too_large: "File exceeds the 15MB limit",
      toast_img_fail: "Image processing failed",
      toast_img_read_fail: "Failed to read image",
      err_parse: "Invalid server response",
      err_request: "Request failed",
      label_image: "Image",
      label_file: "File",
      lang_switched_zh: "Switched to Chinese",
      lang_switched_en: "Switched to English",
      btn_lang_to_zh: "中文",
      btn_lang_to_en: "English",
      release_talk: "Release to finish",
    },
  };

  var KEY = "tpc-lang";

  function detect() {
    try {
      var l = (navigator.language || "zh").toLowerCase();
      return l.indexOf("zh") === 0 ? "zh" : "en";
    } catch (e) { return "zh"; }
  }

  function load() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === "zh" || v === "en") return v;
    } catch (e) {}
    return detect();
  }

  // 单一数据源：api.current 始终是当前语言，切换后立即同步
  var api = {
    current: load(),
  };

  function t(key) {
    var v = DICT[api.current] && DICT[api.current][key];
    if (v !== undefined) return v;
    var z = DICT.zh && DICT.zh[key];
    return z !== undefined ? z : key;
  }

  function apply() {
    document.documentElement.lang = api.current === "zh" ? "zh-CN" : "en";
    var title = document.querySelector("title");
    if (title) title.textContent = t("app_name");

    var btn = document.getElementById("btn-lang");
    if (btn) btn.textContent = api.current === "zh" ? t("btn_lang_to_en") : t("btn_lang_to_zh");

    var els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
      els[i].innerHTML = t(els[i].getAttribute("data-i18n"));
    }
    var phs = document.querySelectorAll("[data-i18n-placeholder]");
    for (var j = 0; j < phs.length; j++) {
      phs[j].setAttribute("placeholder", t(phs[j].getAttribute("data-i18n-placeholder")));
    }
    var tts = document.querySelectorAll("[data-i18n-title]");
    for (var k = 0; k < tts.length; k++) {
      tts[k].setAttribute("title", t(tts[k].getAttribute("data-i18n-title")));
    }

    try {
      document.dispatchEvent(new CustomEvent("tpc:langchange"));
    } catch (e) {}
  }

  function setLang(lang) {
    if (lang !== "zh" && lang !== "en") return;
    api.current = lang;
    try { localStorage.setItem(KEY, lang); } catch (e) {}
    apply();
  }

  api.t = t;
  api.set = setLang;
  api.apply = apply;
  window.I18N = api;

  apply();
})();
