/**
 * Promo Attendant Bot
 * Separate bot for showing live room activity with participant counts and join links
 * Uses its own token: PROMO_ATTENDANT_BOT_TOKEN
 * Features:
 * - Auto-updating room status (edits every 10 minutes)
 * - Scheduled reposts (1-24 hours configurable)
 * - DM mode: Users can subscribe to receive updates in their DMs
 * - Group mode: Add to groups via deep link
 * - Settings via inline buttons only (no commands)
 * Test mode: Set PROMO_ATTENDANT_TEST_USER_ID to send DMs to specific users
 */

const TelegramBot = require('node-telegram-bot-api');
const { query } = require('./database');

let bot = null;
const timers = new Map(); // Repost timers (delete/repost on schedule)
const updateTimers = new Map(); // Edit timers (edit existing message)

const INTERVALS = [1, 2, 4, 6, 8, 12, 24];
const UPDATE_INTERVAL_MS = 10 * 60 * 1000; // Edit message every 10 minutes

/**
 * Check if user is super admin
 */
function isSuperAdmin(userId) {
  const superAdminId = process.env.PROMO_ATTENDANT_SUPER_ADMIN;
  if (!superAdminId) return false;
  return String(userId) === String(superAdminId);
}

/**
 * Initialize the Promo Attendant bot
 */
async function initPromoAttendant() {
  const token = process.env.PROMO_ATTENDANT_BOT_TOKEN;

  if (!token) {
    console.log('[PromoAttendant] No PROMO_ATTENDANT_BOT_TOKEN set, bot disabled');
    return null;
  }

  try {
    bot = new TelegramBot(token, { polling: true });
    console.log('[PromoAttendant] Bot initialized successfully');

    // Handle commands (messages and channel posts)
    const handleMessage = async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id || msg.sender_chat?.id || chatId;
      const text = msg.text || '';

      // Hidden /settings command for super admin only (DM only)
      if (text === '/settings' && msg.chat.type === 'private') {
        if (isSuperAdmin(userId)) {
          await showAdminPanel(chatId);
        }
        return;
      }

      // /addzoom command for super admin
      if (text.startsWith('/addzoom ') && msg.chat.type === 'private' && isSuperAdmin(userId)) {
        const parts = text.replace('/addzoom ', '').split('|').map(s => s.trim());
        const [name, meetingId, expireHours] = parts;

        if (!name || !meetingId) {
          await bot.sendMessage(chatId, '❌ Invalid format. Use: /addzoom Name|MeetingID|ExpireHours');
          return;
        }

        try {
          await addManualEntry('zoom', name, meetingId, null, expireHours || null, userId);
          const expireMsg = expireHours ? ` (expires in ${expireHours}h)` : ' (permanent)';
          await bot.sendMessage(chatId, `✅ Added Zoom room: <b>${name}</b>${expireMsg}`, { parse_mode: 'HTML' });
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
        }
        return;
      }

      // /addtg command for super admin
      if (text.startsWith('/addtg ') && msg.chat.type === 'private' && isSuperAdmin(userId)) {
        const parts = text.replace('/addtg ', '').split('|').map(s => s.trim());

        // Find the URL in the parts (it contains t.me or http)
        let name = null;
        let inviteLink = null;
        let expireHours = null;

        for (const part of parts) {
          if (part.includes('t.me') || part.includes('http')) {
            inviteLink = part;
          } else if (/^\d+$/.test(part)) {
            expireHours = part;
          } else if (!name) {
            name = part;
          } else {
            // Additional text before URL becomes part of name
            name = name + ' ' + part;
          }
        }

        if (!name || !inviteLink) {
          await bot.sendMessage(chatId, '❌ Invalid format. Use: /addtg Name|InviteLink|ExpireHours');
          return;
        }

        try {
          await addManualEntry('telegram', name, null, inviteLink, expireHours, userId);
          const expireMsg = expireHours ? ` (expires in ${expireHours}h)` : ' (permanent)';
          await bot.sendMessage(chatId, `✅ Added Telegram chat: <b>${name}</b>${expireMsg}`, { parse_mode: 'HTML' });
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
        }
        return;
      }

      // /enroll command for super admin (enroll a chat by ID)
      if (text.startsWith('/enroll ') && msg.chat.type === 'private' && isSuperAdmin(userId)) {
        const parts = text.replace('/enroll ', '').split('|').map(s => s.trim());
        const [enrollChatId, chatType] = parts;

        if (!enrollChatId) {
          await bot.sendMessage(chatId, '❌ Invalid format. Use: /enroll ChatID|Type');
          return;
        }

        const validTypes = ['private', 'group', 'supergroup', 'channel'];
        const type = validTypes.includes(chatType) ? chatType : 'unknown';

        try {
          await enableChat(parseInt(enrollChatId), userId, type);
          await bot.sendMessage(chatId, `✅ Enrolled chat <code>${enrollChatId}</code> as ${type}`, { parse_mode: 'HTML' });

          // Try to post to the chat
          try {
            await postMessage(parseInt(enrollChatId));
            await bot.sendMessage(chatId, '📤 First message sent successfully!');
          } catch (postErr) {
            await bot.sendMessage(chatId, `⚠️ Enrolled but couldn't post: ${postErr.message}`);
          }
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
        }
        return;
      }

      // Handle /start command
      if (text === '/start' || text.startsWith('/start ') || text === '/start@' + (process.env.PROMO_ATTENDANT_BOT_USERNAME || 'PromoAttendantBot')) {
        const payload = text.split(' ')[1];

        // Group or channel - enroll it (admins only)
        if (msg.chat.type !== 'private') {
          // For channels, skip admin check (channel posts are from admins)
          if (msg.chat.type !== 'channel') {
            // Check if user is admin (for groups)
            try {
              const member = await bot.getChatMember(chatId, userId);
              if (!['creator', 'administrator'].includes(member.status)) {
                return; // Silently ignore non-admins
              }
            } catch (e) {
              console.error('[PromoAttendant] Failed to check admin status:', e.message);
              return;
            }
          }

          // Check member count - must have at least 100 members
          try {
            const memberCount = await bot.getChatMemberCount(chatId);
            if (memberCount < 100) {
              await bot.sendMessage(chatId, '❌ This bot can only be added to groups/channels with 100+ members.', {
                reply_to_message_id: msg.message_id
              });
              await bot.leaveChat(chatId);
              return;
            }
          } catch (e) {
            console.error('[PromoAttendant] Failed to check member count:', e.message);
          }
          await enableChat(chatId, userId, msg.chat.type);
          const confirmMsg = await bot.sendMessage(chatId, '✅ Enabled', {
            reply_to_message_id: msg.message_id
          });
          setTimeout(() => bot.deleteMessage(chatId, confirmMsg.message_id).catch(() => {}), 3000);
          await postMessage(chatId);
          return;
        }

        // Private chat - enroll and show main menu
        if (msg.chat.type === 'private') {
          await enableChat(chatId, userId, 'private');
          const confirmMsg = await bot.sendMessage(chatId, '✅ Subscribed', {
            reply_to_message_id: msg.message_id
          });
          setTimeout(() => bot.deleteMessage(chatId, confirmMsg.message_id).catch(() => {}), 3000);
          await postMessage(chatId);
        }
      }
    };

    bot.on('message', handleMessage);
    bot.on('channel_post', handleMessage);

    // Set up callback handlers
    setupCallbacks();

    // Run migration
    await runPromoAttendantMigration();

    // Start timers for existing subscriptions
    await startAllTimers();

    // Test mode: enable test user DMs (respects existing timer settings)
    const testUserIds = process.env.PROMO_ATTENDANT_TEST_USER_ID;
    if (testUserIds) {
      const ids = testUserIds.split(/[,\s&]+/).filter(id => id.trim());
      for (const id of ids) {
        const userId = parseInt(id.trim());
        if (userId) {
          const existing = await getSettings(userId);
          if (!existing.enabled) {
            // New test user - enable and post first message
            console.log(`[PromoAttendant] Test mode - enabling new user ${userId}`);
            await enableChat(userId, userId, 'private');
            await postMessage(userId);
          } else {
            // Existing user - just ensure timer is running (respects last_posted_at)
            console.log(`[PromoAttendant] Test mode - user ${userId} already enabled, timer will respect settings`);
            startTimer(userId);
          }
        }
      }
    }

    console.log('[PromoAttendant] Bot is ready');
    return bot;
  } catch (error) {
    console.error('[PromoAttendant] Failed to initialize:', error.message);
    return null;
  }
}

