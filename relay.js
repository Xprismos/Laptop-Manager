// relay.js
// WebSocket relay server — runs on DO (or locally for testing)
// Agents connect here. Bot sends commands through here.
//
// To run locally:  node relay.js
// To run on DO:    same, just make sure port 8080 is open in your firewall

const WebSocket = require("ws");
const http = require("http");

const RELAY_PORT = process.env.RELAY_PORT || 8081;
const RELAY_SECRET = process.env.RELAY_SECRET || "changeme_secret"; // Must match agent

// In-memory registry: rustdesk_id -> { ws, rustdesk_id, password, laptop_id }
const agents = {};

// Pending command callbacks: commandId -> { resolve, reject, timeout }
const pendingCommands = {};

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Relay running");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("📡 New connection");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log("❌ Invalid JSON from agent");
      return;
    }

    // ---- AGENT INTRODUCTION ----
    if (msg.type === "INTRODUCE") {
      if (msg.secret !== RELAY_SECRET) {
        console.log("❌ Agent failed secret check, disconnecting");
        ws.close();
        return;
      }

      const { rustdesk_id, password } = msg;
      ws.rustdesk_id = rustdesk_id;

      agents[rustdesk_id] = { ws, rustdesk_id, password };
      console.log(`✅ Agent introduced: ${rustdesk_id}`);

      // Notify bot callback if registered
      if (relay.onAgentConnect) relay.onAgentConnect(rustdesk_id, password);

      ws.send(JSON.stringify({ type: "INTRODUCE_ACK", status: "ok" }));
      return;
    }

    // ---- COMMAND RESPONSE ----
    if (msg.type === "COMMAND_RESPONSE") {
      const { commandId, success, error } = msg;
      if (pendingCommands[commandId]) {
        if (success) {
          pendingCommands[commandId].resolve(msg);
        } else {
          pendingCommands[commandId].reject(new Error(error || "Command failed"));
        }
        clearTimeout(pendingCommands[commandId].timeout);
        delete pendingCommands[commandId];
      }
      return;
    }

    // ---- HEARTBEAT ----
    if (msg.type === "PING") {
      ws.send(JSON.stringify({ type: "PONG" }));
      return;
    }
  });

  ws.on("close", () => {
    if (ws.rustdesk_id) {
      console.log(`🔌 Agent disconnected: ${ws.rustdesk_id}`);
      delete agents[ws.rustdesk_id];
      if (relay.onAgentDisconnect) relay.onAgentDisconnect(ws.rustdesk_id);
    }
  });

  ws.on("error", (err) => {
    console.log("WebSocket error:", err.message);
  });
});

// ---- PUBLIC API (used by botty.js) ----
const relay = {

  // Check if an agent is connected
  isConnected(rustdesk_id) {
    return !!agents[rustdesk_id];
  },

  // Get all connected agents
  getConnectedAgents() {
    return Object.values(agents).map(a => ({
      rustdesk_id: a.rustdesk_id,
      password: a.password
    }));
  },

  // Send a command to a specific agent, wait for response
  sendCommand(rustdesk_id, command, payload = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const agent = agents[rustdesk_id];
      if (!agent) {
        return reject(new Error("Agent not connected"));
      }

      const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const timeout = setTimeout(() => {
        delete pendingCommands[commandId];
        reject(new Error("Command timed out"));
      }, timeoutMs);

      pendingCommands[commandId] = { resolve, reject, timeout };

      agent.ws.send(JSON.stringify({
        type: command,
        commandId,
        ...payload
      }));
    });
  },

  // Handshake — just a ping/pong to confirm agent is alive
  async handshake(rustdesk_id) {
    return relay.sendCommand(rustdesk_id, "HANDSHAKE", {}, 8000);
  },

  // Tell agent to change RustDesk password
  async setPassword(rustdesk_id, password) {
    const result = await relay.sendCommand(rustdesk_id, "SET_PASSWORD", { password }, 15000);
    if (result.success) {
      // Update local registry
      if (agents[rustdesk_id]) agents[rustdesk_id].password = password;
    }
    return result;
  },

  // Callbacks registered by the bot
  onAgentConnect: null,
  onAgentDisconnect: null,
};

server.listen(RELAY_PORT, () => {
  console.log(`🔌 Relay server running on port ${RELAY_PORT}`);
});

module.exports = relay;
