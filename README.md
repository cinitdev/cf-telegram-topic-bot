# cf-telegram-topic-bot

Telegram 双向消息机器人，跑在 Cloudflare Workers 上。用户私聊你，消息进管理群的独立话题；你在话题里回复，消息回到用户私聊。**两边编辑消息都会实时同步。**

```
用户私聊 ──▶ Worker /webhook ──▶ Durable Object ──▶ 管理群 · 每个用户一个话题
   ▲                                   │                     │
   └────────────── 群里的回复 ◀─────────┴─────────────────────┘
```

## 特性

| | |
|---|---|
| 双向转发 | 文字、图片、视频、文件、语音、视频留言、贴纸、GIF、位置、联系人、投票…… 全部走 `copyMessage`，不显示「转发自」 |
| 话题隔离 | 每个用户自动建一个 forum topic，标题是「名字 @用户名」，群里聊起来不会串 |
| 编辑同步 | `edited_message` 立即映射到对面那条并改写；文字走 `editMessageText`，媒体说明走 `editMessageCaption`，格式（粗体/链接等）用 entities 原样搬运 |
| 回复关系 | 用户回复自己的某条消息，群里也回复对应的那条；反向同理 |
| 相册 | 一次发多张图不会散成几条单图，靠 DO alarm 攒 1.2 秒后用 `copyMessages` 批量发 |
| 人机验证 | 首次私聊必须点中指定表情，3 分钟 / 3 次机会，通过后自动把被拦下的那条消息补发到话题 |
| 拉黑 | 用户卡上有一键按钮，也可以在话题里 `/ban` `/unban`；验证失败 3 次自动拉黑 |
| 强一致 | 状态存在 Durable Object 的 SQLite 里，刚发出去的消息马上被编辑也一定对得上（KV 会有最终一致延迟，这也是很多同类 bot 编辑同步失灵的原因） |

## 前置条件

