const TelegramBot = require("node-telegram-bot-api");
const { initDB, db } = require("./database");
const relay = require("./relay");
require("dotenv").config();

const TOKEN = process.env.TOKEN;

const bot = new TelegramBot(TOKEN, { polling: true });

const GROUP_CHAT_ID = parseInt(process.env.GROUP_CHAT_ID);
const GROUP_CHAT_ID_2 = -1003657694389;
const EXPERT_GROUP_CHAT_ID = parseInt(process.env.EXPERT_GROUP_CHAT_ID);
const ADMIN_HELP_GROUP_ID = -1003970027998;
const ADMIN_IDS = [2117559048, 6466671056, 1911312334, 1532807099, 1248799247, 1302705638, 1325958049, 1248799247, 8526365759, 1046218147, 5448140589, 912497121];
const pendingChecks = {};
const missedChecks = {};
const adminState = {};
const pendingAdminHelp = {};

(async () => {
  await initDB();
  console.log("🤖 Bot running");
})();

// ─── RELAY CALLBACKS ────────────────────────────────────────────────────────

function escapeMarkdown(text) {
  return (text || "").replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

function stripEmoji(str) {
  return (str || "").replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{FE00}-\u{FEFF}★⭐]/gu, "").trim();
}

relay.onAgentConnect = async (rustdesk_id, password) => {
  const now = new Date().toISOString();
  await db().run(
    `INSERT INTO agents (rustdesk_id, rustdesk_password, last_seen)
     VALUES (?, ?, ?)
     ON CONFLICT(rustdesk_id) DO UPDATE SET
       rustdesk_password = excluded.rustdesk_password,
       last_seen = excluded.last_seen`,
    [rustdesk_id, password, now]
  );
  await db().run(`UPDATE laptops SET agent_connected = 1 WHERE rustdesk_id = ?`, [rustdesk_id]);
  console.log(`✅ Agent registered in DB: ${rustdesk_id}`);
};

relay.onAgentDisconnect = async (rustdesk_id) => {
  await db().run(`UPDATE laptops SET agent_connected = 0 WHERE rustdesk_id = ?`, [rustdesk_id]);
  console.log(`🔌 Agent marked offline in DB: ${rustdesk_id}`);
};

// ─── KEYBOARDS ──────────────────────────────────────────────────────────────

const normalKeyboard = {
  reply_markup: {
    keyboard: [["Request Laptop"], ["My Laptop"], ["Return Laptop"], ["View Queue"], ["Admin Help"], ["Admin Controls"]],
    resize_keyboard: true,
    persistent: true
  }
};

const expertKeyboard = {
  reply_markup: {
    keyboard: [["Choose a Laptop"], ["My Laptop"], ["Return Laptop"]],
    resize_keyboard: true,
    persistent: true
  }
};

// ─── HELPERS ────────────────────────────────────────────────────────────────

function getGroupType(chatId) {
  if (chatId === EXPERT_GROUP_CHAT_ID) return "expert";
  if (chatId === GROUP_CHAT_ID || chatId === GROUP_CHAT_ID_2) return "normal";
  return null;
}

function getAssignedAt() {
  return new Date().toISOString();
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
  let password = "";
  for (let i = 0; i < 7; i++) password += chars.charAt(Math.floor(Math.random() * chars.length));
  return password;
}

function formatLogTime(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

async function sendAdminPanel(targetId) {
  try {
    await bot.sendMessage(targetId, "🛠 Admin Panel", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Add Laptop", callback_data: "add_laptop" }],
          [{ text: "📦 Stasis", callback_data: "stasis_menu" }],
          [{ text: "❌ Remove Laptop", callback_data: "remove_laptop" }],
          [{ text: "🔌 Offline", callback_data: "offline_menu" }],
          [{ text: "🔄 Transfer", callback_data: "transfer_menu" }],
          [{ text: "⚡ Force Assign", callback_data: "force_assign" }],
          [{ text: "🗑 Delete Laptop", callback_data: "delete_laptop" }],
          [{ text: "📊 Status", callback_data: "status" }],
          [{ text: "🔐 Security", callback_data: "security_menu" }],
          [{ text: "📋 Laptop Logs", callback_data: "logs_menu" }],
          [{ text: "🕐 24h Workers", callback_data: "logs_24h" }],
          [{ text: "🗑 Clear Queue", callback_data: "clear_queue" }]
        ]
      }
    });
  } catch (e) {
    console.log("Could not send admin panel:", e.message);
  }
}

async function notifyNeedsStart(chatId, username) {
  await bot.sendMessage(chatId,
    `⚠️ ${username}, you need to message the bot privately first. Open @YourBotUsername and press Start, then try again.`
  );
}

// Sends to both normal groups; pass options as you would to bot.sendMessage
async function sendToNormalGroups(message, options = {}) {
  await bot.sendMessage(GROUP_CHAT_ID, message, options);
  await bot.sendMessage(GROUP_CHAT_ID_2, message, options);
}

