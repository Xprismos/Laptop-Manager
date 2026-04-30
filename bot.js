const TelegramBot = require("node-telegram-bot-api");
const { initDB, db } = require("./database");
require("dotenv").config();

const TOKEN = process.env.TOKEN;

const bot = new TelegramBot(TOKEN, { polling: true });


const GROUP_CHAT_ID = parseInt(process.env.GROUP_CHAT_ID);
const EXPERT_GROUP_CHAT_ID = parseInt(process.env.EXPERT_GROUP_CHAT_ID);
const ADMIN_IDS = [2117559048, 6466671056, 1911312334, 1532807099, 1248799247, 1302705638, 1325958049, 5448140589, 1217462895, 912497121, 8526365759];

const pendingChecks = {};
const adminState = {};

(async () => {
  await initDB();
  console.log("🤖 Bot running");
})();

// ---------------- KEYBOARDS ----------------
const normalKeyboard = {
  reply_markup: {
    keyboard: [
      ["Request Laptop"],
      ["My Laptop"],
      ["Return Laptop"],
      ["View Queue"],
      ["Admin Controls"]
    ],
    resize_keyboard: true,
    persistent: true
  }
};

const expertKeyboard = {
  reply_markup: {
    keyboard: [
      ["Choose a Laptop"],
      ["My Laptop"],
      ["Return Laptop"]
    ],
    resize_keyboard: true,
    persistent: true
  }
};

// ---------------- HELPERS ----------------
function getGroupType(chatId) {
  if (chatId === EXPERT_GROUP_CHAT_ID) return "expert";
  if (chatId === GROUP_CHAT_ID) return "normal";
  return null;
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
          [{ text: "📊 Status", callback_data: "status" }]
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

// ---------------- ASK NEXT IN QUEUE ----------------
async function askNextInQueue(laptopId, groupType) {
  const nextUser = await db().get(
    `SELECT * FROM queue WHERE group_type = ? ORDER BY id ASC LIMIT 1`,
    [groupType]
  );

  if (!nextUser) {
    console.log("Queue is empty for", groupType);
    return;
  }

  const laptop = await db().get(
    `SELECT * FROM laptops WHERE id = ?`, [laptopId]
  );

  if (!laptop) return;

  // If user already has a pending check, skip and ask next
  if (pendingChecks[nextUser.user_id]) {
    console.log(`User ${nextUser.user_id} already has pending check, skipping`);
    const tempQueue = await db().get(
      `SELECT * FROM queue WHERE group_type = ? AND id != ? ORDER BY id ASC LIMIT 1`,
      [groupType, nextUser.id]
    );
    if (tempQueue) {
      await askNextInQueue(laptopId, groupType);
    }
    return;
  }

  const mention = nextUser.username ? `@${nextUser.username.replace("@", "")}` : `User ${nextUser.user_id}`;
  const targetGroupId = groupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;

  await bot.sendMessage(targetGroupId,
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

    await db().run(`DELETE FROM queue WHERE id = ?`, [nextUser.id]);
    await db().run(
      `INSERT INTO queue (user_id, username, group_type) VALUES (?, ?, ?)`,
      [nextUser.user_id, nextUser.username, groupType]
    );

    await bot.sendMessage(targetGroupId,
      `⏰ ${mention} didn't respond in time and has been moved to the bottom of the queue.`
    );

    await askNextInQueue(laptopId, groupType);
  }, 1 * 60 * 1000);

  pendingChecks[nextUser.user_id] = { laptopId, timeout, groupType };
}

// ---------------- START ----------------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const groupType = getGroupType(chatId);

  if (msg.chat.type === "private") {
    return bot.sendMessage(chatId, "👋 Welcome! Please use the group chat to interact with the bot.");
  }

  if (groupType === "expert") {
    return bot.sendMessage(chatId, "Welcome to Laptop Manager", expertKeyboard);
  }

  return bot.sendMessage(chatId, "Welcome to Laptop Manager", normalKeyboard);
});

