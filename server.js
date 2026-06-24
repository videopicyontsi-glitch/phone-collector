const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const DB_PATH = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'phones.db') : path.join(__dirname, 'phones.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    display_name TEXT,
    phone TEXT DEFAULT '',
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS names (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    phone_added_at TEXT,
    created_at TEXT
  );
`);
// migration: add support_status column if missing
try { db.exec("ALTER TABLE names ADD COLUMN support_status TEXT DEFAULT ''"); } catch {}

// contacts table
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    resident_code TEXT UNIQUE,
    last_name TEXT,
    first_name TEXT,
    address TEXT DEFAULT '',
    phone1 TEXT DEFAULT '',
    phone2 TEXT DEFAULT '',
    email TEXT DEFAULT '',
    branch_status TEXT DEFAULT '',
    coordinator_id TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
  );
`);
try { db.exec("ALTER TABLE contacts ADD COLUMN coordinator_id TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE contacts ADD COLUMN notes TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE contacts ADD COLUMN support_status TEXT DEFAULT ''"); } catch {}

const adminExists = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
if (!adminExists) {
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(
    'admin', 'admin', 'admin123', 'admin', 'מנהל ראשי', '', new Date().toISOString()
  );
}

// Seed demo data if no regular users exist
const usersExist = db.prepare("SELECT id FROM users WHERE role='user' LIMIT 1").get();
if (!usersExist) {
  const now = new Date();
  const ts = () => new Date().toISOString();
  const daysAgo = d => new Date(now - d*86400000).toISOString();

  const demoUsers = [
    { id:'u_demo1', username:'moshe', password:'1234', displayName:'משה כהן', phone:'0501234567' },
    { id:'u_demo2', username:'sarah', password:'1234', displayName:'שרה לוי',  phone:'0527654321' },
    { id:'u_demo3', username:'yossi', password:'1234', displayName:'יוסי ברקוביץ', phone:'0541112233' },
  ];
  const insertUser = db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)');
  demoUsers.forEach(u => insertUser.run(u.id, u.username, u.password, 'user', u.displayName, u.phone, ts()));

  const demoNames = {
    u_demo1: [
      { name:'אברהם אבוטבול', phone:'0521111111', daysAgo:0, support:'supporter' },
      { name:'בתיה בן-דוד',   phone:'0532222222', daysAgo:0, support:'supporter' },
      { name:'גדעון גולן',     phone:'0543333333', daysAgo:1, support:'not_supporter' },
      { name:'דינה דיאמנט',   phone:'0554444444', daysAgo:1, support:'supporter' },
      { name:'הדר הרצוג',     phone:'0565555555', daysAgo:2, support:'' },
      { name:'ויקטוריה ויסמן', phone:'', daysAgo:null, support:'' },
      { name:'זיוה זכריה',     phone:'', daysAgo:null, support:'' },
      { name:'חיים חדד',       phone:'', daysAgo:null, support:'' },
      { name:'טל טייב',        phone:'', daysAgo:null, support:'' },
      { name:'יעל יצחקי',      phone:'', daysAgo:null, support:'' },
    ],
    u_demo2: [
      { name:'כרמית כהן',      phone:'0571234567', daysAgo:0, support:'supporter' },
      { name:'לימור לוי',      phone:'0582345678', daysAgo:0, support:'not_supporter' },
      { name:'מיכל מזרחי',     phone:'0593456789', daysAgo:0, support:'supporter' },
      { name:'נועה נחמני',     phone:'0504567890', daysAgo:1, support:'supporter' },
      { name:'סיגל סמואל',     phone:'', daysAgo:null, support:'' },
      { name:'עינב עמרני',     phone:'', daysAgo:null, support:'' },
      { name:'פנינה פרץ',      phone:'', daysAgo:null, support:'' },
    ],
    u_demo3: [
      { name:'צבי צדוק',       phone:'', daysAgo:null, support:'' },
      { name:'קרן קפלן',       phone:'', daysAgo:null, support:'' },
      { name:'ראובן רוזנברג',  phone:'', daysAgo:null, support:'' },
      { name:'שמואל שפירא',    phone:'', daysAgo:null, support:'' },
      { name:'תמר תורג\'מן',   phone:'', daysAgo:null, support:'' },
    ],
  };

  const insertName = db.prepare('INSERT INTO names (id,user_id,name,phone,phone_added_at,support_status,created_at) VALUES (?,?,?,?,?,?,?)');
  let idx = 0;
  Object.entries(demoNames).forEach(([userId, names]) => {
    names.forEach(n => {
      const addedAt = n.phone && n.daysAgo !== null ? daysAgo(n.daysAgo) : null;
      insertName.run(`n_demo${idx++}`, userId, n.name, n.phone||'', addedAt, n.support||'', ts());
    });
  });
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'phone-collector-s3cr3t-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
const admin = (req, res, next) => {
  if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
};

