
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

let db;

async function initDB() {
  db = await open({
    filename: "./bot.db",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS laptops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      status TEXT DEFAULT 'stasis',
      group_type TEXT DEFAULT 'stasis',
      assigned_to INTEGER,
      assigned_username TEXT
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      group_type TEXT DEFAULT 'normal'
    )
  `);

  const count = await db.get(`SELECT COUNT(*) as count FROM laptops`);

  if (count.count === 0) {
    await db.run(`INSERT INTO laptops (name, status, group_type) VALUES ('Rejoice', 'available', 'normal')`);
    await db.run(`INSERT INTO laptops (name, status, group_type) VALUES ('Ikpang', 'available', 'normal')`);
    await db.run(`INSERT INTO laptops (name, status, group_type) VALUES ('Patrick (e)', 'available', 'expert')`);
    await db.run(`INSERT INTO laptops (name, status, group_type) VALUES ('Tochukwu (e)', 'available', 'expert')`);
  }

  console.log("✅ DB initialized");
}

module.exports = {
  initDB,
  db: () => db
};