# Telegram 双向消息管理机器人 部署文档

这是一个基于 Cloudflare Workers 和 KV 存储的 Telegram 双向消息管理机器人。它允许用户通过机器人与您联系，所有消息都会被转发到您指定的 Telegram 管理群组中，并自动为每位用户创建专属话题（Topic）。

## 🚀 功能特性

* **双向消息转发**：无缝转发用户与管理员群组话题之间的所有消息。
* **高级人机验证**：
    * **多种验证**：支持**算数题**、**点击按钮**和**顺序点击**三种随机验证码，有效防止机器人滥用。
    * **安全机制**：验证码有 3 次尝试机会和 3 分钟时效，失败或超时将自动拉黑。
* **动态话题管理**：
    * **自动创建**：当新用户第一次发送消息时，自动在管理群组中创建一个以该用户命名的专属话题。
    * **用户信息卡**：在话题内自动发送并置顶一张用户信息卡（包含 ID、用户名、语言等）。
* **黑名单系统**：
    * **自动拉黑**：验证失败的用户会自动进入黑名单。
    * **手动拉黑**：管理员可在用户信息卡上点击「🚫 拉黑用户」按钮，一键拉黑。
    * **解除拉黑**：所有拉黑记录会发送到专用的「🚫 验证失败记录」话题，并附带「🔓 解除拉黑」按钮。
* **高级消息同步**：
    * **回复同步**：完美同步用户和管理员之间的**回复 (Reply)** 消息。
    * **编辑同步**：完美同步用户和管理员之间的**编辑 (Edit)** 消息。
* **状态提示**：
    * 通过「👍」和「✍️」等 Emoji Reaction 实时提示消息发送和编辑状态。
* **持久化存储**：
    * 使用 Cloudflare KV 存储用户状态、黑名单、话题映射和消息映射。
    * 使用**单一** Cloudflare KV (`BOT_KV`) 存储所有数据。

## ⚠️ 部署前提

1. 一个 **Cloudflare 账户**。
2. 一个 **Telegram 机器人** (通过 @BotFather 创建，获取 **Bot Token**)。
3. 一个 **Telegram 管理群组** (必须是**超级群组**，必须**启用「话题」**功能)。
4. 将您的机器人添加为管理群组的**管理员**，并给予**必要权限**：`Manage Topics` (管理话题), `Pin Messages` (置顶消息), `Send Messages` (发送消息)。
5. 获取群组的 **Chat ID** (通常以 `-100...` 开头)。

---

## 方式一：💻 电脑部署 (Wrangler CLI)

这是最推荐、最安全的方式。

### 步骤 1: 准备文件和环境

