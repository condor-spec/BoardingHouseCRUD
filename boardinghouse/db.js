const Database = require('better-sqlite3');
const db = new Database('boardinghouse.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_no TEXT NOT NULL,
    capacity INTEGER,
    rate REAL,
    status TEXT DEFAULT 'vacant'
  );
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT,
    room_id INTEGER,
    move_in_date TEXT
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    amount REAL,
    month TEXT,
    date_paid TEXT,
    status TEXT DEFAULT 'paid'
  );
`);

module.exports = db;