// ---------------- MESSAGE HANDLER ----------------
bot.on("message", async (msg) => {
    console.log("Received message:", msg.text);
  const text = (msg.text || "").trim();
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const lower = text.toLowerCase();
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const isAdmin = ADMIN_IDS.includes(userId);
  const groupType = getGroupType(chatId);

  // Block private messages from normal users
  if (msg.chat.type === "private" && !isAdmin) {
    return bot.sendMessage(chatId, "⚠️ Please use the group chat to interact with the bot.");
  }

  // ---------------- ADMIN CONTROLS ----------------
  if (lower === "admin controls") {
    if (!isAdmin) {
      return bot.sendMessage(chatId, "⛔ You don't have access to admin controls.");
    }
    try {
      await bot.sendMessage(chatId, "🛠 Admin panel sent to your DM.");
      await sendAdminPanel(userId);
    } catch (e) {
      await notifyNeedsStart(chatId, username);
    }
    return;
  }

  // ---------------- ADMIN TEXT INPUT ----------------
  if (adminState[userId] && adminState[userId].action === "awaiting_laptop_name") {
    if (!isAdmin) return;

const reserved = ["request laptop", "my laptop", "return laptop", "view queue", "admin controls", "choose a laptop"];
if (reserved.includes(lower)) return;

    const laptopName = text;
    delete adminState[userId];
    await db().run(`INSERT INTO laptops (name, status, group_type) VALUES (?, 'stasis', 'stasis')`, [laptopName]);
    await bot.sendMessage(userId, `✅ ${laptopName} added to stasis.`);
    await sendAdminPanel(userId);
    return;
  }

  // ---------------- /admin ----------------
  if (text === "/admin" && isAdmin) {
    try {
      await sendAdminPanel(userId);
    } catch (e) {
      await notifyNeedsStart(chatId, username);
    }
    return;
  }

  // Only process group messages from here
  if (msg.chat.type === "private") return;

  // ---------------- EXPERT GROUP ----------------
  if (groupType === "expert") {

    // CHOOSE A LAPTOP
    if (lower === "choose a laptop") {
      try {
        const existing = await db().get(
          `SELECT * FROM laptops WHERE assigned_to = ?`, [userId]
        );
        if (existing) {
          return bot.sendMessage(chatId, `⚠️ You already have: ${existing.name}`);
        }

        const expertLaptops = await db().all(
          `SELECT * FROM laptops WHERE status = 'available' AND group_type = 'expert'`
        );

        if (!expertLaptops.length) {

          return bot.sendMessage(chatId, "⏳ No expert laptops available. Please try again later.");
        }

        const buttons = expertLaptops.map(l => ([{
          text: l.name,
          callback_data: `expert_pick_${l.id}`
        }]));

        return bot.sendMessage(chatId, "🖥 Select a laptop:", {
          reply_markup: { inline_keyboard: buttons }
        });
      } catch (err) {
        console.log("EXPERT CHOOSE ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred.");
      }
    }

    // MY LAPTOP (expert)
    if (lower === "my laptop") {
      const laptop = await db().get(
        `SELECT * FROM laptops WHERE assigned_to = ?`, [userId]
      );
      if (!laptop) return bot.sendMessage(chatId, "❌ You don't have an expert laptop.");
      return bot.sendMessage(chatId, `💻 ${username} is assigned to: ${laptop.name}`);
    }

    // RETURN LAPTOP (expert)
    if (lower === "return laptop") {
      try {
        const laptop = await db().get(
          `SELECT * FROM laptops WHERE assigned_to = ?`, [userId]
        );
        if (!laptop) return bot.sendMessage(chatId, "❌ You don't have an expert laptop.");

        await db().run(
          `UPDATE laptops SET status = 'available', assigned_to = NULL, assigned_username = NULL WHERE id = ?`,
          [laptop.id]
        );

        await bot.sendMessage(chatId, `🔄 ${username} returned: ${laptop.name}`);

        const queueCount = await db().get(
          `SELECT COUNT(*) as count FROM queue WHERE group_type = 'expert'`
        );
        if (queueCount.count > 0) {
          await askNextInQueue(laptop.id, "expert");
        }
      } catch (err) {
        console.log("EXPERT RETURN ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred during return.");
      }
    }

    return;
  }

  // ---------------- NORMAL GROUP ----------------
  if (groupType === "normal") {

    // REQUEST LAPTOP
    if (lower.includes("request")) {
      try {
        const existing = await db().get(
          `SELECT * FROM laptops WHERE assigned_to = ?`, [userId]
        );
        if (existing) return bot.sendMessage(chatId, `⚠️ You already have: ${existing.name}`);

        const inQueue = await db().get(
          `SELECT * FROM queue WHERE user_id = ? AND group_type = 'normal'`, [userId]
        );
        if (inQueue) return bot.sendMessage(chatId, "⏳ You are already in queue.");

        const laptop = await db().get(
          `SELECT * FROM laptops WHERE status = 'available' AND group_type = 'normal' ORDER BY RANDOM() LIMIT 1`
        );

        if (!laptop) {
          await db().run(
            `INSERT INTO queue (user_id, username, group_type) VALUES (?, ?, 'normal')`,
            [userId, username]
          );
          return bot.sendMessage(chatId, "⏳ No laptops available. You've been added to queue.");
        }

        await db().run(
          `UPDATE laptops SET status = 'assigned', assigned_to = ?, assigned_username = ? WHERE id = ?`,
          [userId, username, laptop.id]
        );

        return bot.sendMessage(chatId, `✅ ${username} has been assigned: ${laptop.name}`);
      } catch (err) {
        console.log("REQUEST ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred during request.");
      }
    }

    // RETURN LAPTOP
    if (lower.includes("return")) {
      try {
        const laptop = await db().get(
          `SELECT * FROM laptops WHERE assigned_to = ?`, [userId]
        );
        if (!laptop) return bot.sendMessage(chatId, "❌ You don't have a laptop.");

        await db().run(
          `UPDATE laptops SET status = 'available', assigned_to = NULL, assigned_username = NULL WHERE id = ?`,
          [laptop.id]
        );

        await bot.sendMessage(chatId, `🔄 ${username} returned: ${laptop.name}`);

        const queueCount = await db().get(
          `SELECT COUNT(*) as count FROM queue WHERE group_type = 'normal'`
        );
        if (queueCount.count > 0) {
          await askNextInQueue(laptop.id, "normal");
        }
      } catch (err) {
        console.log("RETURN ERROR:", err);
        return bot.sendMessage(chatId, "❌ Error occurred during return.");
      }
    }

    // MY LAPTOP
    if (lower.includes("my laptop")) {
      const laptop = await db().get(
        `SELECT * FROM laptops WHERE assigned_to = ?`, [userId]
      );
      if (!laptop) return bot.sendMessage(chatId, "❌ You don't have a laptop.");
      return bot.sendMessage(chatId, `💻 ${username} is assigned to: ${laptop.name}`);
    }

    // VIEW QUEUE
    if (lower.includes("view queue") || lower === "queue") {
      const queue = await db().all(
        `SELECT * FROM queue WHERE group_type = 'normal' ORDER BY id ASC`
      );
      if (!queue.length) return bot.sendMessage(chatId, "📊 Queue is empty.");

      const list = queue.map((q, i) => `${i + 1}. ${q.username || `User ${q.user_id}`}`).join("\n");
      return bot.sendMessage(chatId, `📊 QUEUE\n\n${list}`);
    }
  }
});

