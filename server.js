const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { body, validationResult } = require('express-validator');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'nexbank-secret-key-change-in-production';

app.use(cors());
app.use(express.json());

// Serve static assets (css, js, fonts) but NOT html files via static middleware
// HTML pages are served explicitly by route handlers below
app.use('/style.css',    (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.use('/Style.css',    (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.use('/javascript.js',(req, res) => res.sendFile(path.join(__dirname, 'javascript.js')));
app.use('/Javascript.js',(req, res) => res.sendFile(path.join(__dirname, 'javascript.js')));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'nexbank.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT    UNIQUE NOT NULL,
        password TEXT    NOT NULL,
        role     TEXT    NOT NULL CHECK(role IN ('admin','customer'))
    );
    CREATE TABLE IF NOT EXISTS customers (
        id      TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        dob     TEXT,
        phone   TEXT,
        address TEXT
    );
    CREATE TABLE IF NOT EXISTS accounts (
        id         TEXT PRIMARY KEY,
        type       TEXT,
        balance    REAL DEFAULT 0,
        customerId TEXT
    );
    CREATE TABLE IF NOT EXISTS transactions (
        id        TEXT PRIMARY KEY,
        date      TEXT,
        amount    REAL,
        mode      TEXT,
        accountId TEXT
    );
    CREATE TABLE IF NOT EXISTS loans (
        id         TEXT PRIMARY KEY,
        amount     REAL,
        type       TEXT,
        interest   REAL,
        issueDate  TEXT,
        dueDate    TEXT,
        status     TEXT DEFAULT 'Active',
        customerId TEXT
    );
    CREATE TABLE IF NOT EXISTS payments (
        id     TEXT PRIMARY KEY,
        loanId TEXT,
        amount REAL
    );
    CREATE TABLE IF NOT EXISTS employees (
        id     TEXT PRIMARY KEY,
        name   TEXT,
        salary REAL
    );
    CREATE TABLE IF NOT EXISTS branches (
        branchId TEXT PRIMARY KEY,
        bankId   TEXT,
        bankName TEXT,
        city     TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT DEFAULT (datetime('now')),
        actor    TEXT,
        action   TEXT,
        entity   TEXT,
        entityId TEXT,
        detail   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_customer ON accounts(customerId);
    CREATE INDEX IF NOT EXISTS idx_transactions_acct ON transactions(accountId);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_loans_customer    ON loans(customerId);
    CREATE INDEX IF NOT EXISTS idx_loans_status      ON loans(status);
    CREATE INDEX IF NOT EXISTS idx_payments_loan     ON payments(loanId);
    CREATE INDEX IF NOT EXISTS idx_audit_ts          ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_actor       ON audit_log(actor);
`);

// Seed admin user and default branches once
if (!db.prepare('SELECT id FROM users WHERE username=?').get('admin')) {
    db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)')
      .run('admin', bcrypt.hashSync('admin123', 10), 'admin');
}
if (db.prepare('SELECT COUNT(*) as c FROM branches').get().c === 0) {
    const ins = db.prepare('INSERT INTO branches (branchId,bankId,bankName,city) VALUES (?,?,?,?)');
    ins.run('BR101', 'B001', 'NexBank HQ',   'New York');
    ins.run('BR102', 'B001', 'NexBank West', 'Los Angeles');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function auditLog(actor, action, entity, entityId, detail = '') {
    db.prepare('INSERT INTO audit_log (actor,action,entity,entityId,detail) VALUES (?,?,?,?,?)')
      .run(actor, action, entity, String(entityId), detail);
}

function validate(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        return false;
    }
    return true;
}

function paginate(req) {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    return { limit, offset: (page - 1) * limit, page };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(requiredRole = null) {
    return (req, res, next) => {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer '))
            return res.status(401).json({ error: 'No token provided.' });
        try {
            const payload = jwt.verify(header.slice(7), SECRET);
            req.user = payload;
            if (requiredRole && payload.role !== requiredRole)
                return res.status(403).json({ error: 'Insufficient permissions.' });
            next();
        } catch {
            res.status(401).json({ error: 'Invalid or expired token.' });
        }
    };
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/register',
    body('username').trim().isLength({ min: 3 }).withMessage('Username min 3 chars.'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 chars.'),
    body('role').isIn(['admin', 'customer']).withMessage('Role must be admin or customer.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { username, password, role } = req.body;
        if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
            return res.status(409).json({ error: 'Username already exists.' });
        db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)')
          .run(username, bcrypt.hashSync(password, 10), role);
        auditLog('system', 'REGISTER', 'user', username, `role=${role}`);
        res.status(201).json({ message: 'User registered.' });
    }
);

app.post('/api/auth/login',
    body('username').trim().notEmpty().withMessage('Username required.'),
    body('password').notEmpty().withMessage('Password required.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { username, password } = req.body;
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        if (!user || !bcrypt.compareSync(password, user.password))
            return res.status(401).json({ error: 'Invalid credentials.' });
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            SECRET, { expiresIn: '8h' }
        );
        auditLog(username, 'LOGIN', 'user', username);
        res.json({ token, role: user.role, username: user.username });
    }
);

// ── Customers ─────────────────────────────────────────────────────────────────
app.get('/api/customers', auth(), (req, res) => {
    const { limit, offset, page } = paginate(req);
    const rows  = db.prepare('SELECT * FROM customers LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
    res.json({ data: rows, total, page, pages: Math.ceil(total / limit) });
});

app.post('/api/customers', auth('admin'),
    body('id').trim().notEmpty().withMessage('id required.'),
    body('name').trim().isLength({ min: 2 }).withMessage('name min 2 chars.'),
    body('phone').optional({ checkFalsy: true }).isString().withMessage('Invalid phone.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { id, name, dob, phone, address } = req.body;
        db.prepare('INSERT OR REPLACE INTO customers (id,name,dob,phone,address) VALUES (?,?,?,?,?)')
          .run(id, name, dob || null, phone || null, address || null);
        auditLog(req.user.username, 'UPSERT', 'customer', id);
        res.status(201).json({ message: 'Customer saved.' });
    }
);

// ── Accounts ──────────────────────────────────────────────────────────────────
app.get('/api/accounts', auth(), (req, res) => {
    const { limit, offset, page } = paginate(req);
    const rows  = db.prepare('SELECT * FROM accounts LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as c FROM accounts').get().c;
    res.json({ data: rows, total, page, pages: Math.ceil(total / limit) });
});

app.post('/api/accounts', auth('admin'),
    body('id').trim().notEmpty().withMessage('id required.'),
    body('balance').isFloat({ min: 0 }).withMessage('balance must be >= 0.'),
    body('customerId').trim().notEmpty().withMessage('customerId required.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { id, type, balance, customerId } = req.body;
        db.prepare('INSERT OR IGNORE INTO accounts (id,type,balance,customerId) VALUES (?,?,?,?)')
          .run(id, type || null, Number(balance), customerId);
        auditLog(req.user.username, 'CREATE', 'account', id, `balance=${balance}`);
        res.status(201).json({ message: 'Account created.' });
    }
);

// ── Transactions ──────────────────────────────────────────────────────────────
app.get('/api/transactions', auth(), (req, res) => {
    const { limit, offset, page } = paginate(req);
    const rows  = db.prepare('SELECT * FROM transactions ORDER BY date DESC LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
    res.json({ data: rows, total, page, pages: Math.ceil(total / limit) });
});

app.post('/api/transactions', auth(),
    body('id').trim().notEmpty().withMessage('id required.'),
    body('amount').isFloat({ min: 0.01 }).withMessage('amount must be > 0.'),
    body('mode').isIn(['Deposit', 'Withdrawal', 'Transfer']).withMessage('mode must be Deposit, Withdrawal or Transfer.'),
    body('accountId').trim().notEmpty().withMessage('accountId required.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { id, date, amount, mode, accountId } = req.body;

        const doTransfer = db.transaction(() => {
            const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
            if (!account) throw { status: 404, error: `Account "${accountId}" not found.` };
            const amt = Number(amount);
            if ((mode === 'Withdrawal' || mode === 'Transfer') && account.balance < amt)
                throw { status: 400, error: `Insufficient balance. Current: $${account.balance}.` };
            const delta = mode === 'Deposit' ? amt : -amt;
            db.prepare('UPDATE accounts SET balance=balance+? WHERE id=?').run(delta, accountId);
            db.prepare('INSERT INTO transactions (id,date,amount,mode,accountId) VALUES (?,?,?,?,?)')
              .run(id, date || new Date().toISOString().slice(0, 10), amt, mode, accountId);
            return db.prepare('SELECT balance FROM accounts WHERE id=?').get(accountId).balance;
        });

        try {
            const newBalance = doTransfer();
            auditLog(req.user.username, mode.toUpperCase(), 'transaction', id, `acct=${accountId} amt=${amount}`);
            res.status(201).json({ message: 'Transaction processed.', newBalance });
        } catch (e) {
            res.status(e.status || 500).json({ error: e.error || 'Transaction failed.' });
        }
    }
);

// ── Loans ─────────────────────────────────────────────────────────────────────
app.get('/api/loans', auth(), (req, res) => {
    const { limit, offset, page } = paginate(req);
    const rows  = db.prepare('SELECT * FROM loans LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as c FROM loans').get().c;
    res.json({ data: rows, total, page, pages: Math.ceil(total / limit) });
});

app.post('/api/loans', auth('admin'),
    body('id').trim().notEmpty().withMessage('id required.'),
    body('amount').isFloat({ min: 1000 }).withMessage('amount min $1000.'),
    body('interest').isFloat({ min: 0 }).withMessage('interest must be >= 0.'),
    body('customerId').trim().notEmpty().withMessage('customerId required.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { id, amount, type, interest, issueDate, dueDate, status, customerId } = req.body;
        if (db.prepare('SELECT id FROM loans WHERE id=?').get(id))
            return res.status(409).json({ error: `Loan "${id}" already exists.` });
        const account = db.prepare('SELECT * FROM accounts WHERE customerId=? LIMIT 1').get(customerId);
        if (!account) return res.status(404).json({ error: `No account found for customer "${customerId}".` });
        db.transaction(() => {
            db.prepare('INSERT INTO loans (id,amount,type,interest,issueDate,dueDate,status,customerId) VALUES (?,?,?,?,?,?,?,?)')
              .run(id, Number(amount), type || null, Number(interest), issueDate || null, dueDate || null, status || 'Active', customerId);
            db.prepare('UPDATE accounts SET balance=balance+? WHERE id=?').run(Number(amount), account.id);
        })();
        auditLog(req.user.username, 'APPROVE', 'loan', id, `amt=${amount} cust=${customerId}`);
        const newBalance = db.prepare('SELECT balance FROM accounts WHERE id=?').get(account.id).balance;
        res.status(201).json({ message: `Loan approved. $${amount} credited to account ${account.id}.`, newBalance });
    }
);

// ── Payments ──────────────────────────────────────────────────────────────────
app.get('/api/payments', auth(), (req, res) => {
    const { limit, offset, page } = paginate(req);
    const rows  = db.prepare('SELECT * FROM payments LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as c FROM payments').get().c;
    res.json({ data: rows, total, page, pages: Math.ceil(total / limit) });
});

app.post('/api/payments', auth(),
    body('id').trim().notEmpty().withMessage('id required.'),
    body('loanId').trim().notEmpty().withMessage('loanId required.'),
    body('amount').isFloat({ min: 0.01 }).withMessage('amount must be > 0.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { id, loanId, amount } = req.body;
        const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(loanId);
        if (!loan) return res.status(404).json({ error: `Loan "${loanId}" not found.` });
        const account = db.prepare('SELECT * FROM accounts WHERE customerId=? LIMIT 1').get(loan.customerId);
        if (!account) return res.status(404).json({ error: `No account found for customer "${loan.customerId}".` });
        const amt = Number(amount);
        if (account.balance < amt)
            return res.status(400).json({ error: `Insufficient balance. Current: $${account.balance}.` });
        db.transaction(() => {
            db.prepare('UPDATE accounts SET balance=balance-? WHERE id=?').run(amt, account.id);
            db.prepare('INSERT OR REPLACE INTO payments (id,loanId,amount) VALUES (?,?,?)').run(id, loanId, amt);
        })();
        auditLog(req.user.username, 'PAYMENT', 'payment', id, `loan=${loanId} amt=${amount}`);
        const newBalance = db.prepare('SELECT balance FROM accounts WHERE id=?').get(account.id).balance;
        res.status(201).json({ message: 'Payment recorded. Balance updated.', newBalance });
    }
);

// ── Employees ─────────────────────────────────────────────────────────────────
app.get('/api/employees', auth('admin'), (req, res) => {
    const { limit, offset, page } = paginate(req);
    const rows  = db.prepare('SELECT * FROM employees LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as c FROM employees').get().c;
    res.json({ data: rows, total, page, pages: Math.ceil(total / limit) });
});

app.post('/api/employees', auth('admin'),
    body('id').trim().notEmpty().withMessage('id required.'),
    body('name').trim().isLength({ min: 2 }).withMessage('name min 2 chars.'),
    body('salary').isFloat({ min: 0 }).withMessage('salary must be >= 0.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { id, name, salary } = req.body;
        db.prepare('INSERT OR REPLACE INTO employees (id,name,salary) VALUES (?,?,?)').run(id, name, Number(salary));
        auditLog(req.user.username, 'UPSERT', 'employee', id);
        res.status(201).json({ message: 'Employee saved.' });
    }
);

// ── Branches ──────────────────────────────────────────────────────────────────
app.get('/api/branches', auth(), (req, res) =>
    res.json({ data: db.prepare('SELECT * FROM branches').all() })
);

app.post('/api/branches', auth('admin'),
    body('branchId').trim().notEmpty().withMessage('branchId required.'),
    (req, res) => {
        if (!validate(req, res)) return;
        const { branchId, bankId, bankName, city } = req.body;
        db.prepare('INSERT OR REPLACE INTO branches (branchId,bankId,bankName,city) VALUES (?,?,?,?)')
          .run(branchId, bankId || null, bankName || null, city || null);
        auditLog(req.user.username, 'UPSERT', 'branch', branchId);
        res.status(201).json({ message: 'Branch saved.' });
    }
);

// ── Audit log ─────────────────────────────────────────────────────────────────
app.get('/api/audit', auth('admin'), (req, res) => {
    const { limit, offset, page } = paginate(req);
    const rows  = db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
    res.json({ data: rows, total, page, pages: Math.ceil(total / limit) });
});

// ── Dashboard stats ───────────────────────────────────────────────────────────
app.get('/api/dashboard/stats', auth(), (req, res) => {
    res.json({
        totCustomers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
        totAccounts:  db.prepare('SELECT COUNT(*) as c FROM accounts').get().c,
        totBalance:   db.prepare('SELECT COALESCE(SUM(balance),0) as s FROM accounts').get().s,
        totLoans:     db.prepare("SELECT COUNT(*) as c FROM loans WHERE status='Active'").get().c
    });
});

// ── HTML page routes (must come after /api routes) ────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start server ──────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`  NexBank running at: http://localhost:${PORT}`);
    console.log(`  Default login: admin / admin123`);
    console.log(`==================================================`);
});
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} busy, trying ${PORT + 1}...`);
        server.listen(PORT + 1);
    } else throw err;
});
