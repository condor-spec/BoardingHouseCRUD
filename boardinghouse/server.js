const express = require('express');
const cors = require('cors');
const db = require('./db');

const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const cols = {
  rooms: ['room_no', 'capacity', 'rate', 'status'],
  tenants: ['name', 'contact', 'room_id', 'move_in_date'],
  payments: ['tenant_id', 'amount', 'month', 'date_paid', 'status'],
};

const listSql = {
  rooms: `SELECT r.*, (SELECT COUNT(*) FROM tenants t WHERE t.room_id = r.id) AS occupants
          FROM rooms r ORDER BY r.room_no`,
  tenants: `SELECT t.*, r.room_no FROM tenants t
            LEFT JOIN rooms r ON r.id = t.room_id ORDER BY t.name`,
  payments: `SELECT p.*, t.name AS tenant_name FROM payments p
             LEFT JOIN tenants t ON t.id = p.tenant_id ORDER BY p.id DESC`,
};

// A room with no capacity set holds 1 person
const capOf = r => (Number(r.capacity) > 0 ? Number(r.capacity) : 1);
const occupantsOf = (roomId, exceptTenantId = null) =>
  db.prepare('SELECT COUNT(*) n FROM tenants WHERE room_id = ? AND id IS NOT ?').get(roomId, exceptTenantId).n;

// Room status: 'full' when occupants reach capacity, otherwise 'available' (has space)
function syncRooms() {
  db.exec(`
    UPDATE rooms SET status = CASE
      WHEN (SELECT COUNT(*) FROM tenants t WHERE t.room_id = rooms.id)
           >= COALESCE(NULLIF(capacity, 0), 1)
      THEN 'full' ELSE 'available' END
  `);
}
syncRooms();

// Block adding / moving a tenant into a full room
function checkTenantRoom(req, res, next) {
  const roomId = req.body.room_id;
  if (roomId === '' || roomId === null || roomId === undefined) return next();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(400).json({ error: 'Selected room does not exist.' });
  const used = occupantsOf(room.id, req.params.id ? Number(req.params.id) : null);
  if (used >= capOf(room)) {
    return res.status(400).json({ error: `Room ${room.room_no} is already full (${used}/${capOf(room)}).` });
  }
  next();
}
app.post('/api/tenants', checkTenantRoom);
app.put('/api/tenants/:id', checkTenantRoom);

// A paid payment with no Date Paid is stamped with today's date
function defaultDatePaid(req, res, next) {
  if (!req.body.date_paid && req.body.status !== 'unpaid') req.body.date_paid = todayStr();
  next();
}
app.post('/api/payments', defaultDatePaid);
app.put('/api/payments/:id', defaultDatePaid);
// Older paid records saved without a date get today's date once
db.prepare("UPDATE payments SET date_paid = ? WHERE status = 'paid' AND (date_paid IS NULL OR date_paid = '')").run(todayStr());

// Don't allow lowering a room's capacity below its current occupants
app.put('/api/rooms/:id', (req, res, next) => {
  const used = occupantsOf(Number(req.params.id));
  const newCap = Number(req.body.capacity) > 0 ? Number(req.body.capacity) : 1;
  if (newCap < used) {
    return res.status(400).json({ error: `This room already has ${used} tenant(s). Capacity can't be lower than that.` });
  }
  next();
});

const clean = (body, t) =>
  cols[t].map(c => (body[c] === '' || body[c] === undefined ? null : body[c]));

Object.keys(cols).forEach(t => {
  const c = cols[t];

  // READ
  app.get(`/api/${t}`, (req, res) => res.json(db.prepare(listSql[t]).all()));

  // CREATE
  app.post(`/api/${t}`, (req, res) => {
    const sql = `INSERT INTO ${t} (${c.join(',')}) VALUES (${c.map(() => '?').join(',')})`;
    const info = db.prepare(sql).run(...clean(req.body, t));
    syncRooms();
    res.json({ id: info.lastInsertRowid });
  });

  // UPDATE
  app.put(`/api/${t}/:id`, (req, res) => {
    const sql = `UPDATE ${t} SET ${c.map(x => x + '=?').join(',')} WHERE id=?`;
    db.prepare(sql).run(...clean(req.body, t), req.params.id);
    syncRooms();
    res.json({ ok: true });
  });

  // DELETE
  app.delete(`/api/${t}/:id`, (req, res) => {
    db.prepare(`DELETE FROM ${t} WHERE id=?`).run(req.params.id);
    syncRooms();
    res.json({ ok: true });
  });
});

// ---- Billing helpers (used by the bill box AND the dashboard) ----
// Billed = months since move-in (counting the current month) x room rate
// Balance = billed - total paid (never below 0)
function billFor(tenantId) {
  const t = db.prepare(`SELECT t.*, r.rate, r.room_no FROM tenants t
    LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?`).get(tenantId);
  if (!t) return { rate: 0, months: 0, billed: 0, paid: 0, balance: 0 };

  const rate = t.rate || 0;
  let months = 1;
  if (t.move_in_date) {
    const s = new Date(t.move_in_date), n = new Date();
    months = Math.max(1, (n.getFullYear() - s.getFullYear()) * 12 + n.getMonth() - s.getMonth() + 1);
  }
  const billed = months * rate;
  const paid = db.prepare(
    "SELECT COALESCE(SUM(amount),0) n FROM payments WHERE tenant_id=? AND status='paid'"
  ).get(t.id).n;

  return { room_no: t.room_no, rate, months, billed, paid, balance: Math.max(0, billed - paid) };
}

// Tenant bill + balance
app.get('/api/tenants/:id/bill', (req, res) => res.json(billFor(req.params.id)));

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const month = todayStr().slice(0, 7); // current month, local time (YYYY-MM)
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  res.json({
    totalRooms: one('SELECT COUNT(*) n FROM rooms').n,
    occupied: one('SELECT COUNT(*) n FROM rooms r WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.room_id = r.id)').n,
    available: one("SELECT COUNT(*) n FROM rooms WHERE status='available'").n,
    full: one("SELECT COUNT(*) n FROM rooms WHERE status='full'").n,
    tenants: one('SELECT COUNT(*) n FROM tenants').n,
    // money actually received this month (by Date Paid)
    collected: one("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='paid' AND substr(date_paid,1,7)=?", month).n,
    // tenants who still owe something (balance > 0)
    unpaid: db.prepare('SELECT id FROM tenants').all().filter(t => billFor(t.id).balance > 0).length,
  });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));