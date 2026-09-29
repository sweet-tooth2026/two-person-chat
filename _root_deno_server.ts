/**
 * 二人聊天室 · Deno Deploy 后端（deno_server.ts）
 *
 * 与 Cloudflare Worker 版同一套 API（前端无需改动）：
 *   POST /api/room/create        房主创建房间（返回邀请码 + ownerToken）
 *   POST /api/room/join          受邀者首次加入（返回 guestToken，防第三人）
 *   POST /api/room/guest-recover 受邀者凭 guestToken 重新进入
 *   POST /api/room/recover       房主凭 ownerToken 换设备回归
 *   GET  /api/room/state?code=   房间状态查询
 *   GET  /api/history?room=&limit= 聊天历史
 *   POST /api/send?room=&msgId=&name=&mime=  媒体上传（原始字节）
 *   GET  /api/file/<room>/<msgId> 媒体下载
 *   GET  /ws?room=&role=&token=   WebSocket 实时通道
 *   GET  /api/ping  /            探活
 *
 * 数据：Deno KV（免费 1GiB，单值上限 64KiB → 媒体分块 60KB/块）
 *   ["room", code]                房间元数据
 *   ["seq", room]                 消息序号
 *   ["m", room, seq]              消息
 *   ["file", room, msgId, "meta"] 媒体元数据
 *   ["file", room, msgId, idx]    媒体分块
 *
 * 实时：WebSocket + kv.watch（跨实例可靠推送，不依赖同实例内存）。
 */

const MAX_UPLOAD = 20 * 1024 * 1024;
const CHUNK = 60_000;

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

interface RoomMeta {
  roomId: string;
  ownerToken: string;
  guestToken: string | null;
  guestJoined: boolean;
  createdAt: number;
}

interface ChatMsg {
  seq: number;
  from: string;
  ts: number;
  type: string;
  text?: string;
  media?: { id: string; name: string; mime: string; size: number };
}

interface FileMeta {
  mime: string;
  name: string;
  size: number;
  chunks: number;
}

// Deno Deploy 上无此环境变量 → 使用平台托管 KV；本地测试时指定路径
const kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH"));

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function genCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

function genToken(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  return s;
}

async function getRoom(code: string): Promise<RoomMeta | null> {
  const e = await kv.get<RoomMeta>(["room", code]);
  return e.value ?? null;
}

// 原子递增消息序号（乐观锁 + 重试）
async function nextSeq(room: string): Promise<number> {
  for (;;) {
    const e = await kv.get<number>(["seq", room]);
    const next = (e.value ?? 0) + 1;
    const res = await kv.atomic().check(e).set(["seq", room], next).commit();
    if (res) return next;
  }
}

// 本实例连接表（跨实例由 kv.watch 兜底）
const conns = new Map<string, { owner: WebSocket | null; guest: WebSocket | null }>();

function setConn(room: string, role: string, ws: WebSocket): void {
  const m = conns.get(room) || { owner: null, guest: null };
  m[role as "owner" | "guest"] = ws;
  conns.set(room, m);
}

function dropConn(room: string, role: string, ws: WebSocket): void {
  const m = conns.get(room);
  if (m && m[role as "owner" | "guest"] === ws) {
    m[role as "owner" | "guest"] = null;
    if (!m.owner && !m.guest) conns.delete(room);
  }
}

