import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

/** 极简 Telegram Bot API 模拟服务：记录全部调用，按需返回失败 */
export function startMockTelegram() {
  const calls = [];
  let msgId = 5000;
  let topicId = 100;
  const behavior = {
    failCopyOnceWith: null, // 例如 'message thread not found'
    copyCounter: 0,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {}
      calls.push({ method, body });

      const send = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (behavior.failCopyOnceWith && (method === 'copyMessage' || method === 'copyMessages')) {
        const text = behavior.failCopyOnceWith;
        behavior.failCopyOnceWith = null;
        return send({ ok: false, error_code: 400, description: text });
      }

      switch (method) {
        case 'getMe':
          return send({ ok: true, result: { id: 777, is_bot: true, first_name: 'TestBot', username: 'testbot' } });
        case 'createForumTopic':
          topicId += 1;
          return send({ ok: true, result: { message_thread_id: topicId, name: body.name } });
        case 'copyMessage':
          behavior.copyCounter += 1;
          return send({ ok: true, result: { message_id: ++msgId } });
        case 'copyMessages':
          behavior.copyCounter += 1;
          return send({ ok: true, result: (body.message_ids || []).map(() => ({ message_id: ++msgId })) });
        case 'sendMessage':
          return send({ ok: true, result: { message_id: ++msgId, chat: { id: body.chat_id }, text: body.text } });
        case 'editMessageText':
        case 'editMessageCaption':
        case 'editMessageMedia':
        case 'editMessageReplyMarkup':
          return send({ ok: true, result: { message_id: body.message_id } });
        case 'setWebhook':
        case 'pinChatMessage':
        case 'deleteMessage':
        case 'answerCallbackQuery':
        case 'setMessageReaction':
        case 'editForumTopic':
          return send({ ok: true, result: true });
        case 'getWebhookInfo':
          return send({ ok: true, result: { url: 'https://example.com/webhook' } });
        default:
          return send({ ok: true, result: true });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        base: `http://127.0.0.1:${port}/bot`,
        calls,
        behavior,
        of(method) {
          return calls.filter((c) => c.method === method);
        },
        last(method) {
          const list = calls.filter((c) => c.method === method);
          return list[list.length - 1];
        },
        clear() {
          calls.length = 0;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Durable Object 的 state 垫片：用 node:sqlite 顶掉 ctx.storage.sql */
export function makeState() {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const sql = {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        return { toArray: () => stmt.all(...params) };
      }
      stmt.run(...params);
      return { toArray: () => [] };
    },
  };
  return {
    storage: {
      sql,
      async getAlarm() {
        return alarm;
      },
      async setAlarm(t) {
        alarm = t;
        return t;
      },
      __fireAlarm() {
        return alarm;
      },
      __db: db,
    },
  };
}
