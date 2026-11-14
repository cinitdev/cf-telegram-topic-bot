import assert from 'node:assert/strict';
import { startMockTelegram, makeState } from './harness.mjs';
import { BotDO } from '../src/index.js';

const ADMIN = -1001234567890;
const USER = 1001;

let mock;
let callSeq = 90000;

function mk() {
  const state = makeState();
  const doEnv = { BOT_TOKEN: 'TESTTOKEN', ADMIN_GROUP_ID: String(ADMIN), TG_API_BASE: mock.base };
  const bot = new BotDO(state, doEnv);
  return { bot, state };
}

const nextUpdate = () => ++callSeq;
const nextMsg = () => ++callSeq;

async function send(bot, update) {
  const res = await bot.fetch(new Request('https://bot/update', { method: 'POST', body: JSON.stringify(update) }));
  assert.equal(res.status, 200);
}

function userText(text, extra = {}) {
  const message_id = nextMsg();
  return {
    update_id: nextUpdate(),
    message: {
      message_id,
      from: { id: USER, is_bot: false, first_name: 'Alice', last_name: 'Wang', username: 'alice', language_code: 'zh-hans' },
      chat: { id: USER, type: 'private', first_name: 'Alice' },
      date: 1,
      text,
      ...extra,
    },
  };
}

function adminText(text, thread, extra = {}) {
  const message_id = nextMsg();
  return {
    update_id: nextUpdate(),
    message: {
      message_id,
      from: { id: 42, is_bot: false, first_name: 'Admin' },
      chat: { id: ADMIN, type: 'supergroup', is_forum: true },
      message_thread_id: thread,
      is_topic_message: true,
      date: 1,
      text,
      ...extra,
    },
  };
}

function callback(data, chatId, msgId, thread) {
  return {
    update_id: nextUpdate(),
    callback_query: {
      id: 'cb' + nextUpdate(),
      from: { id: 42, is_bot: false, first_name: 'Admin' },
      data,
      message: {
        message_id: msgId,
        chat: { id: chatId, type: chatId === USER ? 'private' : 'supergroup' },
        message_thread_id: thread,
        reply_markup: { inline_keyboard: [] },
      },
    },
  };
}

/** 拿某个用户当前绑定的话题 id */
function topicOf(state, userId = USER) {
  const row = state.storage.sql.exec('SELECT topic_id FROM users WHERE user_id=?', userId).toArray()[0];
  return row && row.topic_id;
}

/** 拿某条消息在对面 chat 里的 id */
function mirrorOf(state, chat, msgId) {
  const row = state.storage.sql.exec('SELECT * FROM links WHERE a_chat=? AND a_id=?', chat, msgId).toArray()[0];
  return row ? row.b_id : null;
}

function challengeTarget(text) {
  return /请点击下面的 <b>(.+?)<\/b>/.exec(text)[1];
}

async function passChallenge(bot, sent) {
  const target = challengeTarget(sent.text);
  const btn = sent.reply_markup.inline_keyboard.flat().find((b) => b.text === target);
  assert.ok(btn, '应有正确按钮');
  await send(bot, callback(btn.callback_data, USER, 1));
  return btn.callback_data;
}