// ---------------- CALLBACK HANDLER ----------------
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const username = callbackQuery.from.username
    ? `@${callbackQuery.from.username}`
    : callbackQuery.from.first_name;
  const isAdmin = ADMIN_IDS.includes(userId);

  try {
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (e) {
    console.log("Callback query expired");
  }

  // ---------------- EXPERT LAPTOP PICK ----------------
if (data.startsWith("expert_pick_")) {
    const laptopId = parseInt(data.split("_")[2]);

    const existing = await db().get(`SELECT * FROM laptops WHERE assigned_to = ?`, [userId]);
    if (existing) {
      return bot.sendMessage(chatId, `⚠️ You already have: ${existing.name}`);
    }

    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);

    if (!laptop || laptop.status !== "available") {
      return bot.sendMessage(chatId, "⚠️ That laptop is no longer available.");
    }

    await db().run(
      `UPDATE laptops SET status = 'assigned', assigned_to = ?, assigned_username = ? WHERE id = ?`,
      [userId, username, laptopId]
    );

    return bot.sendMessage(EXPERT_GROUP_CHAT_ID, `✅ ${username} is working on: ${laptop.name}`);
  }

  // ---------------- AVAILABILITY YES ----------------
  if (data.startsWith("available_yes_")) {
    const parts = data.split("_");
    const laptopId = parseInt(parts[2]);
    const targetUserId = parseInt(parts[3]);

    // Only the tagged user can respond
    if (userId !== targetUserId) {
      return bot.answerCallbackQuery(callbackQuery.id, { text: "This is not for you.", show_alert: true });
    }

    if (!pendingChecks[userId]) {
      return bot.sendMessage(chatId, "⚠️ This request has already expired.");
    }

    const groupType = pendingChecks[userId].groupType;
    clearTimeout(pendingChecks[userId].timeout);
    delete pendingChecks[userId];

    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    if (!laptop || laptop.status !== "available") {
      return bot.sendMessage(chatId, "⚠️ Laptop is no longer available.");
    }

    await db().run(`DELETE FROM queue WHERE user_id = ? AND group_type = ?`, [userId, groupType]);
    await db().run(
      `UPDATE laptops SET status = 'assigned', assigned_to = ?, assigned_username = ? WHERE id = ?`,
      [userId, username, laptopId]
    );

    const targetGroupId = groupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
    return bot.sendMessage(targetGroupId, `✅ ${username} has been assigned: ${laptop.name}`);
  }

  // ---------------- AVAILABILITY NO ----------------
  if (data.startsWith("available_no_")) {
    const parts = data.split("_");
    const laptopId = parseInt(parts[2]);
    const targetUserId = parseInt(parts[3]);

    if (userId !== targetUserId) {
      return bot.answerCallbackQuery(callbackQuery.id, { text: "This is not for you.", show_alert: true });
    }

    if (!pendingChecks[userId]) {
      return bot.sendMessage(chatId, "⚠️ This request has already expired.");
    }

    const groupType = pendingChecks[userId].groupType;
    clearTimeout(pendingChecks[userId].timeout);
    delete pendingChecks[userId];

    await db().run(`DELETE FROM queue WHERE user_id = ? AND group_type = ?`, [userId, groupType]);

    const targetGroupId = groupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
    await bot.sendMessage(targetGroupId, `${username} has opted out and been removed from the queue.`);
    await askNextInQueue(laptopId, groupType);
    return;
  }

  // Admin only from here
  if (!isAdmin) return;

  // ---------------- CANCEL ----------------
  if (data === "cancel") {
    delete adminState[userId];
    return sendAdminPanel(userId);
  }

  const cancelButton = [{ text: "🚫 Cancel", callback_data: "cancel" }];

  // ---------------- ADD LAPTOP ----------------
  if (data === "add_laptop") {
    adminState[userId] = { action: "awaiting_laptop_name" };
    return bot.sendMessage(userId, "💬 Send me the name of the new laptop:", {
      reply_markup: { inline_keyboard: [cancelButton] }
    });
  }

  // ---------------- STASIS MENU ----------------
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

    if (!stasisLaptops.length) {
      await bot.sendMessage(userId, "📭 No laptops in stasis.");
      return sendAdminPanel(userId);
    }

    const buttons = stasisLaptops.map(l => ([{
      text: l.name,
      callback_data: `deploy_${targetGroup}_${l.id}`
    }]));
    buttons.push(cancelButton);

    return bot.sendMessage(userId, `Select a laptop to deploy to ${targetGroup} group:`, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("deploy_")) {
    const parts = data.split("_");
    const targetGroup = parts[1];
    const laptopId = parseInt(parts[2]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);

    await db().run(
      `UPDATE laptops SET status = 'available', group_type = ? WHERE id = ?`,
      [targetGroup, laptopId]
    );

    await bot.sendMessage(userId, `✅ ${laptop.name} deployed to ${targetGroup} group.`);

    const queueCount = await db().get(
      `SELECT COUNT(*) as count FROM queue WHERE group_type = ?`, [targetGroup]
    );
    if (queueCount.count > 0) {
      await askNextInQueue(laptopId, targetGroup);
    }

    return sendAdminPanel(userId);
  }

  // ---------------- REMOVE LAPTOP ----------------
  if (data === "remove_laptop") {
    const activeLaptops = await db().all(
      `SELECT * FROM laptops WHERE status = 'available' OR status = 'assigned'`
    );

    if (!activeLaptops.length) {
      await bot.sendMessage(userId, "📭 No active laptops.");
      return sendAdminPanel(userId);
    }

    const buttons = activeLaptops.map(l => ([{
      text: `❌ ${l.name} (${l.status} - ${l.group_type})`,
      callback_data: `remove_${l.id}`
    }]));
    buttons.push(cancelButton);

    return bot.sendMessage(userId, "Select a laptop to put in stasis:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("remove_") && !data.startsWith("remove_laptop")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);

    if (laptop.assigned_to) {
      const assignedUsername = laptop.assigned_username || `User ${laptop.assigned_to}`;
      const targetGroupId = laptop.group_type === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
      await bot.sendMessage(targetGroupId,
        `⚠️ ${assignedUsername} has been removed from ${laptop.name}. Please submit your work.`
      );
    }

    await db().run(
      `UPDATE laptops SET status = 'stasis', group_type = 'stasis', assigned_to = NULL, assigned_username = NULL WHERE id = ?`,
      [laptopId]
    );

    await bot.sendMessage(userId, `✅ ${laptop.name} has been put in stasis.`);
    return sendAdminPanel(userId);
  }

  // ---------------- OFFLINE MENU ----------------
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
    const laptops = await db().all(
      `SELECT * FROM laptops WHERE status != 'offline'`
    );

    if (!laptops.length) {
      await bot.sendMessage(userId, "📭 No laptops to put offline.");
      return sendAdminPanel(userId);
    }

    const buttons = laptops.map(l => ([{
      text: `🔌 ${l.name} (${l.status} - ${l.group_type})`,
      callback_data: `offline_${l.id}`
    }]));
    buttons.push(cancelButton);

    return bot.sendMessage(userId, "Select a laptop to put offline:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("offline_")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);

    if (laptop.assigned_to) {
      const assignedUsername = laptop.assigned_username || `User ${laptop.assigned_to}`;
      const targetGroupId = laptop.group_type === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
      await bot.sendMessage(targetGroupId,
        `⚠️ ${assignedUsername} has been removed from ${laptop.name}. The laptop is going offline.`
      );
    }

    await db().run(
      `UPDATE laptops SET status = 'offline', assigned_to = NULL, assigned_username = NULL WHERE id = ?`,
      [laptopId]
    );

    await bot.sendMessage(userId, `✅ ${laptop.name} is now offline.`);
    return sendAdminPanel(userId);
  }

  if (data === "restore_offline") {
    const offlineLaptops = await db().all(`SELECT * FROM laptops WHERE status = 'offline'`);

    if (!offlineLaptops.length) {
      await bot.sendMessage(userId, "📭 No offline laptops.");
      return sendAdminPanel(userId);
    }

    const buttons = offlineLaptops.map(l => ([{
      text: `♻️ ${l.name}`,
      callback_data: `restoreoffline_${l.id}`
    }]));
    buttons.push(cancelButton);

    return bot.sendMessage(userId, "Select a laptop to restore to stasis:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("restoreoffline_")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);

    await db().run(
      `UPDATE laptops SET status = 'stasis', group_type = 'stasis' WHERE id = ?`,
      [laptopId]
    );

    await bot.sendMessage(userId, `✅ ${laptop.name} restored to stasis.`);
    return sendAdminPanel(userId);
  }

  // ---------------- TRANSFER MENU ----------------
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

    const laptops = await db().all(
      `SELECT * FROM laptops WHERE status = 'available' AND group_type = ?`, [fromGroup]
    );

    if (!laptops.length) {
      await bot.sendMessage(userId, `📭 No available laptops in ${fromGroup} group.`);
      return sendAdminPanel(userId);
    }

    adminState[userId] = { action: "transferring", fromGroup, toGroup, selected: [] };

    const buttons = laptops.map(l => ([{
      text: l.name,
      callback_data: `tselect_${l.id}`
    }]));
    buttons.push([{ text: "✅ Confirm Transfer", callback_data: "transfer_confirm" }]);
    buttons.push(cancelButton);

    return bot.sendMessage(userId, `Select laptops to transfer from ${fromGroup} to ${toGroup}:\n\nSelected: none`, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("tselect_")) {
    const laptopId = parseInt(data.split("_")[1]);
    if (!adminState[userId] || adminState[userId].action !== "transferring") return;

    const selected = adminState[userId].selected;
    const idx = selected.indexOf(laptopId);
    if (idx === -1) {
      selected.push(laptopId);
    } else {
      selected.splice(idx, 1);
    }

    const laptops = await db().all(
      `SELECT * FROM laptops WHERE status = 'available' AND group_type = ?`,
      [adminState[userId].fromGroup]
    );

    const selectedNames = await Promise.all(
      selected.map(async id => {
        const l = await db().get(`SELECT name FROM laptops WHERE id = ?`, [id]);
        return l ? l.name : id;
      })
    );

    const buttons = laptops.map(l => ([{
      text: selected.includes(l.id) ? `✅ ${l.name}` : l.name,
      callback_data: `tselect_${l.id}`
    }]));
    buttons.push([{ text: "✅ Confirm Transfer", callback_data: "transfer_confirm" }]);
    buttons.push(cancelButton);

    return bot.editMessageText(
      `Select laptops to transfer:\n\nSelected: ${selectedNames.length ? selectedNames.join(", ") : "none"}`,
      {
        chat_id: userId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: buttons }
      }
    );
  }

  if (data === "transfer_confirm") {
    if (!adminState[userId] || adminState[userId].action !== "transferring") return;

    const { fromGroup, toGroup, selected } = adminState[userId];
    delete adminState[userId];

    if (!selected.length) {
      await bot.sendMessage(userId, "⚠️ No laptops selected.");
      return sendAdminPanel(userId);
    }

    const names = [];
    for (const laptopId of selected) {
      const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
      await db().run(`UPDATE laptops SET group_type = ? WHERE id = ?`, [toGroup, laptopId]);
      names.push(laptop.name);
    }

    const targetGroupId = toGroup === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
    await bot.sendMessage(targetGroupId,
      `🔄 The following laptops have been transferred to this group: ${names.join(", ")}`
    );

    await bot.sendMessage(userId, `✅ Transferred ${names.join(", ")} to ${toGroup} group.`);
    return sendAdminPanel(userId);
  }

  // ---------------- FORCE ASSIGN ----------------
  if (data === "force_assign") {
    const normalQueue = await db().all(`SELECT * FROM queue WHERE group_type = 'normal' ORDER BY id ASC`);
    const expertQueue = await db().all(`SELECT * FROM queue WHERE group_type = 'expert' ORDER BY id ASC`);
    const allQueue = [...normalQueue, ...expertQueue];

    if (!allQueue.length) {
      await bot.sendMessage(userId, "📭 Queue is empty.");
      return sendAdminPanel(userId);
    }

    const buttons = allQueue.map(q => ([{
      text: `${q.username || `User ${q.user_id}`} (${q.group_type})`,
      callback_data: `fa_user_${q.user_id}_${q.group_type}`
    }]));
    buttons.push(cancelButton);

    return bot.sendMessage(userId, "⚡ Select a user from the queue:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("fa_user_")) {
    const parts = data.split("_");
    const targetUserId = parseInt(parts[2]);
    const userGroupType = parts[3];

    adminState[userId] = { action: "force_assign_select_laptop", targetUserId, userGroupType };

    const laptops = await db().all(
      `SELECT * FROM laptops WHERE status = 'available' OR status = 'stasis'`
    );

    if (!laptops.length) {
      await bot.sendMessage(userId, "📭 No laptops available to assign.");
      return sendAdminPanel(userId);
    }

    const buttons = laptops.map(l => ([{
      text: `${l.name} (${l.status} - ${l.group_type})`,
      callback_data: `fa_laptop_${l.id}`
    }]));
    buttons.push(cancelButton);

    return bot.sendMessage(userId, "🖥 Select a laptop to assign:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("fa_laptop_")) {
    const laptopId = parseInt(data.split("_")[2]);

    if (!adminState[userId] || adminState[userId].action !== "force_assign_select_laptop") {
      return bot.sendMessage(userId, "⚠️ Session expired. Try again.");
    }

    const { targetUserId, userGroupType } = adminState[userId];
    delete adminState[userId];

    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);
    const queueUser = await db().get(`SELECT * FROM queue WHERE user_id = ?`, [targetUserId]);
    const targetUsername = queueUser ? queueUser.username : `User ${targetUserId}`;
    const targetGroupId = userGroupType === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;

    await db().run(`DELETE FROM queue WHERE user_id = ?`, [targetUserId]);
    await db().run(
      `UPDATE laptops SET status = 'assigned', assigned_to = ?, assigned_username = ?, group_type = ? WHERE id = ?`,
      [targetUserId, targetUsername, userGroupType, laptopId]
    );

    await bot.sendMessage(targetGroupId, `⚡ ${targetUsername} has been assigned to ${laptop.name}`);
    await bot.sendMessage(userId, `✅ ${targetUsername} force assigned to ${laptop.name}.`);
    return sendAdminPanel(userId);
  }

  // ---------------- DELETE LAPTOP ----------------
  if (data === "delete_laptop") {
    const laptops = await db().all(`SELECT * FROM laptops`);

    if (!laptops.length) {
      await bot.sendMessage(userId, "📭 No laptops found.");
      return sendAdminPanel(userId);
    }

    const buttons = laptops.map(l => ([{
      text: `🗑 ${l.name} (${l.status} - ${l.group_type})`,
      callback_data: `confirmdelete_${l.id}`
    }]));
    buttons.push(cancelButton);

    return bot.sendMessage(userId, "Select a laptop to delete:", {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith("confirmdelete_")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);

    if(!laptop) {
      await bot.sendMessage(userId, "⚠️ Laptop not found.");
      return sendAdminPanel(userId);
    }

    return bot.sendMessage(userId, `⚠️ Are you sure you want to delete ${laptop.name}?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Yes, Delete", callback_data: `dodelete_${laptopId}` },
            { text: "❌ No, Cancel", callback_data: "cancel" }
          ]
        ]
      }
    });
  }

  if (data.startsWith("dodelete_")) {
    const laptopId = parseInt(data.split("_")[1]);
    const laptop = await db().get(`SELECT * FROM laptops WHERE id = ?`, [laptopId]);

    if (laptop.assigned_to) {
      const targetGroupId = laptop.group_type === "expert" ? EXPERT_GROUP_CHAT_ID : GROUP_CHAT_ID;
      await bot.sendMessage(targetGroupId,
        `⚠️ ${laptop.assigned_username || `User ${laptop.assigned_to}`} has been removed from ${laptop.name}. The laptop has been deleted.`
      );
    }

    await db().run(`DELETE FROM laptops WHERE id = ?`, [laptopId]);
    await bot.sendMessage(userId, `✅ ${laptop.name} has been deleted.`);
    return sendAdminPanel(userId);
  }

  // ---------------- STATUS ----------------
  if (data === "status") {
    const normalAssigned = await db().all(`SELECT * FROM laptops WHERE status = 'assigned' AND group_type = 'normal'`);
    const expertAssigned = await db().all(`SELECT * FROM laptops WHERE status = 'assigned' AND group_type = 'expert'`);
    const normalAvailable = await db().all(`SELECT * FROM laptops WHERE status = 'available' AND group_type = 'normal'`);
    const expertAvailable = await db().all(`SELECT * FROM laptops WHERE status = 'available' AND group_type = 'expert'`);
    const normalQueue = await db().all(`SELECT * FROM queue WHERE group_type = 'normal' ORDER BY id ASC`);
    const stasis = await db().all(`SELECT * FROM laptops WHERE status = 'stasis'`);
    const offline = await db().all(`SELECT * FROM laptops WHERE status = 'offline'`);

    let msg = "📊 STATUS\n\n";

    msg += "💻 In Use (Normal):\n";
    msg += normalAssigned.length ? normalAssigned.map(l => `• ${l.name} → ${l.assigned_username || `User ${l.assigned_to}`}`).join("\n") + "\n" : "None\n";

    msg += "\n💻 In Use (Expert):\n";
    msg += expertAssigned.length ? expertAssigned.map(l => `• ${l.name} → ${l.assigned_username || `User ${l.assigned_to}`}`).join("\n") + "\n" : "None\n";

    msg += "\n✅ Available (Normal):\n";
    msg += normalAvailable.length ? normalAvailable.map(l => `• ${l.name}`).join("\n") + "\n" : "None\n";

    msg += "\n✅ Available (Expert):\n";
    msg += expertAvailable.length ? expertAvailable.map(l => `• ${l.name}`).join("\n") + "\n" : "None\n";

    msg += "\n📋 Queue (Normal):\n";
    msg += normalQueue.length ? normalQueue.map((q, i) => `${i + 1}. ${q.username || `User ${q.user_id}`}`).join("\n") + "\n" : "Empty\n";


    msg += "\n📦 In Stasis:\n";
    msg += stasis.length ? stasis.map(l => `• ${l.name}`).join("\n") + "\n" : "None\n";

    msg += "\n🔌 Offline:\n";
    msg += offline.length ? offline.map(l => `• ${l.name}`).join("\n") + "\n" : "None\n";

    await bot.sendMessage(userId, msg);
    return sendAdminPanel(userId);
  }
});

// ---------------- KEEP ALIVE SERVER ----------------
const http = require("http");
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running");
}).listen(process.env.PORT || 3000);
