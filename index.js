/**
 * Telegram 双向消息管理机器人
 * 支持多重验证、话题管理、消息转发
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';

// 验证类型配置
const VERIFICATION_TYPES = {
  MATH: 'math',           // 算数验证
  BUTTON: 'button',       // 按钮验证
  SEQUENCE: 'sequence'    // 顺序验证
};

class TelegramBot {
  constructor(env) {
    this.token = env.BOT_TOKEN;
    this.adminGroupId = env.ADMIN_GROUP_ID;
    // 移除 this.failedTopicId - 改为动态获取
    this.userState = env.USER_STATE;
    this.blacklist = env.BLACKLIST;
    this.topicMap = env.TOPIC_MAP;
    this.messageMap = env.MESSAGE_MAP;  // 新增：消息映射
  }

  // Telegram API 调用
  async callAPI(method, params = {}) {
    const url = `${TELEGRAM_API}${this.token}/${method}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      const result = await response.json();
      if (!result.ok) {
        console.error(`API Error: ${method}`);
        console.error('完整错误:', JSON.stringify(result, null, 2));
        console.error('请求参数:', JSON.stringify(params, null, 2));
      }
      return result;
    } catch (error) {
      console.error(`API Exception: ${method}`, error);
      return { ok: false, error: error.message };
    }
  }

  // 生成算数验证
  generateMathVerification() {
    const operations = ['+', '-', '×'];
    const operation = operations[Math.floor(Math.random() * operations.length)];

    let num1, num2, answer;

    switch(operation) {
      case '+':
        num1 = Math.floor(Math.random() * 50) + 1;
        num2 = Math.floor(Math.random() * 50) + 1;
        answer = num1 + num2;
        break;
      case '-':
        num1 = Math.floor(Math.random() * 50) + 20;
        num2 = Math.floor(Math.random() * num1);
        answer = num1 - num2;
        break;
      case '×':
        num1 = Math.floor(Math.random() * 12) + 1;
        num2 = Math.floor(Math.random() * 12) + 1;
        answer = num1 * num2;
        break;
    }

    const wrongAnswers = [];
    while (wrongAnswers.length < 3) {
      const wrong = answer + Math.floor(Math.random() * 10) - 5;
      if (wrong !== answer && wrong > 0 && !wrongAnswers.includes(wrong)) {
        wrongAnswers.push(wrong);
      }
    }

    const allAnswers = [answer, ...wrongAnswers].sort(() => Math.random() - 0.5);

    return {
      question: `${num1} ${operation} ${num2} = ?`,
      answer: answer.toString(),
      options: allAnswers.map(a => a.toString())
    };
  }

  // 生成按钮验证
  generateButtonVerification() {
    const emojis = ['🐱', '🐶', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼'];
    const targetEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    const otherEmojis = emojis.filter(e => e !== targetEmoji);
    const selectedOthers = [];

    while (selectedOthers.length < 3) {
      const emoji = otherEmojis[Math.floor(Math.random() * otherEmojis.length)];
      if (!selectedOthers.includes(emoji)) {
        selectedOthers.push(emoji);
      }
    }

    const allOptions = [targetEmoji, ...selectedOthers].sort(() => Math.random() - 0.5);

    return {
      question: `请点击这个表情：${targetEmoji}`,
      answer: targetEmoji,
      options: allOptions
    };
  }

  // 生成顺序验证
  generateSequenceVerification() {
    const length = 4;
    const numbers = Array.from({length}, (_, i) => i + 1);
    const sequence = numbers.join('');

    // 生成干扰数字
    const distractors = [5, 6, 7].filter(n => !numbers.includes(n));
    const selected = distractors.slice(0, 3);

    const allNumbers = [...numbers, ...selected].sort(() => Math.random() - 0.5);

    return {
      question: `请按顺序点击：${sequence}`,
      answer: sequence,
      options: allNumbers.map(n => n.toString())
    };
  }

  // 随机选择验证类型
  getRandomVerification() {
    const types = [
      VERIFICATION_TYPES.MATH,
      VERIFICATION_TYPES.BUTTON,
      VERIFICATION_TYPES.SEQUENCE
    ];
    const type = types[Math.floor(Math.random() * types.length)];

    let verification;
    switch(type) {
      case VERIFICATION_TYPES.MATH:
        verification = this.generateMathVerification();
        break;
      case VERIFICATION_TYPES.BUTTON:
        verification = this.generateButtonVerification();
        break;
      case VERIFICATION_TYPES.SEQUENCE:
        verification = this.generateSequenceVerification();
        break;
    }

    return { type, ...verification };
  }

  // 创建验证键盘
  createVerificationKeyboard(options, type) {
    const buttons = options.map(opt => ({
      text: opt,
      callback_data: `verify_${opt}`
    }));

    // 根据类型调整布局
    const keyboard = [];
    if (type === VERIFICATION_TYPES.SEQUENCE) {
      // 顺序验证：一行多个
      for (let i = 0; i < buttons.length; i += 4) {
        keyboard.push(buttons.slice(i, i + 4));
      }
    } else {
      // 其他：两列
      for (let i = 0; i < buttons.length; i += 2) {
        keyboard.push(buttons.slice(i, i + 2));
      }
    }

    return { inline_keyboard: keyboard };
  }

  // 创建顺序验证键盘（支持显示已点击）
  createSequenceKeyboard(options, clickedNumbers) {
    const buttons = options.map(opt => {
      const isClicked = clickedNumbers.includes(opt);
      return {
        text: isClicked ? `✅ ${opt}` : opt,
        callback_data: `verify_${opt}`
      };
    });

    // 一行4个
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 4) {
      keyboard.push(buttons.slice(i, i + 4));
    }

    return { inline_keyboard: keyboard };
  }

  // 发送验证消息
  async sendVerification(userId, userInfo) {
    const verification = this.getRandomVerification();

    const state = {
      type: verification.type,
      answer: verification.answer,
      options: verification.options,  // 保存选项
      attempts: [],
      remainingChances: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3 * 60 * 1000
    };

    await this.userState.put(`verify_${userId}`, JSON.stringify(state), {
      expirationTtl: 600
    });

    const typeNames = {
      [VERIFICATION_TYPES.MATH]: '算数题',
      [VERIFICATION_TYPES.BUTTON]: '选择表情',
      [VERIFICATION_TYPES.SEQUENCE]: '点击顺序'
    };

    const message = `🤖 欢迎使用本机器人！

为了防止滥用，请完成人机验证：

📝 验证类型：${typeNames[verification.type]}
❓ 问题：${verification.question}

⚠️ 注意：
• 你有 3 次机会
• 验证码 3 分钟后过期
• 失败将被拉黑`;

    await this.callAPI('sendMessage', {
      chat_id: userId,
      text: message,
      reply_markup: this.createVerificationKeyboard(verification.options, verification.type)
    });
  }

  // 处理验证回调
  async handleVerificationCallback(callbackQuery) {
    const userId = callbackQuery.from.id;
    const userAnswer = callbackQuery.data.replace('verify_', '');
    const messageId = callbackQuery.message.message_id;

    const stateData = await this.userState.get(`verify_${userId}`);
    if (!stateData) {
      await this.callAPI('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '❌ 验证已过期，请重新发送 /start',
        show_alert: true
      });
      return;
    }

    const state = JSON.parse(stateData);

    // 检查是否过期
    if (Date.now() > state.expiresAt) {
      await this.blacklistUser(userId, callbackQuery.from, '验证超时');

      // 删除用户状态（验证失败）
      await this.userState.delete(`verify_${userId}`);
      await this.userState.delete(`user_${userId}`);

      await this.callAPI('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '❌ 验证超时，已被拉黑',
        show_alert: true
      });
      return;
    }

    // 处理顺序验证
    if (state.type === VERIFICATION_TYPES.SEQUENCE) {
      state.attempts.push(userAnswer);

      if (state.attempts.join('') === state.answer) {
        // 验证成功
        await this.verifyUser(userId, callbackQuery.from);
        await this.callAPI('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: '✅ 验证成功！'
        });
        await this.callAPI('editMessageText', {
          chat_id: userId,
          message_id: messageId,
          text: '✅ 验证成功！\n\n现在您可以发送消息了。'
        });
        return;
      } else if (state.attempts.length === state.answer.length) {
        // 顺序错误
        state.remainingChances--;
        if (state.remainingChances <= 0) {
          await this.blacklistUser(userId, callbackQuery.from, '验证失败（顺序错误）');

          // 删除用户状态（验证失败）
          await this.userState.delete(`verify_${userId}`);
          await this.userState.delete(`user_${userId}`);

          await this.callAPI('answerCallbackQuery', {
            callback_query_id: callbackQuery.id,
            text: '❌ 验证失败，已被拉黑',
            show_alert: true
          });
          return;
        }

        // 重置并提示
        state.attempts = [];
        await this.userState.put(`verify_${userId}`, JSON.stringify(state), {
          expirationTtl: 600
        });
        await this.callAPI('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: `❌ 顺序错误！还有 ${state.remainingChances} 次机会`,
          show_alert: true
        });
        return;
      } else {
        // 继续输入 - 更新按钮显示
        await this.userState.put(`verify_${userId}`, JSON.stringify(state), {
          expirationTtl: 600
        });

        // 创建更新后的键盘，已点击的按钮显示 ✔
        const updatedKeyboard = this.createSequenceKeyboard(state.options, state.attempts);

        await this.callAPI('editMessageReplyMarkup', {
          chat_id: userId,
          message_id: messageId,
          reply_markup: updatedKeyboard
        });

        await this.callAPI('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: `已输入: ${state.attempts.join('')}`
        });
        return;
      }
    }

    // 处理其他验证类型
    state.attempts.push(userAnswer);

    if (userAnswer === state.answer) {
      // 验证成功
      await this.verifyUser(userId, callbackQuery.from);
      await this.callAPI('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '✅ 验证成功！'
      });
      await this.callAPI('editMessageText', {
        chat_id: userId,
        message_id: messageId,
        text: '✅ 验证成功！\n\n现在您可以发送消息了。'
      });
    } else {
      // 答案错误
      state.remainingChances--;

      if (state.remainingChances <= 0) {
        await this.blacklistUser(userId, callbackQuery.from, '验证失败（答案错误）');

        // 删除用户状态（验证失败）
        await this.userState.delete(`verify_${userId}`);
        await this.userState.delete(`user_${userId}`);

        await this.callAPI('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: '❌ 验证失败，已被拉黑',
          show_alert: true
        });
        await this.callAPI('editMessageText', {
          chat_id: userId,
          message_id: messageId,
          text: '❌ 验证失败！\n\n答案错误次数过多，您已被拉黑。'
        });
      } else {
        await this.userState.put(`verify_${userId}`, JSON.stringify(state), {
          expirationTtl: 600
        });
        await this.callAPI('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: `❌ 答案错误！还有 ${state.remainingChances} 次机会`,
          show_alert: true
        });
      }
    }
  }

  // 验证用户
  async verifyUser(userId, userInfo) {
    await this.userState.delete(`verify_${userId}`);
    await this.userState.put(`user_${userId}`, JSON.stringify({
      verified: true,
      verifiedAt: Date.now(),
      topicId: null,
      userInfo: {
        firstName: userInfo.first_name,
        lastName: userInfo.last_name || '',
        username: userInfo.username || '',
        languageCode: userInfo.language_code || ''
      }
    }));
  }

  // 拉黑用户
  async blacklistUser(userId, userInfo, reason) {
    try {
      await this.blacklist.put(`user_${userId}`, JSON.stringify({
        blacklistedAt: Date.now(),
        reason,
        userInfo: {
          firstName: userInfo.first_name,
          lastName: userInfo.last_name || '',
          username: userInfo.username || ''
        }
      }));

      const userName = userInfo.first_name + (userInfo.last_name ? ` ${userInfo.last_name}` : '');
      const username = userInfo.username ? `@${userInfo.username}` : '无';

      // 获取验证失败话题ID（自动创建如果不存在）
      const failedTopicId = await this.getFailedTopicId();
      if (!failedTopicId) {
        console.error('无法获取验证失败话题ID');
        return;
      }

      console.log(`发送验证失败记录到话题 ${failedTopicId}`);

      const result = await this.callAPI('sendMessage', {
        chat_id: this.adminGroupId,
        message_thread_id: failedTopicId,
        text: `🚫 *验证失败记录*

👤 用户信息：
• ID: \`${userId}\`
• 名字: ${userName}
• 用户名: ${username}
• 原因: ${reason}
• 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔓 解除拉黑', callback_data: `unban_${userId}` }
          ]]
        }
      });

      if (result.ok) {
        console.log('验证失败记录发送成功');
      } else {
        console.error('发送验证失败记录失败:', result);
      }
    } catch (error) {
      console.error('拉黑用户时出错:', error);
    }
  }

  // 创建用户话题
  async createUserTopic(userId, userInfo) {
    try {
      // 确保 userInfo 存在
      if (!userInfo) {
        console.error('userInfo 为空，无法创建话题');
        return null;
      }

      const userName = userInfo.firstName + (userInfo.lastName ? ` ${userInfo.lastName}` : '');
      const username = userInfo.username || '';

      // 话题名称只显示用户的 Telegram 名字
      const topicName = userName.trim();

      console.log(`创建话题: ${topicName} for user ${userId}`);

      const result = await this.callAPI('createForumTopic', {
        chat_id: this.adminGroupId,
        name: topicName
      });

      if (!result.ok) {
        console.error('API Error: createForumTopic');
        console.error('错误详情:', JSON.stringify(result));
        console.error('群组ID:', this.adminGroupId);
        console.error('话题名称:', topicName);
        return null;
      }

      const topicId = result.result.message_thread_id;
      console.log(`话题创建成功，ID: ${topicId}`);

      // 保存话题ID
      const userData = JSON.parse(await this.userState.get(`user_${userId}`) || '{}');
      userData.topicId = topicId;
      await this.userState.put(`user_${userId}`, JSON.stringify(userData));

      // 保存反向映射
      await this.topicMap.put(`topic_${topicId}`, userId.toString());

      // 获取国旗emoji
      const flagEmoji = this.getCountryFlag(userInfo.languageCode || '');

      // 创建信息卡片 - 使用 HTML 格式更稳定，添加醒目的标题
      let infoText = `<b>📋 用户信息</b>\n`;
      infoText += `━━━━━━━━━━━━━━━\n`;
      infoText += `• ID: <code>${userId}</code>\n`;
      infoText += `• 名字: ${userName}\n`;
      if (username) {
        infoText += `• 用户名: @${username}\n`;
      }
      infoText += `• 语言: ${userInfo.languageCode || 'unknown'} ${flagEmoji}\n`;
      infoText += `━━━━━━━━━━━━━━━\n`;
      infoText += `#id${userId}`;

      console.log(`准备发送信息卡片`);
      console.log(`话题ID: ${topicId}`);
      console.log(`信息内容: ${infoText}`);

      const infoMsg = await this.callAPI('sendMessage', {
        chat_id: this.adminGroupId,
        message_thread_id: topicId,
        text: infoText,
        parse_mode: 'HTML',  // 改用 HTML 模式
        reply_markup: {
          inline_keyboard: [[
            { text: '🚫 拉黑用户', callback_data: `block_${userId}` }
          ]]
        }
      });

      console.log(`信息卡片API响应:`, JSON.stringify(infoMsg));

      if (!infoMsg.ok) {
        console.error('❌ 发送信息卡片失败!');
        console.error('错误详情:', JSON.stringify(infoMsg));
        console.error('群组ID:', this.adminGroupId);
        console.error('话题ID:', topicId);
      } else {
        console.log('✅ 信息卡片发送成功');
        console.log('消息ID:', infoMsg.result.message_id);

        // 置顶信息消息到话题内
        console.log('开始置顶信息卡片...');
        console.log('置顶参数:', {
          chat_id: this.adminGroupId,
          message_id: infoMsg.result.message_id
        });

        const pinResult = await this.callAPI('pinChatMessage', {
          chat_id: this.adminGroupId,
          message_id: infoMsg.result.message_id,
          disable_notification: true  // 静默置顶，不发送通知
        });

        console.log('置顶API响应:', JSON.stringify(pinResult));

        if (pinResult.ok) {
          console.log('✅ 信息卡片置顶成功');
        } else {
          console.error('❌ 置顶失败');
          console.error('错误详情:', JSON.stringify(pinResult));
          console.error('错误码:', pinResult.error_code);
          console.error('错误描述:', pinResult.description);
          console.error('群组ID:', this.adminGroupId);
          console.error('消息ID:', infoMsg.result.message_id);
          console.error('话题ID:', topicId);

          // 常见错误提示
          if (pinResult.error_code === 400) {
            console.error('💡 可能原因：');
            console.error('   1. Bot 没有"置顶消息"权限');
            console.error('   2. Bot 不是管理员');
            console.error('   3. 群组设置不允许置顶');
          } else if (pinResult.error_code === 403) {
            console.error('💡 权限不足：Bot 需要"Pin Messages"权限');
          }
        }
      }

      return topicId;
    } catch (error) {
      console.error('创建用户话题时出错:', error);
      return null;
    }
  }


  // 获取国旗emoji
  getCountryFlag(languageCode) {
    const flags = {
      'zh': '🇨🇳',
      'zh-hans': '🇨🇳',
      'zh-hant': '🇹🇼',
      'en': '🇺🇸',
      'ru': '🇷🇺',
      'ja': '🇯🇵',
      'ko': '🇰🇷',
      'es': '🇪🇸',
      'fr': '🇫🇷',
      'de': '🇩🇪'
    };
    return flags[languageCode] || '🌐';
  }

  // 获取或创建验证失败话题
  async getFailedTopicId() {
    try {
      // 尝试从 KV 获取
      const topicId = await this.topicMap.get('topic_failed');
      if (topicId) {
        console.log(`找到已存在的验证失败话题: ${topicId}`);
        return parseInt(topicId);
      }

      // 不存在，创建新话题
      console.log('验证失败话题不存在，开始创建...');
      const result = await this.callAPI('createForumTopic', {
        chat_id: this.adminGroupId,
        name: '🚫 验证失败记录',
        icon_color: 0xFF0000,  // 红色图标
        icon_custom_emoji_id: null
      });

      if (!result.ok) {
        console.error('创建验证失败话题失败:', result);
        return null;
      }

      const newTopicId = result.result.message_thread_id;
      console.log(`验证失败话题创建成功，ID: ${newTopicId}`);

      // 保存到 KV
      await this.topicMap.put('topic_failed', newTopicId.toString());

      // 发送欢迎消息
      await this.callAPI('sendMessage', {
        chat_id: this.adminGroupId,
        message_thread_id: newTopicId,
        text: `📋 *验证失败记录话题*

此话题用于记录所有验证失败的用户。

• 验证超时
• 答案错误
• 手动拉黑

您可以在这里查看所有被拉黑的用户，并一键解除拉黑。`,
        parse_mode: 'Markdown'
      });

      return newTopicId;
    } catch (error) {
      console.error('获取验证失败话题ID时出错:', error);
      return null;
    }
  }

  // 检查话题是否为验证失败话题
  async isFailedTopic(topicId) {
    try {
      const failedTopicId = await this.topicMap.get('topic_failed');
      return failedTopicId && parseInt(failedTopicId) === topicId;
    } catch (error) {
      console.error('检查验证失败话题时出错:', error);
      return false;
    }
  }

  // 保存消息映射（优化版：使用 JSON 格式）
  async saveMessageMapping(userId, topicId, userMsgId, adminMsgId) {
    try {
      // 使用用户维度的单个 JSON 存储所有消息映射
      const mappingKey = `mapping_${userId}`;

      // 获取现有映射
      const existingData = await this.messageMap.get(mappingKey);
      let mappings = existingData ? JSON.parse(existingData) : { messages: {} };

      // 添加新映射（双向）
      mappings.messages[`u_${userMsgId}`] = {
        admin: adminMsgId,
        topic: topicId,
        time: Date.now()
      };

      mappings.messages[`a_${adminMsgId}`] = {
        user: userMsgId,
        userId: userId,
        time: Date.now()
      };

      // 清理超过100条的旧映射（保留最新的100条）
      const entries = Object.entries(mappings.messages);
      if (entries.length > 200) {  // 100条消息 = 200个映射（双向）
        // 按时间排序，保留最新的
        const sorted = entries.sort((a, b) => b[1].time - a[1].time);
        mappings.messages = Object.fromEntries(sorted.slice(0, 200));
      }

      // 保存更新后的映射
      await this.messageMap.put(mappingKey, JSON.stringify(mappings), {
        expirationTtl: 86400 * 7  // 7天过期
      });

      console.log(`保存消息映射: 用户${userId}, 用户消息${userMsgId} <-> 管理群消息${adminMsgId}`);
    } catch (error) {
      console.error('保存消息映射失败:', error);
    }
  }

  // 获取用户消息对应的管理群消息ID
  async getUserToAdminMapping(userId, userMsgId) {
    try {
      const mappingKey = `mapping_${userId}`;
      const data = await this.messageMap.get(mappingKey);

      if (!data) return null;

      const mappings = JSON.parse(data);
      const mapping = mappings.messages[`u_${userMsgId}`];

      return mapping ? mapping.admin : null;
    } catch (error) {
      console.error('获取消息映射失败:', error);
      return null;
    }
  }

  // 获取管理群消息对应的用户消息ID
  async getAdminToUserMapping(userId, adminMsgId) {
    try {
      const mappingKey = `mapping_${userId}`;
      const data = await this.messageMap.get(mappingKey);

      if (!data) return null;

      const mappings = JSON.parse(data);
      const mapping = mappings.messages[`a_${adminMsgId}`];

      return mapping ? mapping.user : null;
    } catch (error) {
      console.error('获取消息映射失败:', error);
      return null;
    }
  }

  // 转发用户消息到管理群
  async forwardUserMessage(message) {
    const userId = message.from.id;
    let userData = JSON.parse(await this.userState.get(`user_${userId}`) || '{}');

    console.log(`用户 ${userId} 发送消息`);
    console.log(`用户数据:`, userData);

    if (!userData.topicId) {
      console.log(`用户 ${userId} 还没有话题，开始创建...`);

      // 检查 userInfo
      if (!userData.userInfo) {
        console.error(`用户 ${userId} 的 userInfo 为空！`);
        await this.callAPI('sendMessage', {
          chat_id: userId,
          text: '❌ 系统错误：用户信息缺失，请重新发送 /start 验证'
        });
        return;
      }

      // 创建话题
      const topicId = await this.createUserTopic(userId, userData.userInfo);
      if (!topicId) {
        console.error(`创建话题失败，用户 ${userId}`);
        await this.callAPI('sendMessage', {
          chat_id: userId,
          text: '❌ 系统错误，请稍后重试'
        });
        return;
      }
      // 更新本地 userData
      userData.topicId = topicId;
      console.log(`话题创建完成，ID: ${topicId}`);
    }

    console.log(`转发消息到话题 ${userData.topicId}`);

    // 先回应表情
    await this.callAPI('setMessageReaction', {
      chat_id: userId,
      message_id: message.message_id,
      reaction: [{ type: 'emoji', emoji: '👍' }]
    });

    // 处理引用消息
    let replyToMessageId = null;
    if (message.reply_to_message) {
      // 查找被引用消息在管理群的 ID
      const originalMsgId = message.reply_to_message.message_id;
      const adminMsgId = await this.getUserToAdminMapping(userId, originalMsgId);
      if (adminMsgId) {
        replyToMessageId = parseInt(adminMsgId);
        console.log(`找到引用消息映射: 用户消息 ${originalMsgId} -> 管理群消息 ${adminMsgId}`);
      }
    }

    // 转发消息（支持引用）
    const copyParams = {
      chat_id: this.adminGroupId,
      message_thread_id: userData.topicId,
      from_chat_id: userId,
      message_id: message.message_id
    };

    if (replyToMessageId) {
      copyParams.reply_parameters = {
        message_id: replyToMessageId
      };
    }

    const copyResult = await this.callAPI('copyMessage', copyParams);

    if (copyResult.ok) {
      console.log(`消息转发成功`);

      // 保存消息映射（使用优化的 JSON 格式）
      await this.saveMessageMapping(
        userId,
        userData.topicId,
        message.message_id,
        copyResult.result.message_id
      );
    } else {
      console.error(`消息转发失败:`, copyResult);
    }

    // 等待1秒
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 取消表情回应
    await this.callAPI('setMessageReaction', {
      chat_id: userId,
      message_id: message.message_id,
      reaction: []
    });

    console.log(`已取消表情回应`);
  }

  // 转发管理员回复给用户
  async forwardAdminReply(message) {
    const topicId = message.message_thread_id;

    // 检查是否为验证失败话题
    if (!topicId || await this.isFailedTopic(topicId)) return;

    const userId = await this.topicMap.get(`topic_${topicId}`);
    if (!userId) return;

    // 先回应表情
    await this.callAPI('setMessageReaction', {
      chat_id: this.adminGroupId,
      message_id: message.message_id,
      reaction: [{ type: 'emoji', emoji: '👍' }]
    });

    // 处理引用消息
    let replyToMessageId = null;
    if (message.reply_to_message) {
      // 查找被引用消息在用户聊天的 ID
      const originalMsgId = message.reply_to_message.message_id;
      const userMsgId = await this.getAdminToUserMapping(userId, originalMsgId);
      if (userMsgId) {
        replyToMessageId = parseInt(userMsgId);
        console.log(`找到引用消息映射: 管理群消息 ${originalMsgId} -> 用户消息 ${userMsgId}`);
      }
    }

    // 复制消息给用户（支持引用）
    try {
      const copyParams = {
        chat_id: userId,
        from_chat_id: this.adminGroupId,
        message_id: message.message_id
      };

      if (replyToMessageId) {
        copyParams.reply_parameters = {
          message_id: replyToMessageId
        };
      }

      const copyResult = await this.callAPI('copyMessage', copyParams);

      if (copyResult.ok) {
        // 保存消息映射（使用优化的 JSON 格式）
        // 注意：这里是管理员消息ID -> 用户消息ID的映射
        await this.saveMessageMapping(
          userId,
          topicId,
          copyResult.result.message_id,  // 用户端的消息ID
          message.message_id  // 管理群的消息ID
        );
      }

      // 等待1秒
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 取消表情回应
      await this.callAPI('setMessageReaction', {
        chat_id: this.adminGroupId,
        message_id: message.message_id,
        reaction: []
      });
    } catch (error) {
      console.error('转发失败:', error);
      await this.callAPI('sendMessage', {
        chat_id: this.adminGroupId,
        message_thread_id: topicId,
        text: '⚠️ 消息发送失败，用户可能屏蔽了机器人',
        reply_to_message_id: message.message_id
      });
    }
  }

  // 处理解除拉黑回调
  async handleUnbanCallback(callbackQuery) {
    const userId = callbackQuery.data.replace('unban_', '');

    const blacklistData = await this.blacklist.get(`user_${userId}`);
    if (!blacklistData) {
      await this.callAPI('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '❌ 用户不在黑名单中',
        show_alert: true
      });
      return;
    }

    await this.blacklist.delete(`user_${userId}`);

    await this.callAPI('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '✅ 已解除拉黑'
    });

    await this.callAPI('editMessageReplyMarkup', {
      chat_id: this.adminGroupId,
      message_id: callbackQuery.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });

    // 获取验证失败话题ID
    const failedTopicId = await this.getFailedTopicId();
    if (failedTopicId) {
      await this.callAPI('sendMessage', {
        chat_id: this.adminGroupId,
        message_thread_id: failedTopicId,
        text: `✅ 已解除用户 \`${userId}\` 的拉黑\n\n操作者: ${callbackQuery.from.first_name}`,
        parse_mode: 'Markdown',
        reply_to_message_id: callbackQuery.message.message_id
      });
    }
  }

  // 处理拉黑用户回调
  async handleBlockCallback(callbackQuery) {
    const userId = callbackQuery.data.replace('block_', '');
    const topicId = callbackQuery.message.message_thread_id;

    // 检查是否已经在黑名单
    const blacklistData = await this.blacklist.get(`user_${userId}`);
    if (blacklistData) {
      await this.callAPI('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '⚠️ 用户已经在黑名单中',
        show_alert: true
      });
      return;
    }

    // 获取用户信息
    const userData = await this.userState.get(`user_${userId}`);
    if (!userData) {
      await this.callAPI('answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        text: '❌ 未找到用户信息',
        show_alert: true
      });
      return;
    }

    const user = JSON.parse(userData);
    const userInfo = user.userInfo;

    // 拉黑用户
    await this.blacklist.put(`user_${userId}`, JSON.stringify({
      blacklistedAt: Date.now(),
      reason: '管理员手动拉黑',
      blockedBy: callbackQuery.from.first_name,
      userInfo: {
        firstName: userInfo.firstName,
        lastName: userInfo.lastName || '',
        username: userInfo.username || ''
      }
    }));

    // 删除用户数据
    await this.userState.delete(`user_${userId}`);

    // 删除话题映射
    if (topicId) {
      await this.topicMap.delete(`topic_${topicId}`);
    }

    // 移除按钮
    await this.callAPI('editMessageReplyMarkup', {
      chat_id: this.adminGroupId,
      message_id: callbackQuery.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });

    await this.callAPI('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: '✅ 已拉黑用户'
    });

    // 在话题中发送拉黑通知
    await this.callAPI('sendMessage', {
      chat_id: this.adminGroupId,
      message_thread_id: topicId,
      text: `🚫 用户已被拉黑\n\n操作者: ${callbackQuery.from.first_name}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
    });

    // 在验证失败话题记录
    const userName = userInfo.firstName + (userInfo.lastName ? ` ${userInfo.lastName}` : '');
    const username = userInfo.username ? `@${userInfo.username}` : '无';

    // 获取验证失败话题ID
    const failedTopicId = await this.getFailedTopicId();
    if (failedTopicId) {
      await this.callAPI('sendMessage', {
        chat_id: this.adminGroupId,
        message_thread_id: failedTopicId,
        text: `🚫 *用户被手动拉黑*

👤 用户信息：
• ID: \`${userId}\`
• 名字: ${userName}
• 用户名: ${username}
• 原因: 管理员手动拉黑
• 操作者: ${callbackQuery.from.first_name}
• 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔓 解除拉黑', callback_data: `unban_${userId}` }
          ]]
        }
      });
    }

    console.log(`用户 ${userId} 被管理员 ${callbackQuery.from.first_name} 手动拉黑`);
  }

  // 处理用户编辑消息
  // 处理用户编辑消息
  async handleUserEditedMessage(editedMessage) {
    const userId = editedMessage.from.id;
    const messageId = editedMessage.message_id;

    // 查找对应的管理群消息
    const adminMsgId = await this.getUserToAdminMapping(userId, messageId);

    if (!adminMsgId) {
      console.log(`未找到消息映射: 用户${userId}消息${messageId}`);
      return;
    }

    // 获取用户话题ID
    const userData = JSON.parse(await this.userState.get(`user_${userId}`) || '{}');
    if (!userData.topicId) {
      console.log(`用户 ${userId} 没有话题ID`);
      return;
    }

    console.log(`用户 ${userId} 编辑了消息 ${messageId}，对应管理群消息 ${adminMsgId}`);

    // 1️⃣ 先给用户端的原始消息加表情（告诉用户编辑成功）
    await this.callAPI('setMessageReaction', {
      chat_id: userId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '✍️' }]
    });

    // 2️⃣ 编辑管理群中的消息
    if (editedMessage.text) {
      await this.callAPI('editMessageText', {
        chat_id: this.adminGroupId,
        message_id: parseInt(adminMsgId),
        text: editedMessage.text
      });
      console.log(`已同步编辑管理群消息`);
    } else if (editedMessage.caption) {
      await this.callAPI('editMessageCaption', {
        chat_id: this.adminGroupId,
        message_id: parseInt(adminMsgId),
        caption: editedMessage.caption
      });
      console.log(`已同步编辑管理群消息标题`);
    }

    // 3️⃣ 给管理群的消息加表情（告诉管理员用户编辑了）
    await this.callAPI('setMessageReaction', {
      chat_id: this.adminGroupId,
      message_id: parseInt(adminMsgId),
      reaction: [{ type: 'emoji', emoji: '✍️' }]
    });

    // 4️⃣ 等待1秒后取消双端表情
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 取消用户端表情
    await this.callAPI('setMessageReaction', {
      chat_id: userId,
      message_id: messageId,
      reaction: []
    });

    // 取消管理群表情
    await this.callAPI('setMessageReaction', {
      chat_id: this.adminGroupId,
      message_id: parseInt(adminMsgId),
      reaction: []
    });

    console.log(`编辑同步完成`);
  }

  // 处理管理员编辑消息
  async handleAdminEditedMessage(editedMessage) {
    const topicId = editedMessage.message_thread_id;

    // 检查是否为验证失败话题
    if (!topicId || await this.isFailedTopic(topicId)) return;

    const messageId = editedMessage.message_id;

    // 获取话题对应的用户ID
    const userId = await this.topicMap.get(`topic_${topicId}`);
    if (!userId) {
      console.log(`未找到话题 ${topicId} 对应的用户`);
      return;
    }

    // 查找对应的用户消息
    const userMsgId = await this.getAdminToUserMapping(userId, messageId);

    if (!userMsgId) {
      console.log(`未找到消息映射: 管理群消息${messageId}`);
      return;
    }

    console.log(`管理员编辑了消息 ${messageId}，对应用户 ${userId} 的消息 ${userMsgId}`);

    // 1️⃣ 先给管理群的原始消息加表情（告诉管理员编辑成功）
    await this.callAPI('setMessageReaction', {
      chat_id: this.adminGroupId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '✍️' }]
    });

    // 2️⃣ 编辑用户聊天中的消息
    if (editedMessage.text) {
      await this.callAPI('editMessageText', {
        chat_id: userId,
        message_id: parseInt(userMsgId),
        text: editedMessage.text
      });
      console.log(`已同步编辑用户消息`);
    } else if (editedMessage.caption) {
      await this.callAPI('editMessageCaption', {
        chat_id: userId,
        message_id: parseInt(userMsgId),
        caption: editedMessage.caption
      });
      console.log(`已同步编辑用户消息标题`);
    }

    // 3️⃣ 给用户端的消息加表情（告诉用户管理员编辑了回复）
    await this.callAPI('setMessageReaction', {
      chat_id: userId,
      message_id: parseInt(userMsgId),
      reaction: [{ type: 'emoji', emoji: '✍️' }]
    });

    // 4️⃣ 等待1秒后取消双端表情
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 取消管理群表情
    await this.callAPI('setMessageReaction', {
      chat_id: this.adminGroupId,
      message_id: messageId,
      reaction: []
    });

    // 取消用户端表情
    await this.callAPI('setMessageReaction', {
      chat_id: userId,
      message_id: parseInt(userMsgId),
      reaction: []
    });

    console.log(`编辑同步完成`);
  }

  // 处理命令
  async handleCommand(message) {
    const text = message.text;
    const userId = message.from.id;

    if (text === '/start') {
      // 检查黑名单
      const blacklisted = await this.blacklist.get(`user_${userId}`);
      if (blacklisted) {
        await this.callAPI('sendMessage', {
          chat_id: userId,
          text: '❌ 您已被拉黑，无法使用本机器人'
        });
        return;
      }

      // 检查是否已验证
      const userData = await this.userState.get(`user_${userId}`);
      if (userData) {
        const user = JSON.parse(userData);
        if (user.verified) {
          await this.callAPI('sendMessage', {
            chat_id: userId,
            text: '✅ 您已完成验证，可以直接发送消息'
          });
          return;
        }
      }

      // 发送验证
      await this.sendVerification(userId, message.from);
    }
  }

  // 处理未验证用户的消息
  async handleUnverifiedMessage(message) {
    const userId = message.from.id;

    // 检查黑名单
    const blacklisted = await this.blacklist.get(`user_${userId}`);
    if (blacklisted) {
      await this.callAPI('sendMessage', {
        chat_id: userId,
        text: '❌ 您已被拉黑，无法使用本机器人'
      });
      return;
    }

    // 检查是否已验证
    const userData = await this.userState.get(`user_${userId}`);
    if (userData) {
      const user = JSON.parse(userData);
      if (user.verified) {
        // 已验证，转发消息
        await this.forwardUserMessage(message);
        return;
      }
    }

    // 未验证，发送验证
    await this.sendVerification(userId, message.from);
  }

  // 处理更新
  async handleUpdate(update) {
    try {
      // 处理回调查询
      if (update.callback_query) {
        const data = update.callback_query.data;

        if (data.startsWith('verify_')) {
          await this.handleVerificationCallback(update.callback_query);
        } else if (data.startsWith('unban_')) {
          await this.handleUnbanCallback(update.callback_query);
        } else if (data.startsWith('block_')) {
          await this.handleBlockCallback(update.callback_query);
        }
        return;
      }

      // 处理编辑消息
      if (update.edited_message) {
        const editedMessage = update.edited_message;
        const chatId = editedMessage.chat.id;
        const userId = editedMessage.from.id;

        // 私聊编辑消息
        if (chatId === userId) {
          // 检查用户是否已验证
          const userData = await this.userState.get(`user_${userId}`);
          if (userData) {
            const user = JSON.parse(userData);
            if (user.verified) {
              await this.handleUserEditedMessage(editedMessage);
            }
          }
        }
        // 管理群编辑消息
        else if (chatId.toString() === this.adminGroupId) {
          await this.handleAdminEditedMessage(editedMessage);
        }
        return;
      }

      // 处理消息
      if (update.message) {
        const message = update.message;
        const userId = message.from.id;
        const chatId = message.chat.id;

        // 处理命令
        if (message.text && message.text.startsWith('/')) {
          if (chatId === userId) {
            await this.handleCommand(message);
          }
          return;
        }

        // 私聊消息
        if (chatId === userId) {
          // 使用新的处理函数，会自动检查验证状态
          await this.handleUnverifiedMessage(message);
        }
        // 管理群消息
        else if (chatId.toString() === this.adminGroupId) {
          // 检查是否有话题ID且不是验证失败话题
          if (message.message_thread_id && !(await this.isFailedTopic(message.message_thread_id))) {
            await this.forwardAdminReply(message);
          }
        }
      }
    } catch (error) {
      console.error('处理更新时出错:', error);
    }
  }
}

// Cloudflare Workers 入口
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bot = new TelegramBot(env);

    // Webhook 端点
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const update = await request.json();
      await bot.handleUpdate(update);
      return new Response('OK', { status: 200 });
    }

    // 设置 Webhook
    if (url.pathname === '/setup' && request.method === 'GET') {
      const webhookUrl = `${url.origin}/webhook`;
      const result = await bot.callAPI('setWebhook', {
        url: webhookUrl,
        drop_pending_updates: true
      });
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 获取 Webhook 信息
    if (url.pathname === '/info' && request.method === 'GET') {
      const result = await bot.callAPI('getWebhookInfo', {});
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Telegram Bot is running', { status: 200 });
  }
};