/** 走完「首次私聊 → 验证 → 建话题」，返回 {bot, state, topicId} */
async function bootstrap() {
  const { bot, state } = mk();
  await send(bot, userText('启动'));
  await passChallenge(bot, mock.last('sendMessage').body);
  mock.clear();
  return { bot, state, topicId: topicOf(state) };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------------ */

test('首次私聊：先出人机验证，不转发', async () => {
  const { bot } = mk();
  await send(bot, userText('你好，在吗'));

  assert.equal(mock.of('copyMessage').length, 0, '未验证时不应转发');
  const ch = mock.last('sendMessage');
  assert.ok(ch, '应发出验证消息');
  assert.match(ch.body.text, /人机验证/);
  assert.equal(ch.body.reply_markup.inline_keyboard.flat().length, 4, '四个选项');
  assert.equal(ch.body.chat_id, USER);
});

test('验证通过：建话题 + 置顶用户卡 + 补发被拦下的那条', async () => {
  const { bot, state } = mk();
  const first = userText('我是第一条');
  await send(bot, first);
  await passChallenge(bot, mock.last('sendMessage').body);

  const topic = mock.last('createForumTopic');
  assert.ok(topic, '应创建话题');
  assert.equal(topic.body.chat_id, ADMIN);
  assert.match(topic.body.name, /Alice/);
  assert.ok(mock.last('pinChatMessage'), '用户卡应置顶');
  assert.equal(topicOf(state), topic.body && state.storage.sql.exec('SELECT topic_id FROM users WHERE user_id=?', USER).toArray()[0].topic_id);

  const copy = mock.last('copyMessage');
  assert.ok(copy, '验证通过后补发原消息');
  assert.equal(copy.body.chat_id, ADMIN);
  assert.equal(copy.body.from_chat_id, USER);
  assert.equal(copy.body.message_id, first.message.message_id, '补发的正是那条被拦下的消息');
  assert.equal(copy.body.message_thread_id, topicOf(state));
});

test('验证后继续发消息：沿用同一话题', async () => {
  const { bot, state } = await bootstrap();
  const topics = mock.of('createForumTopic').length;
  const u = userText('第二条');
  await send(bot, u);

  assert.equal(mock.of('createForumTopic').length, topics, '不应重复建话题');
  const copy = mock.last('copyMessage');
  assert.equal(copy.body.chat_id, ADMIN);
  assert.equal(copy.body.message_thread_id, topicOf(state));
  assert.ok(mirrorOf(state, USER, u.message.message_id) > 5000);
});

test('管理员回复：落到用户私聊，保留回复关系', async () => {
  const { bot, state, topicId } = await bootstrap();
  const u = userText('你好');
  await send(bot, u);
  const userSideId = u.message.message_id;

  const a = adminText('收到，稍后回复你', topicId);
  a.message.reply_to_message = { message_id: mirrorOf(state, USER, userSideId), chat: { id: ADMIN } };
  await send(bot, a);

  const copy = mock.last('copyMessage');
  assert.equal(copy.body.chat_id, USER, '发到用户私聊');
  assert.equal(copy.body.from_chat_id, ADMIN);
  assert.ok(copy.body.reply_parameters, '保留回复关系');
  assert.equal(copy.body.reply_parameters.message_id, userSideId);
  assert.equal(copy.body.message_thread_id, undefined, '私聊不带话题 id');
  assert.ok(mirrorOf(state, ADMIN, a.message.message_id) > 5000);
});

test('用户编辑：同步 editMessageText 到话题里那一条', async () => {
  const { bot, state } = await bootstrap();
  const u = userText('原始文字');
  await send(bot, u);
  const adminSideId = mirrorOf(state, USER, u.message.message_id);

  await send(bot, {
    update_id: nextUpdate(),
    edited_message: {
      message_id: u.message.message_id,
      from: { id: USER, first_name: 'Alice' },
      chat: { id: USER, type: 'private' },
      date: 2,
      text: '改过的文字',
      entities: [{ type: 'bold', offset: 0, length: 2 }],
    },
  });

  const e = mock.last('editMessageText');
  assert.ok(e, '应调用 editMessageText');
  assert.equal(e.body.chat_id, ADMIN);
  assert.equal(e.body.message_id, adminSideId);
  assert.equal(e.body.text, '改过的文字');
  assert.deepEqual(e.body.entities, [{ type: 'bold', offset: 0, length: 2 }]);
});

test('管理员编辑：同步回用户私聊', async () => {
  const { bot, state, topicId } = await bootstrap();
  const u = userText('你好');
  await send(bot, u);
  const a = adminText('原始回复', topicId);
  await send(bot, a);
  const userSideId = mirrorOf(state, ADMIN, a.message.message_id);

  await send(bot, {
    update_id: nextUpdate(),
    edited_message: {
      message_id: a.message.message_id,
      from: { id: 42, first_name: 'Admin' },
      chat: { id: ADMIN, type: 'supergroup' },
      message_thread_id: topicId,
      date: 2,
      text: '改过的回复',
    },
  });

  const e = mock.last('editMessageText');
  assert.ok(e);
  assert.equal(e.body.chat_id, USER);
  assert.equal(e.body.message_id, userSideId);
  assert.equal(e.body.text, '改过的回复');
});

test('编辑图片说明：走 editMessageCaption 并保留 entities', async () => {
  const { bot, state } = await bootstrap();
  const photo = {
    update_id: nextUpdate(),
    message: {
      message_id: nextMsg(),
      from: { id: USER, first_name: 'Alice' },
      chat: { id: USER, type: 'private' },
      date: 1,
      photo: [{ file_id: 'f1', width: 10, height: 10 }],
      caption: '第一版说明',
    },
  };
  await send(bot, photo);
  const adminSideId = mirrorOf(state, USER, photo.message.message_id);

  await send(bot, {
    update_id: nextUpdate(),
    edited_message: {
      message_id: photo.message.message_id,
      from: { id: USER, first_name: 'Alice' },
      chat: { id: USER, type: 'private' },
      date: 2,
      photo: [{ file_id: 'f1', width: 10, height: 10 }],
      caption: '第二版说明',
      caption_entities: [{ type: 'url', offset: 0, length: 3 }],
    },
  });

  const e = mock.last('editMessageCaption');
  assert.ok(e, '应调用 editMessageCaption');
  assert.equal(e.body.chat_id, ADMIN);
  assert.equal(e.body.message_id, adminSideId);
  assert.equal(e.body.caption, '第二版说明');
  assert.deepEqual(e.body.caption_entities, [{ type: 'url', offset: 0, length: 3 }]);
});

test('验证失败 3 次：自动拉黑，之后消息全部丢弃', async () => {
  const { bot } = mk();
  await send(bot, userText('hi'));
  const ch = mock.last('sendMessage').body;
  const target = challengeTarget(ch.text);
  const wrong = ch.reply_markup.inline_keyboard.flat().filter((b) => b.text !== target);

  for (let i = 0; i < 3; i++) await send(bot, callback(wrong[i].callback_data, USER, 1));

  assert.ok(mock.of('sendMessage').some((c) => /限制使用/.test(c.body.text || '')), '应告知已被限制');
  assert.equal(mock.of('copyMessage').length, 0);

  mock.clear();
  await send(bot, userText('我还能说话吗'));
  assert.equal(mock.of('copyMessage').length, 0, '拉黑后不再转发');
});

test('/ban 与 /unban：管理员指令生效', async () => {
  const { bot, state, topicId } = await bootstrap();
  await send(bot, adminText(`/ban`, topicId));
  let row = state.storage.sql.exec('SELECT blocked FROM users WHERE user_id=?', USER).toArray()[0];
  assert.equal(row.blocked, 1);

  mock.clear();
  await send(bot, userText('被封了吗'));
  assert.equal(mock.of('copyMessage').length, 0);

  await send(bot, adminText(`/unban`, topicId));
  row = state.storage.sql.exec('SELECT blocked FROM users WHERE user_id=?', USER).toArray()[0];
  assert.equal(row.blocked, 0);

  mock.clear();
  await send(bot, userText('放出来了吗'));
  assert.equal(mock.of('copyMessage').length, 1);
});

test('卡片按钮：一键拉黑 / 解除', async () => {
  const { bot, state, topicId } = await bootstrap();
  await send(bot, callback(`b:${USER}:1`, ADMIN, 777, topicId));
  assert.equal(state.storage.sql.exec('SELECT blocked FROM users WHERE user_id=?', USER).toArray()[0].blocked, 1);
  assert.ok(mock.of('editMessageReplyMarkup').length >= 1, '按钮应就地翻转');

  await send(bot, callback(`b:${USER}:0`, ADMIN, 777, topicId));
  assert.equal(state.storage.sql.exec('SELECT blocked FROM users WHERE user_id=?', USER).toArray()[0].blocked, 0);
});

test('话题被删：自动重建并重发', async () => {
  const { bot, state } = await bootstrap();
  const before = mock.of('createForumTopic').length;

  mock.behavior.failCopyOnceWith = 'Bad Request: message thread not found';
  await send(bot, userText('话题还在吗'));

  assert.equal(mock.of('createForumTopic').length, before + 1, '应重建话题');
  assert.ok(topicOf(state), '应有新话题 id');
  assert.equal(mock.of('copyMessage').length >= 1, true, '重建后要补发');
});

test('重复 update_id 只处理一次', async () => {
  const { bot } = await bootstrap();
  mock.clear();
  const u = userText('只发一次');
  await send(bot, u);
  await send(bot, u);
  assert.equal(mock.of('copyMessage').length, 1);
});

test('相册：攒齐后用 copyMessages 批量发', async () => {
  const { bot, state } = await bootstrap();
  const gid = 'alb-' + nextUpdate();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = nextMsg();
    ids.push(id);
    await send(bot, {
      update_id: nextUpdate(),
      message: {
        message_id: id,
        from: { id: USER, first_name: 'Alice' },
        chat: { id: USER, type: 'private' },
        date: 1,
        media_group_id: gid,
        photo: [{ file_id: 'p' + i, width: 10, height: 10 }],
      },
    });
  }
  assert.equal(mock.of('copyMessage').length, 0, 'alarm 之前不单发');
  assert.ok((await state.storage.getAlarm()) > 0, '应安排 alarm');

  await bot.alarm();

  const batch = mock.last('copyMessages');
  assert.ok(batch, '应批量复制');
  assert.deepEqual(batch.body.message_ids, ids);
  assert.equal(batch.body.message_thread_id, topicOf(state));
});

test('非管理群的消息一律忽略', async () => {
  const { bot } = mk();
  await send(bot, {
    update_id: nextUpdate(),
    message: {
      message_id: nextMsg(),
      from: { id: 999, first_name: 'Bob' },
      chat: { id: -1009999999999, type: 'supergroup' },
      date: 1,
      text: '别的群在聊天',
    },
  });
  assert.equal(mock.of('copyMessage').length, 0);
  assert.equal(mock.of('createForumTopic').length, 0);
});

test('未验证用户编辑消息不会泄露到群里', async () => {
  const { bot } = mk();
  const u = userText('hi');
  await send(bot, u);
  mock.clear();
  await send(bot, {
    update_id: nextUpdate(),
    edited_message: { ...u.message, text: '改了一下' },
  });
  assert.equal(mock.of('editMessageText').length, 0);
});

/* ------------------------------------------------------------------ */

async function run() {
  mock = await startMockTelegram();
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    mock.clear();
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      pass++;
    } catch (e) {
      console.log(`  ✗ ${t.name}`);
      console.log('    ' + (e && e.message ? e.message.split('\n').join('\n    ') : e));
      fail++;
    }
  }
  await mock.close();
  console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
  if (fail) process.exitCode = 1;
}

run();