async function sendPasswordDM(userId, laptopName, rustdesk_id, password, groupChatId) {
  try {
    await bot.sendMessage(userId,
      `🖥 You have been assigned: *${escapeMarkdown(laptopName)}*\n\n` +
      `🔑 RustDesk ID: \`${rustdesk_id}\`\n` +
      `🔐 Password: \`${password}\`\n\n` +
      `Use these to connect via RustDesk. Return the laptop when done.`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.log("Could not DM user:", e.message);
    await bot.sendMessage(groupChatId, `⚠️ Could not send you the RustDesk credentials via DM. Please start the bot privately first.`);
  }
}

async function assignLaptopToUser(laptop, userId, username, groupChatId) {
  const now = getAssignedAt();
  const nowISO = new Date().toISOString();
  const isNormalGroup = groupChatId === GROUP_CHAT_ID;

  await db().run(
    `UPDATE laptops SET status = 'assigned', assigned_to = ?, assigned_username = ?, assigned_at = ? WHERE id = ?`,
    [userId, username, now, laptop.id]
  );

  await db().run(
    `INSERT INTO laptop_logs (laptop_id, laptop_name, user_id, username, action, action_time) VALUES (?, ?, ?, ?, 'assigned', ?)`,
    [laptop.id, laptop.name, userId, username, nowISO]
  );

  const sendGroup = async (msg, opts = {}) => {
    await bot.sendMessage(groupChatId, msg, opts);
    if (isNormalGroup) await bot.sendMessage(GROUP_CHAT_ID_2, msg, opts);
  };

  if (laptop.advanced_security && laptop.rustdesk_id) {
    if (!relay.isConnected(laptop.rustdesk_id)) {
      await sendGroup(
        `⚠️ ${escapeMarkdown(username)} has been assigned *${escapeMarkdown(laptop.name)}* but there seems to be a disconnection with this laptop's security agent. Please let an admin handle this.`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    try {
      const newPassword = generatePassword();
      await relay.setPassword(laptop.rustdesk_id, newPassword);
      await db().run(`UPDATE laptops SET rustdesk_password = ? WHERE id = ?`, [newPassword, laptop.id]);
      await db().run(`UPDATE agents SET rustdesk_password = ? WHERE rustdesk_id = ?`, [newPassword, laptop.rustdesk_id]);
      await sendGroup(
        `✅ ${escapeMarkdown(username)} has been assigned: *${escapeMarkdown(laptop.name)}*\n🔐 Credentials sent via DM.`,
        { parse_mode: "Markdown" }
      );
      await sendPasswordDM(userId, laptop.name, laptop.rustdesk_id, newPassword, groupChatId);
    } catch (err) {
      console.log("Security assignment error:", err.message);
      await sendGroup(
        `⚠️ ${escapeMarkdown(username)} has been assigned *${escapeMarkdown(laptop.name)}* but the security agent did not respond. Please let an admin handle this.`,
        { parse_mode: "Markdown" }
      );
    }
  } else {
    await sendGroup(`✅ ${username} has been assigned: ${laptop.name}`);
  }
}

async function handleLaptopReturn(laptop, groupChatId) {
  const nowISO = new Date().toISOString();

  if (laptop.advanced_security && laptop.rustdesk_id && relay.isConnected(laptop.rustdesk_id)) {
    try {
      const newPassword = generatePassword();
      await relay.setPassword(laptop.rustdesk_id, newPassword);
      await db().run(`UPDATE laptops SET rustdesk_password = ? WHERE id = ?`, [newPassword, laptop.id]);
      await db().run(`UPDATE agents SET rustdesk_password = ? WHERE rustdesk_id = ?`, [newPassword, laptop.rustdesk_id]);
      console.log(`🔐 Password rotated on return for ${laptop.name}`);
    } catch (err) {
      console.log("Password rotation on return failed:", err.message);
    }
  }

  await db().run(
    `INSERT INTO laptop_logs (laptop_id, laptop_name, user_id, username, action, action_time) VALUES (?, ?, ?, ?, 'returned', ?)`,
    [laptop.id, laptop.name, laptop.assigned_to || null, laptop.assigned_username || null, nowISO]
  );

  await db().run(
    `UPDATE laptops SET status = 'available', assigned_to = NULL, assigned_username = NULL, assigned_at = NULL WHERE id = ?`,
    [laptop.id]
  );
}

// ─── TRACK USER ─────────────────────────────────────────────────────────────

async function trackUser(userId, username, firstName, groupType) {
  await db().run(
    `INSERT INTO users (user_id, username, first_name, group_type)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       group_type = excluded.group_type`,
    [userId, username || null, firstName || null, groupType]
  );
}

// ─── QUEUE ──────────────────────────────────────────────────────────────────

async function askNextInQueue(laptopId, groupType) {
  const nextUser = await db().get(`SELECT * FROM queue WHERE group_type = ? ORDER BY id ASC LIMIT 1`, [groupType]);
  if (!nextUser) { console.log("Queue is empty for", groupType); return; }

  const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
  if (!laptop) return;

  if (pendingChecks[nextUser.user_id]) {
    console.log(`User ${nextUser.user_id} already has pending check, skipping`);
    return;
  }

  const mention = nextUser.username ? `@${nextUser.username.replace("@", "")}` : `User ${nextUser.user_id}`;
  const targetGroupId = groupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
  const isNormalGroup = groupType !== "expert";
  const sendToTarget = async (msg, opts = {}) => {
    await bot.sendMessage(targetGroupId, msg, opts);
    if (isNormalGroup) await bot.sendMessage(GROUP_CHAT_ID_2, msg, opts);
  };

  await sendToTarget(
    `🔔 ${mention}, a laptop is available: ${laptop.name}\n\nAre you still available to work?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Yes", callback_data: `available_yes_${laptopId}_${nextUser.user_id}` },
          { text: "❌ No", callback_data: `available_no_${laptopId}_${nextUser.user_id}` }
        ]]
      }
    }
  );

  const timeout = setTimeout(async () => {
    if (!pendingChecks[nextUser.user_id]) return;
    delete pendingChecks[nextUser.user_id];

    missedChecks[nextUser.user_id] = (missedChecks[nextUser.user_id] || 0) + 1;

    if (missedChecks[nextUser.user_id] >= 2) {
      // Two strikes — remove from queue entirely
      delete missedChecks[nextUser.user_id];
      await db().run(`DELETE FROM queue WHERE id = ?`, [nextUser.id]);
      await sendToTarget(`❌ ${mention} didn't respond twice and has been removed from the queue.`);
    } else {
      // First strike — move to bottom
      await db().run(`DELETE FROM queue WHERE id = ?`, [nextUser.id]);
      await db().run(`INSERT INTO queue (user_id, username, group_type) VALUES (?, ?, ?)`, [nextUser.user_id, nextUser.username, groupType]);
      await sendToTarget(`⏰ ${mention} didn't respond in time and has been moved to the bottom of the queue. (1/2 — one more miss and you'll be removed)`);
    }

    // Only recurse if the next person in line is someone different
    const nextInLine = await db().get(`SELECT * FROM queue WHERE group_type = ? ORDER BY id ASC LIMIT 1`, [groupType]);
    if (nextInLine && nextInLine.user_id !== nextUser.user_id) {
      await askNextInQueue(laptopId, groupType);
    }
  }, 1 * 60 * 1000);

  pendingChecks[nextUser.user_id] = { laptopId, timeout, groupType };
}

// ─── START ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const groupType = getGroupType(chatId);
  if (msg.chat.type === "private") return bot.sendMessage(chatId, "👋 Welcome! Please use the group chat to interact with the bot.");
  if (groupType === "expert") return bot.sendMessage(chatId, "Welcome to Laptop Manager", expertKeyboard);
  return bot.sendMessage(chatId, "Welcome to Laptop Manager", normalKeyboard);
});

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const text = (msg.text || "").trim();
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const lower = text.toLowerCase();
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const firstName = msg.from.first_name || "";
  const isAdmin = ADMIN_IDS.includes(userId);
  const groupType = getGroupType(chatId);

  if (msg.chat.type !== "private" && groupType) {
    await trackUser(userId, msg.from.username || null, firstName, groupType);
  }

  if (msg.chat.type === "private" && !isAdmin) {
    return bot.sendMessage(chatId, "⚠️ Please use the group chat to interact with the bot.");
  }

  if (lower === "admin controls") {
    if (!isAdmin) return bot.sendMessage(chatId, "⛔ You don't have access to admin controls.");
    try {
      await bot.sendMessage(chatId, "🛠 Admin panel sent to your DM.");
      await sendAdminPanel(userId);
    } catch (e) {
      await notifyNeedsStart(chatId, username);
    }
    return;
  }

  // ── ADMIN HELP INPUT (non-admin users) ──
  if (adminState[userId] && adminState[userId].action === "awaiting_admin_help_issue") {
    const issue = text;
    const helpUserId = adminState[userId].helpUserId;
    const helpUsername = adminState[userId].helpUsername;
    delete adminState[userId];
    delete pendingAdminHelp[helpUserId];

    const adminUsers = await db().all(
      `SELECT username FROM users WHERE user_id IN (${ADMIN_IDS.join(",")}) AND username IS NOT NULL`
    );
    const adminMentions = adminUsers.length
      ? adminUsers.map(u => `@${u.username.replace(/^@/, "")}`).join(" ")
      : "";
    const helpMsg = `🆘 *Admin Help Request*\n\nFrom: ${helpUsername}\n\n*Issue:*\n${issue}${adminMentions ? `\n\n${adminMentions}` : ""}`;
    try {
      await bot.sendMessage(ADMIN_HELP_GROUP_ID, helpMsg);
      await bot.sendMessage(chatId, "✅ Your issue has been sent to the admins. Someone will assist you shortly.");
    } catch (e) {
      console.log("Admin help send error:", e.message);
      await bot.sendMessage(chatId, "❌ Could not send your message. Please try again.");
    }
    return;
  }

  // ── ADMIN TEXT INPUT ──
  if (adminState[userId]) {
    if (!isAdmin) return;
    const reserved = ["request laptop", "my laptop", "return laptop", "view queue", "admin controls", "admin help", "choose a laptop"];
    if (reserved.includes(lower)) return;

    if (adminState[userId].action === "awaiting_remove_search") {
      const query = stripEmoji(text.toLowerCase().trim());
      delete adminState[userId];
      const allLaptops = await db().all(`SELECT * FROM laptops WHERE status = 'available' OR status = 'assigned'`);
      const laptops = allLaptops.filter(l => stripEmoji(l.name.toLowerCase()).includes(query));
      if (!laptops.length) {
        await bot.sendMessage(userId, `⚠️ No active laptops found matching "${text}". Try again.`);
        return sendAdminPanel(userId);
      }
      const buttons = laptops.map(l => ([{ text: `❌ ${l.name} (${l.status} - ${l.group_type})`, callback_data: `remove_${l.id}` }]));
      buttons.push([{ text: "🚫 Cancel", callback_data: "cancel" }]);
      return bot.sendMessage(userId, `Select a laptop to put in stasis:`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (adminState[userId].action === "awaiting_laptop_name") {
      const laptopName = text;
      delete adminState[userId];
      await db().run(`INSERT INTO laptops (name, status, group_type) VALUES (?, 'stasis', 'stasis')`, [laptopName]);
      await bot.sendMessage(userId, `✅ ${escapeMarkdown(laptopName)} added to stasis.`);
      await sendAdminPanel(userId);
      return;
    }

    if (adminState[userId].action === "awaiting_delete_search") {
      const query = stripEmoji(text.toLowerCase().trim());
      delete adminState[userId];
      const allLaptops = await db().all(`SELECT * FROM laptops`);
      const laptops = allLaptops.filter(l => stripEmoji(l.name.toLowerCase()).includes(query));
      if (!laptops.length) {
        await bot.sendMessage(userId, `⚠️ No laptops found matching "${text}".`);
        return sendAdminPanel(userId);
      }
      const buttons = laptops.map(l => ([{ text: `🗑 ${l.name} (${l.status} - ${l.group_type})`, callback_data: `confirmdelete_${l.id}` }]));
      buttons.push([{ text: "🚫 Cancel", callback_data: "cancel" }]);
      return bot.sendMessage(userId, `Select a laptop to delete:`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (adminState[userId].action === "awaiting_password_search") {
      const query = stripEmoji(text.toLowerCase().trim());
      delete adminState[userId];
      const allLaptops = await db().all(`SELECT * FROM laptops WHERE advanced_security = 1`);
      const laptops = allLaptops.filter(l => stripEmoji(l.name.toLowerCase()).includes(query));
      if (!laptops.length) {
        await bot.sendMessage(userId, `⚠️ No secure laptops found matching "${text}".`);
        return sendAdminPanel(userId);
      }
      const buttons = laptops.map(l => {
        const online = l.rustdesk_id && relay.isConnected(l.rustdesk_id) ? "🟢" : "🔴";
        return [{ text: `${online} ${l.name}`, callback_data: `showpw_${l.id}` }];
      });
      buttons.push([{ text: "🚫 Cancel", callback_data: "cancel" }]);
      return bot.sendMessage(userId, `Select a laptop to view password:`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (adminState[userId].action === "awaiting_deactivate_search") {
      const query = stripEmoji(text.toLowerCase().trim());
      delete adminState[userId];
      const allLaptops = await db().all(`SELECT * FROM laptops WHERE advanced_security = 1`);
      const laptops = allLaptops.filter(l => stripEmoji(l.name.toLowerCase()).includes(query));
      if (!laptops.length) {
        await bot.sendMessage(userId, `⚠️ No laptops with advanced security found matching "${text}".`);
        return sendAdminPanel(userId);
      }
      const buttons = laptops.map(l => {
        const online = relay.isConnected(l.rustdesk_id) ? "🟢" : "🔴";
        return [{ text: `${online} ${l.name}`, callback_data: `sec_do_deactivate_${l.id}` }];
      });
      buttons.push([{ text: "🚫 Cancel", callback_data: "cancel" }]);
      return bot.sendMessage(userId, `Select a laptop to deactivate advanced security:`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (adminState[userId].action === "awaiting_logs_search") {
      const query = stripEmoji(text.toLowerCase().trim());
      delete adminState[userId];
      const allLaptops = await db().all(`SELECT * FROM laptops`);
      const laptops = allLaptops.filter(l => stripEmoji(l.name.toLowerCase()).includes(query));
      if (!laptops.length) {
        await bot.sendMessage(userId, `⚠️ No laptops found matching "${text}".`);
        return sendAdminPanel(userId);
      }
      const buttons = laptops.map(l => ([{ text: l.name, callback_data: `showlogs_${l.id}` }]));
      buttons.push([{ text: "🚫 Cancel", callback_data: "cancel" }]);
      return bot.sendMessage(userId, `Select a laptop to view logs:`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (adminState[userId].action === "awaiting_security_name") {
      const { rustdesk_id } = adminState[userId];
      const query = stripEmoji(text.toLowerCase().trim());
      const allLaptops = await db().all(`SELECT * FROM laptops`);
      const matches = allLaptops.filter(l => stripEmoji(l.name.toLowerCase()).includes(query));

      if (!matches.length) {
        await bot.sendMessage(userId,
          `⚠️ No laptops found matching "${escapeMarkdown(text)}". Try again.`,
          { reply_markup: { inline_keyboard: [[{ text: "🚫 Cancel", callback_data: "cancel" }]] } }
        );
        return;
      }


      const buttons = matches.map(l => ([{ text: l.name, callback_data: `sec_pick_laptop_${l.id}_${rustdesk_id}` }]));
      buttons.push([{ text: "🚫 Cancel", callback_data: "cancel" }]);
      return bot.sendMessage(userId, `Select the laptop to link:`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (adminState[userId].action === "awaiting_fa_search") {
      const query = text.replace(/^@/, "").toLowerCase();
      const results = await db().all(
        `SELECT * FROM users WHERE LOWER(username) LIKE ? OR LOWER(first_name) LIKE ?`,
        [`%${query}%`, `%${query}%`]
      );
      if (!results.length) {
        await bot.sendMessage(userId, `⚠️ No users found matching "${text}". Try again.`);
        return;
      }
      const buttons = results.map(u => {
        const label = u.username ? `@${u.username}` : u.first_name;
        return [{ text: label, callback_data: `fa_user_${u.user_id}_${u.group_type}` }];
      });
      buttons.push([{ text: "🔍 Search Again", callback_data: "force_assign" }]);
      buttons.push([{ text: "🚫 Cancel", callback_data: "cancel" }]);
      delete adminState[userId];
      return bot.sendMessage(userId, `Select a user:`, { reply_markup: { inline_keyboard: buttons } });
    }
  }

  if (text === "/admin" && isAdmin) {
    try { await sendAdminPanel(userId); } catch (e) { await notifyNeedsStart(chatId, username); }
    return;
  }

  if (msg.chat.type === "private") return;

  // ── EXPERT GROUP ──
  if (groupType === "expert") {
    if (lower === "choose a laptop") {
      try {
        const existing = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
        if (existing) return bot.sendMessage(chatId, `⚠️ You already have: ${existing.name}`);
        const expertLaptops = await db().all(`SELECT * FROM laptops WHERE status = 'available' AND group_type = 'expert'`);
        if (!expertLaptops.length) return bot.sendMessage(chatId, "⏳ No expert laptops available. Please try again later.");
        const buttons = expertLaptops.map(l => ([{ text: l.name, callback_data: `expert_pick_${l.id}` }]));
        return bot.sendMessage(chatId, "🖥 Select a laptop:", { reply_markup: { inline_keyboard: buttons } });
      } catch (err) {
        console.log("EXPERT CHOOSE ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred.");
      }
    }
    if (lower === "my laptop") {
      const laptop = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
      if (!laptop) return bot.sendMessage(chatId, "❌ You don't have an expert laptop.");
      return bot.sendMessage(chatId, `💻 ${username} is assigned to: ${laptop.name}`);
    }
    if (lower === "return laptop") {
      try {
        const laptop = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
        if (!laptop) return bot.sendMessage(chatId, "❌ You don't have an expert laptop.");
        await handleLaptopReturn(laptop, EXPERT_GROUP_CHAT_ID);
        await bot.sendMessage(chatId, `🔄 ${username} returned: ${laptop.name}`);
        const queueCount = await db().get(`SELECT COUNT(*) as count FROM queue WHERE group_type = 'expert'`);
        if (queueCount.count > 0) await askNextInQueue(laptop.id, "expert");
      } catch (err) {
        console.log("EXPERT RETURN ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred during return.");
      }
    }
    return;
  }

  // ── NORMAL GROUP ──
  if (groupType === "normal") {
    if (lower.includes("request")) {
      try {
        const existing = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
        if (existing) return bot.sendMessage(chatId, `⚠️ You already have: ${existing.name}`);
        const inQueue = await db().get(`SELECT * FROM queue WHERE user_id = ? AND group_type = 'normal'`, [userId]);
        if (inQueue) return bot.sendMessage(chatId, "⏳ You are already in queue.");
        const sentMsg = await bot.sendMessage(chatId,
          `${username}, are you available to work?`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Yes", callback_data: `req_confirm_yes_${userId}` },
                { text: "❌ No", callback_data: `req_confirm_no_${userId}` }
              ]]
            }
          }
        );
        const timeout = setTimeout(async () => {
          try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: sentMsg.message_id });
            await bot.sendMessage(chatId, `⏰ ${username}, your request confirmation expired. Please make another request.`);
          } catch (e) { console.log("Request confirm timeout cleanup error:", e.message); }
        }, 3 * 60 * 1000);
        pendingAdminHelp[`req_${userId}`] = { chatId, timeout };
      } catch (err) {
        console.log("REQUEST ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred during request.");
      }
    }
    if (lower.includes("return")) {
      try {
        const laptop = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
        if (!laptop) return bot.sendMessage(chatId, "❌ You don't have a laptop.");
        await handleLaptopReturn(laptop, GROUP_CHAT_ID);
        await bot.sendMessage(chatId, `🔄 ${username} returned: ${laptop.name}`);
        const queueCount = await db().get(`SELECT COUNT(*) as count FROM queue WHERE group_type = 'normal'`);
        if (queueCount.count > 0) await askNextInQueue(laptop.id, "normal");
      } catch (err) {
        console.log("RETURN ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred during return.");
      }
    }
    if (lower.includes("my laptop")) {
      const laptop = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
      if (!laptop) return bot.sendMessage(chatId, "❌ You don't have a laptop.");
      return bot.sendMessage(chatId, `💻 ${username} is assigned to: ${laptop.name}`);
    }
    if (lower.includes("view queue") || lower === "queue") {
      const queue = await db().all(`SELECT * FROM queue WHERE group_type = 'normal' ORDER BY id ASC`);
      if (!queue.length) return bot.sendMessage(chatId, "📊 Queue is empty.");
      const list = queue.map((q, i) => `${i + 1}. ${q.username || `User ${q.user_id}`}`).join("\n");
      return bot.sendMessage(chatId, `📊 QUEUE\n\n${list}`);
    }
    if (lower === "admin help") {
      const existing = pendingAdminHelp[userId];
      if (existing) return bot.sendMessage(chatId, "⏳ You already have a pending admin help request. Please type your issue.");
      pendingAdminHelp[userId] = true;
      adminState[userId] = { action: "awaiting_admin_help_issue", helpUserId: userId, helpUsername: username };
      return bot.sendMessage(chatId, "📝 Please type the issue you are facing and I will forward it to the admins.");
    }
  }
});

// ─── CALLBACK HANDLER ────────────────────────────────────────────────────────

bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const username = callbackQuery.from.username ? `@${callbackQuery.from.username}` : callbackQuery.from.first_name;
  const isAdmin = ADMIN_IDS.includes(userId);

  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (e) { console.log("Callback query expired"); }

  if (data.startsWith("expert_pick_")) {
    const laptopId = parseInt(data.split("_")[2]);
    const existing = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
    if (existing) return bot.sendMessage(chatId, `⚠️ You already have: ${existing.name}`);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (!laptop || laptop.status !== "available") return bot.sendMessage(chatId, "⚠️ That laptop is no longer available.");
    await assignLaptopToUser(laptop, userId, username, EXPERT_GROUP_CHAT_ID);
    return;
  }

  if (data.startsWith("available_yes_")) {
    const parts = data.split("_");
    const laptopId = parseInt(parts[2]);
    const targetUserId = parseInt(parts[3]);
    if (userId !== targetUserId) return;
    if (!pendingChecks[userId]) return bot.sendMessage(chatId, "⚠️ This request has already expired.");
    const groupType = pendingChecks[userId].groupType;
    clearTimeout(pendingChecks[userId].timeout);
    delete pendingChecks[userId];
    delete missedChecks[userId];
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (!laptop || laptop.status !== "available") return bot.sendMessage(chatId, "⚠️ Laptop is no longer available.");
    await db().run(`DELETE FROM queue WHERE user_id = ? AND group_type = ?`, [userId, groupType]);
    const targetGroupId = groupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
    await assignLaptopToUser(laptop, userId, username, targetGroupId);
    return;
  }

  if (data.startsWith("available_no_")) {
    const parts = data.split("_");
    const laptopId = parseInt(parts[2]);
    const targetUserId = parseInt(parts[3]);
    if (userId !== targetUserId) return;
    if (!pendingChecks[userId]) return bot.sendMessage(chatId, "⚠️ This request has already expired.");
    const groupType = pendingChecks[userId].groupType;
    clearTimeout(pendingChecks[userId].timeout);
    delete pendingChecks[userId];
    delete missedChecks[userId];
    await db().run(`DELETE FROM queue WHERE user_id = ? AND group_type = ?`, [userId, groupType]);
    const targetGroupId = groupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
    await bot.sendMessage(targetGroupId, `${username} has opted out and been removed from the queue.`);
    if (groupType !== "expert") await bot.sendMessage(GROUP_CHAT_ID_2, `${username} has opted out and been removed from the queue.`);
    await askNextInQueue(laptopId, groupType);
    return;
  }

  // ── REQUEST CONFIRMATION ──
  if (data.startsWith("req_confirm_yes_")) {
    const targetUserId = parseInt(data.replace("req_confirm_yes_", ""));
    if (userId !== targetUserId) return;
    const pending = pendingAdminHelp[`req_${userId}`];
    if (!pending) return bot.sendMessage(chatId, "⚠️ This request has already expired.");
    clearTimeout(pending.timeout);
    delete pendingAdminHelp[`req_${userId}`];
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    } catch (e) {}
    try {
      const existing = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
      if (existing) return bot.sendMessage(chatId, `⚠️ You already have: ${existing.name}`);
      const inQueue = await db().get(`SELECT * FROM queue WHERE user_id = ? AND group_type = 'normal'`, [userId]);
      if (inQueue) return bot.sendMessage(chatId, "⏳ You are already in queue.");
      const laptop = await db().get(`SELECT * FROM laptops WHERE status = 'available' AND group_type = 'normal' ORDER BY RANDOM() LIMIT 1`);
      if (!laptop) {
        await db().run(`INSERT INTO queue (user_id, username, group_type) VALUES (?, ?, 'normal')`, [userId, username]);
        return bot.sendMessage(chatId, "⏳ No laptops available. You've been added to queue.");
      }
      await assignLaptopToUser(laptop, userId, username, GROUP_CHAT_ID);
    } catch (err) {
      console.log("REQUEST CONFIRM ERROR:", err);
      return bot.sendMessage(chatId, "❌ Error occurred during request.");
    }
    return;
  }

  if (data.startsWith("req_confirm_no_")) {
    const targetUserId = parseInt(data.replace("req_confirm_no_", ""));
    if (userId !== targetUserId) return;
    const pending = pendingAdminHelp[`req_${userId}`];
    if (!pending) return bot.sendMessage(chatId, "⚠️ This request has already expired.");
    clearTimeout(pending.timeout);
    delete pendingAdminHelp[`req_${userId}`];
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });
    } catch (e) {}
    return bot.sendMessage(chatId, `👍 No problem ${username}. Request cancelled.`);
  }

  if (!isAdmin) return;

  const cancelButton = [{ text: "🚫 Cancel", callback_data: "cancel" }];

  if (data === "cancel") {
    delete adminState[userId];
    return sendAdminPanel(userId);
  }

  if (data === "add_laptop") {
    adminState[userId] = { action: "awaiting_laptop_name" };
    return bot.sendMessage(userId, "💬 Send me the name of the new laptop:", { reply_markup: { inline_keyboard: [cancelButton] } });
  }

  if (data === "stasis_menu") {
    return bot.sendMessage(userId, "📦 Stasis — deploy a laptop to a group:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➡️ Send to Normal Group", callback_data: "stasis_to_normal" }],
          [{ text: "➡️ Send to Expert Group", callback_data: "stasis_to_expert" }],
          cancelButton
        ]
      }
    });
  }

  if (data === "stasis_to_normal" || data === "stasis_to_expert") {
    const targetGroup = data === "stasis_to_normal" ? "normal" : "expert";
    const stasisLaptops = await db().all(`SELECT * FROM laptops WHERE status = 'stasis'`);
    if (!stasisLaptops.length) { await bot.sendMessage(userId, "📭 No laptops in stasis."); return sendAdminPanel(userId); }
    const buttons = stasisLaptops.map(l => ([{ text: l.name, callback_data: `deploy_${targetGroup}_${l.id}` }]));
    buttons.push(cancelButton);
    return bot.sendMessage(userId, `Select a laptop to deploy to ${targetGroup} group:`, { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("deploy_")) {
    const parts = data.split("_");
    const targetGroup = parts[1];
    const laptopId = parseInt(parts[2]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    await db().run(`UPDATE laptops SET status = 'available', group_type = ? WHERE id = ?`, [targetGroup, laptopId]);
    await bot.sendMessage(userId, `✅ ${laptop.name} deployed to ${targetGroup} group.`);
    const queueCount = await db().get(`SELECT COUNT(*) as count FROM queue WHERE group_type = ?`, [targetGroup]);
    if (queueCount.count > 0) await askNextInQueue(laptopId, targetGroup);
    return sendAdminPanel(userId);
  }

  if (data === "remove_laptop") {
    adminState[userId] = { action: "awaiting_remove_search" };
    return bot.sendMessage(userId, "🔍 Type a laptop name to search:", { reply_markup: { inline_keyboard: [cancelButton] } });
  }

  if (data.startsWith("remove_") && !data.startsWith("remove_laptop")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (laptop.assigned_to) {
      const assignedUsername = laptop.assigned_username || `User ${laptop.assigned_to}`;
      const targetGroupId = laptop.group_type === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
      await bot.sendMessage(targetGroupId, `⚠️ ${assignedUsername} has been removed from ${laptop.name}. Please submit your work.`);
      if (laptop.group_type !== "expert") await bot.sendMessage(GROUP_CHAT_ID_2, `⚠️ ${assignedUsername} has been removed from ${laptop.name}. Please submit your work.`);
    }
    await db().run(`UPDATE laptops SET status = 'stasis', group_type = 'stasis', assigned_to = NULL, assigned_username = NULL, assigned_at = NULL WHERE id = ?`, [laptopId]);
    await bot.sendMessage(userId, `✅ ${laptop.name} has been put in stasis.`);
    return sendAdminPanel(userId);
  }

  if (data === "offline_menu") {
    return bot.sendMessage(userId, "🔌 Offline menu:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Add to Offline", callback_data: "add_offline" }],
          [{ text: "♻️ Restore to Stasis", callback_data: "restore_offline" }],
          cancelButton
        ]
      }
    });
  }

  if (data === "add_offline") {
    const laptops = await db().all(`SELECT * FROM laptops WHERE status != 'offline'`);
    if (!laptops.length) { await bot.sendMessage(userId, "📭 No laptops to put offline."); return sendAdminPanel(userId); }
    const buttons = laptops.map(l => ([{ text: `🔌 ${l.name} (${l.status} - ${l.group_type})`, callback_data: `offline_${l.id}` }]));
    buttons.push(cancelButton);
    return bot.sendMessage(userId, "Select a laptop to put offline:", { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("offline_") && !data.startsWith("offline_menu")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (laptop.assigned_to) {
      const assignedUsername = laptop.assigned_username || `User ${laptop.assigned_to}`;
      const targetGroupId = laptop.group_type === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
      await bot.sendMessage(targetGroupId, `⚠️ ${assignedUsername} has been removed from ${laptop.name}. The laptop is going offline.`);
      if (laptop.group_type !== "expert") await bot.sendMessage(GROUP_CHAT_ID_2, `⚠️ ${assignedUsername} has been removed from ${laptop.name}. The laptop is going offline.`);
    }
    await db().run(`UPDATE laptops SET status = 'offline', assigned_to = NULL, assigned_username = NULL, assigned_at = NULL WHERE id = ?`, [laptopId]);
    await bot.sendMessage(userId, `✅ ${laptop.name} is now offline.`);
    return sendAdminPanel(userId);
  }

  if (data === "restore_offline") {
    const offlineLaptops = await db().all(`SELECT * FROM laptops WHERE status = 'offline'`);
    if (!offlineLaptops.length) { await bot.sendMessage(userId, "📭 No offline laptops."); return sendAdminPanel(userId); }
    const buttons = offlineLaptops.map(l => ([{ text: `♻️ ${l.name}`, callback_data: `restoreoffline_${l.id}` }]));
    buttons.push(cancelButton);
    return bot.sendMessage(userId, "Select a laptop to restore to stasis:", { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("restoreoffline_")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    await db().run(`UPDATE laptops SET status = 'stasis', group_type = 'stasis' WHERE id = ?`, [laptopId]);
    await bot.sendMessage(userId, `✅ ${laptop.name} restored to stasis.`);
    return sendAdminPanel(userId);
  }

  if (data === "transfer_menu") {
    return bot.sendMessage(userId, "🔄 Transfer laptops between groups:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Expert ➡️ Normal", callback_data: "transfer_e2n" }],
          [{ text: "Normal ➡️ Expert", callback_data: "transfer_n2e" }],
          cancelButton
        ]
      }
    });
  }

  if (data === "transfer_e2n" || data === "transfer_n2e") {
    const fromGroup = data === "transfer_e2n" ? "expert" : "normal";
    const toGroup = data === "transfer_e2n" ? "normal" : "expert";
    const laptops = await db().all(`SELECT * FROM laptops WHERE status = 'available' AND group_type = ?`, [fromGroup]);
    if (!laptops.length) { await bot.sendMessage(userId, `📭 No available laptops in ${fromGroup} group.`); return sendAdminPanel(userId); }
    adminState[userId] = { action: "transferring", fromGroup, toGroup, selected: [] };
    const buttons = laptops.map(l => ([{ text: l.name, callback_data: `tselect_${l.id}` }]));
    buttons.push([{ text: "✅ Confirm Transfer", callback_data: "transfer_confirm" }]);
    buttons.push(cancelButton);
    return bot.sendMessage(userId, `Select laptops to transfer from ${fromGroup} to ${toGroup}:\n\nSelected: none`, { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("tselect_")) {
    const laptopId = parseInt(data.split("_")[1]);
    if (!adminState[userId] || adminState[userId].action !== "transferring") return;
    const selected = adminState[userId].selected;
    const idx = selected.indexOf(laptopId);
    if (idx === -1) selected.push(laptopId); else selected.splice(idx, 1);
    const laptops = await db().all(`SELECT * FROM laptops WHERE status = 'available' AND group_type = ?`, [adminState[userId].fromGroup]);
    const selectedNames = await Promise.all(selected.map(async id => { const l = await db().get(`SELECT name FROM laptops WHERE id = ?`, [id]); return l ? l.name : id; }));
    const buttons = laptops.map(l => ([{ text: selected.includes(l.id) ? `✅ ${l.name}` : l.name, callback_data: `tselect_${l.id}` }]));
    buttons.push([{ text: "✅ Confirm Transfer", callback_data: "transfer_confirm" }]);
    buttons.push(cancelButton);
    return bot.editMessageText(
      `Select laptops to transfer:\n\nSelected: ${selectedNames.length ? selectedNames.join(", ") : "none"}`,
      { chat_id: userId, message_id: callbackQuery.message.message_id, reply_markup: { inline_keyboard: buttons } }
    );
  }

  if (data === "transfer_confirm") {
    if (!adminState[userId] || adminState[userId].action !== "transferring") return;
    const { fromGroup, toGroup, selected } = adminState[userId];
    delete adminState[userId];
    if (!selected.length) { await bot.sendMessage(userId, "⚠️ No laptops selected."); return sendAdminPanel(userId); }
    const names = [];
    for (const laptopId of selected) {
      const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
      await db().run(`UPDATE laptops SET group_type = ? WHERE id = ?`, [toGroup, laptopId]);
      names.push(laptop.name);
    }
    const targetGroupId = toGroup === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
    await bot.sendMessage(targetGroupId, `🔄 The following laptops have been transferred to this group: ${names.join(", ")}`);
    if (toGroup !== "expert") await bot.sendMessage(GROUP_CHAT_ID_2, `🔄 The following laptops have been transferred to this group: ${names.join(", ")}`);
    await bot.sendMessage(userId, `✅ Transferred ${names.join(", ")} to ${toGroup} group.`);
    return sendAdminPanel(userId);
  }

  if (data === "force_assign") {
    adminState[userId] = { action: "awaiting_fa_search" };
    return bot.sendMessage(userId, "🔍 Type a name or username to search for a user:", {
      reply_markup: { inline_keyboard: [[{ text: "📋 Pick from Queue", callback_data: "force_assign_queue" }], cancelButton] }
    });
  }

  if (data === "force_assign_queue") {
    const normalQueue = await db().all(`SELECT * FROM queue WHERE group_type = 'normal' ORDER BY id ASC`);
    const expertQueue = await db().all(`SELECT * FROM queue WHERE group_type = 'expert' ORDER BY id ASC`);
    const allQueue = [...normalQueue, ...expertQueue];
    if (!allQueue.length) { await bot.sendMessage(userId, "📭 Queue is empty."); return sendAdminPanel(userId); }
    const buttons = allQueue.map(q => ([{ text: `${q.username || `User ${q.user_id}`} (${q.group_type})`, callback_data: `fa_user_${q.user_id}_${q.group_type}` }]));
    buttons.push(cancelButton);
    return bot.sendMessage(userId, "⚡ Select a user from the queue:", { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("fa_user_")) {
    const parts = data.split("_");
    const targetUserId = parseInt(parts[2]);
    const userGroupType = parts[3];
    const targetUser = await db().get(`SELECT * FROM users WHERE user_id = ?`, [targetUserId]);
    const queueUser = await db().get(`SELECT * FROM queue WHERE user_id = ?`, [targetUserId]);
    const targetUsername = targetUser
      ? (targetUser.username ? `@${targetUser.username}` : targetUser.first_name)
      : (queueUser ? queueUser.username : `User ${targetUserId}`);
    adminState[userId] = { action: "force_assign_select_laptop", targetUserId, targetUsername, userGroupType };
    const laptops = await db().all(`SELECT * FROM laptops WHERE status = 'available' OR status = 'stasis'`);
    if (!laptops.length) { await bot.sendMessage(userId, "📭 No laptops available to assign."); delete adminState[userId]; return sendAdminPanel(userId); }
    const buttons = laptops.map(l => ([{ text: `${l.name} (${l.status} - ${l.group_type})`, callback_data: `fa_laptop_${l.id}` }]));
    buttons.push(cancelButton);
    return bot.sendMessage(userId, `🖥 Select a laptop to assign to ${targetUsername}:`, { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("fa_laptop_")) {
    const laptopId = parseInt(data.split("_")[2]);
    if (!adminState[userId] || adminState[userId].action !== "force_assign_select_laptop") return bot.sendMessage(userId, "⚠️ Session expired. Try again.");
    const { targetUserId, targetUsername, userGroupType } = adminState[userId];
    delete adminState[userId];
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    const existingLaptop = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [targetUserId]);
    if (existingLaptop) {
      const oldGroupId = existingLaptop.group_type === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
      await db().run(`UPDATE laptops SET status = 'available', assigned_to = NULL, assigned_username = NULL, assigned_at = NULL WHERE id = ?`, [existingLaptop.id]);
      await bot.sendMessage(oldGroupId, `⚠️ ${targetUsername} has been removed from ${existingLaptop.name}. Please submit your work.`);
      if (existingLaptop.group_type !== "expert") await bot.sendMessage(GROUP_CHAT_ID_2, `⚠️ ${targetUsername} has been removed from ${existingLaptop.name}. Please submit your work.`);
      const queueCount = await db().get(`SELECT COUNT(*) as count FROM queue WHERE group_type = ?`, [existingLaptop.group_type]);
      if (queueCount.count > 0) await askNextInQueue(existingLaptop.id, existingLaptop.group_type);
    }
    await db().run(`DELETE FROM queue WHERE user_id = ?`, [targetUserId]);
    if (pendingChecks[targetUserId]) {
      clearTimeout(pendingChecks[targetUserId].timeout);
      delete pendingChecks[targetUserId];
      delete missedChecks[targetUserId];
    }
    const targetGroupId = userGroupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
    await assignLaptopToUser(laptop, targetUserId, targetUsername, targetGroupId);
    await bot.sendMessage(userId, `✅ ${targetUsername} force assigned to ${laptop.name}.`);
    return sendAdminPanel(userId);
  }

  // ── DELETE LAPTOP ──
  if (data === "delete_laptop") {
    return bot.sendMessage(userId, "🗑 Delete — filter by status:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📦 Stasis", callback_data: "deletelist_stasis" }],
          [{ text: "✅ Available", callback_data: "deletelist_available" }],
          [{ text: "💻 Assigned", callback_data: "deletelist_assigned" }],
          [{ text: "🔌 Offline", callback_data: "deletelist_offline" }],
          [{ text: "🗂 All", callback_data: "deletelist_all" }],
          [{ text: "🔍 Search by Name", callback_data: "deletelist_search" }],
          cancelButton
        ]
      }
    });
  }

  if (data === "deletelist_search") {
    adminState[userId] = { action: "awaiting_delete_search" };
    return bot.sendMessage(userId, "🔍 Type the laptop name to search:", { reply_markup: { inline_keyboard: [cancelButton] } });
  }

  if (data.startsWith("deletelist_")) {
    const statusFilter = data.split("_")[1];
    const laptops = statusFilter === "all"
      ? await db().all(`SELECT * FROM laptops`)
      : await db().all(`SELECT * FROM laptops WHERE status = ?`, [statusFilter]);
    if (!laptops.length) { await bot.sendMessage(userId, `📭 No laptops${statusFilter !== "all" ? ` with status: ${statusFilter}` : ""}.`); return sendAdminPanel(userId); }
    const buttons = laptops.map(l => ([{ text: `🗑 ${l.name} (${l.status} - ${l.group_type})`, callback_data: `confirmdelete_${l.id}` }]));
    buttons.push(cancelButton);
    return bot.sendMessage(userId, `Select a laptop to delete:`, { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("confirmdelete_")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (!laptop) { await bot.sendMessage(userId, "⚠️ Laptop not found."); return sendAdminPanel(userId); }
    return bot.sendMessage(userId, `⚠️ Are you sure you want to delete ${laptop.name}?`, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Yes, Delete", callback_data: `dodelete_${laptopId}` }, { text: "❌ No, Cancel", callback_data: "cancel" }]] }
    });
  }

  if (data.startsWith("dodelete_")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (laptop.assigned_to) {
      const targetGroupId = laptop.group_type === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
      await bot.sendMessage(targetGroupId, `⚠️ ${laptop.assigned_username || `User ${laptop.assigned_to}`} has been removed from ${laptop.name}. The laptop has been deleted.`);
      if (laptop.group_type !== "expert") await bot.sendMessage(GROUP_CHAT_ID_2, `⚠️ ${laptop.assigned_username || `User ${laptop.assigned_to}`} has been removed from ${laptop.name}. The laptop has been deleted.`);
    }
    await db().run(`DELETE FROM laptops WHERE id = ?`, [laptopId]);
    await bot.sendMessage(userId, `✅ ${laptop.name} has been deleted.`);
    return sendAdminPanel(userId);
  }

  // ── STATUS ──
  if (data === "status") {
    const normalAssigned  = await db().all(`SELECT * FROM laptops WHERE status = 'assigned' AND group_type = 'normal'`);
    const expertAssigned  = await db().all(`SELECT * FROM laptops WHERE status = 'assigned' AND group_type = 'expert'`);
    const normalAvailable = await db().all(`SELECT * FROM laptops WHERE status = 'available' AND group_type = 'normal'`);
    const expertAvailable = await db().all(`SELECT * FROM laptops WHERE status = 'available' AND group_type = 'expert'`);
    const stasis          = await db().all(`SELECT * FROM laptops WHERE status = 'stasis'`);
    const offline         = await db().all(`SELECT * FROM laptops WHERE status = 'offline'`);
    let statusMsg = "📊 LAPTOP STATUS\n\n";
    statusMsg += "💻 Normal — Assigned:\n";
    statusMsg += normalAssigned.length ? normalAssigned.map((l, i) => `${i + 1}. ${l.name} → ${l.assigned_username || `User ${l.assigned_to}`} (${formatLogTime(l.assigned_at)})`).join("\n") + "\n" : "None\n";
    statusMsg += "\n💻 Expert — Assigned:\n";
    statusMsg += expertAssigned.length ? expertAssigned.map((l, i) => `${i + 1}. ${l.name} → ${l.assigned_username || `User ${l.assigned_to}`} (${formatLogTime(l.assigned_at)})`).join("\n") + "\n" : "None\n";
    statusMsg += "\n✅ Normal — Available:\n";
    statusMsg += normalAvailable.length ? normalAvailable.map((l, i) => `${i + 1}. ${l.name}`).join("\n") + "\n" : "None\n";
    statusMsg += "\n✅ Expert — Available:\n";
    statusMsg += expertAvailable.length ? expertAvailable.map((l, i) => `${i + 1}. ${l.name}`).join("\n") + "\n" : "None\n";
    statusMsg += "\n📦 In Stasis:\n";
    statusMsg += stasis.length ? stasis.map((l, i) => `${i + 1}. ${l.name}`).join("\n") + "\n" : "None\n";
    statusMsg += "\n🔌 Offline:\n";
    statusMsg += offline.length ? offline.map((l, i) => `${i + 1}. ${l.name}`).join("\n") + "\n" : "None\n";
    await bot.sendMessage(userId, statusMsg);
    return sendAdminPanel(userId);
  }

  // ── LAPTOP LOGS ──
  if (data === "logs_menu") {
    adminState[userId] = { action: "awaiting_logs_search" };
    return bot.sendMessage(userId, "📋 Type a laptop name to search logs:", {
      reply_markup: { inline_keyboard: [cancelButton] }
    });
  }

  if (data.startsWith("showlogs_")) {
    const laptopId = parseInt(data.replace("showlogs_", ""));
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (!laptop) { await bot.sendMessage(userId, "⚠️ Laptop not found."); return sendAdminPanel(userId); }
    return bot.sendMessage(userId, `📋 *${escapeMarkdown(laptop.name)}* — Select a time range:`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Last 3 Days", callback_data: `logs_range_${laptopId}_3` }],
          [{ text: "Last 7 Days", callback_data: `logs_range_${laptopId}_7` }],
          [{ text: "Last 30 Days", callback_data: `logs_range_${laptopId}_30` }],
          [{ text: "All Time", callback_data: `logs_range_${laptopId}_0` }],
          [{ text: "🚫 Cancel", callback_data: "cancel" }]
        ]
      }
    });
  }

  if (data.startsWith("logs_range_")) {
    const parts = data.replace("logs_range_", "").split("_");
    const laptopId = parseInt(parts[0]);
    const days = parseInt(parts[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (!laptop) { await bot.sendMessage(userId, "⚠️ Laptop not found."); return sendAdminPanel(userId); }

    let logs;
    let rangeLabel;
    if (days === 0) {
      logs = await db().all(
        `SELECT * FROM laptop_logs WHERE laptop_id = ? ORDER BY action_time ASC`,
        [laptopId]
      );
      rangeLabel = "All Time";
    } else {
      const since = new Date();
      since.setDate(since.getDate() - days);
      logs = await db().all(
        `SELECT * FROM laptop_logs WHERE laptop_id = ? AND action_time >= ? ORDER BY action_time ASC`,
        [laptopId, since.toISOString()]
      );
      rangeLabel = `Last ${days} Days`;
    }

    if (!logs.length) {
      await bot.sendMessage(userId, `📋 No logs for *${escapeMarkdown(laptop.name)}* (${rangeLabel}).`, { parse_mode: "Markdown" });
      return sendAdminPanel(userId);
    }

    let msg = `📋 *${escapeMarkdown(laptop.name)}* — ${rangeLabel}\n\n`;
    for (const log of logs) {
      const icon = log.action === "assigned" ? "🟢" : "🔴";
      const action = log.action === "assigned" ? "Assigned to" : "Returned by";
      const user = log.username || `User ${log.user_id}`;
      msg += `${icon} ${action}: ${escapeMarkdown(user)}\n`;
      msg += `   🕐 ${formatLogTime(log.action_time)}\n\n`;
    }

    if (msg.length > 4096) {
      const chunks = [];
      let remaining = msg;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 4096));
        remaining = remaining.slice(4096);
      }
      for (const chunk of chunks) await bot.sendMessage(userId, chunk, { parse_mode: "Markdown" });
    } else {
      await bot.sendMessage(userId, msg, { parse_mode: "Markdown" });
    }
    return sendAdminPanel(userId);
  }

  // ── CLEAR QUEUE ──
  if (data === "clear_queue") {
    return bot.sendMessage(userId, "⚠️ Are you sure you want to clear the entire queue? This cannot be undone.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Yes, Clear Queue", callback_data: "clear_queue_confirm" }, { text: "❌ Cancel", callback_data: "cancel" }]
        ]
      }
    });
  }

  if (data === "clear_queue_confirm") {
    await db().run(`DELETE FROM queue`);
    // Cancel all pending checks
    for (const uid of Object.keys(pendingChecks)) {
      clearTimeout(pendingChecks[uid].timeout);
      delete pendingChecks[uid];
      delete missedChecks[uid];
    }
    await bot.sendMessage(userId, "✅ Queue has been cleared.");
    return sendAdminPanel(userId);
  }

  // ── 24H WORKERS ──
  if (data === "logs_24h") {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const workers = await db().all(
      `SELECT l.name as laptop_name, l.assigned_username, l.assigned_to, l.assigned_at
       FROM laptops l
       WHERE l.status = 'assigned' AND l.assigned_at IS NOT NULL`,
    );
    const longWorkers = workers.filter(w => {
      if (!w.assigned_at) return false;
      const assignedDate = new Date(w.assigned_at);
      return !isNaN(assignedDate) && assignedDate < new Date(cutoff);
    });
    if (!longWorkers.length) {
      await bot.sendMessage(userId, "✅ No workers have been on a laptop for more than 24 hours.");
      return sendAdminPanel(userId);
    }
    let msg = "🕐 *WORKERS ON FOR 24h+*\n\n";
    for (const w of longWorkers) {
      const assignedDate = new Date(w.assigned_at);
      const hoursOn = Math.floor((Date.now() - assignedDate.getTime()) / (1000 * 60 * 60));
      msg += `👤 ${escapeMarkdown(w.assigned_username || `User ${w.assigned_to}`)}\n`;
      msg += `💻 ${escapeMarkdown(w.laptop_name)}\n`;
      msg += `🕐 Requested: ${formatLogTime(assignedDate.toISOString())}\n`;
      msg += `⏱ On for: ~${hoursOn}h\n\n`;
    }
    await bot.sendMessage(userId, msg, { parse_mode: "Markdown" });
    return sendAdminPanel(userId);
  }

  // ════════════════════════════════════════════════
  // 🔐 SECURITY MENU
  // ════════════════════════════════════════════════

  if (data === "security_menu") {
    return bot.sendMessage(userId, "🔐 Security Panel:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Link Agent to Laptop", callback_data: "sec_link_agent" }],
          [{ text: "🛡 Activate Advanced Security", callback_data: "sec_activate" }],
          [{ text: "🔓 Deactivate Advanced Security", callback_data: "sec_deactivate" }],
          [{ text: "📡 Live Agent Status", callback_data: "sec_status" }],
          [{ text: "🔑 Password Search", callback_data: "sec_password_search" }],
          cancelButton
        ]
      }
    });
  }

  if (data === "sec_password_search") {
    adminState[userId] = { action: "awaiting_password_search" };
    return bot.sendMessage(userId, "🔍 Type a laptop name to search:", { reply_markup: { inline_keyboard: [cancelButton] } });
  }

  if (data.startsWith("showpw_")) {
    const laptopId = parseInt(data.replace("showpw_", ""));
    const l = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    const online = l.rustdesk_id && relay.isConnected(l.rustdesk_id) ? "🟢" : "🔴";
    const msg = `${online} *${escapeMarkdown(l.name)}*\nID: \`${l.rustdesk_id || "not linked"}\`\nPassword: \`${l.rustdesk_password || "unknown"}\``;
    await bot.sendMessage(userId, msg, { parse_mode: "Markdown" });
    return sendAdminPanel(userId);
  }

  if (data === "sec_status") {
    const connectedAgents = relay.getConnectedAgents();
    const allSecureLaptops = await db().all(`SELECT * FROM laptops WHERE advanced_security = 1`);
    let msg = "📡 LIVE AGENT STATUS\n\n";
    if (!connectedAgents.length && !allSecureLaptops.length) msg += "No agents connected and no laptops with advanced security.";
    if (connectedAgents.length) {
      msg += "🟢 Connected Agents:\n";
      for (const agent of connectedAgents) {
        const laptop = await db().get(`SELECT * FROM laptops WHERE rustdesk_id = ?`, [agent.rustdesk_id]);
        const laptopLabel = laptop ? escapeMarkdown(laptop.name) : "⚠️ Not linked to a laptop";
        msg += `• ID: \`${agent.rustdesk_id}\`\n  Laptop: ${laptopLabel}\n  Password: \`${agent.password}\`\n\n`;
      }
    }
    const offlineSecure = allSecureLaptops.filter(l => !relay.isConnected(l.rustdesk_id));
    if (offlineSecure.length) {
      msg += "🔴 Offline (Advanced Security laptops not connected):\n";
      for (const l of offlineSecure) msg += `• ${escapeMarkdown(l.name)} (ID: \`${l.rustdesk_id || "unknown"}\`)\n`;
    }
    await bot.sendMessage(userId, msg, { parse_mode: "Markdown" });
    return bot.sendMessage(userId, "🔐 Security Panel:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Link Agent to Laptop", callback_data: "sec_link_agent" }],
          [{ text: "🛡 Activate Advanced Security", callback_data: "sec_activate" }],
          [{ text: "🔓 Deactivate Advanced Security", callback_data: "sec_deactivate" }],
          [{ text: "📡 Live Agent Status", callback_data: "sec_status" }],
          cancelButton
        ]
      }
    });
  }
