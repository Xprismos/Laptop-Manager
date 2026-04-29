const Database = require("better-sqlite3");

let database;

async function initDB() {
  database = new Database("./bot.db");

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

  database.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      group_type TEXT DEFAULT 'normal'
    )
  `);

  const count = database.prepare(`SELECT COUNT(*) as count FROM laptops`).get();

  if (count.count === 0) {
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('Dell XPS 15', 'available', 'normal');
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('HP EliteBook', 'available', 'normal');
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('MacBook Pro (e)', 'available', 'expert');
    database.prepare(`INSERT INTO laptops (name, status, group_type) VALUES (?, ?, ?)`).run('Lenovo ThinkPad (e)', 'available', 'expert');
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