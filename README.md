# NexBank Management System

A full-stack banking management web app built with **Express.js**, **SQLite (better-sqlite3)**, **JWT authentication**, and a vanilla JS frontend.

---

## Prerequisites
- Node.js v14+

## Quick Start
```bash
npm install
npm start
# Open http://localhost:3000
# Default login: admin / admin123
```

---

## ER Diagram

```
┌──────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   users      │       │   customers      │       │   accounts       │
│──────────────│       │──────────────────│       │──────────────────│
│ id (PK)      │       │ id (PK)          │1─────<│ id (PK)          │
│ username     │       │ name             │       │ type             │
│ password     │       │ dob              │       │ balance          │
│ role         │       │ phone            │       │ customerId (FK)  │
└──────────────┘       │ address          │       └────────┬─────────┘
                       └──────────────────┘                │
                                                           │1
                                              ┌────────────▼─────────┐
                                              │   transactions       │
                                              │──────────────────────│
                                              │ id (PK)              │
                                              │ date                 │
                                              │ amount               │
                                              │ mode                 │
                                              │ accountId (FK)       │
                                              └──────────────────────┘

┌──────────────────┐       ┌──────────────────┐
│   loans          │       │   payments       │
│──────────────────│       │──────────────────│
│ id (PK)          │1─────<│ id (PK)          │
│ amount           │       │ loanId (FK)      │
│ type             │       │ amount           │
│ interest         │       └──────────────────┘
│ issueDate        │
│ dueDate          │
│ status           │
│ customerId (FK)  │
└──────────────────┘

┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   employees      │       │   branches       │       │   audit_log      │
│──────────────────│       │──────────────────│       │──────────────────│
│ id (PK)          │       │ branchId (PK)    │       │ id (PK)          │
│ name             │       │ bankId           │       │ ts               │
│ salary           │       │ bankName         │       │ actor            │
└──────────────────┘       │ city             │       │ action           │
                           └──────────────────┘       │ entity           │
                                                       │ entityId         │
                                                       │ detail           │
                                                       └──────────────────┘
```

---

## API Reference

All protected routes require: `Authorization: Bearer <token>`

### Auth
| Method | Endpoint              | Body                          | Auth | Description          |
|--------|-----------------------|-------------------------------|------|----------------------|
| POST   | /api/auth/login       | `{username, password}`        | No   | Returns JWT token    |
| POST   | /api/auth/register    | `{username, password, role}`  | No   | Register new user    |

### Customers
| Method | Endpoint         | Auth  | Description                  |
|--------|------------------|-------|------------------------------|
| GET    | /api/customers   | Any   | List customers (paginated)   |
| POST   | /api/customers   | Admin | Create/update customer       |

### Accounts
| Method | Endpoint       | Auth  | Description                  |
|--------|----------------|-------|------------------------------|
| GET    | /api/accounts  | Any   | List accounts (paginated)    |
| POST   | /api/accounts  | Admin | Create account               |

### Transactions
| Method | Endpoint            | Auth  | Description                                        |
|--------|---------------------|-------|----------------------------------------------------|
| GET    | /api/transactions   | Any   | List transactions (paginated, newest first)        |
| POST   | /api/transactions   | Any   | Process Deposit/Withdrawal/Transfer — auto-updates account balance atomically |

**Body:** `{ id, date, amount, mode: "Deposit"|"Withdrawal"|"Transfer", accountId }`

### Loans
| Method | Endpoint    | Auth  | Description                                      |
|--------|-------------|-------|--------------------------------------------------|
| GET    | /api/loans  | Any   | List loans (paginated)                           |
| POST   | /api/loans  | Admin | Approve loan — auto-credits customer account     |

**Body:** `{ id, amount, type, interest, issueDate, dueDate, status, customerId }`

### Payments
| Method | Endpoint       | Auth  | Description                                      |
|--------|----------------|-------|--------------------------------------------------|
| GET    | /api/payments  | Any   | List payments (paginated)                        |
| POST   | /api/payments  | Any   | Record payment — auto-deducts from account       |

**Body:** `{ id, loanId, amount }`

### Employees
| Method | Endpoint        | Auth  | Description           |
|--------|-----------------|-------|-----------------------|
| GET    | /api/employees  | Admin | List employees        |
| POST   | /api/employees  | Admin | Add/update employee   |

### Branches
| Method | Endpoint       | Auth  | Description     |
|--------|----------------|-------|-----------------|
| GET    | /api/branches  | Any   | List branches   |
| POST   | /api/branches  | Admin | Add/update branch |

### Audit Log
| Method | Endpoint    | Auth  | Description                        |
|--------|-------------|-------|------------------------------------|
| GET    | /api/audit  | Admin | Paginated audit log (newest first) |

### Dashboard
| Method | Endpoint               | Auth | Description              |
|--------|------------------------|------|--------------------------|
| GET    | /api/dashboard/stats   | Any  | Totals for dashboard     |

### Pagination
All list endpoints support `?page=1&limit=20` query params.
Response shape: `{ data: [...], total, page, pages }`

---

## Security Features

| Feature | Implementation |
|---------|---------------|
| Password hashing | bcryptjs (salt rounds: 10) |
| Authentication | JWT (8h expiry, HS256) |
| Role separation | `admin` — full access; `customer` — read + own transactions |
| SQL injection prevention | All queries use parameterized statements (`?` placeholders) |
| Input validation | express-validator on every POST route |
| Atomic transfers | `better-sqlite3` transactions — balance read + update in single exclusive write, preventing double-spend |
| Audit trail | Every mutating action logged to `audit_log` with actor, timestamp, entity, and detail |

---

## Database Indexes

```sql
idx_accounts_customer  ON accounts(customerId)
idx_transactions_acct  ON transactions(accountId)
idx_transactions_date  ON transactions(date)
idx_loans_customer     ON loans(customerId)
idx_loans_status       ON loans(status)
idx_payments_loan      ON payments(loanId)
idx_audit_ts           ON audit_log(ts)
idx_audit_actor        ON audit_log(actor)
```

---

## Environment Variables

| Variable    | Default                              | Description        |
|-------------|--------------------------------------|--------------------|
| PORT        | 3000                                 | Server port        |
| JWT_SECRET  | nexbank-secret-key-change-in-production | JWT signing key |

Set in production:
```bash
JWT_SECRET=your-strong-random-secret node server.js
```