// ── AUTH ──
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  req.session.userId = user.id;
  req.session.role = user.role;
  res.json({ id: user.id, username: user.username, role: user.role, displayName: user.display_name, phone: user.phone });
});

app.post('/api/logout', auth, (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,username,role,display_name,phone FROM users WHERE id=?').get(req.session.userId);
  if (!u) return res.status(401).json({ error: 'not found' });
  res.json({ id: u.id, username: u.username, role: u.role, displayName: u.display_name, phone: u.phone });
});

// ── USERS ──
app.get('/api/users', admin, (req, res) => {
  const rows = db.prepare("SELECT id,username,role,display_name,phone,created_at FROM users WHERE role!='admin'").all();
  res.json(rows.map(u => ({ id: u.id, username: u.username, role: u.role, displayName: u.display_name, phone: u.phone, createdAt: u.created_at })));
});

app.post('/api/users', admin, (req, res) => {
  const { username, password, displayName, phone } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'חסרים שדות חובה' });
  if (password.length < 4) return res.status(400).json({ error: 'סיסמה קצרה מדי' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return res.status(400).json({ error: 'שם משתמש כבר קיים' });
  const id = 'u_' + Date.now();
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id, username, password, 'user', displayName || username, phone || '', new Date().toISOString());
  res.json({ ok: true, id });
});

