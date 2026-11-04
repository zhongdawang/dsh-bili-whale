# 直播间弹幕助手（独立版）

从 `dsh-bili-whale` 里抽出来的 B 站直播间弹幕助手。**不依赖 DSH、不依赖 npm 包**，只做四件事：

- 进入直播间（`roomEntryAction` + 连弹幕服务器）
- 实时收弹幕 / 进场 / 礼物事件
- 按规则回复（只回主人 / 被 @ / 关键词 / 全部）
- 可选：接 OpenAI 兼容接口，让模型生成回复

## 网页控制台（推荐）

不想手改 JSON、也不想记命令，直接开控制台：

```bash
node src/cli.mjs ui
# 浏览器打开 http://127.0.0.1:7788
```

控制台里可以：

- 填房间号、互动方式、关键词、限速、过滤规则
- **扫码登录 B 站**（手机 App 扫一下，自动写入 SESSDATA / bili_jct / buvid3）
- 也可以手动填 SESSDATA / bili_jct / buvid3 和 LLM Key（保存后不回显）
- LLM 服务商预设（DeepSeek / OpenAI / 自定义）+ 模型选择 + 一键拉取模型列表
- 测试连接、测试 LLM、模拟一条弹幕看会怎么回
- 一键启动 dry-run / 真实发送、停止
- 看实时日志

默认只监听 `127.0.0.1`。换端口：`--port 7789`；不要随便用 `--host 0.0.0.0`，那会让同网段的人也能打开控制台。

## 快速开始（命令行）

要求 **Node 22+**（收弹幕用到了全局 `WebSocket`）。

```bash
cd live-assistant
cp config.example.json config.json
# 1. 改 config.json 里的 room、aliases、triggers
# 2. 准备凭据：~/.bili-ai/credentials.json（和原项目共用）
#    或环境变量 BILI_SESSDATA / BILI_JCT / BILI_BUVID3
# 3. 先预检
node src/cli.mjs pre --room 6

# 4. 默认 dry-run：只看不发
node src/cli.mjs start --room 6 --verbose

# 5. 确认规则没问题后，真发
node src/cli.mjs start --room 6 --go
```

## 凭据

### 方式一：扫码（推荐）

打开控制台 → 「凭据 / 密钥」→「扫码登录」→ 手机 B 站 App 扫码确认。 登录成功后会自动写入 `~/.bili-ai/credentials.json`，不用手动抄 Cookie。

二维码 3 分钟有效；过期点「重新生成」。扫码只保存 `SESSDATA` / `bili_jct` / `buvid3`，不会保存密码。

### 方式二：手动填

`SESSDATA`、`bili_jct`、`buvid3` 三个值。`SESSDATA` 是 HttpOnly，必须在浏览器 F12 → Application → Cookies → `https://www.bilibili.com` 里手动复制，`document.cookie` 读不到。

查找顺序：

1. `--credentials <文件>`
2. 环境变量 `BILI_SESSDATA` / `BILI_JCT` / `BILI_BUVID3`
3. `~/.bili-ai/credentials.json`
4. `./credentials.json`

只读命令（`pre` / `history` / `start` 的 dry-run）没有凭据也能跑；真发必须有 `SESSDATA` + `bili_jct`。

也可以把所有密钥放进 `.env`（启动时自动读取，已被 gitignore）：

```bash
cp env.example .env
# 编辑 .env：LLM_API_KEY / BILI_SESSDATA / BILI_JCT / BILI_BUVID3
```

## 互动档位

改 `reply.triggers` 即可：

| 档位 | 配置 | 说明 |
|---|---|---|
| 只回主人 | `["owner"]` + `ownerMid` | 最安全，观众一律不理 |
| 被 @ / 关键词 | `["mention", "keyword"]` | 默认；有人叫她才回，或命中关键词 |
| 全回 | `["all"]` | 所有弹幕都回，最容易刷屏，慎用 |

### 只有一个号？

如果助手登录的账号就是主播号，B 站会把你自己的弹幕也回传给 WebSocket，但助手默认会忽略“自己发的”。 想自己发弹幕测试，打开控制台里的：

**允许回复本账号自己的弹幕（`reply.allowSelf`）**

它会记录自己刚发出去的回复，看到同样的文字就跳过，防止自问自答循环。 正式使用时建议还是给助手单独一个号，并把这个开关关掉。

### 关键词规则

关键词规则支持普通字符串（包含匹配）和 `/正则/flags`：

