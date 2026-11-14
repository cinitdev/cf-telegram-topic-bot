/**
 * Telegram 双向话题机器人 —— Cloudflare Workers + Durable Object
 *
 * 架构：
 *   Worker (/webhook) 收到 Telegram update，立刻回 200，把 update 丢给唯一的 Durable Object。
 *   DO 里串行处理：状态（用户 / 话题 / 消息映射 / 验证挑战）全部存在 DO 的 SQLite 里，
 *   强一致，所以「刚转发出去的消息马上被编辑」也能对上号。
 *
 * 环境变量（Worker Secret 或 vars）：
 *   BOT_TOKEN      必填  @BotFather 给的 token
 *   ADMIN_GROUP_ID 必填  管理群（必须是开启了「话题」的超级群，形如 -1001234567890）
 *   WEBHOOK_SECRET 可选  setWebhook 的 secret_token，设了就校验来源
 *   SETUP_KEY      可选  /setup 与 /info 的访问口令
 */

const DEFAULT_API = 'https://api.telegram.org/bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function displayName(u) {
  const n = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return n || (u.username ? '@' + u.username : String(u.id));
}

/** Telegram 的文本 / caption 上限是 4096 字符（UTF-16 code unit 计算足够接近） */
function clip(s, max) {
  const str = String(s ?? '');
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

/* ------------------------------------------------------------------ */
/* Telegram API                                                        */
/* ------------------------------------------------------------------ */

class Tg {
  constructor(token, base) {
    this.token = token;
    this.base = base || DEFAULT_API;
  }

  async call(method, body = {}) {
    const url = `${this.base}${this.token}/${method}`;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        lastErr = e;
        await sleep(250 * (attempt + 1));
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        data = { ok: false, description: `HTTP ${res.status}` };
      }
      if (data.ok) return data.result;

      const retryAfter = data.parameters && data.parameters.retry_after;
      if (res.status === 429 && retryAfter && attempt < 2) {
        await sleep(Math.min(retryAfter, 5) * 1000 + 100);
        continue;
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      const err = new Error(`${method}: ${data.error_code || res.status} ${data.description || ''}`.trim());
      err.code = data.error_code || res.status;
      err.description = data.description || '';
      throw err;
    }
    throw lastErr || new Error(`${method}: unknown failure`);
  }

  /** 失败只记日志，不抛出 */
  async tryCall(method, body) {
    try {
      return await this.call(method, body);
    } catch (e) {
      console.error(`[tg] ${method} failed:`, e.message);
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 文案                                                                */
/* ------------------------------------------------------------------ */

const T = {
  welcome: (name) =>
    `你好，${esc(name)} 👋\n\n这里是留言通道，你发的内容会转达给管理员，管理员的回复也会出现在这里。\n\n` +
    `发送任意消息即可开始。`,
  blocked: '你已被限制使用本服务，如有疑问请联系管理员。',
  verifyTitle: '🛡 人机验证',
  verifyText: (emoji) =>
    `<b>🛡 人机验证</b>\n\n请点击下面的 <b>${esc(emoji)}</b> 完成验证。\n` +
    `<i>3 分钟内有效，最多 3 次机会。</i>`,
  verifyOk: '✅ 验证通过，现在可以开始对话了。',
  verifyFail: (left) => `❌ 不是这个，再试一次（剩余 ${left} 次）。`,
  verifyKilled: '❌ 验证失败次数过多，你已被限制使用本服务。',
  verifyExpired: '⌛ 验证已过期，请重新发送消息。',
  card: (u) =>
    [
      '<b>👤 新会话</b>',
      `名字：<a href="tg://user?id=${u.id}">${esc(displayName(u))}</a>`,
      `ID：<code>${u.id}</code>`,
      u.username ? `用户名：@${esc(u.username)}` : '用户名：—',
      u.language_code ? `语言：${esc(u.language_code)}` : '',
      `时间：${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    ]
      .filter(Boolean)
      .join('\n'),
  bannedToast: (u) => `🚫 已拉黑 ${displayName(u)}`,
  unbannedToast: (u) => `✅ 已解除 ${displayName(u)}`,
  adminHelp:
    '<b>管理员指令</b>\n' +
    '/ban — 拉黑当前话题的用户\n' +
    '/unban — 解除拉黑\n' +
    '/info — 查看用户信息\n' +
    '/id — 当前 chat / topic 的 ID',
  userHelp:
    '<b>怎么用</b>\n' +
    '直接发送消息即可，支持文字、图片、文件、语音、贴纸、位置等。\n' +
    '管理员的回复会以私聊形式出现在这里。',
};

/* ------------------------------------------------------------------ */
/* Durable Object                                                      */
/* ------------------------------------------------------------------ */

const EMOJIS = ['🐱', '🐶', '🦊', '🐼', '🐻', '🐨', '🐯', '🦁', '🐸', '🐵'];

export class BotDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.api = env.TG_API_BASE || DEFAULT_API;
    this.tg = new Tg(env.BOT_TOKEN, this.api);
    this.adminChat = String(env.ADMIN_GROUP_ID || '');
    this.queue = Promise.resolve();

    const sql = state.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS users (
         user_id     INTEGER PRIMARY KEY,
         username    TEXT,
         name        TEXT,
         lang        TEXT,
         topic_id    INTEGER,
         verified    INTEGER NOT NULL DEFAULT 0,
         blocked     INTEGER NOT NULL DEFAULT 0,
         created_at  INTEGER,
         last_seen   INTEGER
       )`
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_users_topic ON users(topic_id)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS links (
         a_chat  INTEGER NOT NULL,
         a_id    INTEGER NOT NULL,
         b_chat  INTEGER NOT NULL,
         b_id    INTEGER NOT NULL,
         ts      INTEGER,
         PRIMARY KEY (a_chat, a_id)
       )`
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_links_b ON links(b_chat, b_id)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS challenges (
         id         TEXT PRIMARY KEY,
         user_id    INTEGER NOT NULL,
         chat_id    INTEGER NOT NULL,
         msg_id     INTEGER,
         answer     TEXT NOT NULL,
         tries      INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         payload    INTEGER,
         options    TEXT
       )`
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS albums (
         group_id TEXT PRIMARY KEY,
         user_id  INTEGER NOT NULL,
         topic_id INTEGER NOT NULL,
         msg_ids  TEXT NOT NULL,
         ts       INTEGER NOT NULL
       )`
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS seen (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL)`);
  }

  get sql() {
    return this.state.storage.sql;
  }

  /* -------------------------- 入口 -------------------------- */

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/update') {
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad json', { status: 400 });
      }
      // 全部串行：保证同一用户连发的多条消息顺序不乱、映射写入不会互相覆盖
      this.queue = this.queue.then(
        () => this.handleUpdate(update),
        () => this.handleUpdate(update)
      );
      await this.queue;
      return new Response('ok');
    }
    if (url.pathname === '/stats') {
      return Response.json(this.stats());
    }
    return new Response('bot', { status: 200 });
  }

  stats() {
    const one = (q) => this.sql.exec(q).toArray()[0] || {};
    return {
      users: one('SELECT COUNT(*) AS n FROM users').n,
      verified: one('SELECT COUNT(*) AS n FROM users WHERE verified=1').n,
      blocked: one('SELECT COUNT(*) AS n FROM users WHERE blocked=1').n,
      topics: one('SELECT COUNT(*) AS n FROM users WHERE topic_id IS NOT NULL').n,
      links: one('SELECT COUNT(*) AS n FROM links').n,
    };
  }

  /* ------------------------ 存储小工具 ------------------------ */

  getUser(userId) {
    return this.sql.exec('SELECT * FROM users WHERE user_id = ?', userId).toArray()[0] || null;
  }

  userByTopic(topicId) {
    return this.sql.exec('SELECT * FROM users WHERE topic_id = ?', topicId).toArray()[0] || null;
  }

  linkOf(chatId, msgId) {
    return this.sql.exec('SELECT * FROM links WHERE a_chat = ? AND a_id = ?', chatId, msgId).toArray()[0] || null;
  }

  link(aChat, aId, bChat, bId) {
    const ts = nowSec();
    this.sql.exec(
      'INSERT OR REPLACE INTO links (a_chat, a_id, b_chat, b_id, ts) VALUES (?, ?, ?, ?, ?)',
      aChat,
      aId,
      bChat,
      bId,
      ts
    );
    this.sql.exec(
      'INSERT OR REPLACE INTO links (a_chat, a_id, b_chat, b_id, ts) VALUES (?, ?, ?, ?, ?)',
      bChat,
      bId,
      aChat,
      aId,
      ts
    );
  }

  unlink(chatId, msgId) {
    const row = this.linkOf(chatId, msgId);
    if (!row) return;
    this.sql.exec('DELETE FROM links WHERE a_chat = ? AND a_id = ?', chatId, msgId);
    this.sql.exec('DELETE FROM links WHERE a_chat = ? AND a_id = ?', row.b_chat, row.b_id);
  }

  touchUser(from) {
    const existing = this.getUser(from.id);
    const name = displayName(from);
    if (!existing) {
      this.sql.exec(
        'INSERT INTO users (user_id, username, name, lang, verified, created_at, last_seen) VALUES (?, ?, ?, ?, 0, ?, ?)',
        from.id,
        from.username || null,
        name,
        from.language_code || null,
        nowSec(),
        nowSec()
      );
      return this.getUser(from.id);
    }
    if (existing.username !== (from.username || null) || existing.name !== name) {
      this.sql.exec(
        'UPDATE users SET username = ?, name = ?, last_seen = ? WHERE user_id = ?',
        from.username || null,
        name,
        nowSec(),
        from.id
      );
      // 名字变了顺手同步话题标题
      if (existing.topic_id) this.renameTopic(existing.topic_id, from);
    } else {
      this.sql.exec('UPDATE users SET last_seen = ? WHERE user_id = ?', nowSec(), from.id);
    }
    return this.getUser(from.id);
  }

  async renameTopic(topicId, from) {
    const name = topicTitle(from);
    await this.tg.tryCall('editForumTopic', {
      chat_id: Number(this.adminChat),
      message_thread_id: topicId,
      name,
    });
  }

  async handleUpdate(u) {
    // 1. 去重（Telegram 重试会带同样的 update_id）
    if (u.update_id) {
      const seen = this.sql.exec('SELECT 1 AS x FROM seen WHERE update_id = ?', u.update_id).toArray().length;
      if (seen) return;
      this.sql.exec('INSERT OR IGNORE INTO seen (update_id, ts) VALUES (?, ?)', u.update_id, nowSec());
      this.sql.exec('DELETE FROM seen WHERE ts < ?', nowSec() - 3 * 86400);
    }

    try {
      if (u.callback_query) return await this.onCallback(u.callback_query);
      if (u.edited_message) return await this.onEdited(u.edited_message);
      if (u.message) return await this.onMessage(u.message);
    } catch (e) {
      console.error('[update] failed', e && e.stack ? e.stack : e);
    }
  }

  async onMessage(m) {
    const chatType = m.chat && m.chat.type;
    if (chatType === 'private') return await this.onUserMessage(m);
    if (String(m.chat.id) === this.adminChat) return await this.onAdminMessage(m);
  }

  /* ------------------------ 用户侧 ------------------------ */

  async onUserMessage(m) {
    const from = m.from;
    if (!from || from.is_bot) return;
    if (m.via_bot) return;

    let user = this.touchUser(from);
    if (user.blocked) {
      // 已被拉黑：静默丢弃，只在主动 /start 时回一句，免得对方以为机器人挂了
      if (m.text && m.text.split(/\s+/)[0].toLowerCase().startsWith('/start')) {
        await this.tg.tryCall('sendMessage', { chat_id: m.chat.id, text: T.blocked });
      }
      return;
    }

    // 命令
    if (m.text && m.text.startsWith('/')) return await this.onUserCommand(m, user);

    // 未验证 → 先验证，通过后再把这条消息补发到话题
    if (!user.verified) return await this.sendChallenge(m, user);

    if (!user.topic_id) {
      const topicId = await this.ensureTopic(user, from);
      if (!topicId) return;
      user = this.getUser(from.id);
    }

    // 相册要走攒批，否则会在群里散成一堆单图
    if (m.media_group_id) return await this.queueAlbum(m, user, user.topic_id, 'user');

    await this.forwardToAdmin(m, from.id, m.message_id);
  }

  async onUserCommand(m, user) {
    const cmd = m.text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
    if (cmd === '/start') {
      if (user.blocked) {
        return void (await this.tg.tryCall('sendMessage', { chat_id: m.chat.id, text: T.blocked }));
      }
      if (!user.verified) return await this.sendChallenge(m, user);
      const topicId = user.topic_id || (await this.ensureTopic(user, m.from));
      await this.tg.tryCall('sendMessage', {
        chat_id: m.chat.id,
        text: topicId ? T.welcome(displayName(m.from)) : '暂时无法建立会话，请稍后再试。',
      });
      return;
    }
    if (cmd === '/id') {
      return void (await this.tg.tryCall('sendMessage', {
        chat_id: m.chat.id,
        text: `你的 ID：<code>${m.from.id}</code>\n会话：<code>${m.chat.id}</code>`,
        parse_mode: 'HTML',
      }));
    }
    if (cmd === '/help') {
      return void (await this.tg.tryCall('sendMessage', { chat_id: m.chat.id, text: T.userHelp, parse_mode: 'HTML' }));
    }
  }

  /* ------------------------ 管理员侧 ------------------------ */

  async onAdminMessage(m) {
    const threadId = m.message_thread_id;
    // 只认用户话题；General 或别的服务话题一律忽略
    if (!threadId) return;
    const user = this.userByTopic(threadId);
    if (!user) return;
    if (m.from && m.from.is_bot) return;

    if (m.text && m.text.startsWith('/')) return await this.onAdminCommand(m, user, threadId);

    let reply;
    if (m.reply_to_message) {
      const link = this.linkOf(m.chat.id, m.reply_to_message.message_id);
      if (link && String(link.b_chat) === String(user.user_id)) {
        reply = { message_id: link.b_id, allow_sending_without_reply: true };
      }
    }

    if (m.media_group_id) return await this.queueAlbum(m, user, threadId, 'admin');

    await this.copyOne({
      toChat: user.user_id,
      fromChat: m.chat.id,
      messageId: m.message_id,
      reply,
      onSent: (sentId) => this.link(m.chat.id, m.message_id, user.user_id, sentId),
    });
  }

  async onAdminCommand(m, user, threadId) {
    const cmd = m.text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
    const say = (text) =>
      this.tg.tryCall('sendMessage', { chat_id: m.chat.id, message_thread_id: threadId, text, parse_mode: 'HTML' });

    if (cmd === '/ban') {
      this.sql.exec('UPDATE users SET blocked = 1 WHERE user_id = ?', user.user_id);
      await this.tg.tryCall('sendMessage', { chat_id: user.user_id, text: T.blocked }).catch(() => {});
      await say(`🚫 已拉黑 <code>${user.user_id}</code>`);
      await this.refreshCard(user.user_id, threadId, true);
      return;
    }
    if (cmd === '/unban') {
      this.sql.exec('UPDATE users SET blocked = 0 WHERE user_id = ?', user.user_id);
      await say(`✅ 已解除拉黑 <code>${user.user_id}</code>`);
      await this.refreshCard(user.user_id, threadId, false);
      return;
    }
    if (cmd === '/info') {
      const u = this.getUser(user.user_id) || user;
      await say(
        [
          '<b>用户信息</b>',
          `名字：${esc(u.name)}`,
          `ID：<code>${u.user_id}</code>`,
          u.username ? `用户名：@${esc(u.username)}` : '用户名：—',
          `验证：${u.verified ? '已通过' : '未通过'}`,
          `状态：${u.blocked ? '🚫 已拉黑' : '正常'}`,
          u.created_at ? `首次：${new Date(u.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
      return;
    }
    if (cmd === '/id') {
      await say(`chat：<code>${m.chat.id}</code>\n话题：<code>${threadId}</code>\n用户：<code>${user.user_id}</code>`);
      return;
    }
    await say(T.adminHelp);
  }

  /* ------------------------ 复制 & 话题 ------------------------ */

  /**
   * 把一条消息复制到另一个 chat / 话题。失败时不抛错，只记日志。
   * 敏感错误（话题被删）由调用方通过 onError 处理。
   */
  async copyOne({ toChat, fromChat, messageId, thread, reply, silent, onSent }) {
    const params = {
      chat_id: toChat,
      from_chat_id: fromChat,
      message_id: messageId,
      disable_notification: !!silent,
    };
    if (thread) params.message_thread_id = thread;
    if (reply) params.reply_parameters = reply;
    try {
      const sent = await this.tg.call('copyMessage', params);
      if (onSent && sent && sent.message_id) onSent(sent.message_id);
      return sent;
    } catch (e) {
      console.error('[copy] failed', e.message);
      return { __error: e };
    }
  }

  /** 用户 → 管理群话题；话题若已被删掉，重建一次再试 */
  async forwardToAdmin(m, userId, messageId) {
    let user = this.getUser(userId);
    if (!user || !user.topic_id) {
      const topicId = await this.ensureTopic(user, m.from);
      if (!topicId) return;
      user = this.getUser(userId);
    }

    let reply;
    if (m.reply_to_message) {
      const link = this.linkOf(userId, m.reply_to_message.message_id);
      if (link && String(link.b_chat) === this.adminChat) {
        reply = { message_id: link.b_id, allow_sending_without_reply: true };
      }
    }

    const doSend = (threadId) =>
      this.copyOne({
        toChat: Number(this.adminChat),
        fromChat: userId,
        messageId,
        thread: threadId,
        reply,
        onSent: (sentId) => this.link(userId, messageId, Number(this.adminChat), sentId),
      });

    const res = await doSend(user.topic_id);
    if (res && res.__error && isTopicGone(res.__error)) {
      console.warn('[topic] gone, recreating for', userId);
      this.sql.exec('UPDATE users SET topic_id = NULL WHERE user_id = ?', userId);
      const topicId = await this.ensureTopic(this.getUser(userId), m.from);
      if (topicId) await doSend(topicId);
      return;
    }
    if (res && res.__error && isBlockedByUser(res.__error)) {
      this.sql.exec('UPDATE users SET blocked = 1 WHERE user_id = ?', userId);
    }
  }

  async ensureTopic(user, from) {
    if (!user) return null;
    if (user.topic_id) return user.topic_id;

    let created;
    try {
      created = await this.tg.call('createForumTopic', {
        chat_id: Number(this.adminChat),
        name: topicTitle(from || user),
      });
    } catch (e) {
      console.error('[topic] create failed', e.message, '—— 管理群需要是超级群并开启「话题」');
      return null;
    }
    const topicId = created.message_thread_id;
    this.sql.exec('UPDATE users SET topic_id = ? WHERE user_id = ?', topicId, user.user_id);

    const card = await this.tg.tryCall('sendMessage', {
      chat_id: Number(this.adminChat),
      message_thread_id: topicId,
      text: T.card(from || user),
      parse_mode: 'HTML',
      reply_markup: cardKeyboard(user.user_id, false),
    });
    if (card) {
      await this.tg.tryCall('pinChatMessage', {
        chat_id: Number(this.adminChat),
        message_id: card.message_id,
        disable_notification: true,
      });
    } else {
      console.error('[topic] card send failed');
    }
    return topicId;
  }

  async refreshCard(userId, threadId, banned) {
    const user = this.getUser(userId);
    if (!user) return;
    // 找到话题里最近的那张卡片：直接发一条新状态即可，避免翻历史
    await this.tg.tryCall('sendMessage', {
      chat_id: Number(this.adminChat),
      message_thread_id: threadId,
      text: banned ? `🚫 <b>${esc(user.name)}</b> 已被拉黑` : `✅ <b>${esc(user.name)}</b> 已恢复`,
      parse_mode: 'HTML',
      reply_markup: cardKeyboard(userId, banned),
    });
  }

  /* ------------------------ 编辑同步 ------------------------ */

  async onEdited(m) {
    if (m.chat.type !== 'private' && String(m.chat.id) !== this.adminChat) return;

    if (m.chat.type === 'private') {
      const user = this.getUser(m.from.id);
      if (!user || !user.verified || user.blocked) return;
    }

    const link = this.linkOf(m.chat.id, m.message_id);
    if (!link) return;

    const params = { chat_id: link.b_chat, message_id: link.b_id };

    if (typeof m.text === 'string') {
      if (!m.text.trim()) return;
      params.text = clip(m.text, 4096);
      if (m.entities && m.entities.length) params.entities = m.entities;
      else params.link_preview_options = { is_disabled: true };
      return await this.tg.tryCall('editMessageText', params);
    }

    if (typeof m.caption === 'string') {
      params.caption = clip(m.caption, 1024);
      if (m.caption_entities && m.caption_entities.length) params.caption_entities = m.caption_entities;
      return await this.tg.tryCall('editMessageCaption', params);
    }
  }

  /* ------------------------ 人机验证 ------------------------ */

  async sendChallenge(m, user) {
    // 已有未过期的挑战 → 直接补发一次按钮，不再新建
    const live = this.sql
      .exec('SELECT * FROM challenges WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC', user.user_id, nowSec() - 180)
      .toArray()[0];
    if (live) {
      if (nowSec() - live.created_at < 8) return; // 防刷屏
      const opts = parseOptions(live.options, live.answer);
      await this.tg.tryCall('sendMessage', {
        chat_id: m.chat.id,
        text: this.challengeText(live.answer, opts),
        parse_mode: 'HTML',
        reply_markup: this.challengeKeyboard(live.id, opts),
      });
      return;
    }

    const target = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    const others = shuffle(EMOJIS.filter((e) => e !== target)).slice(0, 3);
    const options = shuffle([target, ...others]);
    const id = randomId(8);

    const sent = await this.tg.tryCall('sendMessage', {
      chat_id: m.chat.id,
      text: this.challengeText(target, options),
      parse_mode: 'HTML',
      reply_markup: this.challengeKeyboard(id, options),
    });
    if (!sent) return;

    const isCommand = typeof m.text === 'string' && m.text.startsWith('/');
    this.sql.exec(
      'INSERT OR REPLACE INTO challenges (id, user_id, chat_id, msg_id, answer, tries, created_at, payload, options) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      id,
      user.user_id,
      m.chat.id,
      sent.message_id,
      target,
      nowSec(),
      isCommand ? null : m.message_id,
      JSON.stringify(options)
    );
  }

  challengeText(target) {
    return T.verifyText(target);
  }

  challengeKeyboard(id, options) {
    const opts = Array.isArray(options) ? options : [options];
    const rows = [];
    for (let i = 0; i < opts.length; i += 2) {
      rows.push(opts.slice(i, i + 2).map((o) => ({ text: o, callback_data: `v:${id}:${o}` })));
    }
    return { inline_keyboard: rows };
  }

  async onCallback(q) {
    const data = q.data || '';
    const [kind, ...rest] = data.split(':');

    if (kind === 'v') {
      const id = rest[0];
      const pick = rest.slice(1).join(':');
      return await this.onVerify(q, id, pick);
    }
    if (kind === 'b') {
      if (!q.message || String(q.message.chat.id) !== this.adminChat) return await this.answer(q, '');
      const userId = Number(rest[0]);
      const ban = rest[1] === '1';
      const user = this.getUser(userId);
      if (!user) return await this.answer(q, '用户不存在');
      this.sql.exec('UPDATE users SET blocked = ? WHERE user_id = ?', ban ? 1 : 0, userId);
      if (ban) await this.tg.tryCall('sendMessage', { chat_id: userId, text: T.blocked });
      await this.answer(q, ban ? T.bannedToast(user) : T.unbannedToast(user));
      // 原地翻转按钮
      if (q.message) {
        await this.tg.tryCall('editMessageReplyMarkup', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: cardKeyboard(userId, ban),
        });
      }
      return;
    }
    await this.answer(q, '');
  }

  async onVerify(q, id, pick) {
    const ch = this.sql.exec('SELECT * FROM challenges WHERE id = ?', id).toArray()[0];
    if (!ch) return await this.answer(q, '验证已失效，请重新发送消息', true);

    if (nowSec() - ch.created_at > 180) {
      this.sql.exec('DELETE FROM challenges WHERE id = ?', id);
      await this.answer(q, T.verifyExpired, true);
      if (ch.msg_id) {
        await this.tg.tryCall('deleteMessage', { chat_id: ch.chat_id, message_id: ch.msg_id });
      }
      return;
    }

    if (pick !== ch.answer) {
      const tries = ch.tries + 1;
      this.sql.exec('UPDATE challenges SET tries = ? WHERE id = ?', tries, id);
      if (tries >= 3) {
        this.sql.exec('DELETE FROM challenges WHERE id = ?', id);
        this.sql.exec('UPDATE users SET blocked = 1 WHERE user_id = ?', ch.user_id);
        await this.answer(q, '验证失败', true);
        if (ch.msg_id) await this.tg.tryCall('deleteMessage', { chat_id: ch.chat_id, message_id: ch.msg_id });
        await this.tg.tryCall('sendMessage', { chat_id: ch.chat_id, text: T.verifyKilled });
        await this.notifyAdminBlocked(ch.user_id, '验证失败次数过多');
        return;
      }
      await this.answer(q, T.verifyFail(3 - tries), true);
      if (ch.msg_id) {
        await this.tg.tryCall('editMessageText', {
          chat_id: ch.chat_id,
          message_id: ch.msg_id,
          text: T.verifyText(ch.answer) + `\n\n<i>剩余 ${3 - tries} 次机会</i>`,
          parse_mode: 'HTML',
          reply_markup: this.challengeKeyboard(id, parseOptions(ch.options, ch.answer)),
        });
      }
      return;
    }

    // 通过
    this.sql.exec('DELETE FROM challenges WHERE id = ?', id);
    this.sql.exec('UPDATE users SET verified = 1 WHERE user_id = ?', ch.user_id);
    await this.answer(q, '✅ 通过');
    if (ch.msg_id) await this.tg.tryCall('deleteMessage', { chat_id: ch.chat_id, message_id: ch.msg_id });

    const user = this.getUser(ch.user_id);
    if (!user) return;
    await this.tg.tryCall('sendMessage', { chat_id: ch.chat_id, text: T.verifyOk });

    const topicId = await this.ensureTopic(user, { id: user.user_id, first_name: user.name, username: user.username });
    if (!topicId || !ch.payload) return;

    // 验证期间压着的那条消息，补发到话题
    const payloadId = ch.payload;
    const doSend = () =>
      this.copyOne({
        toChat: Number(this.adminChat),
        fromChat: user.user_id,
        messageId: payloadId,
        thread: topicId,
        onSent: (sentId) => this.link(user.user_id, payloadId, Number(this.adminChat), sentId),
      });
    const res = await doSend();
    if (res && res.__error && isTopicGone(res.__error)) {
      this.sql.exec('UPDATE users SET topic_id = NULL WHERE user_id = ?', user.user_id);
      const t2 = await this.ensureTopic(this.getUser(user.user_id), user);
      if (t2) {
        await this.copyOne({
          toChat: Number(this.adminChat),
          fromChat: user.user_id,
          messageId: payloadId,
          thread: t2,
          onSent: (sentId) => this.link(user.user_id, payloadId, Number(this.adminChat), sentId),
        });
      }
    }
  }

  async notifyAdminBlocked(userId, reason) {
    const user = this.getUser(userId);
    const text = `🚫 <b>自动拉黑</b>\n${
      user ? `用户：${esc(user.name)}（<code>${userId}</code>）` : `用户：<code>${userId}</code>`
    }\n原因：${esc(reason)}`;
    await this.tg.tryCall('sendMessage', {
      chat_id: Number(this.adminChat),
      text,
      parse_mode: 'HTML',
      reply_markup: cardKeyboard(userId, true),
    });
  }

  async answer(q, text, alert) {
    await this.tg.tryCall('answerCallbackQuery', {
      callback_query_id: q.id,
      text: text || undefined,
      show_alert: !!alert,
    });
  }

  /* ------------------------ 相册（media group） ------------------------ */

  /**
   * 相册在 Telegram 里是多条独立 update，逐条 copy 会在群里散成一堆单图。
   * 这里先攒进 albums 表，靠 DO 的 alarm 统一用 copyMessages 批量发。
   */
  async queueAlbum(m, user, topicId, side) {
    const gid = `${side}:${m.media_group_id}`;
    const row = this.sql.exec('SELECT * FROM albums WHERE group_id = ?', gid).toArray()[0];
    if (!row) {
      this.sql.exec(
        'INSERT INTO albums (group_id, user_id, topic_id, msg_ids, ts) VALUES (?, ?, ?, ?, ?)',
        gid,
        user.user_id,
        topicId,
        String(m.message_id),
        nowSec()
      );
    } else {
      const ids = row.msg_ids ? `${row.msg_ids},${m.message_id}` : String(m.message_id);
      this.sql.exec('UPDATE albums SET msg_ids = ? WHERE group_id = ?', ids, gid);
    }
    await this.scheduleFlush();
  }

  async scheduleFlush() {
    const cur = await this.state.storage.getAlarm();
    const at = Date.now() + 1200;
    if (!cur || cur > at) await this.state.storage.setAlarm(at);
  }

  async alarm() {
    const rows = this.sql.exec('SELECT * FROM albums WHERE ts <= ?', nowSec()).toArray();
    for (const row of rows) {
      this.sql.exec('DELETE FROM albums WHERE group_id = ?', row.group_id);
      const ids = row.msg_ids
        .split(',')
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) continue;

      const side = row.group_id.startsWith('admin:') ? 'admin' : 'user';
      const toChat = side === 'admin' ? row.user_id : Number(this.adminChat);
      const fromChat = side === 'admin' ? Number(this.adminChat) : row.user_id;
      const batch = ids.slice(0, 100);
      const params = {
        chat_id: toChat,
        from_chat_id: fromChat,
        message_ids: batch,
      };
      if (side === 'user') params.message_thread_id = row.topic_id;

      try {
        const res = await this.tg.call('copyMessages', params);
        const sent = Array.isArray(res) ? res : [];
        batch.forEach((id, i) => {
          const obj = sent[i];
          const newId = obj && (obj.message_id || obj);
          if (newId) this.link(fromChat, id, toChat, newId);
        });
      } catch (e) {
        console.error('[album] copyMessages failed', e.message);
        // 退化成逐条复制
        for (const id of ids) {
          await this.copyOne({
            toChat,
            fromChat,
            messageId: id,
            thread: side === 'user' ? row.topic_id : undefined,
            onSent: (sentId) => this.link(fromChat, id, toChat, sentId),
          });
        }
      }
    }
    const more = this.sql.exec('SELECT COUNT(*) AS n FROM albums').toArray()[0];
    if (more && more.n > 0) await this.scheduleFlush();
  }
}

function topicTitle(u) {
  let t = displayName(u);
  if (u.username) t += ' @' + u.username;
  t = t.replace(/[\r\n\t]+/g, ' ').trim();
  return clip(t, 120);
}

/* ------------------------------------------------------------------ */
/* Update 分发                                                         */
/* ------------------------------------------------------------------ */

function isTopicGone(err) {
  const d = (err && err.description) || '';
  return /thread not found|topic_deleted|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(d);
}

function isBlockedByUser(err) {
  const d = (err && err.description) || '';
  return /bot was blocked by the user|user is deactivated|chat not found/i.test(d);
}

function parseOptions(raw, fallback) {
  try {
    const v = JSON.parse(raw || 'null');
    if (Array.isArray(v) && v.length) return v;
  } catch {}
  return [fallback];
}

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomId(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function cardKeyboard(userId, banned) {
  return {
    inline_keyboard: [
      [
        banned
          ? { text: '✅ 解除拉黑', callback_data: `b:${userId}:0` }
          : { text: '🚫 拉黑', callback_data: `b:${userId}:1` },
      ],
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 按钮回调                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Worker 入口                                                         */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const base = env.TG_API_BASE || DEFAULT_API;
    const tg = new Tg(env.BOT_TOKEN, base);

    if (path === '/webhook') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (env.WEBHOOK_SECRET) {
        const got = request.headers.get('x-telegram-bot-api-secret-token');
        if (got !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      const stub = env.BOT.get(env.BOT.idFromName('main'));
      ctx.waitUntil(
        stub
          .fetch('https://bot/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(update),
          })
          .catch((e) => console.error('[do] dispatch failed', e && e.message))
      );
      return new Response('ok');
    }

    // 以下管理端点：设了 SETUP_KEY 就必须带 ?key=
    if (path === '/setup' || path === '/info' || path === '/stats') {
      if (env.SETUP_KEY && url.searchParams.get('key') !== env.SETUP_KEY) {
        return new Response('forbidden', { status: 403 });
      }
    }

    if (path === '/setup') {
      const body = {
        url: `${url.origin}/webhook`,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
        drop_pending_updates: true,
        max_connections: 40,
      };
      if (env.WEBHOOK_SECRET) body.secret_token = env.WEBHOOK_SECRET;
      try {
        const r = await tg.call('setWebhook', body);
        const me = await tg.tryCall('getMe');
        return Response.json({ ok: true, webhook: body.url, bot: me && me.username, result: r });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (path === '/info') {
      try {
        const [info, me] = await Promise.all([tg.call('getWebhookInfo'), tg.tryCall('getMe')]);
        return Response.json({ ok: true, me, webhook: info });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    if (path === '/stats') {
      const stub = env.BOT.get(env.BOT.idFromName('main'));
      const res = await stub.fetch('https://bot/stats');
      return new Response(res.body, { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Telegram topic bot is running.\n', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