app.put('/api/users/:id', admin, (req, res) => {
  const { displayName, phone, password } = req.body;
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'לא נמצא' });
  if (displayName !== undefined) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, req.params.id);
  if (phone !== undefined) db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, req.params.id);
  if (password) {
    if (password.length < 4) return res.status(400).json({ error: 'סיסמה קצרה מדי' });
    db.prepare('UPDATE users SET password=? WHERE id=?').run(password, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', admin, (req, res) => {
  db.prepare('DELETE FROM names WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/data/all', admin, (req, res) => {
  db.prepare('DELETE FROM names').run();
  db.prepare('DELETE FROM contacts').run();
  res.json({ ok: true });
});

// ── NAMES ──
app.get('/api/names', auth, (req, res) => {
  const userId = req.query.userId || req.session.userId;
  if (req.session.role !== 'admin' && userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare('SELECT * FROM names WHERE user_id=? ORDER BY created_at ASC').all(userId);
  res.json(rows.map(n => ({ id: n.id, userId: n.user_id, name: n.name, phone: n.phone, phoneAddedAt: n.phone_added_at, supportStatus: n.support_status||'', createdAt: n.created_at })));
});

app.post('/api/names', admin, (req, res) => {
  const { userId, names, replace } = req.body;
  if (!userId || !Array.isArray(names)) return res.status(400).json({ error: 'שגיאה בנתונים' });
  if (replace) db.prepare("DELETE FROM names WHERE user_id=? AND (phone IS NULL OR phone='')").run(userId);
  const existing = db.prepare('SELECT name FROM names WHERE user_id=?').all(userId).map(n => n.name);
  const stmt = db.prepare('INSERT INTO names VALUES (?,?,?,?,?,?)');
  let added = 0;
  const insert = db.transaction((list) => {
    list.forEach(name => {
      if (!existing.includes(name)) {
        stmt.run('n_' + Date.now() + '_' + Math.random().toString(36).substr(2,5), userId, name, '', null, new Date().toISOString());
        existing.push(name);
        added++;
      }
    });
  });
  insert(names);
  res.json({ ok: true, added });
});

app.put('/api/names/:id', auth, (req, res) => {
  const { phone, supportStatus } = req.body;
  const n = db.prepare('SELECT * FROM names WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'לא נמצא' });
  if (req.session.role !== 'admin' && n.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  if (phone !== undefined) {
    db.prepare('UPDATE names SET phone=?, phone_added_at=? WHERE id=?').run(
      phone || '', phone ? new Date().toISOString() : null, req.params.id
    );
  }
  if (supportStatus !== undefined) {
    db.prepare('UPDATE names SET support_status=? WHERE id=?').run(supportStatus, req.params.id);
  }
  res.json({ ok: true });
});

// ── MY ASSIGNED CONTACTS (for coordinators) ──
app.get('/api/my-contacts', auth, (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT * FROM contacts WHERE coordinator_id=?';
  const params = [req.session.userId];
  if (q) { sql += ' AND (last_name LIKE ? OR first_name LIKE ? OR address LIKE ?)'; const l=`%${q}%`; params.push(l,l,l); }
  sql += ' ORDER BY last_name, first_name';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({
    id: r.id, lastName: r.last_name, firstName: r.first_name,
    address: r.address, phone1: r.phone1, phone2: r.phone2,
    email: r.email, branchStatus: r.branch_status, supportStatus: r.support_status||''
  })));
});

// allow coordinator to update their own assigned contacts
app.put('/api/my-contacts/:id', auth, (req, res) => {
  const c = db.prepare('SELECT id,coordinator_id FROM contacts WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'לא נמצא' });
  if (req.session.role !== 'admin' && c.coordinator_id !== req.session.userId)
    return res.status(403).json({ error: 'Forbidden' });
  const { phone1, phone2, email, address, supportStatus } = req.body;
  const now = new Date().toISOString();
  if (phone1         !== undefined) db.prepare('UPDATE contacts SET phone1=?,updated_at=? WHERE id=?').run(phone1,now,req.params.id);
  if (phone2         !== undefined) db.prepare('UPDATE contacts SET phone2=?,updated_at=? WHERE id=?').run(phone2,now,req.params.id);
  if (email          !== undefined) db.prepare('UPDATE contacts SET email=?,updated_at=? WHERE id=?').run(email,now,req.params.id);
  if (address        !== undefined) db.prepare('UPDATE contacts SET address=?,updated_at=? WHERE id=?').run(address,now,req.params.id);
  if (supportStatus  !== undefined) db.prepare('UPDATE contacts SET support_status=?,updated_at=? WHERE id=?').run(supportStatus,now,req.params.id);
  res.json({ ok: true });
});

// ── STATS (admin overview) ──
app.get('/api/stats', admin, (req, res) => {
  const users = db.prepare("SELECT id,username,display_name,phone FROM users WHERE role!='admin'").all();
  const today = new Date().toDateString();
  const stats = users.map(u => {
    const names    = db.prepare('SELECT phone,phone_added_at,support_status FROM names WHERE user_id=?').all(u.id);
    const contacts = db.prepare("SELECT phone1,phone2,updated_at FROM contacts WHERE coordinator_id=?").all(u.id);

    // names stats
    const namesCollected  = names.filter(n => n.phone).length;
    const namesToday      = names.filter(n => n.phone && new Date(n.phone_added_at).toDateString() === today).length;
    const supporters      = names.filter(n => n.support_status === 'supporter').length;
    const notSupport      = names.filter(n => n.support_status === 'not_supporter').length;

    // contacts stats
    const contactsFilled  = contacts.filter(c => c.phone1 || c.phone2).length;
    const contactsToday   = contacts.filter(c => (c.phone1||c.phone2) && new Date(c.updated_at).toDateString() === today).length;

    // combined
    const total     = names.length + contacts.length;
    const collected = namesCollected + contactsFilled;
    const todayC    = namesToday + contactsToday;

    return {
      userId: u.id, displayName: u.display_name, username: u.username, phone: u.phone,
      total, collected, today: todayC,
      remaining: total - collected,
      pct: total ? Math.round(collected / total * 100) : 0,
      supporters, notSupport,
      assignedContacts: contacts.length,
      filledContacts: contactsFilled
    };
  });
  res.json(stats);
});

// ── EXPORT (admin) ──
app.get('/api/export/all', admin, (req, res) => {
  const rows = db.prepare(`
    SELECT n.name, n.phone, n.support_status, u.display_name, n.phone_added_at
    FROM names n JOIN users u ON n.user_id=u.id
    WHERE n.phone!='' ORDER BY u.display_name, n.name
  `).all();
  res.json(rows.map(r => ({ name: r.name, phone: r.phone, support: r.support_status, user: r.display_name, date: r.phone_added_at })));
});

app.get('/api/export/user/:id', admin, (req, res) => {
  const rows = db.prepare("SELECT name,phone,support_status,phone_added_at FROM names WHERE user_id=? AND phone!=''").all(req.params.id);
  res.json(rows.map(r => ({ name: r.name, phone: r.phone, support: r.support_status, date: r.phone_added_at })));
});

// ── CONTACTS ──

// Import from Excel (JSON payload sent from client-side SheetJS parsing)
app.post('/api/contacts/import', admin, (req, res) => {
  const { rows, coordinatorId } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'שגיאה בנתונים' });
  const coordId = coordinatorId || '';

  const insert = db.prepare(`
    INSERT OR IGNORE INTO contacts (id,resident_code,last_name,first_name,address,phone1,phone2,email,branch_status,coordinator_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const now = new Date().toISOString();
  let added = 0, skipped = 0;

  const run = db.transaction(() => {
    rows.forEach(r => {
      const result = insert.run(
        'c_' + Date.now() + '_' + Math.random().toString(36).substr(2,6),
        r.resident_code || null,
        r.last_name || '', r.first_name || '',
        r.address || '', r.phone1 || '', r.phone2 || '',
        r.email || '', r.branch_status || '', coordId, now, now
      );
      if (result.changes > 0) added++; else skipped++;
    });
  });
  run();
  res.json({ ok: true, added, skipped, total: rows.length });
});

// Get contacts — supports filter: missing=phone|email|any, coordinator=id, q=search
app.get('/api/contacts', admin, (req, res) => {
  const { missing, coordinator, q, page = 1, limit = 50 } = req.query;
  let where = [];
  let params = [];

  if (missing === 'phone')  { where.push("(phone1='' AND phone2='')"); }
  if (missing === 'email')  { where.push("email=''"); }
  if (missing === 'any')    { where.push("(phone1='' AND phone2='' OR email='')"); }
  if (coordinator === 'none') { where.push("(coordinator_id='' OR coordinator_id IS NULL)"); }
  else if (coordinator)     { where.push("coordinator_id=?"); params.push(coordinator); }
  if (q) {
    where.push("(last_name LIKE ? OR first_name LIKE ? OR address LIKE ? OR phone1 LIKE ? OR phone2 LIKE ? OR email LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as n FROM contacts ${whereClause}`).get(...params).n;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const rows = db.prepare(`
    SELECT c.*, u.display_name as coordinator_name
    FROM contacts c
    LEFT JOIN users u ON c.coordinator_id = u.id
    ${whereClause}
    ORDER BY c.last_name, c.first_name
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({ total, page: parseInt(page), rows: rows.map(r => ({
    id: r.id, residentCode: r.resident_code,
    lastName: r.last_name, firstName: r.first_name,
    address: r.address, phone1: r.phone1, phone2: r.phone2,
    email: r.email, branchStatus: r.branch_status,
    coordinatorId: r.coordinator_id, coordinatorName: r.coordinator_name || '',
    notes: r.notes || '', createdAt: r.created_at, updatedAt: r.updated_at
  }))});
});

app.put('/api/contacts/:id', admin, (req, res) => {
  const { phone1, phone2, email, coordinatorId, notes } = req.body;
  const c = db.prepare('SELECT id FROM contacts WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'לא נמצא' });
  const now = new Date().toISOString();
  if (phone1      !== undefined) db.prepare('UPDATE contacts SET phone1=?, updated_at=? WHERE id=?').run(phone1, now, req.params.id);
  if (phone2      !== undefined) db.prepare('UPDATE contacts SET phone2=?, updated_at=? WHERE id=?').run(phone2, now, req.params.id);
  if (email       !== undefined) db.prepare('UPDATE contacts SET email=?, updated_at=? WHERE id=?').run(email, now, req.params.id);
  if (coordinatorId !== undefined) db.prepare('UPDATE contacts SET coordinator_id=?, updated_at=? WHERE id=?').run(coordinatorId, now, req.params.id);
  if (notes       !== undefined) db.prepare('UPDATE contacts SET notes=?, updated_at=? WHERE id=?').run(notes, now, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/contacts', admin, (req, res) => {
  db.prepare('DELETE FROM contacts').run();
  res.json({ ok: true });
});

app.get('/api/contacts/stats', admin, (req, res) => {
  const total       = db.prepare("SELECT COUNT(*) as n FROM contacts").get().n;
  const missingPhone= db.prepare("SELECT COUNT(*) as n FROM contacts WHERE phone1='' AND phone2=''").get().n;
  const missingEmail= db.prepare("SELECT COUNT(*) as n FROM contacts WHERE email=''").get().n;
  const assigned    = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE coordinator_id!='' AND coordinator_id IS NOT NULL").get().n;
  const complete    = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE (phone1!='' OR phone2!='') AND email!=''").get().n;
  res.json({ total, missingPhone, missingEmail, assigned, complete, incomplete: total - complete });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