```json
{ "match": "你好", "reply": "你好呀 {name}～" },
{ "match": "/^(在吗|在不在)[?？]?$/", "reply": "在的 {name}" }
```

模板占位符：`{name}`（昵称）、`{text}`（原话）、`{room}`（房间号）、`{gift}`（礼物名）。

### 接 LLM

控制台里可以直接选服务商：

| 服务商 | Base URL | 常用模型 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` / `deepseek-reasoner` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` / `gpt-4o` |
| 自定义 | 自己填 | 自己填 |

填完 Key 后点「获取模型列表」，会调用 `GET /models` 把可用模型拉下来（接口不支持就手动填）。

配置长这样：

```json
"llm": {
  "enabled": true,
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "apiKeyEnv": "LLM_API_KEY",
  "maxTokens": 512,
  "contextMessages": 0
}
```

`contextMessages` 是每次回复带多少条上一段弹幕：

- `0`（默认）= 每条弹幕独立回答，不会接上一段话
- `4` = 带最近 4 条，适合连续对话

> 推理模型（`deepseek-flash` / `deepseek-reasoner`）会先消耗 reasoning tokens。 `maxTokens` 太小（比如 80）会导致正文为空，然后退回模板回复。默认 512；如果还是空，程序会自动翻倍重试一次。

然后 `export LLM_API_KEY=...` 或写进 `.env`。`baseUrl` 直接拼 `/chat/completions`。

规则命中但没写死回复时，才会走 LLM；再不行才用 `templateReplies` 兜底。

## 限速（默认值对直播间算保守）

```json
"throttle": {
  "globalCooldownMs": 10000,
  "perUserCooldownMs": 90000,
  "dailyCap": 60,
  "sameTextWindowMs": 600000
}
```

> 控制台里按**秒**填写；写进 `config.json` 时仍然是**毫秒**（自动 ×1000）。 例如界面填 `10` / `120` / `600`，配置里就是 `10000` / `120000` / `600000`。

- 全局：两次回复至少隔 10 秒
- 同一个人：90 秒内只回一次
- 每天最多 60 条
- 同一人同一句话 10 分钟内不重复回

弹幕接口对频率很敏感（`10031` 就是发太快）。**不要为了“像真人”把冷却调到 1 秒以内**，轻则限流，重则封禁直播间发言。

## 其他命令

```bash
node src/cli.mjs ui       --port 7788          # 网页控制台
node src/cli.mjs pre      --room 6            # 房间信息 / 账号 / 弹幕配置
node src/cli.mjs history  --room 6 --limit 10 # 最近历史弹幕
node src/cli.mjs send     --room 6 --msg "hi" --dry
node src/cli.mjs send     --room 6 --msg "hi" --go
node src/cli.mjs simulate --text "你好" --name 阿伟   # 不联网，只看规则会怎么回
```

## 目录

```
live-assistant/
├── src/
│   ├── cli.mjs          # 命令行入口
│   ├── config.mjs       # 配置合并 / 默认值
│   ├── credentials.mjs  # 凭据读取
│   ├── api.mjs          # 房间 / WBI / 发弹幕 / 进房
│   ├── ws.mjs           # 弹幕 WebSocket 协议
│   ├── reply.mjs        # 触发规则 / 模板
│   ├── llm.mjs          # 可选 LLM
│   └── assistant.mjs    # 主循环 / 限速 / 重连
├── src/server.mjs       # 本地网页控制台（HTTP + SSE）
├── public/              # 控制台前端（原生 HTML/CSS/JS）
├── tests/
├── config.example.json
└── package.json
```

## 常见错误码

| code | 含义 | 怎么办 |
|---|---|---|
| -101 | 未登录 | `SESSDATA` 过期，重新复制 |
| -111 | csrf 校验失败 | `bili_jct` 和 `SESSDATA` 不是同一个号 |
| -352 | WBI 签名失败 | 通常是 `nav` 拿不到 `wbi_img`，重试或换网络 |
| 10031 | 发送频率过快 | 调大冷却，别连发 |
| 12015 / 12051 | 账号被限制 / 风控 | 停手，去网页端处理验证 |

## 和原项目的关系

这个目录是独立程序：不 import `lib/`、不注册 DSH 插件、不跑生物钟/日记/视频那一套。只和原项目共用 `~/.bili-ai/credentials.json` 这一份凭据。

License: MIT（与原项目一致）。
