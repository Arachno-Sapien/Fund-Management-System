/*
 * FundVault Backend Server
 *
 * Run:
 * 1. npm install
 * 2. npm start
 *
 * Server URL: http://localhost:3000
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 24;
const JWT_SECRET =
  process.env.JWT_SECRET ||
  'fundvault-secret-key-change-in-production';

if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set. Using development fallback secret.');
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..')));

// Database Setup
const db = new Database('fundvault.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS databases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    balance REAL DEFAULT 0,
    low_balance_threshold REAL DEFAULT 0,
    approval_threshold REAL DEFAULT 0,
    is_archived INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('credit', 'debit')),
    amount REAL NOT NULL CHECK(amount > 0),
    date DATETIME NOT NULL,
    sender TEXT,
    receiver TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('electronic', 'cheque', 'cash')),
    mode_data TEXT,
    location TEXT,
    notes TEXT,
    running_balance REAL NOT NULL,
    receipt_image TEXT,
    requires_approval INTEGER DEFAULT 0,
    approved INTEGER DEFAULT 1,
    approved_by TEXT,
    approved_at DATETIME,
    is_voided INTEGER DEFAULT 0,
    void_reason TEXT,
    voided_by TEXT,
    voided_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (database_id) REFERENCES databases(id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS recurring_transactions (
    id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('credit', 'debit')),
    amount REAL NOT NULL CHECK(amount > 0),
    frequency TEXT NOT NULL CHECK(frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
    description TEXT,
    next_run DATE NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (database_id) REFERENCES databases(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS trash (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_data TEXT NOT NULL,
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_by TEXT,
    FOREIGN KEY (deleted_by) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_databases_user ON databases(user_id);
  CREATE INDEX IF NOT EXISTS idx_txn_database ON transactions(database_id);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

const ensureColumn = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(col => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

ensureColumn('users', 'is_active', 'INTEGER DEFAULT 1');
ensureColumn('users', 'updated_at', 'DATETIME');
db.prepare(`
  UPDATE users
  SET
    is_active = COALESCE(is_active, 1),
    updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
`).run();
db.exec('CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);');
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());

// Utilities
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const addAudit = (userId, action, entityType, entityId, details) => {
  db.prepare(`
    INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid(), userId, action, entityType, entityId, details);
};

const createSessionToken = userId =>
  jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });

const createSession = (userId, token) => {
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, user_id, token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(uid(), userId, token, expiresAt);
  return expiresAt;
};

const countOtherActiveAdmins = userId =>
  db.prepare(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE role = 'admin' AND is_active = 1 AND id != ?
  `).get(userId).count;

const isValidRole = role => role === 'admin' || role === 'member';

// Auth Middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const session = db.prepare(`
    SELECT
      s.user_id,
      s.expires_at,
      u.username,
      u.role,
      u.is_active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!session) {
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
  if (decoded.id !== session.user_id) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Invalid session' });
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
  if (!session.is_active) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.user_id);
    return res.status(403).json({ error: 'Account is inactive' });
  }

  db.prepare('UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE token = ?').run(token);
  req.user = {
    id: session.user_id,
    username: session.username,
    role: session.role,
    token
  };
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════

app.post('/api/auth/signup', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.status(400).json({ error: 'Username or email already exists' });
  }

  const id = uid();
  const passwordHash = bcrypt.hashSync(password, 10);
  const role = db.prepare('SELECT COUNT(*) as count FROM users').get().count === 0 ? 'admin' : 'member';

  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, username, email, passwordHash, role);

  const token = createSessionToken(id);
  createSession(id, token);

  addAudit(id, 'signup', 'user', id, `User ${username} registered`);

  res.json({ token, user: { id, username, email, role, is_active: true } });
});

app.post('/api/auth/login', (req, res) => {
  const usernameOrEmail = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(usernameOrEmail, usernameOrEmail.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is inactive' });
  }

  const token = createSessionToken(user.id);
  createSession(user.id, token);

  addAudit(user.id, 'login', 'user', user.id, `User ${user.username} logged in`);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      is_active: !!user.is_active
    }
  });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.user.token);
  addAudit(req.user.id, 'logout', 'user', req.user.id, `User ${req.user.username} logged out`);
  res.json({ success: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare(`
    SELECT id, username, email, role, is_active, created_at, updated_at
    FROM users
    WHERE id = ?
  `).get(req.user.id);
  res.json({ ...user, is_active: !!user.is_active });
});

// ═══════════════════════════════════════════════════════
// DATABASE ROUTES
// ═══════════════════════════════════════════════════════

app.get('/api/databases', auth, (req, res) => {
  const databases = db.prepare(`
    SELECT * FROM databases
    WHERE user_id = ? AND is_deleted = 0
    ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(databases);
});

app.post('/api/databases', auth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const lowBalanceThreshold = Number(req.body?.lowBalanceThreshold) || 0;
  const approvalThreshold = Number(req.body?.approvalThreshold) || 0;

  if (!name) return res.status(400).json({ error: 'Name required' });

  const id = uid();
  db.prepare(`
    INSERT INTO databases (id, user_id, name, description, low_balance_threshold, approval_threshold)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, name, description, lowBalanceThreshold, approvalThreshold);

  addAudit(req.user.id, 'create', 'database', id, `Database "${name}" created`);

  const database = db.prepare('SELECT * FROM databases WHERE id = ?').get(id);
  res.json(database);
});

app.get('/api/databases/:id', auth, (req, res) => {
  const database = db.prepare(`
    SELECT * FROM databases
    WHERE id = ? AND user_id = ? AND is_deleted = 0
  `).get(req.params.id, req.user.id);
  if (!database) return res.status(404).json({ error: 'Database not found' });

  const transactions = db.prepare(`
    SELECT * FROM transactions
    WHERE database_id = ?
    ORDER BY date DESC
  `).all(req.params.id);

  res.json({ ...database, transactions });
});

app.put('/api/databases/:id', auth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const lowBalanceThreshold = Number(req.body?.lowBalanceThreshold) || 0;
  const approvalThreshold = Number(req.body?.approvalThreshold) || 0;

  if (!name) return res.status(400).json({ error: 'Name required' });

  const update = db.prepare(`
    UPDATE databases
    SET name = ?, description = ?, low_balance_threshold = ?, approval_threshold = ?
    WHERE id = ? AND user_id = ? AND is_deleted = 0
  `).run(name, description, lowBalanceThreshold, approvalThreshold, req.params.id, req.user.id);

  if (update.changes === 0) {
    return res.status(404).json({ error: 'Database not found' });
  }

  addAudit(req.user.id, 'update', 'database', req.params.id, `Database "${name}" updated`);

  const database = db.prepare('SELECT * FROM databases WHERE id = ?').get(req.params.id);
  res.json(database);
});

app.delete('/api/databases/:id', auth, (req, res) => {
  const database = db.prepare(`
    SELECT * FROM databases
    WHERE id = ? AND user_id = ? AND is_deleted = 0
  `).get(req.params.id, req.user.id);
  if (!database) return res.status(404).json({ error: 'Database not found' });

  db.prepare('UPDATE databases SET is_deleted = 1 WHERE id = ?').run(req.params.id);
  db.prepare(`
    INSERT INTO trash (id, entity_type, entity_data, deleted_by)
    VALUES (?, 'database', ?, ?)
  `).run(uid(), JSON.stringify(database), req.user.id);

  addAudit(req.user.id, 'delete', 'database', req.params.id, `Database "${database.name}" deleted`);
  res.json({ success: true });
});

app.post('/api/databases/:id/archive', auth, (req, res) => {
  const database = db.prepare(`
    SELECT * FROM databases
    WHERE id = ? AND user_id = ? AND is_deleted = 0
  `).get(req.params.id, req.user.id);
  if (!database) return res.status(404).json({ error: 'Database not found' });

  const newState = database.is_archived ? 0 : 1;
  db.prepare('UPDATE databases SET is_archived = ? WHERE id = ?').run(newState, req.params.id);
  addAudit(req.user.id, 'update', 'database', req.params.id, `Database "${database.name}" ${newState ? 'archived' : 'unarchived'}`);

  res.json({ success: true, is_archived: newState });
});

// ═══════════════════════════════════════════════════════
// TRANSACTION ROUTES
// ═══════════════════════════════════════════════════════

app.get('/api/databases/:id/transactions', auth, (req, res) => {
  const database = db.prepare(`
    SELECT id FROM databases
    WHERE id = ? AND user_id = ? AND is_deleted = 0
  `).get(req.params.id, req.user.id);
  if (!database) return res.status(404).json({ error: 'Database not found' });

  const transactions = db.prepare(`
    SELECT * FROM transactions
    WHERE database_id = ?
    ORDER BY date DESC, created_at DESC
  `).all(req.params.id);

  res.json(transactions);
});

app.post('/api/databases/:id/transactions', auth, (req, res) => {
  const type = String(req.body?.type || '').trim();
  const amount = Number(req.body?.amount);
  const date = String(req.body?.date || '').trim();
  const sender = String(req.body?.sender || '').trim();
  const receiver = String(req.body?.receiver || '').trim();
  const mode = String(req.body?.mode || '').trim();
  const modeData = req.body?.modeData || {};
  const location = String(req.body?.location || '').trim();
  const notes = String(req.body?.notes || '').trim();
  const receiptImage = req.body?.receiptImage || null;

  if (!['credit', 'debit'].includes(type)) {
    return res.status(400).json({ error: 'Invalid transaction type' });
  }
  if (!['electronic', 'cheque', 'cash'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid transaction mode' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }
  if (!date) {
    return res.status(400).json({ error: 'Transaction date is required' });
  }

  const database = db.prepare(`
    SELECT * FROM databases
    WHERE id = ? AND user_id = ? AND is_deleted = 0
  `).get(req.params.id, req.user.id);
  if (!database) return res.status(404).json({ error: 'Database not found' });

  if (type === 'debit' && amount > database.balance) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const requiresApproval = database.approval_threshold > 0 && amount >= database.approval_threshold;
  const newBalance = requiresApproval
    ? database.balance
    : (type === 'credit' ? database.balance + amount : database.balance - amount);

  const id = uid();
  const createTransaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO transactions (
        id, database_id, type, amount, date, sender, receiver, mode, mode_data, location,
        notes, running_balance, receipt_image, requires_approval, approved
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      req.params.id,
      type,
      amount,
      date,
      sender || null,
      receiver || null,
      mode,
      JSON.stringify(modeData),
      location || null,
      notes || null,
      newBalance,
      receiptImage,
      requiresApproval ? 1 : 0,
      requiresApproval ? 0 : 1
    );

    if (!requiresApproval) {
      db.prepare('UPDATE databases SET balance = ? WHERE id = ?').run(newBalance, req.params.id);
    }
  });

  createTransaction();
  addAudit(
    req.user.id,
    'create',
    'transaction',
    id,
    `${type === 'credit' ? 'Credit' : 'Debit'} of ₹${amount} ${requiresApproval ? 'pending approval' : 'recorded'}`
  );

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  res.json({ transaction, requiresApproval, newBalance });
});

app.post('/api/transactions/:id/void', auth, (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Void reason required' });

  const transaction = db.prepare(`
    SELECT t.*
    FROM transactions t
    JOIN databases d ON d.id = t.database_id
    WHERE t.id = ? AND d.user_id = ? AND d.is_deleted = 0
  `).get(req.params.id, req.user.id);

  if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
  if (transaction.is_voided) {
    return res.status(400).json({ error: 'Transaction is already voided' });
  }

  const applyVoid = db.transaction(() => {
    db.prepare(`
      UPDATE transactions
      SET is_voided = 1, void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason, req.user.username, req.params.id);

    const approvedTransactions = db.prepare(`
      SELECT * FROM transactions
      WHERE database_id = ? AND is_voided = 0 AND approved = 1
      ORDER BY date, created_at, id
    `).all(transaction.database_id);

    let balance = 0;
    for (const t of approvedTransactions) {
      balance = t.type === 'credit' ? balance + t.amount : balance - t.amount;
      db.prepare('UPDATE transactions SET running_balance = ? WHERE id = ?').run(balance, t.id);
    }
    db.prepare('UPDATE databases SET balance = ? WHERE id = ?').run(balance, transaction.database_id);
  });

  applyVoid();
  addAudit(req.user.id, 'void', 'transaction', req.params.id, `Transaction voided: ${reason}`);
  res.json({ success: true });
});

app.post('/api/transactions/:id/approve', auth, (req, res) => {
  const transaction = db.prepare(`
    SELECT t.*
    FROM transactions t
    JOIN databases d ON d.id = t.database_id
    WHERE t.id = ? AND d.user_id = ? AND d.is_deleted = 0
  `).get(req.params.id, req.user.id);

  if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
  if (transaction.is_voided) return res.status(400).json({ error: 'Cannot approve a voided transaction' });
  if (transaction.approved) return res.status(400).json({ error: 'Transaction is already approved' });
  if (!transaction.requires_approval) return res.status(400).json({ error: 'Transaction does not require approval' });

  const database = db.prepare('SELECT * FROM databases WHERE id = ? AND user_id = ?').get(transaction.database_id, req.user.id);
  if (!database) return res.status(404).json({ error: 'Database not found' });

  if (transaction.type === 'debit' && transaction.amount > database.balance) {
    return res.status(400).json({ error: 'Insufficient balance to approve this debit transaction' });
  }

  const newBalance = transaction.type === 'credit'
    ? database.balance + transaction.amount
    : database.balance - transaction.amount;

  const approveTransaction = db.transaction(() => {
    db.prepare(`
      UPDATE transactions
      SET approved = 1, approved_by = ?, approved_at = CURRENT_TIMESTAMP, running_balance = ?
      WHERE id = ?
    `).run(req.user.username, newBalance, req.params.id);

    db.prepare('UPDATE databases SET balance = ? WHERE id = ?').run(newBalance, transaction.database_id);
  });

  approveTransaction();
  addAudit(req.user.id, 'update', 'transaction', req.params.id, `Transaction approved by ${req.user.username}`);
  res.json({ success: true, newBalance });
});

// ═══════════════════════════════════════════════════════
// AUDIT & ANALYTICS ROUTES
// ═══════════════════════════════════════════════════════

app.get('/api/audit', auth, (req, res) => {
  const logs = db.prepare(`
    SELECT * FROM audit_log
    WHERE user_id = ?
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(req.user.id);
  res.json(logs);
});

app.get('/api/analytics/overview', auth, (req, res) => {
  const databases = db.prepare('SELECT * FROM databases WHERE user_id = ? AND is_deleted = 0').all(req.user.id);
  const dbIds = databases.map(d => d.id);

  if (dbIds.length === 0) {
    return res.json({
      totalDatabases: 0,
      totalBalance: 0,
      totalCredits: 0,
      totalDebits: 0,
      monthlyData: [],
      modeData: []
    });
  }

  const placeholders = dbIds.map(() => '?').join(',');
  const credits = db.prepare(`
    SELECT SUM(amount) AS total
    FROM transactions
    WHERE database_id IN (${placeholders}) AND type = 'credit' AND is_voided = 0
  `).get(...dbIds);
  const debits = db.prepare(`
    SELECT SUM(amount) AS total
    FROM transactions
    WHERE database_id IN (${placeholders}) AND type = 'debit' AND is_voided = 0
  `).get(...dbIds);

  res.json({
    totalDatabases: databases.length,
    totalBalance: databases.reduce((sum, d) => sum + d.balance, 0),
    totalCredits: credits?.total || 0,
    totalDebits: debits?.total || 0
  });
});

// ═══════════════════════════════════════════════════════
// TRASH ROUTES
// ═══════════════════════════════════════════════════════

app.get('/api/trash', auth, (req, res) => {
  const items = db.prepare(`
    SELECT * FROM trash
    WHERE deleted_by = ?
    ORDER BY deleted_at DESC
  `).all(req.user.id);
  res.json(items);
});

app.post('/api/trash/:id/restore', auth, (req, res) => {
  const item = db.prepare('SELECT * FROM trash WHERE id = ? AND deleted_by = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (item.entity_type === 'database') {
    const data = JSON.parse(item.entity_data);
    db.prepare('UPDATE databases SET is_deleted = 0 WHERE id = ? AND user_id = ?').run(data.id, req.user.id);
  }

  db.prepare('DELETE FROM trash WHERE id = ?').run(req.params.id);
  addAudit(req.user.id, 'update', item.entity_type, req.params.id, 'Item restored from trash');
  res.json({ success: true });
});

app.delete('/api/trash/:id', auth, (req, res) => {
  const item = db.prepare('SELECT * FROM trash WHERE id = ? AND deleted_by = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (item.entity_type === 'database') {
    const data = JSON.parse(item.entity_data);
    db.prepare('DELETE FROM recurring_transactions WHERE database_id = ?').run(data.id);
    db.prepare('DELETE FROM transactions WHERE database_id = ?').run(data.id);
    db.prepare('DELETE FROM databases WHERE id = ? AND user_id = ?').run(data.id, req.user.id);
  }

  db.prepare('DELETE FROM trash WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// ADMIN USER MANAGEMENT ROUTES
// ═══════════════════════════════════════════════════════

app.get('/api/admin/users', auth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.role,
      u.is_active,
      u.created_at,
      u.updated_at,
      COUNT(DISTINCT d.id) AS database_count,
      COUNT(DISTINCT CASE WHEN d.is_deleted = 0 THEN d.id END) AS active_database_count,
      COUNT(t.id) AS transaction_count
    FROM users u
    LEFT JOIN databases d ON d.user_id = u.id
    LEFT JOIN transactions t ON t.database_id = d.id
    GROUP BY u.id
    ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
  `).all();

  res.json(users.map(user => ({
    ...user,
    is_active: !!user.is_active
  })));
});

app.put('/api/admin/users/:id', auth, requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const nextUsername = req.body?.username !== undefined
    ? String(req.body.username).trim()
    : target.username;
  const nextEmail = req.body?.email !== undefined
    ? String(req.body.email).trim().toLowerCase()
    : target.email;
  const nextRole = req.body?.role !== undefined
    ? String(req.body.role).trim()
    : target.role;
  const nextIsActive = req.body?.is_active !== undefined
    ? (req.body.is_active ? 1 : 0)
    : target.is_active;

  if (!nextUsername || !nextEmail) {
    return res.status(400).json({ error: 'Username and email are required' });
  }
  if (!isValidRole(nextRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (req.user.id === targetId && nextIsActive === 0) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  const adminDowngrade = target.role === 'admin' && (nextRole !== 'admin' || nextIsActive === 0);
  if (adminDowngrade && countOtherActiveAdmins(targetId) === 0) {
    return res.status(400).json({ error: 'At least one active admin account is required' });
  }

  try {
    const updateUser = db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET username = ?, email = ?, role = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextUsername, nextEmail, nextRole, nextIsActive, targetId);

      if (nextIsActive === 0) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      }
    });
    updateUser();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    throw error;
  }

  const updated = db.prepare(`
    SELECT id, username, email, role, is_active, created_at, updated_at
    FROM users
    WHERE id = ?
  `).get(targetId);

  addAudit(
    req.user.id,
    'update',
    'user',
    targetId,
    `Updated user "${target.username}" → "${updated.username}" (${updated.role}, ${updated.is_active ? 'active' : 'inactive'})`
  );

  res.json({ ...updated, is_active: !!updated.is_active });
});

app.post('/api/admin/users/:id/reset-password', auth, requireAdmin, (req, res) => {
  const targetId = req.params.id;
  const newPassword = String(req.body?.newPassword || '');

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  const resetPassword = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(passwordHash, targetId);

    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  });
  resetPassword();

  addAudit(req.user.id, 'update', 'user', targetId, `Password reset for user "${target.username}"`);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', auth, requireAdmin, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin' && countOtherActiveAdmins(targetId) === 0) {
    return res.status(400).json({ error: 'At least one active admin account is required' });
  }

  const removeUser = db.transaction(() => {
    const dbRows = db.prepare('SELECT id FROM databases WHERE user_id = ?').all(targetId);
    const dbIds = dbRows.map(row => row.id);

    if (dbIds.length) {
      const placeholders = dbIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM recurring_transactions WHERE database_id IN (${placeholders})`).run(...dbIds);
      db.prepare(`DELETE FROM transactions WHERE database_id IN (${placeholders})`).run(...dbIds);
    }

    db.prepare('DELETE FROM databases WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM trash WHERE deleted_by = ?').run(targetId);
    db.prepare('DELETE FROM audit_log WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  });
  removeUser();

  addAudit(req.user.id, 'delete', 'user', targetId, `Deleted user account "${target.username}"`);
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ◈ FundVault Server Running                              ║
║   ─────────────────────────────                           ║
║   Port: ${PORT}                                              ║
║   URL:  http://localhost:${PORT}                             ║
║                                                           ║
║   API Endpoints:                                          ║
║   • POST /api/auth/signup                                 ║
║   • POST /api/auth/login                                  ║
║   • POST /api/auth/logout                                 ║
║   • GET  /api/auth/me                                     ║
║   • GET  /api/databases                                   ║
║   • POST /api/databases                                   ║
║   • GET  /api/admin/users (admin)                         ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
