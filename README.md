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

## ⚠️ 部署前提

1.  一个 **Cloudflare 账户**。
2.  已安装 **Node.js** 和 **npm** (用于安装 Wrangler)。
3.  已安装 Cloudflare 命令行工具 **Wrangler**。
    * `npm install -g wrangler`
4.  一个 **Telegram 机器人**。
    * 通过 @BotFather 创建，并获取 **Bot Token**。
5.  一个 **Telegram 管理群组**。
    * 必须是**超级群组 (Supergroup)**。
    * 必须**已启用「话题」(Topics)** 功能。
    * 将你创建的机器人添加为该群组的**管理员**。
    * **重要权限**：机器人必须拥有所有权限。
    * 获取该群组的 **Chat ID** (通常是一个以 `-100` 开头的数字)。

## 部署步骤

### 1. 准备项目
1.  将您的机器人代码保存为 `index.js`。
2.  在项目根目录创建 `wrangler.toml` 配置文件。

### 2. 创建 KV 命名空间
您总共需要创建 **4** 个 KV 命名空间。请在网页端手动创建kv：
```
# 1. 用于存储用户验证状态 (已验证、验证中)
 telegram-user-state

# 2. 用于存储黑名单用户
telegram-blacklist

# 3. 用于存储 话题ID <-> 用户ID 的映射
telegram-topic_map

# 4. 用于存储 消息ID <-> 消息ID 的映射
telegram-message_map
```

3. 配置 wrangler.toml
这是最关键的一步。创建 wrangler.toml 文件，并填入以下内容，请务必替换所有id，复制创建kv的id粘贴替换即可：
```TOML
name = "telegram-bot"
main = "index.js"
compatibility_date = "2024-11-14"

[vars]
# 填入你的 Bot Token (来自 @BotFather)
BOT_TOKEN = "123456:ABC-DEF123456789"
# 填入你的管理群组 ID (必须是启用了 Topic 的超级群组，以 -100 开头)
ADMIN_GROUP_ID = "-1001234567890"

# KV Namespaces
[[kv_namespaces]]
binding = "USER_STATE"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[[kv_namespaces]]
binding = "BLACKLIST"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[[kv_namespaces]]
binding = "TOPIC_MAP"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[[kv_namespaces]]
binding = "MESSAGE_MAP"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[observability]
[observability.logs]
enabled = true
head_sampling_rate = 1
invocation_logs = true
persist = true
```

### 3. 部署到 Cloudflare
 在项目根目录运行 wrangler 登录和部署命令：

```Bash
# (如果是第一次使用) 登录 Cloudflare
wrangler login
# 部署！
wrangler deploy
```