1. Cloudflare 账号。
2. 一个 bot：找 [@BotFather](https://t.me/BotFather) `/newbot`。
3. 一个**超级群**，并且**开启「话题」(Topics)**。
4. 把 bot 拉进群，设为**管理员**，勾上：
   - Manage Topics（管理话题）
   - Pin Messages（置顶消息）
   - Delete Messages（删消息，验证失败时清理提示用）
5. **关掉 privacy mode**（重要）：
   BotFather → `/setprivacy` → 选你的 bot → **Disable**。
   不关的话，bot 在群里只能收到 `/命令` 和 @它的话，管理员打的普通回复全部收不到。

## 部署

```bash
npm install

# BOT_TOKEN 与群组 ID（两个都是 Secret，不进代码库）
npx wrangler secret put BOT_TOKEN       # 123456:ABC-DEF...
npx wrangler secret put ADMIN_GROUP_ID  # -1001234567890

npx wrangler deploy
```

部署完会得到一个 `https://cf-telegram-topic-bot.<你的子域>.workers.dev` 地址，然后挂上 webhook：

```bash
curl "https://<你的域名>/setup"
# → {"ok":true,"webhook":"https://<你的域名>/webhook","bot":"xxx_bot","result":true}
```

检查状态：

```bash
curl "https://<你的域名>/info"          # webhook 是否生效、最后错误
curl "https://<你的域名>/stats"         # 用户数 / 已验证 / 已拉黑 / 消息映射条数
```

可选的环境变量：

| 变量 | 作用 |
|---|---|
| `WEBHOOK_SECRET` | 设置后 `/setup` 会带 `secret_token`，Worker 校验 `X-Telegram-Bot-Api-Secret-Token`，防止别人往你的 webhook 灌假 update |
| `SETUP_KEY` | 设置后 `/setup` `/info` `/stats` 必须带 `?key=xxx` |

```bash
npx wrangler secret put WEBHOOK_SECRET
curl "https://<你的域名>/setup"   # 重新挂一次 webhook 才会用上 secret
```

### 群组 ID 怎么拿

把 bot 拉进群、随便发条消息，然后：

```
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

返回里找 `"chat":{"id":-100xxxxxxxxxx}`。或者直接群里发 `/id`（如果 bot 已经在跑）。

### 手机部署

Durable Object 需要在部署时注册 migration（`new_sqlite_classes`），网页版 Quick Edit 不方便做这件事。手机上推荐用 Termux / 任何带 shell 的环境跑同样的命令；或者直接在浏览器里的 Cloudflare **Workers 编辑器**上传 `src/index.js` 后，到 Settings → Bindings 加一个 Durable Object 绑定（Variable name `BOT`，Class name `BotDO`）——首次仍需一次 `wrangler deploy` 完成 migration。

## 用起来是什么样

**用户侧**

1. 第一次私聊 bot，收到一条 `🛡 人机验证`，四个表情按钮。
2. 点对了 → 「✅ 验证通过」，刚才那条消息被补发到管理群的话题里。
3. 之后发的每条消息都会出现在话题中。

**管理员侧**

- 每个新用户自动建一个话题，话题里置顶一张用户卡（名字、ID、@用户名、语言、首条消息时间）。
- 直接在该话题里回复 → 用户私聊收到。
- **回复某条转发消息** → 用户那边也是回复同一条。
- 改了群里的消息 → 用户那边跟着改。

**命令**

| 位置 | 命令 | 作用 |
|---|---|---|
| 用户私聊 | `/start` | 重新触发验证 / 打招呼 |
| 用户私聊 | `/id` | 看自己的 ID |
| 用户私聊 | `/help` | 用法说明 |
| 管理群话题 | `/ban` | 拉黑当前话题的用户 |
| 管理群话题 | `/unban` | 解除拉黑 |
| 管理群话题 | `/info` | 用户详情 |
| 管理群话题 | `/id` | 当前 chat / topic ID |

## 数据存在哪

全部在 Durable Object `main` 实例的 SQLite 里：

| 表 | 内容 |
|---|---|
| `users` | 用户资料、话题 id、验证与拉黑状态 |
| `links` | 消息映射，双向各一条 `(chat_id, message_id) → (chat_id, message_id)` |
| `challenges` | 进行中的验证挑战 |
| `albums` | 待批量转发的相册 |
| `seen` | 已处理过的 `update_id`，防 Telegram 重投 |

想清空重来：`npx wrangler d1 ...` 用不到，直接 `wrangler delete` 再部署一次即可。

## 本地开发

```bash
npm run dev                              # wrangler dev，本地 workerd
node test/bot.test.mjs                   # 15 个用例，mock 掉 Telegram API
```

测试覆盖：验证流程、话题创建与复用、双向转发、回复映射、双向编辑、相册攒批、拉黑/解除、话题被删自动重建、update 去重、非管理群忽略。

## 常见坑

**机器人收不到群里的消息** → privacy mode 没关（见前置条件 5）。

**`createForumTopic` 报 400** → 群不是超级群，或者没开「话题」，或者 bot 没有 Manage Topics 权限。

**编辑不同步** → 只有经过 bot 转发过的消息才会同步。bot 上线前的历史消息没有映射。

**消息发送失败** → `npx wrangler tail` 看日志，`[copy] failed` 后面就是 Telegram 的原始报错；`/info` 里也能看到 webhook 的最后一次错误。

**想换群** → 改 `ADMIN_GROUP_ID` 后重新 `/setup`。旧映射还指向老群，建议同时把 DO 清掉（重新 deploy 一个新名字的 worker）。

## 结构

```
src/index.js       全部逻辑：Tg API 封装 / BotDO / Worker 入口
test/harness.mjs   mock Telegram + DO state 垫片（node:sqlite）
test/bot.test.mjs  端到端用例
wrangler.jsonc     绑定与 migration
```
