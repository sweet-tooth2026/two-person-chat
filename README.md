# 二人聊天室

一个只属于两个人的私密聊天网页：房主创建房间，把「邀请码」发给想邀请的人，对方凭邀请码加入后即可聊天。

- 文字消息，支持任何语言（Unicode 文本）
- 图片消息（自动压缩后发送）
- 文件 / 文档消息
- 语音消息（浏览器录音，发送后可播放）
- 每个房间最多 2 人：房主 + 1 位受邀者
- 房主凭证：房主在其它设备可凭「邀请码 + 房主凭证」重新进入房间

## 技术架构

- 前端：静态网页（原生 HTML/CSS/JS），托管在 GitHub Pages
- 后端：Deno Deploy（免费版）
  - 数据存储：Deno KV（房间元数据、消息记录、媒体分块）
  - 即时通信：WebSocket 实时收发 + 云端历史
  - 媒体：图片 / 文件 / 语音按 60KB 分块存入 KV，上限 20MB

## 目录结构

```
two-person-chat/
├── index.html          # 页面
├── css/style.css       # 样式
├── js/config.js        # 后端地址配置
├── js/app.js           # 前端逻辑
├── deno.json           # Deno Deploy 入口配置
├── deno_server.ts      # 后端程序（Deno Deploy）
└── README.md
```

## 部署步骤

### 1. 前端（GitHub Pages）

1. 把本目录全部文件提交到 GitHub 仓库 main 分支。
2. 仓库 Settings → Pages → Source 选「Deploy from a branch」→ 分支 `main`、目录 `/ (root)` → Save。
3. 网站地址：`https://<你的用户名>.github.io/two-person-chat/`

### 2. 后端（Deno Deploy，免费）

1. 打开 https://dash.deno.com 注册（可用 GitHub 账号登录）。
2. 新建应用（New Project）→ 选择本项目仓库 → 应用类型选 **Dynamic App**，入口文件填 `deno_server.ts`（或保证仓库根目录有 deno.json，其中 `deploy.entrypoint = "deno_server.ts"`）。
3. 创建后进入 **Databases** → Deno KV → **+ Attach** → **Provision Deno KV**，给应用关联一个 KV 数据库（后端启动需要）。
4. 在 **Builds** 页触发一次部署（Deploy Default Branch / Retry Build），等待成功。
5. 应用地址：`https://<应用名>.<用户名>.deno.net`
6. 编辑 `js/config.js`，把 `WORKER_URL` 改成你的 Deno 应用地址，重新提交到仓库。

### 3. 使用

- **创建房间**：填房间名 + 昵称 → 生成「邀请码」和「房主凭证」→ 把邀请码发给对方。
- **加入房间**：对方打开同一网址，填邀请码 + 昵称即可进入。
- **房主回归**：换设备时选「房主回归」，填邀请码 + 房主凭证。

## 安全说明（重要）

- 邀请码即通行证：知道邀请码的人就能加入该房间（每个房间限 2 人，先到先得）。
- 房主凭证相当于房间管理口令：请自己保存，不要发给对方。
- 隐私由邀请码的随机性保证（10 位无歧义字符，不可枚举）。

## 已知限制

- 视频通话未实现（已规划为后续功能）。
- 文件上限 20MB（超出会被拒绝）。
- 免费额度：Deno Deploy 免费版每月 100 万请求、KV 1GB；普通聊天远用不完。