/**
 * Set up callback handlers for inline buttons
 */
function setupCallbacks() {
  if (!bot) return;

  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const msgId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;

    try {
      // Refresh button
      if (data === 'pa:refresh') {
        await updateMessage(chatId, msgId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Refreshed!' });
        return;
      }

      // Settings button
      if (data === 'pa:settings') {
        const settings = await getSettings(chatId);
        const text = buildSettingsMessage(settings);
        const keyboard = settingsKeyboard(settings);
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Back button
      if (data === 'pa:back') {
        await updateMessage(chatId, msgId);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Toggle enable/disable
      if (data === 'pa:toggle') {
        const settings = await getSettings(chatId);
        const newEnabled = !settings.enabled;
        await updateSettings(chatId, { enabled: newEnabled });

        if (newEnabled) {
          startTimer(chatId);
          startUpdateTimer(chatId, msgId);
        } else {
          stopTimer(chatId);
          stopUpdateTimer(chatId);
        }

        const updatedSettings = await getSettings(chatId);
        const text = buildSettingsMessage(updatedSettings);
        const keyboard = settingsKeyboard(updatedSettings);
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: newEnabled ? 'Updates enabled!' : 'Updates disabled'
        });
        return;
      }

      // Interval buttons
      if (data.startsWith('pa:int:')) {
        const hours = parseInt(data.split(':')[2]);
        if (INTERVALS.includes(hours)) {
          await updateSettings(chatId, { repost_interval_hours: hours });

          // Restart timer with new interval
          const settings = await getSettings(chatId);
          if (settings.enabled) {
            startTimer(chatId);
          }

          const updatedSettings = await getSettings(chatId);
          const text = buildSettingsMessage(updatedSettings);
          const keyboard = settingsKeyboard(updatedSettings);
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          await bot.answerCallbackQuery(callbackQuery.id, { text: `Interval set to ${hours}h` });
        }
        return;
      }

      // Enable DM updates
      if (data === 'pa:enable_dm') {
        await enableChat(userId, userId, 'private');
        await postMessage(userId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'DM updates enabled!' });
        return;
      }

      // View List (for DM subscribers)
      if (data === 'pa:view_list') {
        const viewListText = buildViewListMessage();
        await bot.editMessageText(viewListText, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: viewListKeyboard()
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // More Info
      if (data === 'pa:more_info') {
        const moreInfoText = buildMoreInfoMessage();
        await bot.editMessageText(moreInfoText, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: moreInfoKeyboard()
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // ========== ADMIN CALLBACKS (Super Admin Only) ==========

      if (data.startsWith('admin:') && !isSuperAdmin(userId)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Access denied', show_alert: true });
        return;
      }

      // Admin panel
      if (data === 'admin:panel') {
        const text = `
<b>🔧 ADMIN PANEL</b>
━━━━━━━━━━━━━━━━━━

<b>Manage Rooms & Chats</b>

Select an option below:
        `.trim();

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📹 Manage Zoom Rooms', callback_data: 'admin:zoom' }],
              [{ text: '💬 Manage Telegram Chats', callback_data: 'admin:telegram' }],
              [{ text: '👥 Manage Subscriptions', callback_data: 'admin:subscriptions' }],
              [{ text: '➕ Add Manual Entry', callback_data: 'admin:add' }],
              [{ text: '👁 View Hidden Items', callback_data: 'admin:hidden' }],
              [{ text: '🔄 Refresh Stats', callback_data: 'admin:refresh' }],
              [{ text: '« Back to Room Pulse', callback_data: 'pa:back' }]
            ]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Refresh admin stats
      if (data === 'admin:refresh') {
        await showAdminPanel(chatId);
        await bot.deleteMessage(chatId, msgId).catch(() => {});
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Stats refreshed!' });
        return;
      }

      // Manage Zoom Rooms
      if (data === 'admin:zoom') {
        const rooms = await getActiveRooms(60);
        const hiddenIds = await getHiddenMeetings();
        const manualZoom = await getManualEntries('zoom');

        let text = `
<b>📹 ZOOM ROOMS</b>
━━━━━━━━━━━━━━━━━━

<b>Auto-detected:</b>
`;
        const buttons = [];

        if (rooms.length === 0) {
          text += '<i>No active rooms</i>\n';
        } else {
          for (const room of rooms) {
            const isHidden = hiddenIds.includes(room.meeting_id);
            const status = isHidden ? '🔴 Hidden' : '🟢 Visible';
            const name = room.room_name || room.group_name || `Room ${room.group_number}`;
            text += `\n• ${name} (${room.meeting_id})\n  ${status}\n`;
            buttons.push([{
              text: `${isHidden ? '👁 Show' : '🙈 Hide'} ${name}`,
              callback_data: `admin:toggle_zoom:${room.meeting_id}`
            }]);
          }
        }

        if (manualZoom.length > 0) {
          text += '\n<b>Manual entries:</b>\n';
          for (const entry of manualZoom) {
            const expiry = entry.expires_at ? `expires ${new Date(entry.expires_at).toLocaleDateString()}` : 'permanent';
            text += `\n• ${entry.name} (${entry.meeting_id})\n  ${expiry}\n`;
            buttons.push([{
              text: `🗑 Delete ${entry.name}`,
              callback_data: `admin:del_manual:${entry.id}`
            }]);
          }
        }

        buttons.push([{ text: '➕ Add Zoom Room', callback_data: 'admin:add_zoom' }]);
        buttons.push([{ text: '« Back', callback_data: 'admin:panel' }]);

        await bot.editMessageText(text.trim(), {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Manage Telegram Chats
      if (data === 'admin:telegram') {
        const telegramGroups = await getTelegramGroups();
        const manualTelegram = await getManualEntries('telegram');

        let text = `
<b>💬 TELEGRAM CHATS</b>
━━━━━━━━━━━━━━━━━━

<b>From config:</b>
`;
        const buttons = [];

        if (telegramGroups.length === 0) {
          text += '<i>No configured chats</i>\n';
        } else {
          for (const group of telegramGroups) {
            text += `\n• ${group.name}\n`;
          }
        }

        if (manualTelegram.length > 0) {
          text += '\n<b>Manual entries:</b>\n';
          for (const entry of manualTelegram) {
            const expiry = entry.expires_at ? `expires ${new Date(entry.expires_at).toLocaleDateString()}` : 'permanent';
            text += `\n• ${entry.name}\n  ${expiry}\n`;
            buttons.push([{
              text: `🗑 Delete ${entry.name}`,
              callback_data: `admin:del_manual:${entry.id}`
            }]);
          }
        }

        buttons.push([{ text: '➕ Add Telegram Chat', callback_data: 'admin:add_telegram' }]);
        buttons.push([{ text: '« Back', callback_data: 'admin:panel' }]);

        await bot.editMessageText(text.trim(), {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Add Manual Entry menu
      if (data === 'admin:add') {
        const text = `
<b>➕ ADD MANUAL ENTRY</b>
━━━━━━━━━━━━━━━━━━

Select entry type:
        `.trim();

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📹 Add Zoom Room', callback_data: 'admin:add_zoom' }],
              [{ text: '💬 Add Telegram Chat', callback_data: 'admin:add_telegram' }],
              [{ text: '« Back', callback_data: 'admin:panel' }]
            ]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Add Zoom Room prompt
      if (data === 'admin:add_zoom') {
        const text = `
<b>➕ ADD ZOOM ROOM</b>
━━━━━━━━━━━━━━━━━━

Send a message in this format:

<code>/addzoom Name|MeetingID|ExpireHours</code>

Examples:
<code>/addzoom Party Room|1234567890|24</code>
<code>/addzoom VIP Lounge|9876543210</code>

ExpireHours is optional (omit for permanent)
        `.trim();

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Back', callback_data: 'admin:zoom' }]]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Add Telegram Chat prompt
      if (data === 'admin:add_telegram') {
        const text = `
<b>➕ ADD TELEGRAM CHAT</b>
━━━━━━━━━━━━━━━━━━

Send a message in this format:

<code>/addtg Name|InviteLink|ExpireHours</code>

Examples:
<code>/addtg VIP Lounge|https://t.me/+abc123|24</code>
<code>/addtg Main Chat|https://t.me/mychat</code>

ExpireHours is optional (omit for permanent)
        `.trim();

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Back', callback_data: 'admin:telegram' }]]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Toggle Zoom visibility
      if (data.startsWith('admin:toggle_zoom:')) {
        const meetingId = data.replace('admin:toggle_zoom:', '');
        const hiddenIds = await getHiddenMeetings();

        if (hiddenIds.includes(meetingId)) {
          await unhideMeeting(meetingId);
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Room is now visible' });
        } else {
          await hideMeeting(meetingId, userId);
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Room is now hidden' });
        }

        // Refresh the zoom panel
        bot.emit('callback_query', { ...callbackQuery, data: 'admin:zoom' });
        return;
      }

      // Delete manual entry
      if (data.startsWith('admin:del_manual:')) {
        const id = parseInt(data.replace('admin:del_manual:', ''));
        await deleteManualEntry(id);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Entry deleted' });
        // Go back to admin panel
        bot.emit('callback_query', { ...callbackQuery, data: 'admin:panel' });
        return;
      }

      // View Hidden Items
      if (data === 'admin:hidden') {
        const hiddenIds = await getHiddenMeetings();
        const hiddenManual = await query(
          'SELECT * FROM promo_attendant_manual_entries WHERE is_hidden = TRUE'
        );

        let text = `
<b>👁 HIDDEN ITEMS</b>
━━━━━━━━━━━━━━━━━━

`;
        const buttons = [];

        if (hiddenIds.length === 0 && hiddenManual.rows.length === 0) {
          text += '<i>No hidden items</i>';
        } else {
          if (hiddenIds.length > 0) {
            text += '<b>Hidden Zoom Rooms:</b>\n';
            for (const id of hiddenIds) {
              text += `• ${id}\n`;
              buttons.push([{
                text: `👁 Unhide ${id}`,
                callback_data: `admin:toggle_zoom:${id}`
              }]);
            }
          }

          if (hiddenManual.rows.length > 0) {
            text += '\n<b>Hidden Manual Entries:</b>\n';
            for (const entry of hiddenManual.rows) {
              text += `• ${entry.name}\n`;
              buttons.push([{
                text: `👁 Unhide ${entry.name}`,
                callback_data: `admin:unhide_manual:${entry.id}`
              }]);
            }
          }
        }

        buttons.push([{ text: '« Back', callback_data: 'admin:panel' }]);

        await bot.editMessageText(text.trim(), {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Unhide manual entry
      if (data.startsWith('admin:unhide_manual:')) {
        const id = parseInt(data.replace('admin:unhide_manual:', ''));
        await toggleHideManualEntry(id);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Entry unhidden' });
        bot.emit('callback_query', { ...callbackQuery, data: 'admin:hidden' });
        return;
      }

      // Manage Subscriptions
      if (data === 'admin:subscriptions') {
        const subs = await getAllSubscriptions();

        let text = `
<b>👥 MANAGE SUBSCRIPTIONS</b>
━━━━━━━━━━━━━━━━━━

<b>Active Subscriptions:</b>
`;
        const buttons = [];

        // Group by type
        const dms = subs.filter(s => s.chat_type === 'private');
        const groups = subs.filter(s => s.chat_type === 'group' || s.chat_type === 'supergroup');
        const channels = subs.filter(s => s.chat_type === 'channel');

        if (dms.length > 0) {
          text += `\n<b>💬 DMs (</b>${dms.length}<b>)</b>\n`;
          for (const sub of dms.slice(0, 5)) {
            const status = sub.enabled ? '🟢' : '🔴';
            text += `  ${status} ${sub.chat_id} (${sub.repost_interval_hours}h)\n`;
            buttons.push([{
              text: `${status} DM ${sub.chat_id}`,
              callback_data: `admin:sub_view:${sub.chat_id}`
            }]);
          }
          if (dms.length > 5) text += `  <i>... and ${dms.length - 5} more</i>\n`;
        }

        if (groups.length > 0) {
          text += `\n<b>👥 Groups (</b>${groups.length}<b>)</b>\n`;
          for (const sub of groups.slice(0, 5)) {
            const status = sub.enabled ? '🟢' : '🔴';
            text += `  ${status} ${sub.chat_id} (${sub.repost_interval_hours}h)\n`;
            buttons.push([{
              text: `${status} Group ${sub.chat_id}`,
              callback_data: `admin:sub_view:${sub.chat_id}`
            }]);
          }
          if (groups.length > 5) text += `  <i>... and ${groups.length - 5} more</i>\n`;
        }

        if (channels.length > 0) {
          text += `\n<b>📢 Channels (</b>${channels.length}<b>)</b>\n`;
          for (const sub of channels.slice(0, 5)) {
            const status = sub.enabled ? '🟢' : '🔴';
            text += `  ${status} ${sub.chat_id} (${sub.repost_interval_hours}h)\n`;
            buttons.push([{
              text: `${status} Channel ${sub.chat_id}`,
              callback_data: `admin:sub_view:${sub.chat_id}`
            }]);
          }
          if (channels.length > 5) text += `  <i>... and ${channels.length - 5} more</i>\n`;
        }

        if (subs.length === 0) {
          text += '<i>No subscriptions yet</i>';
        }

        buttons.push([{ text: '➕ Enroll New', callback_data: 'admin:enroll' }]);
        buttons.push([{ text: '« Back', callback_data: 'admin:panel' }]);

        await bot.editMessageText(text.trim(), {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Enroll new subscription
      if (data === 'admin:enroll') {
        const text = `
<b>➕ ENROLL NEW SUBSCRIPTION</b>
━━━━━━━━━━━━━━━━━━

Send a message with the chat ID to enroll:

<code>/enroll ChatID|Type</code>

<b>Types:</b> private, group, channel

<b>Examples:</b>
<code>/enroll 123456789|private</code>
<code>/enroll -1001234567890|group</code>
<code>/enroll -1001234567890|channel</code>

The bot will start posting to this chat.
        `.trim();

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '« Back', callback_data: 'admin:subscriptions' }]]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // View/Edit subscription
      if (data.startsWith('admin:sub_view:')) {
        const subChatId = data.replace('admin:sub_view:', '');
        const sub = await getSettings(parseInt(subChatId));

        const status = sub.enabled ? '🟢 Enabled' : '🔴 Disabled';
        const interval = sub.repost_interval_hours || 4;
        const chatType = sub.chat_type || 'unknown';

        const text = `
<b>📋 SUBSCRIPTION DETAILS</b>
━━━━━━━━━━━━━━━━━━

<b>Chat ID:</b> <code>${subChatId}</code>
<b>Type:</b> ${chatType}
<b>Status:</b> ${status}
<b>Interval:</b> ${interval}h

Select an action:
        `.trim();

        const intervalBtns = [1, 2, 4, 8, 12, 24].map(h => ({
          text: h === interval ? `[${h}h]` : `${h}h`,
          callback_data: `admin:sub_int:${subChatId}:${h}`
        }));

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: sub.enabled ? '🔴 Disable' : '🟢 Enable', callback_data: `admin:sub_toggle:${subChatId}` }],
              intervalBtns.slice(0, 3),
              intervalBtns.slice(3, 6),
              [{ text: '📤 Force Post Now', callback_data: `admin:sub_post:${subChatId}` }],
              [{ text: '🗑 Unenroll', callback_data: `admin:sub_del:${subChatId}` }],
              [{ text: '« Back', callback_data: 'admin:subscriptions' }]
            ]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Toggle subscription
      if (data.startsWith('admin:sub_toggle:')) {
        const subChatId = parseInt(data.replace('admin:sub_toggle:', ''));
        const sub = await getSettings(subChatId);
        const newEnabled = !sub.enabled;
        await updateSettings(subChatId, { enabled: newEnabled });

        if (newEnabled) {
          startTimer(subChatId);
        } else {
          stopTimer(subChatId);
          stopUpdateTimer(subChatId);
        }

        await bot.answerCallbackQuery(callbackQuery.id, {
          text: newEnabled ? 'Subscription enabled' : 'Subscription disabled'
        });
        bot.emit('callback_query', { ...callbackQuery, data: `admin:sub_view:${subChatId}` });
        return;
      }

      // Change subscription interval
      if (data.startsWith('admin:sub_int:')) {
        const parts = data.replace('admin:sub_int:', '').split(':');
        const subChatId = parseInt(parts[0]);
        const hours = parseInt(parts[1]);

        await updateSettings(subChatId, { repost_interval_hours: hours });
        const sub = await getSettings(subChatId);
        if (sub.enabled) {
          startTimer(subChatId);
        }

        await bot.answerCallbackQuery(callbackQuery.id, { text: `Interval set to ${hours}h` });
        bot.emit('callback_query', { ...callbackQuery, data: `admin:sub_view:${subChatId}` });
        return;
      }

      // Force post to subscription
      if (data.startsWith('admin:sub_post:')) {
        const subChatId = parseInt(data.replace('admin:sub_post:', ''));
        try {
          await postMessage(subChatId);
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Message posted!' });
        } catch (e) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed: ' + e.message, show_alert: true });
        }
        return;
      }

      // Delete/Unenroll subscription
      if (data.startsWith('admin:sub_del:')) {
        const subChatId = parseInt(data.replace('admin:sub_del:', ''));
        stopTimer(subChatId);
        stopUpdateTimer(subChatId);
        await query('DELETE FROM promo_attendant_settings WHERE chat_id = $1', [subChatId]);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Subscription removed' });
        bot.emit('callback_query', { ...callbackQuery, data: 'admin:subscriptions' });
        return;
      }

      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
      console.error('[PromoAttendant] Callback error:', error.message);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Error occurred' }).catch(() => {});
    }
  });

  console.log('[PromoAttendant] Callback handlers set up');
}

/**
 * Run database migration
 */
async function runPromoAttendantMigration() {
  console.log('[PromoAttendant] Running database migration...');

  await query(`
    CREATE TABLE IF NOT EXISTS promo_attendant_settings (
      chat_id BIGINT PRIMARY KEY,
      chat_type VARCHAR(20) DEFAULT 'unknown',
      enabled BOOLEAN DEFAULT TRUE,
      repost_interval_hours INTEGER DEFAULT 4 CHECK (repost_interval_hours >= 1 AND repost_interval_hours <= 24),
      last_message_id BIGINT,
      last_posted_at TIMESTAMPTZ,
      inactive_threshold_minutes INTEGER DEFAULT 60,
      configured_by_user_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add chat_type column if it doesn't exist (for existing installations)
  await query(`
    ALTER TABLE promo_attendant_settings
    ADD COLUMN IF NOT EXISTS chat_type VARCHAR(20) DEFAULT 'unknown'
  `).catch(() => {});
  console.log('[PromoAttendant] 1/4 promo_attendant_settings table');

  await query(`
    CREATE INDEX IF NOT EXISTS idx_promo_attendant_enabled
    ON promo_attendant_settings(enabled) WHERE enabled = TRUE
  `);
  console.log('[PromoAttendant] 2/4 indexes created');

  // Manual entries table (admin can add custom rooms)
  await query(`
    CREATE TABLE IF NOT EXISTS promo_attendant_manual_entries (
      id SERIAL PRIMARY KEY,
      entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN ('zoom', 'telegram')),
      name VARCHAR(255) NOT NULL,
      meeting_id VARCHAR(50),
      invite_link VARCHAR(255),
      participant_count INTEGER DEFAULT 0,
      is_hidden BOOLEAN DEFAULT FALSE,
      expires_at TIMESTAMPTZ,
      created_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[PromoAttendant] 3/4 promo_attendant_manual_entries table');

  // Hidden meetings table (hide auto-detected meetings)
  await query(`
    CREATE TABLE IF NOT EXISTS promo_attendant_hidden (
      meeting_id VARCHAR(50) PRIMARY KEY,
      hidden_by BIGINT,
      hidden_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[PromoAttendant] 4/4 promo_attendant_hidden table');

  console.log('[PromoAttendant] Migration complete!');
}

/**
 * Show admin panel (super admin only)
 */
async function showAdminPanel(chatId) {
  // Get subscription stats
  const stats = await getSubscriptionStats();
  const total = parseInt(stats.total_active) || 0;
  const dms = parseInt(stats.dm_count) || 0;
  const groups = parseInt(stats.group_count) + parseInt(stats.supergroup_count) || 0;
  const channels = parseInt(stats.channel_count) || 0;

  // Build interval distribution chart
  const intervals = [
    { h: 1, count: parseInt(stats.interval_1h) || 0 },
    { h: 2, count: parseInt(stats.interval_2h) || 0 },
    { h: 4, count: parseInt(stats.interval_4h) || 0 },
    { h: 8, count: parseInt(stats.interval_8h) || 0 },
    { h: 12, count: parseInt(stats.interval_12h) || 0 },
    { h: 24, count: parseInt(stats.interval_24h) || 0 }
  ];

  const intervalLines = intervals.map(i => {
    const pct = total > 0 ? Math.round((i.count / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `  ${i.h}h: ${bar} ${pct}% (${i.count})`;
  }).join('\n');

  const text = `
<b>🔧 ADMIN PANEL</b>
━━━━━━━━━━━━━━━━━━

<b>📊 Subscriptions</b>
  Total Active: <b>${total}</b>
  💬 DMs: ${dms}
  👥 Groups: ${groups}
  📢 Channels: ${channels}

<b>⏱ Repost Intervals</b>
${intervalLines}

━━━━━━━━━━━━━━━━━━
<b>Manage Rooms & Chats</b>
  `.trim();

  const keyboard = {
    inline_keyboard: [
      [{ text: '📹 Manage Zoom Rooms', callback_data: 'admin:zoom' }],
      [{ text: '💬 Manage Telegram Chats', callback_data: 'admin:telegram' }],
      [{ text: '➕ Add Manual Entry', callback_data: 'admin:add' }],
      [{ text: '👁 View Hidden Items', callback_data: 'admin:hidden' }],
      [{ text: '🔄 Refresh Stats', callback_data: 'admin:refresh' }],
      [{ text: '« Back to Room Pulse', callback_data: 'pa:back' }]
    ]
  };

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/**
 * Get manual entries
 */
async function getManualEntries(type = null) {
  let sql = `
    SELECT * FROM promo_attendant_manual_entries
    WHERE is_hidden = FALSE
    AND (expires_at IS NULL OR expires_at > NOW())
  `;
  const params = [];

  if (type) {
    sql += ' AND entry_type = $1';
    params.push(type);
  }

  sql += ' ORDER BY created_at DESC';

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Get hidden meeting IDs
 */
async function getHiddenMeetings() {
  const result = await query('SELECT meeting_id FROM promo_attendant_hidden');
  return result.rows.map(r => r.meeting_id);
}

/**
 * Add manual entry
 */
async function addManualEntry(type, name, meetingId, inviteLink, expiresHours, userId) {
  const expiresAt = expiresHours ? `NOW() + INTERVAL '${parseInt(expiresHours)} hours'` : 'NULL';

  await query(`
    INSERT INTO promo_attendant_manual_entries
    (entry_type, name, meeting_id, invite_link, expires_at, created_by)
    VALUES ($1, $2, $3, $4, ${expiresAt}, $5)
  `, [type, name, meetingId, inviteLink, userId]);
}

/**
 * Hide a meeting
 */
async function hideMeeting(meetingId, userId) {
  await query(`
    INSERT INTO promo_attendant_hidden (meeting_id, hidden_by)
    VALUES ($1, $2)
    ON CONFLICT (meeting_id) DO NOTHING
  `, [meetingId, userId]);
}

/**
 * Unhide a meeting
 */
async function unhideMeeting(meetingId) {
  await query('DELETE FROM promo_attendant_hidden WHERE meeting_id = $1', [meetingId]);
}

/**
 * Delete manual entry
 */
async function deleteManualEntry(id) {
  await query('DELETE FROM promo_attendant_manual_entries WHERE id = $1', [id]);
}

/**
 * Toggle hide manual entry
 */
async function toggleHideManualEntry(id) {
  await query(`
    UPDATE promo_attendant_manual_entries
    SET is_hidden = NOT is_hidden, updated_at = NOW()
    WHERE id = $1
  `, [id]);
}

/**
 * Get settings for a chat
 */
async function getSettings(chatId) {
  const result = await query(
    `SELECT * FROM promo_attendant_settings WHERE chat_id = $1`,
    [chatId]
  );
  return result.rows[0] || {
    chat_id: chatId,
    enabled: false,
    repost_interval_hours: 4,
    inactive_threshold_minutes: 60
  };
}

/**
 * Get all subscriptions
 */
async function getAllSubscriptions() {
  const result = await query(
    `SELECT * FROM promo_attendant_settings ORDER BY chat_type, enabled DESC, updated_at DESC`
  );
  return result.rows;
}

/**
 * Update settings for a chat
 */
async function updateSettings(chatId, updates) {
  const fields = [];
  const values = [chatId];
  let paramIndex = 2;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  await query(
    `UPDATE promo_attendant_settings
     SET ${fields.join(', ')}, updated_at = NOW()
     WHERE chat_id = $1`,
    values
  );
}

/**
 * Enable a chat
 */
async function enableChat(chatId, userId, chatType = 'unknown') {
  await query(
    `INSERT INTO promo_attendant_settings (chat_id, chat_type, enabled, configured_by_user_id)
     VALUES ($1, $3, TRUE, $2)
     ON CONFLICT (chat_id) DO UPDATE SET
       enabled = TRUE,
       chat_type = COALESCE(NULLIF($3, 'unknown'), promo_attendant_settings.chat_type),
       configured_by_user_id = $2,
       updated_at = NOW()`,
    [chatId, userId, chatType]
  );
}

/**
 * Get subscription statistics for admin panel
 */
async function getSubscriptionStats() {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE enabled = TRUE) as total_active,
      COUNT(*) FILTER (WHERE enabled = TRUE AND chat_type = 'private') as dm_count,
      COUNT(*) FILTER (WHERE enabled = TRUE AND chat_type = 'group') as group_count,
      COUNT(*) FILTER (WHERE enabled = TRUE AND chat_type = 'supergroup') as supergroup_count,
      COUNT(*) FILTER (WHERE enabled = TRUE AND chat_type = 'channel') as channel_count,
      COUNT(*) FILTER (WHERE enabled = TRUE AND repost_interval_hours = 1) as interval_1h,
      COUNT(*) FILTER (WHERE enabled = TRUE AND repost_interval_hours = 2) as interval_2h,
      COUNT(*) FILTER (WHERE enabled = TRUE AND repost_interval_hours = 4) as interval_4h,
      COUNT(*) FILTER (WHERE enabled = TRUE AND repost_interval_hours = 8) as interval_8h,
      COUNT(*) FILTER (WHERE enabled = TRUE AND repost_interval_hours = 12) as interval_12h,
      COUNT(*) FILTER (WHERE enabled = TRUE AND repost_interval_hours = 24) as interval_24h
    FROM promo_attendant_settings
  `);
  return result.rows[0];
}

/**
 * Get active rooms from database (filtered by hidden list)
 */
async function getActiveRooms(thresholdMinutes = 60) {
  // Ensure thresholdMinutes is a valid integer to prevent SQL injection
  const threshold = Math.max(1, Math.min(1440, parseInt(thresholdMinutes) || 60));

  // Get hidden meeting IDs
  const hiddenIds = await getHiddenMeetings();

  const result = await query(
    `SELECT DISTINCT ON (prg.group_number)
            pm.meeting_id, pm.room_name, pm.zoom_participant_count,
            pm.zoom_host_name, pm.zoom_co_hosts, pm.zoom_scrape_status,
            pm.zoom_last_scraped_at, pm.last_seen,
            prg.primary_name as group_name, prg.group_number
     FROM promo_meetings pm
     JOIN promo_room_groups prg ON pm.group_id = prg.group_id
     WHERE pm.room_enabled = TRUE
       AND pm.last_seen > NOW() - INTERVAL '1 minute' * $1
     ORDER BY prg.group_number, pm.last_seen DESC`,
    [threshold]
  );

  // Filter out hidden meetings (show all active rooms regardless of participant count)
  const filtered = result.rows.filter(r =>
    !hiddenIds.includes(r.meeting_id)
  );

  // Add manual zoom entries (always shown regardless of participant count)
  const manualZoom = await getManualEntries('zoom');
  for (const entry of manualZoom) {
    filtered.push({
      meeting_id: entry.meeting_id,
      room_name: entry.name,
      zoom_participant_count: entry.participant_count || 0,
      is_manual: true
    });
  }

  return filtered;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Create padded room header with consistent total width
 * Target: 29 chars total (◆ + bars + ◆ + space + name + space + ◆ + bars + ◆)
 */
function padRoomHeader(name) {
  const maxNameLen = 15; // "The Locker Room" is longest
  const nameLen = name.length;
  const extraBars = Math.max(0, maxNameLen - nameLen);
  const leftBars = '━'.repeat(2 + Math.floor(extraBars / 2));
  const rightBars = '━'.repeat(2 + Math.ceil(extraBars / 2));
  return `<code>◆${leftBars}◆ ${name} ◆${rightBars}◆</code>`;
}

/**
 * Build the main room activity message
 * @param {Array} rooms - Active rooms
 * @param {Array} telegramGroups - Telegram groups array [{ name, inviteLink, username }]
 */
function buildMessage(rooms, telegramGroups = []) {
  const lines = [];

  // Header (50 chars)
  lines.push('<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>');
  lines.push('<code>◇               ⊱PROMO ATTENDANT⊰                ◇</code>');
  lines.push('<code>◇                 ⊱ Room Pulse ⊰                 ◇</code>');
  lines.push('<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>');
  lines.push('');

  // Zoom Rooms section
  lines.push('<b>➤ ZOOM ROOMS</b>');
  lines.push('[ DIRECTORY ]');
  lines.push('');

  if (rooms.length === 0) {
    lines.push('        <i>No active rooms</i>');
    lines.push('');
  } else {
    for (const room of rooms) {
      const roomName = room.room_name || room.group_name || `Room ${room.group_number}`;
      lines.push(`        ${padRoomHeader(escapeHtml(roomName))}`);
      lines.push(`        ◇ Room ID <code>${room.meeting_id}</code>`);
      if (room.zoom_participant_count > 0) {
        lines.push(`        ◇ ${room.zoom_participant_count} Participants`);
      }
      lines.push(`        ◇ <a href="https://zoom.us/j/${room.meeting_id}">Join Room</a>`);
      lines.push('');
    }
  }

  // Telegram Chats section
  lines.push('<b>➤ TELEGRAM</b>');
  lines.push('[ Live video chat ]');
  lines.push('');

  if (telegramGroups.length === 0) {
    lines.push('        <i>No active chats</i>');
  } else {
    for (const group of telegramGroups) {
      lines.push(`        <b>${escapeHtml(group.name)}</b>`);

      // Build join link
      let joinUrl = null;
      if (group.username) {
        joinUrl = `https://t.me/${group.username}`;
      } else if (group.inviteLink) {
        joinUrl = group.inviteLink;
      }

      if (joinUrl) {
        lines.push(`        ◇ <a href="${joinUrl}">Join Group</a>`);
      }
      lines.push('');
    }
  }

  // Footer
  lines.push('<code>━━━━━━━━━━━━━━━━━━⊱ Let\'s Cloud ⊰━━━━━━━━━━━━━━━━━</code>');

  return lines.join('\n');
}

/**
 * Build main keyboard
 */
function mainKeyboard(settings = null) {
  const isDMSubscriber = settings && settings.chat_type === 'private' && settings.enabled;
  const botUsername = process.env.PROMO_ATTENDANT_BOT_USERNAME || 'PromoAttendantBot';

  return {
    inline_keyboard: [
      [
        { text: '+ GROUP', url: `https://t.me/${botUsername}?startgroup=rooms` },
        { text: 'MORE INFO', callback_data: 'pa:more_info' }
      ],
      [
        { text: '+ CHANNEL', url: `https://t.me/${botUsername}?startchannel=rooms` },
        { text: 'Refresh', callback_data: 'pa:refresh' }
      ],
      [
        isDMSubscriber
          ? { text: 'View List', callback_data: 'pa:view_list' }
          : { text: '+ Direct Message', callback_data: 'pa:enable_dm' },
        { text: 'Settings', callback_data: 'pa:settings' }
      ]
    ]
  };
}

/**
 * Build settings message
 */
function buildSettingsMessage(settings) {
  const status = settings.enabled ? 'ON' : 'OFF';
  const interval = settings.repost_interval_hours || 4;

  return `
          <b>SETTINGS</b>

  Status: <b>${status}</b>
  Repost: every <b>${interval}h</b>

  ─────────────────────
  <i>Select an option below</i>
  `.trim();
}

/**
 * Build settings keyboard
 */
function settingsKeyboard(settings) {
  const toggleText = settings.enabled ? 'Disable' : 'Enable';
  const current = settings.repost_interval_hours || 4;

  const intervalBtns = INTERVALS.map(h => ({
    text: h === current ? `[${h}h]` : `${h}h`,
    callback_data: `pa:int:${h}`
  }));

  // Split into rows of 4
  const rows = [];
  for (let i = 0; i < intervalBtns.length; i += 4) {
    rows.push(intervalBtns.slice(i, i + 4));
  }

  return {
    inline_keyboard: [
      [{ text: toggleText, callback_data: 'pa:toggle' }],
      ...rows,
      [{ text: '« Back', callback_data: 'pa:back' }]
    ]
  };
}

/**
 * Build MORE INFO message
 */
function buildMoreInfoMessage() {
  return `
<b>Promo Attendant - More Info</b>

<b>About</b>
See Active Real Time Status of Rooms

<b>━━━━━━━━━━━━━━━━━━━━━━━━</b>

<b>Related Bots</b>

<b>PNP Directory List</b>
Add your PNP promo to this list to get more subscribers!

<b>GroupAttendant</b> [Group Moderator Bot]
<b>WatchDog</b> [Group Moderator Bot]
<b>BotifyKickBot</b> [Global Moderation Bot]
<b>BotifyModBot</b> [Group Moderator Bot]
<b>Fix 1132</b> [Zoom 1132 Info]

<b>━━━━━━━━━━━━━━━━━━━━━━━━</b>

<b>Setup Instructions</b>

<b>For Groups:</b>
1. Tap + GROUP button
2. Select your group from the list
3. Bot will post room status embed
4. Configure settings as needed

<b>For Channels:</b>
1. Tap + CHANNEL button
2. Select your channel
3. Bot will post updates to channel

<b>For Direct Messages:</b>
1. Tap + Direct Message
2. Receive updates in your DMs
3. Adjust frequency in settings

<b>━━━━━━━━━━━━━━━━━━━━━━━━</b>
  `.trim();
}

/**
 * Get Telegram groups for video chat section
 * Supports multiple groups via env vars:
 * TELEGRAM_GROUPS=Group1|invite_link1,Group2|invite_link2
 * Or falls back to MAIN_GROUP_NAME and MAIN_GROUP_INVITE_LINK
 * Also includes manual entries from database
 */
async function getTelegramGroups() {
  const groups = [];

  // Check for multiple groups config
  const groupsConfig = process.env.TELEGRAM_GROUPS;
  if (groupsConfig) {
    const entries = groupsConfig.split(',');
    for (const entry of entries) {
      const [name, link] = entry.split('|').map(s => s.trim());
      if (name) {
        groups.push({
          name: name,
          inviteLink: link || null,
          username: null
        });
      }
    }
  }

  // Fall back to single group config
  if (groups.length === 0) {
    const name = process.env.MAIN_GROUP_NAME;
    if (name) {
      groups.push({
        name: name,
        inviteLink: process.env.MAIN_GROUP_INVITE_LINK || null,
        username: null
      });
    }
  }

  // Add manual telegram entries from database
  try {
    const manualTelegram = await getManualEntries('telegram');
    for (const entry of manualTelegram) {
      groups.push({
        name: entry.name,
        inviteLink: entry.invite_link || null,
        username: null,
        is_manual: true
      });
    }
  } catch (err) {
    console.error('[PromoAttendant] Error loading manual telegram entries:', err.message);
  }

  return groups;
}

/**
 * Build MORE INFO keyboard
 */
function moreInfoKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'PNP Directory List', url: 'https://t.me/PNPDirectoryListBot' }],
      [{ text: 'GroupAttendant', url: 'https://t.me/groupattendantbot' }],
      [{ text: 'WatchDog', url: 'https://t.me/mrwatchdogbot' }],
      [{ text: 'BotifyKickBot', url: 'https://t.me/autogroupkickbot' }],
      [{ text: 'BotifyModBot', url: 'https://t.me/deletezoomlinksbot' }],
      [{ text: 'Fix 1132', url: 'https://t.me/Fix1132Bot' }],
      [{ text: '« Back', callback_data: 'pa:back' }]
    ]
  };
}

/**
 * Build View List message (for DM subscribers)
 */
function buildViewListMessage() {
  return `
<b>PNP Directory List</b>

View and subscribe to active PNP rooms and groups.

<b>━━━━━━━━━━━━━━━━━━━━━━━━</b>

<b>What is this?</b>
The PNP Directory List Bot maintains a real-time
directory of active PNP rooms and groups.

<b>Features:</b>
• Browse active Zoom rooms
• Find Telegram video chat groups
• Subscribe to room notifications
• Add your own room to the directory

<b>━━━━━━━━━━━━━━━━━━━━━━━━</b>
  `.trim();
}

/**
 * Build View List keyboard
 */
function viewListKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Open PNP Directory List', url: 'https://t.me/PNPDirectoryListBot' }],
      [{ text: '« Back', callback_data: 'pa:back' }]
    ]
  };
}

/**
 * Post a new message to a chat
 */
async function postMessage(chatId) {
  if (!bot) return null;

  try {
    const settings = await getSettings(chatId);
    const rooms = await getActiveRooms(settings.inactive_threshold_minutes || 60);
    const telegramGroups = await getTelegramGroups();
    const text = buildMessage(rooms, telegramGroups);
    const keyboard = mainKeyboard(settings);

    // Delete old message if exists
    if (settings.last_message_id) {
      try {
        await bot.deleteMessage(chatId, settings.last_message_id);
      } catch (e) {
        // Message may already be deleted
      }
    }

    // Post new message
    const msg = await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    });

    // Save message ID and start timers
    await query(
      `UPDATE promo_attendant_settings
       SET last_message_id = $2, last_posted_at = NOW()
       WHERE chat_id = $1`,
      [chatId, msg.message_id]
    );

    startTimer(chatId);
    startUpdateTimer(chatId, msg.message_id);

    console.log(`[PromoAttendant] Posted message to ${chatId}`);
    return msg;
  } catch (error) {
    console.error(`[PromoAttendant] Failed to post to ${chatId}:`, error.message);
    return null;
  }
}

/**
 * Update an existing message
 */
async function updateMessage(chatId, msgId) {
  if (!bot) return;

  try {
    const settings = await getSettings(chatId);
    const rooms = await getActiveRooms(settings.inactive_threshold_minutes || 60);
    const telegramGroups = await getTelegramGroups();
    const text = buildMessage(rooms, telegramGroups);
    const keyboard = mainKeyboard(settings);

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    });
  } catch (error) {
    if (!error.message.includes('message is not modified')) {
      console.error(`[PromoAttendant] Failed to update ${chatId}:`, error.message);
    }
  }
}

/**
 * Start repost timer for a chat (respects last_posted_at on restart)
 */
function startTimer(chatId, skipInitialDelay = false) {
  stopTimer(chatId);

  getSettings(chatId).then(async settings => {
    if (!settings.enabled) return;

    const intervalMs = (settings.repost_interval_hours || 4) * 60 * 60 * 1000;

    // Calculate time until next repost based on last_posted_at
    let initialDelayMs = intervalMs;
    if (!skipInitialDelay && settings.last_posted_at) {
      const lastPosted = new Date(settings.last_posted_at).getTime();
      const nextRepost = lastPosted + intervalMs;
      const now = Date.now();
      initialDelayMs = Math.max(0, nextRepost - now);

      if (initialDelayMs > 0) {
        const mins = Math.round(initialDelayMs / 60000);
        console.log(`[PromoAttendant] Timer for ${chatId}: next repost in ${mins}m (respecting last_posted_at)`);
      }
    }

    // If delay is 0 or very small, still wait at least 1 minute to avoid spam on restart
    if (initialDelayMs < 60000) {
      initialDelayMs = 60000;
    }

    // First timeout, then regular interval
    const initialTimeout = setTimeout(async () => {
      try {
        await postMessage(chatId);
      } catch (e) {
        console.error(`[PromoAttendant] Repost timer failed for ${chatId}:`, e.message);
      }

      // Start regular interval after first post
      const timer = setInterval(async () => {
        try {
          await postMessage(chatId);
        } catch (e) {
          console.error(`[PromoAttendant] Repost timer failed for ${chatId}:`, e.message);
        }
      }, intervalMs);

      timers.set(chatId, timer);
    }, initialDelayMs);

    timers.set(chatId, initialTimeout);
    console.log(`[PromoAttendant] Repost timer started for ${chatId} (${settings.repost_interval_hours}h)`);
  });
}

/**
 * Stop repost timer
 */
function stopTimer(chatId) {
  const timer = timers.get(chatId);
  if (timer) {
    clearInterval(timer);
    timers.delete(chatId);
  }
}

/**
 * Start update timer (edits message every 10 minutes)
 */
function startUpdateTimer(chatId, msgId) {
  stopUpdateTimer(chatId);

  const timer = setInterval(async () => {
    try {
      await updateMessage(chatId, msgId);
    } catch (e) {
      console.error(`[PromoAttendant] Update timer failed for ${chatId}:`, e.message);
    }
  }, UPDATE_INTERVAL_MS);

  updateTimers.set(chatId, timer);
  console.log(`[PromoAttendant] Update timer started for ${chatId} (10m edits)`);
}

/**
 * Stop update timer
 */
function stopUpdateTimer(chatId) {
  const timer = updateTimers.get(chatId);
  if (timer) {
    clearInterval(timer);
    updateTimers.delete(chatId);
  }
}

/**
 * Start timers for all enabled chats
 */
async function startAllTimers() {
  try {
    const result = await query(
      `SELECT chat_id, last_message_id FROM promo_attendant_settings WHERE enabled = TRUE`
    );

    for (const row of result.rows) {
      startTimer(row.chat_id);
      if (row.last_message_id) {
        startUpdateTimer(row.chat_id, row.last_message_id);
      }
    }

    console.log(`[PromoAttendant] Started timers for ${result.rows.length} chats`);
  } catch (error) {
    console.error('[PromoAttendant] Failed to start timers:', error.message);
  }
}

/**
 * Shutdown the bot
 */
async function shutdownPromoAttendant() {
  // Clear all timers
  for (const timer of timers.values()) {
    clearInterval(timer);
  }
  timers.clear();

  for (const timer of updateTimers.values()) {
    clearInterval(timer);
  }
  updateTimers.clear();

  // Stop polling
  if (bot) {
    console.log('[PromoAttendant] Shutting down...');
    await bot.stopPolling();
    bot = null;
  }
}

module.exports = {
  initPromoAttendant,
  shutdownPromoAttendant,
  postMessage,
  getActiveRooms
};