/** kv.watch 推送循环：监视房间序号变化，把新消息推给本连接（含向自己回显，前端按 seq 去重） */
async function startWatcher(room: string, ws: WebSocket): Promise<void> {
  let lastSeq = (await kv.get<number>(["seq", room])).value ?? 0;
  for (;;) {
    try {
      const stream = kv.watch([["seq", room]]);
      for await (const batch of stream) {
        for (const e of batch) {
          const cur = (e.value as number) ?? 0;
          if (cur > lastSeq && ws.readyState === 1) {
            for (let s = lastSeq + 1; s <= cur; s++) {
              const m = (await kv.get<ChatMsg>(["m", room, s])).value;
              if (m && ws.readyState === 1) {
                try {
                  ws.send(JSON.stringify(m));
                } catch {
                  /* 单条失败忽略 */
                }
              }
            }
          }
          lastSeq = Math.max(lastSeq, cur);
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (ws.readyState !== 1) break;
  }
}

/** 处理收到的聊天消息：写 KV（持久化），返回消息对象；无效输入返回 null */
async function handleIncoming(room: string, role: string, data: Record<string, unknown>): Promise<ChatMsg | null> {
  const type = String(data.type || "text");
  const msg: ChatMsg = { seq: 0, from: role, ts: Date.now(), type };
  if (type === "text") {
    msg.text = String(data.text || "").slice(0, 2000);
    if (!msg.text) return null;
  } else if (type === "image" || type === "voice" || type === "file") {
    const media = (data.media || {}) as Record<string, unknown>;
    if (!media.id) return null;
    msg.media = {
      id: String(media.id).slice(0, 64),
      name: String(media.name || "file").slice(0, 120),
      mime: String(media.mime || "application/octet-stream").slice(0, 100),
      size: Number(media.size) || 0,
    };
  } else {
    return null;
  }
  const seq = await nextSeq(room);
  msg.seq = seq;
  await kv.set(["m", room, seq], msg);
  return msg;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // ===== 房主创建房间 =====
  if (path === "/api/room/create" && method === "POST") {
    const code = genCode();
    const ownerToken = genToken();
    const meta: RoomMeta = {
      roomId: code,
      ownerToken,
      guestToken: null,
      guestJoined: false,
      createdAt: Date.now(),
    };
    await kv.set(["room", code], meta);
    return json({ ok: true, code, ownerToken, roomId: code });
  }

  // ===== 受邀者首次加入 =====
  if (path === "/api/room/join" && method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const code = String(body.code || "").trim().toUpperCase();
    const meta = await getRoom(code);
    if (!meta) return json({ ok: false, error: "房间不存在或邀请码错误" }, 404);
    if (meta.guestJoined) return json({ ok: false, error: "房间已满（每位房主只可邀请 1 人）" }, 409);
    const guestToken = genToken();
    meta.guestToken = guestToken;
    meta.guestJoined = true;
    await kv.set(["room", code], meta);
    return json({ ok: true, roomId: meta.roomId, role: "guest", guestToken });
  }

  // ===== 受邀者凭 guestToken 重新进入 =====
  if (path === "/api/room/guest-recover" && method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const code = String(body.code || "").trim().toUpperCase();
    const guestToken = String(body.guestToken || "").trim();
    const meta = await getRoom(code);
    if (!meta) return json({ ok: false, error: "房间不存在或邀请码错误" }, 404);
    if (!meta.guestToken || meta.guestToken !== guestToken)
      return json({ ok: false, error: "受邀者凭证不正确（该房间已绑定第一位受邀者）" }, 403);
    return json({ ok: true, roomId: meta.roomId, role: "guest" });
  }

  // ===== 房主凭 ownerToken 换设备回归 =====
  if (path === "/api/room/recover" && method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const code = String(body.code || "").trim().toUpperCase();
    const ownerToken = String(body.ownerToken || "").trim();
    const meta = await getRoom(code);
    if (!meta) return json({ ok: false, error: "房间不存在或邀请码错误" }, 404);
    if (meta.ownerToken !== ownerToken) return json({ ok: false, error: "房主凭证不正确" }, 403);
    return json({ ok: true, roomId: meta.roomId, role: "owner" });
  }

  // ===== 房间状态 =====
  if (path === "/api/room/state" && method === "GET") {
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();
    const meta = await getRoom(code);
    if (!meta) return json({ ok: false, error: "房间不存在" }, 404);
    return json({ ok: true, roomId: meta.roomId, guestJoined: meta.guestJoined, createdAt: meta.createdAt });
  }

  // ===== 聊天历史 =====
  if (path === "/api/history" && method === "GET") {
    const room = (url.searchParams.get("room") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
    if (!room) return json({ ok: false, error: "缺少房间参数" }, 400);
    const all: ChatMsg[] = [];
    for await (const e of kv.list<ChatMsg>({ prefix: ["m", room] })) all.push(e.value);
    return json({ ok: true, messages: all.slice(-limit) });
  }

  // ===== 媒体上传（原始字节 → 分块写 KV） =====
  if (path === "/api/send" && method === "POST") {
    const room = (url.searchParams.get("room") || "").trim();
    const msgId = (url.searchParams.get("msgId") || "").trim();
    const name = url.searchParams.get("name") || "";
    const mime = url.searchParams.get("mime") || "application/octet-stream";
    if (!room || !msgId) return json({ ok: false, error: "缺少参数" }, 400);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD) return json({ ok: false, error: "文件过大（上限 20MB）" }, 413);
    const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK));
    const ops = kv.atomic();
    for (let i = 0; i < chunks; i++) {
      ops.set(["file", room, msgId, i], bytes.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    const fmeta: FileMeta = { mime, name, size: bytes.byteLength, chunks };
    ops.set(["file", room, msgId, "meta"], fmeta);
    await ops.commit();
    return json({ ok: true, msgId });
  }

  // ===== 媒体下载（分块重组） =====
  if (path.startsWith("/api/file/") && method === "GET") {
    const parts = path.split("/"); // /api/file/<room>/<msgId>
    const room = parts[3] || "";
    const msgId = parts[4] || "";
    const fmeta = (await kv.get<FileMeta>(["file", room, msgId, "meta"])).value;
    if (!fmeta) return json({ ok: false, error: "文件不存在" }, 404);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < fmeta.chunks; i++) {
      const c = (await kv.get<Uint8Array>(["file", room, msgId, i])).value;
      if (!c) return json({ ok: false, error: "文件不完整" }, 500);
      chunks.push(c);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    // 响应头只允许 ASCII：中文等非 ASCII 文件名会触发平台 500，这里转成下划线（不影响界面显示的文件名，那只来自消息数据）
    const safeName = String(fmeta.name || "file").replace(/["\\\r\n]/g, "").replace(/[^\x20-\x7e]/g, "_") || "file";
    return new Response(out, {
      headers: {
        "Content-Type": fmeta.mime || "application/octet-stream",
        "Content-Disposition": 'inline; filename="' + safeName + '"',
        "Cache-Control": "public, max-age=86400",
        ...CORS,
      },
    });
  }

  // ===== WebSocket 实时通道 =====
  if (path === "/ws" && method === "GET") {
    const room = (url.searchParams.get("room") || "").trim();
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token") || "";
    if (!room) return json({ ok: false, error: "缺少房间参数" }, 400);

    const meta = await getRoom(room);
    if (!meta) return json({ ok: false, error: "房间不存在" }, 404);

    if (role === "owner") {
      if (!meta.ownerToken || token !== meta.ownerToken) return json({ ok: false, error: "房主凭证错误" }, 403);
    } else if (role === "guest") {
      if (!meta.guestJoined || !meta.guestToken) return json({ ok: false, error: "房间尚未开放给受邀者" }, 403);
      if (token !== meta.guestToken) return json({ ok: false, error: "受邀者凭证错误" }, 403);
    } else {
      return json({ ok: false, error: "身份错误" }, 403);
    }

    const m = conns.get(room);
    if (m && m[role as "owner" | "guest"]) return json({ ok: false, error: "已在其他窗口连接" }, 409);

    const upgrade = Deno.upgradeWebSocket(req);
    const ws = upgrade.socket;
    setConn(room, role, ws);

    ws.onmessage = async (ev: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const msg = await handleIncoming(room, role, data);
      if (!msg) return;
      // 本实例内直接转发给对方（跨实例由各自 watch 循环负责）
      const cm = conns.get(room);
      if (cm) {
        for (const r of ["owner", "guest"]) {
          const s = cm[r as "owner" | "guest"];
          if (s && s !== ws && s.readyState === 1) {
            try {
              s.send(JSON.stringify(msg));
            } catch {
              /* 忽略 */
            }
          }
        }
      }
    };

    ws.onclose = () => dropConn(room, role, ws);
    ws.onerror = () => dropConn(room, role, ws);

    // 推送循环（含向本连接回显，前端按 seq 去重）
    startWatcher(room, ws);

    return upgrade.response;
  }

  // ===== 探活 =====
  if (path === "/" || path === "/api/ping") {
    return json({ ok: true, name: "two-person-chat-backend-deno" });
  }

  return json({ ok: false, error: "Not found" }, 404);
});