1. 在您的电脑上安装 [Node.js](https://nodejs.org/)。
2. 打开终端（命令行），安装 Wrangler：
```bash
npm install -g wrangler
```
3. 登录 Cloudflare：
```bash
wrangler login
```
4. 在您电脑上创建一个新文件夹（例如 `telegram-bot`），并将 `index.js`, `wrangler.toml`, `package.json` 这三个文件放入该文件夹。

### 步骤 2: 获取群组 ID

1. 将您的机器人设为群组管理员。
2. 在群组中发送任意一条消息。
3. 在浏览器中访问 `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` (将 `<YOUR_BOT_TOKEN>` 替换为您的 Bot Token)。
4. 在返回的 JSON 中，找到 `chat` -> `id`，这个就是 `ADMIN_GROUP_ID` (例如 `-1001234567890`)。

### 步骤 3: 创建 KV 命名空间

1. 在 Cloudflare 网页端 (Workers & Pages -> KV) 创建一个 KV 命名空间。
2. **名称**：您可以随意填写 (例如 `my_bot_kv`)。
3. 创建后，**复制这个 KV 的 ID** (一长串32个字符的编码)。

### 步骤 4: 配置 wrangler.toml

1. 打开项目中的 `wrangler.toml` 文件，如果没有就自己创建。
2. **修改 `name`**：改成您想要的 Worker 名称 (例如 ```my-telegram-bot```)。
3. **填写 `id`**：将您上一步复制的 KV ID 粘贴到 `[[kv_namespaces]]` 下的 `id` 字段中。
```toml
name = "my-telegram-bot" # <--改成您的
main = "index.js"
compatibility_date = "2024-05-01"

[[kv_namespaces]]
binding = "BOT_KV"
id = "粘贴您在网页端创建的KV_ID到这里" # <-- 粘贴您的 ID

[vars]
# 填入你的 Bot Token (来自 @BotFather)
BOT_TOKEN = "123456:ABC-DEF123456789"
# 填入你的管理群组 ID (必须是启用了 Topic(话题) 的群组，以 -100 开头)
ADMIN_GROUP_ID = "-1001234567890"

#开启Worker日志
[observability]
[observability.logs]
enabled = true
head_sampling_rate = 1
invocation_logs = true
persist = true
```

### 步骤 5: 部署
 在终端中运行：
```bash
wrangler deploy
```
部署成功后，Wrangler 会输出一个 *.workers.dev 域名。

### 步骤 6: 设置 Webhook (最后一步)
在您的浏览器中访问以下 URL（将域名替换为您刚部署的域名）：
`https://my-telegram-bot.your-name.workers.dev/setup`

看到 `{"ok":true,...}` 即表示成功！您的机器人已开始运行。

---

## 方式二：📱 手机部署 (Cloudflare 网页端)
 * 这种方式无需电脑，所有操作都在手机浏览器中完成。

### 步骤 1: 创建 Worker
 * 登录 Cloudflare 仪表板。
 * 将 GitHub 里面的 "index.js" 下载到本地
 * 转到 "Workers & Pages" -> "创建应用程序" -> "拖放文件" -> "开始使用" -> "从计算机中选择" 上传 "index.js" 文件。
 * 给您的 Worker 起一个名字 (例如 my-telegram-bot)，然后点击 "Deploy(部署)"。

### 步骤 2: 创建并绑定 KV
 * 创建 KV：
   * 退回到 Cloudflare 仪表板。
   * 转到 "储存和数据库" -> "Workers KV"。
   * 点击 "Create Instance"，输入名称 (例如 my_bot_kv)，然后创建。
 * 绑定 KV：
   * 回到您的 Worker (Workers & Pages -> 找到 my-telegram-bot)。
   * 点击 "绑定" -> "添加绑定"。
   * 选择 "KV 命名空间" -> "添加绑定"。
   * Variable name (变量名称): 必须填写 BOT_KV (必须大写，与代码 env.BOT_KV 对应)。
   * KV Namespace (KV 命名空间): 选择您刚创建的 my_bot_kv。
   * 点击 "添加绑定"。

### 步骤 3: 设置变量信息 (Token 和 ID)
 * 仍在 "设置" 页面，转到 "变量和机密"。
 * 在 "Environment Variables" (变量和机密) 下，点击 "添加"。
 * 文本类似即可，当然也可以选择密钥类型
 * 添加 Bot Token:
   * Variable name: BOT_TOKEN
   * Value: (粘贴您的 Bot Token)
   * 点击 "保存"。
 * 添加群组 ID:
   * Variable name: ADMIN_GROUP_ID
   * Value: (粘贴您的群组 ID，例如 -100123...)
   * 点击 "保存"。
   
### 步骤 4: 重新部署

非常重要：在设置完 KV 和变量后，您必须重新部署一次 Worker 才能让设置生效。
 * 回到 Worker 的 "Overview" (概览) 页面。
 * 点击 "编辑代码"。
 * 无需修改任何代码，直接点击 "部署"。

### 步骤 5: 设置 Webhook (最后一步)
 * 在 Worker 的 "Overview" (概览) 页面，找到您的 *.workers.dev 域名。
 * 在您的手机浏览器中，打开一个新的标签页。
 * 访问这个 URL (将域名替换成您的)：
   ```https://my-telegram-bot.your-name.workers.dev/setup```
 * 看到 ```{"ok":true,...}``` 即表示成功！您的机器人已开始运行。

### 🐛 故障排除 (FAQ)
 * Q: 机器人没反应？
   1. 访问 /info 网址 (https://.../info) 检查 Webhook 是否设置成功。
   2. (电脑) 运行 wrangler tail 查看实时日志。
   3. (手机) 在 Worker 页面查看 "Logs" (日志) 选项卡，看是否有错误。
   4. 检查 BOT_TOKEN 和 ADMIN_GROUP_ID 是否设置正确且已加密。
   5. 检查 KV 绑定名称是否为 BOT_KV。
 * Q: 无法置顶信息卡？
   * 确保机器人在群组中有 Pin Messages (置顶消息) 权限。
 * Q: 无法创建话题？

   * 确保机器人在群组中有 Manage Topics (管理话题) 权限。