if (data === "sec_link_agent") {
    const connectedAgents = relay.getConnectedAgents();
    if (!connectedAgents.length) {
      await bot.sendMessage(userId, "⚠️ No agents currently connected. Make sure the agent program is running on the laptop.");
      return sendAdminPanel(userId);
    }
    return bot.sendMessage(userId, "🔗 Link Agent to Laptop:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔓 Unlinked Agents", callback_data: "sec_show_unlinked" }],
          [{ text: "🔗 Linked Agents", callback_data: "sec_show_linked" }],
          cancelButton
        ]
      }
    });
  }

  if (data === "sec_show_unlinked") {
    const connectedAgents = relay.getConnectedAgents();
    const buttons = [];
    for (const agent of connectedAgents) {
      const existingLink = await db().get(`SELECT name FROM laptops WHERE rustdesk_id = ?`, [agent.rustdesk_id]);
      if (!existingLink) {
        buttons.push([{ text: `🔓 ${agent.rustdesk_id}`, callback_data: `sec_pick_agent_${agent.rustdesk_id}` }]);
      }
    }
    if (!buttons.length) { await bot.sendMessage(userId, "✅ All agents are already linked."); return sendAdminPanel(userId); }
    buttons.push(cancelButton);
    return bot.sendMessage(userId, "Select an unlinked agent:", { reply_markup: { inline_keyboard: buttons } });
  }

  if (data === "sec_show_linked") {
    const connectedAgents = relay.getConnectedAgents();
    const buttons = [];
    for (const agent of connectedAgents) {
      const existingLink = await db().get(`SELECT name FROM laptops WHERE rustdesk_id = ?`, [agent.rustdesk_id]);
      if (existingLink) {
        buttons.push([{ text: `🔗 ${agent.rustdesk_id} → ${existingLink.name}`, callback_data: `sec_pick_agent_${agent.rustdesk_id}` }]);
      }
    }
    if (!buttons.length) { await bot.sendMessage(userId, "⚠️ No linked agents found."); return sendAdminPanel(userId); }
    buttons.push(cancelButton);
    return bot.sendMessage(userId, "Select a linked agent to relink:", { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("sec_pick_agent_")) {
    const rustdesk_id = data.replace("sec_pick_agent_", "");
    adminState[userId] = { action: "awaiting_security_name", rustdesk_id };
    return bot.sendMessage(userId,
      `🔗 Linking agent \`${rustdesk_id}\`\n\nType part of the laptop name to search:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [cancelButton] } }
    );
  }

  if (data.startsWith("sec_pick_laptop_")) {
    const parts = data.replace("sec_pick_laptop_", "").split("_");
    const laptopId = parseInt(parts[0]);
    const rustdesk_id = parts.slice(1).join("_");
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    await db().run(`UPDATE laptops SET rustdesk_id = ?, agent_connected = 1 WHERE id = ?`, [rustdesk_id, laptop.id]);
    await db().run(`UPDATE agents SET laptop_id = ? WHERE rustdesk_id = ?`, [laptop.id, rustdesk_id]);
    await bot.sendMessage(userId,
      `✅ Agent \`${rustdesk_id}\` linked to *${escapeMarkdown(laptop.name)}*.\n\nNow activate advanced security from the Security menu.`,
      { parse_mode: "Markdown" }
    );
    return sendAdminPanel(userId);
  }

  if (data === "sec_activate") {
    const laptops = await db().all(`SELECT * FROM laptops WHERE rustdesk_id IS NOT NULL AND advanced_security = 0`);
    if (!laptops.length) { await bot.sendMessage(userId, "⚠️ No laptops with a linked agent available to activate. Link an agent first."); return sendAdminPanel(userId); }
    const buttons = laptops.map(l => {
      const online = relay.isConnected(l.rustdesk_id) ? "🟢" : "🔴";
      return [{ text: `${online} ${l.name} (${l.rustdesk_id})`, callback_data: `sec_do_activate_${l.id}` }];
    });
    buttons.push(cancelButton);
    return bot.sendMessage(userId, "Select a laptop to activate advanced security:", { reply_markup: { inline_keyboard: buttons } });
  }

  if (data.startsWith("sec_do_activate_")) {
    const laptopId = parseInt(data.replace("sec_do_activate_", ""));
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (!laptop || !laptop.rustdesk_id) { await bot.sendMessage(userId, "⚠️ Laptop not found or no agent linked."); return sendAdminPanel(userId); }
    await bot.sendMessage(userId, `🤝 Sending handshake to ${laptop.name}...`);
    if (!relay.isConnected(laptop.rustdesk_id)) {
      await bot.sendMessage(userId, `❌ Agent for ${laptop.name} is not connected. Make sure the program is running on that laptop.`);
      return sendAdminPanel(userId);
    }
    try {
      await relay.handshake(laptop.rustdesk_id);
      await db().run(`UPDATE laptops SET advanced_security = 1 WHERE id = ?`, [laptopId]);
      await bot.sendMessage(userId,
        `✅ Handshake successful!\n\n🔐 Advanced security activated for *${escapeMarkdown(laptop.name)}*.\n\nFrom now on, users assigned this laptop will receive RustDesk credentials via DM.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await bot.sendMessage(userId, `❌ Handshake failed for ${escapeMarkdown(laptop.name)}: ${err.message}\n\nCheck the agent is running correctly.`);
    }
    return sendAdminPanel(userId);
  }

  if (data === "sec_deactivate") {
    adminState[userId] = { action: "awaiting_deactivate_search" };
    return bot.sendMessage(userId, "🔍 Type a laptop name to search:", { reply_markup: { inline_keyboard: [cancelButton] } });
  }

  if (data.startsWith("sec_do_deactivate_")) {
    const laptopId = parseInt(data.replace("sec_do_deactivate_", ""));
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    await db().run(`UPDATE laptops SET advanced_security = 0 WHERE id = ?`, [laptopId]);
    await bot.sendMessage(userId, `✅ Advanced security deactivated for *${escapeMarkdown(laptop.name)}*. It will now operate normally.`, { parse_mode: "Markdown" });
    return sendAdminPanel(userId);
  }

});

// ─── KEEP ALIVE SERVER ───────────────────────────────────────────────────────
const http = require("http");
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running");
}).listen(process.env.PORT || 3000);

bot.on("polling_error", (err) => { console.log("Polling error:", err.message); });
process.on("unhandledRejection", (err) => { console.log("Unhandled rejection:", err.message); });
