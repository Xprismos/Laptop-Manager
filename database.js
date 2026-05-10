const Database = require("better-sqlite3");

let database;

async function initDB() {
  database = new Database("./bot.db");



    database.exec(`
  CREATE TABLE IF NOT EXISTS laptop_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    laptop_id INTEGER,
    laptop_name TEXT,
    user_id INTEGER,
    username TEXT,
    action TEXT,
    action_time TEXT
  )
`);

  database.exec(`
    CREATE TABLE IF NOT EXISTS laptops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      status TEXT DEFAULT 'stasis',
      group_type TEXT DEFAULT 'stasis',
      assigned_to INTEGER,
      assigned_username TEXT
    )
  `);

  try { database.exec(`ALTER TABLE laptops ADD COLUMN assigned_at TEXT`); } catch (e) {}
  try { database.exec(`ALTER TABLE laptops ADD COLUMN rustdesk_id TEXT`); } catch (e) {}
  try { database.exec(`ALTER TABLE laptops ADD COLUMN rustdesk_password TEXT`); } catch (e) {}
  try { database.exec(`ALTER TABLE laptops ADD COLUMN agent_connected INTEGER DEFAULT 0`); } catch (e) {}
  try { database.exec(`ALTER TABLE laptops ADD COLUMN advanced_security INTEGER DEFAULT 0`); } catch (e) {}

  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rustdesk_id TEXT UNIQUE,
      rustdesk_password TEXT,
      last_seen TEXT,
      laptop_id INTEGER
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      group_type TEXT DEFAULT 'normal'
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      group_type TEXT
    )
  `);



  const count = database.prepare(`SELECT COUNT(*) as count FROM laptops`).get();

  if (count.count === 0) {
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('Dell XPS 15', 'available', 'normal');
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('HP EliteBook', 'available', 'normal');
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('MacBook Pro e', 'available', 'expert');
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('Lenovo ThinkPad e', 'available', 'expert');
  }

  console.log("✅ DB initialized");
}

function db() {
  return {
    get: (sql, params = []) => Promise.resolve(database.prepare(sql).get(...params)),
    all: (sql, params = []) => Promise.resolve(database.prepare(sql).all(...params)),
    run: (sql, params = []) => Promise.resolve(database.prepare(sql).run(...params)),
    exec: (sql) => Promise.resolve(database.exec(sql))
  };
}

module.exports = { initDB, db };
