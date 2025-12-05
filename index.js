/**
 * Telegram 双向消息管理机器人 (最终完整版)
 * * 功能特性：
 * 1. 单一 KV 绑定 (env.BOT_KV)
 * 2. 多重人机验证 (算数/按钮/顺序)
 * 3. 话题自动管理与消息双向转发
 * 4. 消息编辑同步 (支持文本和媒体)
 * 5. 消息删除同步 (回复 /delete 或 删除)
 * 6. 黑名单系统 (自动/手动，带日志记录)
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

        // [核心] 单一 KV 绑定
        this.kv = env.BOT_KV;
    }

    // Telegram API 调用
    async callAPI(method, params = {}) {
        const url = `${TELEGRAM_API}${this.token}/${method}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
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
            return {ok: false, error: error.message};
        }
    }

    // ==========================================
    // 1. 验证码生成模块
    // ==========================================

    generateMathVerification() {
        const operations = ['+', '-', '×'];
        const operation = operations[Math.floor(Math.random() * operations.length)];
        let num1, num2, answer;

        switch (operation) {
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
            if (wrong !== answer && wrong > 0 && !wrongAnswers.includes(wrong)) wrongAnswers.push(wrong);
        }
        const allAnswers = [answer, ...wrongAnswers].sort(() => Math.random() - 0.5);

        return {
            question: `${num1} ${operation} ${num2} = ?`,
            answer: answer.toString(),
            options: allAnswers.map(a => a.toString())
        };
    }

    generateButtonVerification() {
        const emojis = ['🐱', '🐶', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼'];
        const targetEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        const otherEmojis = emojis.filter(e => e !== targetEmoji);
        const selectedOthers = [];
        while (selectedOthers.length < 3) {
            const emoji = otherEmojis[Math.floor(Math.random() * otherEmojis.length)];
            if (!selectedOthers.includes(emoji)) selectedOthers.push(emoji);
        }
        const allOptions = [targetEmoji, ...selectedOthers].sort(() => Math.random() - 0.5);
        return {question: `请点击这个表情：${targetEmoji}`, answer: targetEmoji, options: allOptions};
    }

    generateSequenceVerification() {
        const length = 4;
        const numbers = Array.from({length}, (_, i) => i + 1);
        const sequence = numbers.join('');
        const distractors = [5, 6, 7].filter(n => !numbers.includes(n));
        const selected = distractors.slice(0, 3);
        const allNumbers = [...numbers, ...selected].sort(() => Math.random() - 0.5);
        return {question: `请按顺序点击：${sequence}`, answer: sequence, options: allNumbers.map(n => n.toString())};
    }

    getRandomVerification() {
        const types = [VERIFICATION_TYPES.MATH, VERIFICATION_TYPES.BUTTON, VERIFICATION_TYPES.SEQUENCE];
        const type = types[Math.floor(Math.random() * types.length)];
        let verification;
        switch (type) {
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
        return {type, ...verification};
    }

    createVerificationKeyboard(options, type) {
        const buttons = options.map(opt => ({text: opt, callback_data: `verify_${opt}`}));
        const keyboard = [];
        if (type === VERIFICATION_TYPES.SEQUENCE) {
            for (let i = 0; i < buttons.length; i += 4) keyboard.push(buttons.slice(i, i + 4));
        } else {
            for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
        }
        return {inline_keyboard: keyboard};
    }

    createSequenceKeyboard(options, clickedNumbers) {
        const buttons = options.map(opt => {
            const isClicked = clickedNumbers.includes(opt);
            return {text: isClicked ? `✅ ${opt}` : opt, callback_data: `verify_${opt}`};
        });
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 4) keyboard.push(buttons.slice(i, i + 4));
        return {inline_keyboard: keyboard};
    }

    // ==========================================
    // 2. 验证流程与用户状态
    // ==========================================

    async sendVerification(userId, userInfo) {
        const verification = this.getRandomVerification();
        const state = {
            type: verification.type,
            answer: verification.answer,
            options: verification.options,
            attempts: [],
            remainingChances: 3,
            createdAt: Date.now(),
            expiresAt: Date.now() + 3 * 60 * 1000
        };

        // KV Key: verify_{userId}
        await this.kv.put(`verify_${userId}`, JSON.stringify(state), {expirationTtl: 600});

        const typeNames = {
            [VERIFICATION_TYPES.MATH]: '算数题',
            [VERIFICATION_TYPES.BUTTON]: '选择表情',
            [VERIFICATION_TYPES.SEQUENCE]: '点击顺序'
        };
        const message = `🤖 欢迎使用本机器人！\n\n为了防止滥用，请完成人机验证：\n\n📝 验证类型：${typeNames[verification.type]}\n❓ 问题：${verification.question}\n\n⚠️ 注意：\n• 你有 3 次机会\n• 验证码 3 分钟后过期\n• 失败将被拉黑`;

        await this.callAPI('sendMessage', {
            chat_id: userId,
            text: message,
            reply_markup: this.createVerificationKeyboard(verification.options, verification.type)
        });
    }

    async handleVerificationCallback(callbackQuery) {
        const userId = callbackQuery.from.id;
        const userAnswer = callbackQuery.data.replace('verify_', '');
        const messageId = callbackQuery.message.message_id;

        const stateData = await this.kv.get(`verify_${userId}`);
        if (!stateData) {
            await this.callAPI('answerCallbackQuery', {
                callback_query_id: callbackQuery.id,
                text: '❌ 验证已过期，请重新发送 /start',
                show_alert: true
            });
            return;
        }

        const state = JSON.parse(stateData);

        if (Date.now() > state.expiresAt) {
            await this.blacklistUser(userId, callbackQuery.from, '验证超时');
            await this.kv.delete(`verify_${userId}`);
            await this.kv.delete(`user_${userId}`);
            await this.callAPI('answerCallbackQuery', {
                callback_query_id: callbackQuery.id,
                text: '❌ 验证超时，已被拉黑',
                show_alert: true
            });
            return;
        }

        // 顺序验证逻辑
        if (state.type === VERIFICATION_TYPES.SEQUENCE) {
            state.attempts.push(userAnswer);
            if (state.attempts.join('') === state.answer) {
                await this.verifyUser(userId, callbackQuery.from);
                await this.callAPI('answerCallbackQuery', {callback_query_id: callbackQuery.id, text: '✅ 验证成功！'});
                await this.callAPI('editMessageText', {
                    chat_id: userId,
                    message_id: messageId,
                    text: '✅ 验证成功！\n\n现在您可以发送消息了。'
                });
                return;
            } else if (state.attempts.length === state.answer.length) {
                state.remainingChances--;
                if (state.remainingChances <= 0) {
                    await this.blacklistUser(userId, callbackQuery.from, '验证失败（顺序错误）');
                    await this.kv.delete(`verify_${userId}`);
                    await this.kv.delete(`user_${userId}`);
                    await this.callAPI('answerCallbackQuery', {
                        callback_query_id: callbackQuery.id,
                        text: '❌ 验证失败，已被拉黑',
                        show_alert: true
                    });
                    return;
                }
                state.attempts = [];
                await this.kv.put(`verify_${userId}`, JSON.stringify(state), {expirationTtl: 600});
                await this.callAPI('answerCallbackQuery', {
                    callback_query_id: callbackQuery.id,
                    text: `❌ 顺序错误！还有 ${state.remainingChances} 次机会`,
                    show_alert: true
                });
                return;
            } else {
                await this.kv.put(`verify_${userId}`, JSON.stringify(state), {expirationTtl: 600});
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

        // 普通验证逻辑
        state.attempts.push(userAnswer);
        if (userAnswer === state.answer) {
            await this.verifyUser(userId, callbackQuery.from);
            await this.callAPI('answerCallbackQuery', {callback_query_id: callbackQuery.id, text: '✅ 验证成功！'});
            await this.callAPI('editMessageText', {
                chat_id: userId,
                message_id: messageId,
                text: '✅ 验证成功！\n\n现在您可以发送消息了。'
            });
        } else {
            state.remainingChances--;
            if (state.remainingChances <= 0) {
                await this.blacklistUser(userId, callbackQuery.from, '验证失败（答案错误）');
                await this.kv.delete(`verify_${userId}`);
                await this.kv.delete(`user_${userId}`);
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
                await this.kv.put(`verify_${userId}`, JSON.stringify(state), {expirationTtl: 600});
                await this.callAPI('answerCallbackQuery', {
                    callback_query_id: callbackQuery.id,
                    text: `❌ 答案错误！还有 ${state.remainingChances} 次机会`,
                    show_alert: true
                });
            }
        }
    }

    async verifyUser(userId, userInfo) {
        await this.kv.delete(`verify_${userId}`);
        // KV Key: user_{userId}
        await this.kv.put(`user_${userId}`, JSON.stringify({
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

    // ==========================================
    // 3. 黑名单与话题管理
    // ==========================================

    async blacklistUser(userId, userInfo, reason) {
        try {
            // [修复] KV Key: blacklist_user_{userId} (避免与 user_ 冲突)
            await this.kv.put(`blacklist_user_${userId}`, JSON.stringify({
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
            const failedTopicId = await this.getFailedTopicId();

            if (failedTopicId) {
                await this.callAPI('sendMessage', {
                    chat_id: this.adminGroupId,
                    message_thread_id: failedTopicId,
                    text: `🚫 *验证失败记录*\n\n👤 用户信息：\n• ID: \`${userId}\`\n• 名字: ${userName}\n• 用户名: ${username}\n• 原因: ${reason}\n• 时间: ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`,
                    parse_mode: 'Markdown',
                    reply_markup: {inline_keyboard: [[{text: '🔓 解除拉黑', callback_data: `unban_${userId}`}]]}
                });
            }
        } catch (error) {
            console.error('拉黑用户时出错:', error);
        }
    }

    async createUserTopic(userId, userInfo) {
        try {
            if (!userInfo) return null;
            const userName = userInfo.firstName + (userInfo.lastName ? ` ${userInfo.lastName}` : '');
            const username = userInfo.username || '';
            const topicName = userName.trim();

            const result = await this.callAPI('createForumTopic', {chat_id: this.adminGroupId, name: topicName});
            if (!result.ok) return null;

            const topicId = result.result.message_thread_id;

            // 更新用户数据
            const userData = JSON.parse(await this.kv.get(`user_${userId}`) || '{}');
            userData.topicId = topicId;
            await this.kv.put(`user_${userId}`, JSON.stringify(userData));

            // 建立映射 KV Key: topic_{topicId}
            await this.kv.put(`topic_${topicId}`, userId.toString());

            const flagEmoji = this.getCountryFlag(userInfo.languageCode || '');
            let infoText = `<b>📋 用户信息</b>\n━━━━━━━━━━━━━━━\n• ID: <code>${userId}</code>\n• 名字: ${userName}\n`;
            if (username) infoText += `• 用户名: @${username}\n`;
            infoText += `• 语言: ${userInfo.languageCode || 'unknown'} ${flagEmoji}\n━━━━━━━━━━━━━━━\n#id${userId}`;

            const infoMsg = await this.callAPI('sendMessage', {
                chat_id: this.adminGroupId,
                message_thread_id: topicId,
                text: infoText,
                parse_mode: 'HTML',
                reply_markup: {inline_keyboard: [[{text: '🚫 拉黑用户', callback_data: `block_${userId}`}]]}
            });

            if (infoMsg.ok) {
                await this.callAPI('pinChatMessage', {
                    chat_id: this.adminGroupId,
                    message_id: infoMsg.result.message_id,
                    disable_notification: true
                });
            }
            return topicId;
        } catch (error) {
            console.error('创建用户话题时出错:', error);
            return null;
        }
    }

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

    async getFailedTopicId() {
        try {
            const topicId = await this.kv.get('topic_failed');
            if (topicId) return parseInt(topicId);

            const result = await this.callAPI('createForumTopic', {
                chat_id: this.adminGroupId,
                name: 'Logs',
                icon_color: 0xFF0000
            });
            if (!result.ok) return null;

            const newTopicId = result.result.message_thread_id;
            await this.kv.put('topic_failed', newTopicId.toString());

            await this.callAPI('sendMessage', {
                chat_id: this.adminGroupId,
                message_thread_id: newTopicId,
                text: `📋 *验证失败记录话题*\n\n此话题用于记录所有验证失败的用户。\n• 验证超时\n• 答案错误\n• 手动拉黑`,
                parse_mode: 'Markdown'
            });
            return newTopicId;
        } catch (error) {
            return null;
        }
    }

    async isFailedTopic(topicId) {
        const failedTopicId = await this.kv.get('topic_failed');
        return failedTopicId && parseInt(failedTopicId) === topicId;
    }

    // ==========================================
    // 4. 消息映射与同步
    // ==========================================

    // [新增] 移除消息映射
    async removeMessageMapping(userId, userMsgId, adminMsgId) {
        try {
            const mappingKey = `mapping_${userId}`;
            const existingData = await this.kv.get(mappingKey);
            if (!existingData) return;

            let mappings = JSON.parse(existingData);

            // 删除双向映射
            if (userMsgId) delete mappings.messages[`u_${userMsgId}`];
            if (adminMsgId) delete mappings.messages[`a_${adminMsgId}`];

            // 保存修改后的数据
            await this.kv.put(mappingKey, JSON.stringify(mappings));
            console.log(`已删除消息映射: u_${userMsgId} <-> a_${adminMsgId}`);
        } catch (error) {
            console.error('删除消息映射失败:', error);
        }
    }

    async saveMessageMapping(userId, topicId, userMsgId, adminMsgId) {
        try {
            // KV Key: mapping_{userId}
            const mappingKey = `mapping_${userId}`;
            const existingData = await this.kv.get(mappingKey);
            let mappings = existingData ? JSON.parse(existingData) : {messages: {}};

            mappings.messages[`u_${userMsgId}`] = {admin: adminMsgId, topic: topicId, time: Date.now()};
            mappings.messages[`a_${adminMsgId}`] = {user: userMsgId, userId: userId, time: Date.now()};

            const entries = Object.entries(mappings.messages);
            if (entries.length > 200) {
                const sorted = entries.sort((a, b) => b[1].time - a[1].time);
                mappings.messages = Object.fromEntries(sorted.slice(0, 200));
            }

            await this.kv.put(mappingKey, JSON.stringify(mappings), {expirationTtl: 86400 * 7});
        } catch (error) {
            console.error('保存消息映射失败:', error);
        }
    }

    async getUserToAdminMapping(userId, userMsgId) {
        try {
            const data = await this.kv.get(`mapping_${userId}`);
            if (!data) return null;
            const mappings = JSON.parse(data);
            const mapping = mappings.messages[`u_${userMsgId}`];
            return mapping ? mapping.admin : null;
        } catch (error) {
            return null;
        }
    }

    async getAdminToUserMapping(userId, adminMsgId) {
        try {
            const data = await this.kv.get(`mapping_${userId}`);
            if (!data) return null;
            const mappings = JSON.parse(data);
            const mapping = mappings.messages[`a_${adminMsgId}`];
            return mapping ? mapping.user : null;
        } catch (error) {
            return null;
        }
    }

    async forwardUserMessage(message) {
        const userId = message.from.id;
        let userData = JSON.parse(await this.kv.get(`user_${userId}`) || '{}');

        if (!userData.topicId) {
            if (!userData.userInfo) {
                await this.callAPI('sendMessage', {chat_id: userId, text: '❌ 系统错误：用户信息缺失，请重新验证'});
                return;
            }
            const topicId = await this.createUserTopic(userId, userData.userInfo);
            if (!topicId) {
                await this.callAPI('sendMessage', {chat_id: userId, text: '❌ 系统错误，请稍后重试'});
                return;
            }
            userData.topicId = topicId;
        }

        await this.callAPI('setMessageReaction', {
            chat_id: userId,
            message_id: message.message_id,
            reaction: [{type: 'emoji', emoji: '👍'}]
        });

        let replyToMessageId = null;
        if (message.reply_to_message) {
            const adminMsgId = await this.getUserToAdminMapping(userId, message.reply_to_message.message_id);
            if (adminMsgId) replyToMessageId = parseInt(adminMsgId);
        }

        const copyParams = {
            chat_id: this.adminGroupId,
            message_thread_id: userData.topicId,
            from_chat_id: userId,
            message_id: message.message_id
        };
        if (replyToMessageId) copyParams.reply_parameters = {message_id: replyToMessageId};

        const copyResult = await this.callAPI('copyMessage', copyParams);

        if (copyResult.ok) {
            await this.saveMessageMapping(userId, userData.topicId, message.message_id, copyResult.result.message_id);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.callAPI('setMessageReaction', {chat_id: userId, message_id: message.message_id, reaction: []});
    }

    async forwardAdminReply(message) {
        const topicId = message.message_thread_id;
        if (!topicId || await this.isFailedTopic(topicId)) return;

        const userId = await this.kv.get(`topic_${topicId}`);
        if (!userId) return;

        await this.callAPI('setMessageReaction', {
            chat_id: this.adminGroupId,
            message_id: message.message_id,
            reaction: [{type: 'emoji', emoji: '👍'}]
        });

        let replyToMessageId = null;
        if (message.reply_to_message) {
            const userMsgId = await this.getAdminToUserMapping(userId, message.reply_to_message.message_id);
            if (userMsgId) replyToMessageId = parseInt(userMsgId);
        }

        try {
            const copyParams = {chat_id: userId, from_chat_id: this.adminGroupId, message_id: message.message_id};
            if (replyToMessageId) copyParams.reply_parameters = {message_id: replyToMessageId};

            const copyResult = await this.callAPI('copyMessage', copyParams);

            if (copyResult.ok) {
                await this.saveMessageMapping(userId, topicId, copyResult.result.message_id, message.message_id);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.callAPI('setMessageReaction', {
                chat_id: this.adminGroupId,
                message_id: message.message_id,
                reaction: []
            });
        } catch (error) {
            await this.callAPI('sendMessage', {
                chat_id: this.adminGroupId,
                message_thread_id: topicId,
                text: '⚠️ 消息发送失败，用户可能屏蔽了机器人',
                reply_to_message_id: message.message_id
            });
        }
    }

    // ==========================================
    // 5. 管理员操作 (解除/拉黑/删除)
    // ==========================================

    async handleUnbanCallback(callbackQuery) {
        const userId = callbackQuery.data.replace('unban_', '');
        const blacklistData = await this.kv.get(`blacklist_user_${userId}`);
        if (!blacklistData) {
            await this.callAPI('answerCallbackQuery', {
                callback_query_id: callbackQuery.id,
                text: '❌ 用户不在黑名单中',
                show_alert: true
            });
            return;
        }

        await this.kv.delete(`blacklist_user_${userId}`);
        await this.callAPI('answerCallbackQuery', {callback_query_id: callbackQuery.id, text: '✅ 已解除拉黑'});
        await this.callAPI('editMessageReplyMarkup', {
            chat_id: this.adminGroupId,
            message_id: callbackQuery.message.message_id,
            reply_markup: {inline_keyboard: []}
        });

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

    async handleBlockCallback(callbackQuery) {
        const userId = callbackQuery.data.replace('block_', '');
        const topicId = callbackQuery.message.message_thread_id;

        const blacklistData = await this.kv.get(`blacklist_user_${userId}`);
        if (blacklistData) {
            await this.callAPI('answerCallbackQuery', {
                callback_query_id: callbackQuery.id,
                text: '⚠️ 用户已经在黑名单中',
                show_alert: true
            });
            return;
        }

        const userData = await this.kv.get(`user_${userId}`);
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

        await this.kv.put(`blacklist_user_${userId}`, JSON.stringify({
            blacklistedAt: Date.now(),
            reason: '管理员手动拉黑',
            blockedBy: callbackQuery.from.first_name,
            userInfo: userInfo
        }));

        await this.kv.delete(`user_${userId}`);
        if (topicId) await this.kv.delete(`topic_${topicId}`);

        await this.callAPI('editMessageReplyMarkup', {
            chat_id: this.adminGroupId,
            message_id: callbackQuery.message.message_id,
            reply_markup: {inline_keyboard: []}
        });
        await this.callAPI('answerCallbackQuery', {callback_query_id: callbackQuery.id, text: '✅ 已拉黑用户'});
        await this.callAPI('sendMessage', {
            chat_id: this.adminGroupId,
            message_thread_id: topicId,
            text: `🚫 用户已被拉黑\n\n操作者: ${callbackQuery.from.first_name}`
        });

        const failedTopicId = await this.getFailedTopicId();
        if (failedTopicId) {
            const userName = userInfo.firstName + (userInfo.lastName ? ` ${userInfo.lastName}` : '');
            const username = userInfo.username ? `@${userInfo.username}` : '无';

            // [手动拉黑信息卡片]
            await this.callAPI('sendMessage', {
                chat_id: this.adminGroupId,
                message_thread_id: failedTopicId,
                text: `🚫 *用户被手动拉黑*\n\n👤 用户信息：\n• ID: \`${userId}\`\n• 名字: ${userName}\n• 用户名: ${username}\n• 原因: 管理员手动拉黑\n• 操作者: ${callbackQuery.from.first_name}\n• 时间: ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`,
                parse_mode: 'Markdown',
                reply_markup: {inline_keyboard: [[{text: '🔓 解除拉黑', callback_data: `unban_${userId}`}]]}
            });
        }
    }

    // [新增] 处理用户删除命令
    async handleUserDeleteCommand(message) {
        try {
            const userId = message.from.id;
            const commandMsgId = message.message_id;
            const repliedToId = message.reply_to_message.message_id;

            const mappingKey = `mapping_${userId}`;
            const existingData = await this.kv.get(mappingKey);
            if (!existingData) return;

            const mappings = JSON.parse(existingData);
            let userMsgId, adminMsgId;

            if (mappings.messages[`u_${repliedToId}`]) {
                userMsgId = repliedToId;
                adminMsgId = mappings.messages[`u_${repliedToId}`].admin;
            } else if (mappings.messages[`a_${repliedToId}`]) {
                adminMsgId = repliedToId;
                userMsgId = mappings.messages[`a_${repliedToId}`].user;
            } else {
                await this.callAPI('deleteMessage', {chat_id: userId, message_id: commandMsgId});
                return;
            }

            // 执行删除
            await this.callAPI('deleteMessage', {chat_id: this.adminGroupId, message_id: adminMsgId});
            await this.callAPI('deleteMessage', {chat_id: userId, message_id: userMsgId});
            await this.callAPI('deleteMessage', {chat_id: userId, message_id: commandMsgId});

            // 清理 KV
            await this.removeMessageMapping(userId, userMsgId, adminMsgId);

        } catch (error) {
            console.error('处理用户删除命令时出错:', error);
            try {
                await this.callAPI('deleteMessage', {chat_id: message.from.id, message_id: message.message_id});
            } catch (e) {
            }
        }
    }

    // [新增] 处理管理员删除命令
    async handleAdminDeleteCommand(message) {
        try {
            const topicId = message.message_thread_id;
            const commandMsgId = message.message_id;
            const repliedToId = message.reply_to_message.message_id;

            if (!topicId || await this.isFailedTopic(topicId)) return;

            const userId = await this.kv.get(`topic_${topicId}`);
            if (!userId) return;

            const mappingKey = `mapping_${userId}`;
            const existingData = await this.kv.get(mappingKey);
            if (!existingData) return;

            const mappings = JSON.parse(existingData);
            let userMsgId, adminMsgId;

            const mapping = mappings.messages[`a_${repliedToId}`];

            if (mapping) {
                userMsgId = mapping.user;
                adminMsgId = repliedToId;
            } else {
                const reverseMappingKey = Object.keys(mappings.messages).find(key =>
                    key.startsWith('u_') && mappings.messages[key].admin == repliedToId
                );
                if (reverseMappingKey) {
                    userMsgId = reverseMappingKey.replace('u_', '');
                    adminMsgId = repliedToId;
                } else {
                    await this.callAPI('deleteMessage', {chat_id: this.adminGroupId, message_id: commandMsgId});
                    return;
                }
            }

            await this.callAPI('deleteMessage', {chat_id: userId, message_id: userMsgId});
            await this.callAPI('deleteMessage', {chat_id: this.adminGroupId, message_id: adminMsgId});
            await this.callAPI('deleteMessage', {chat_id: this.adminGroupId, message_id: commandMsgId});

            await this.removeMessageMapping(userId, userMsgId, adminMsgId);

        } catch (error) {
            console.error('处理管理员删除命令时出错:', error);
            try {
                await this.callAPI('deleteMessage', {chat_id: message.chat.id, message_id: message.message_id});
            } catch (e) {
            }
        }
    }

    // ==========================================
    // 6. 消息编辑同步 (修复媒体编辑)
    // ==========================================

    async handleUserEditedMessage(editedMessage) {
        const userId = editedMessage.from.id;
        const messageId = editedMessage.message_id;
        const adminMsgId = await this.getUserToAdminMapping(userId, messageId);
        if (!adminMsgId) return;

        const userData = JSON.parse(await this.kv.get(`user_${userId}`) || '{}');
        if (!userData.topicId) return;

        await this.callAPI('setMessageReaction', {
            chat_id: userId,
            message_id: messageId,
            reaction: [{type: 'emoji', emoji: '✍️'}]
        });

        try {
            if (editedMessage.text) {
                await this.callAPI('editMessageText', {
                    chat_id: this.adminGroupId, message_id: parseInt(adminMsgId), text: editedMessage.text
                });
            } else if (editedMessage.photo || editedMessage.video || editedMessage.document || editedMessage.audio) {
                // [修复] 使用 editMessageMedia 处理媒体编辑
                let inputMedia;
                if (editedMessage.photo) inputMedia = {
                    type: 'photo',
                    media: editedMessage.photo[editedMessage.photo.length - 1].file_id,
                    caption: editedMessage.caption || ''
                };
                else if (editedMessage.video) inputMedia = {
                    type: 'video',
                    media: editedMessage.video.file_id,
                    caption: editedMessage.caption || ''
                };
                else if (editedMessage.document) inputMedia = {
                    type: 'document',
                    media: editedMessage.document.file_id,
                    caption: editedMessage.caption || ''
                };
                else if (editedMessage.audio) inputMedia = {
                    type: 'audio',
                    media: editedMessage.audio.file_id,
                    caption: editedMessage.caption || ''
                };

                const mediaRes = await this.callAPI('editMessageMedia', {
                    chat_id: this.adminGroupId,
                    message_id: parseInt(adminMsgId),
                    media: inputMedia
                });
                if (!mediaRes.ok) {
                    // 如果媒体没变，尝试只更新 caption
                    await this.callAPI('editMessageCaption', {
                        chat_id: this.adminGroupId,
                        message_id: parseInt(adminMsgId),
                        caption: editedMessage.caption || ''
                    });
                }
            } else if (typeof editedMessage.caption === 'string') {
                await this.callAPI('editMessageCaption', {
                    chat_id: this.adminGroupId,
                    message_id: parseInt(adminMsgId),
                    caption: editedMessage.caption
                });
            }
        } catch (e) {
            console.error(e);
        }

        await this.callAPI('setMessageReaction', {
            chat_id: this.adminGroupId,
            message_id: parseInt(adminMsgId),
            reaction: [{type: 'emoji', emoji: '✍️'}]
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.callAPI('setMessageReaction', {chat_id: userId, message_id: messageId, reaction: []});
        await this.callAPI('setMessageReaction', {
            chat_id: this.adminGroupId,
            message_id: parseInt(adminMsgId),
            reaction: []
        });
    }

    async handleAdminEditedMessage(editedMessage) {
        const topicId = editedMessage.message_thread_id;
        if (!topicId || await this.isFailedTopic(topicId)) return;
        const messageId = editedMessage.message_id;
        const userId = await this.kv.get(`topic_${topicId}`);
        if (!userId) return;
        const userMsgId = await this.getAdminToUserMapping(userId, messageId);
        if (!userMsgId) return;

        await this.callAPI('setMessageReaction', {
            chat_id: this.adminGroupId,
            message_id: messageId,
            reaction: [{type: 'emoji', emoji: '✍️'}]
        });

        try {
            if (editedMessage.text) {
                await this.callAPI('editMessageText', {
                    chat_id: userId,
                    message_id: parseInt(userMsgId),
                    text: editedMessage.text
                });
            } else if (editedMessage.photo || editedMessage.video || editedMessage.document || editedMessage.audio) {
                let inputMedia;
                if (editedMessage.photo) inputMedia = {
                    type: 'photo',
                    media: editedMessage.photo[editedMessage.photo.length - 1].file_id,
                    caption: editedMessage.caption || ''
                };
                else if (editedMessage.video) inputMedia = {
                    type: 'video',
                    media: editedMessage.video.file_id,
                    caption: editedMessage.caption || ''
                };
                else if (editedMessage.document) inputMedia = {
                    type: 'document',
                    media: editedMessage.document.file_id,
                    caption: editedMessage.caption || ''
                };
                else if (editedMessage.audio) inputMedia = {
                    type: 'audio',
                    media: editedMessage.audio.file_id,
                    caption: editedMessage.caption || ''
                };

                const mediaRes = await this.callAPI('editMessageMedia', {
                    chat_id: userId,
                    message_id: parseInt(userMsgId),
                    media: inputMedia
                });
                if (!mediaRes.ok) {
                    await this.callAPI('editMessageCaption', {
                        chat_id: userId,
                        message_id: parseInt(userMsgId),
                        caption: editedMessage.caption || ''
                    });
                }
            } else if (typeof editedMessage.caption === 'string') {
                await this.callAPI('editMessageCaption', {
                    chat_id: userId,
                    message_id: parseInt(userMsgId),
                    caption: editedMessage.caption
                });
            }
        } catch (e) {
            console.error(e);
        }

        await this.callAPI('setMessageReaction', {
            chat_id: userId,
            message_id: parseInt(userMsgId),
            reaction: [{type: 'emoji', emoji: '✍️'}]
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.callAPI('setMessageReaction', {chat_id: this.adminGroupId, message_id: messageId, reaction: []});
        await this.callAPI('setMessageReaction', {chat_id: userId, message_id: parseInt(userMsgId), reaction: []});
    }

    // ==========================================
    // 7. 主入口与路由
    // ==========================================

    async handleCommand(message) {
        const text = message.text;
        const userId = message.from.id;

        if (text === '/start') {
            const blacklisted = await this.kv.get(`blacklist_user_${userId}`);
            if (blacklisted) {
                await this.callAPI('sendMessage', {chat_id: userId, text: '❌ 您已被拉黑，无法使用本机器人'});
                return;
            }
            const userData = await this.kv.get(`user_${userId}`);
            if (userData) {
                const user = JSON.parse(userData);
                if (user.verified) {
                    await this.callAPI('sendMessage', {chat_id: userId, text: '✅ 您已完成验证，可以直接发送消息'});
                    return;
                }
            }
            await this.sendVerification(userId, message.from);
        }
    }

    async handleUnverifiedMessage(message) {
        const userId = message.from.id;
        const blacklisted = await this.kv.get(`blacklist_user_${userId}`);
        if (blacklisted) {
            await this.callAPI('sendMessage', {chat_id: userId, text: '❌ 您已被拉黑，无法使用本机器人'});
            return;
        }
        const userData = await this.kv.get(`user_${userId}`);
        if (userData) {
            const user = JSON.parse(userData);
            if (user.verified) {
                await this.forwardUserMessage(message);
                return;
            }
        }
        await this.sendVerification(userId, message.from);
    }

    async handleUpdate(update) {
        try {
            // 1. 处理回调查询
            if (update.callback_query) {
                const data = update.callback_query.data;
                if (data.startsWith('verify_')) await this.handleVerificationCallback(update.callback_query);
                else if (data.startsWith('unban_')) await this.handleUnbanCallback(update.callback_query);
                else if (data.startsWith('block_')) await this.handleBlockCallback(update.callback_query);
                return;
            }

            // 2. 处理编辑消息
            if (update.edited_message) {
                const editedMessage = update.edited_message;
                const chatId = editedMessage.chat.id;
                const userId = editedMessage.from.id;
                if (chatId === userId) {
                    const userData = await this.kv.get(`user_${userId}`);
                    if (userData && JSON.parse(userData).verified) await this.handleUserEditedMessage(editedMessage);
                } else if (chatId.toString() === this.adminGroupId) {
                    await this.handleAdminEditedMessage(editedMessage);
                }
                return;
            }

            // 3. 处理新消息
            if (update.message) {
                const message = update.message;
                const userId = message.from.id;
                const chatId = message.chat.id;

                // [新增] 删除消息命令 (/delete 或 删除)
                if (message.reply_to_message && (message.text === '/delete' || message.text === '删除')) {
                    if (chatId === userId) await this.handleUserDeleteCommand(message);
                    else if (chatId.toString() === this.adminGroupId) await this.handleAdminDeleteCommand(message);
                    return;
                }

                if (message.text && message.text.startsWith('/')) {
                    if (chatId === userId) await this.handleCommand(message);
                    return;
                }

                if (chatId === userId) {
                    await this.handleUnverifiedMessage(message);
                } else if (chatId.toString() === this.adminGroupId) {
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

        if (url.pathname === '/webhook' && request.method === 'POST') {
            const update = await request.json();
            await bot.handleUpdate(update);
            return new Response('OK', {status: 200});
        }
        if (url.pathname === '/setup' && request.method === 'GET') {
            const webhookUrl = `${url.origin}/webhook`;
            const result = await bot.callAPI('setWebhook', {url: webhookUrl, drop_pending_updates: true});
            return new Response(JSON.stringify(result, null, 2), {headers: {'Content-Type': 'application/json'}});
        }
        if (url.pathname === '/info' && request.method === 'GET') {
            const result = await bot.callAPI('getWebhookInfo', {});
            return new Response(JSON.stringify(result, null, 2), {headers: {'Content-Type': 'application/json'}});
        }
        return new Response('Telegram Bot is running', {status: 200});
    }
};