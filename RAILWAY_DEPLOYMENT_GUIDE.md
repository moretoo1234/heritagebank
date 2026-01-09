# Railway Deployment Guide (Heritage Bank)

This project runs an Express backend (and serves the static frontend) from **`backend/server.js`**.

> ✅ This backend requires a **MySQL-compatible** database (MySQL / TiDB / PlanetScale).  
> ❌ Railway **PostgreSQL** will not work with `mysql2`.

## 1) Create the Railway services

1. Create a new Railway project.
2. Add a **MySQL** database (Railway Plugin → MySQL).
3. Deploy this repo as a **Node.js** service.

## 2) Configure the Start Command

Railway usually detects `package.json` and runs `npm start`.

This repo’s root `package.json` uses:
- `start: node backend/server.js`

So you typically **do not need** a custom start command.

## 3) Environment variables you must set

### Required

- `NODE_ENV=production`
- `JWT_SECRET=<strong random secret>`

Database (choose **one** style):

#### Option A (recommended on Railway): use Railway MySQL plugin variables
Railway’s MySQL plugin provides these automatically when linked to your service:
- `MYSQLHOST`
- `MYSQLPORT`
- `MYSQLUSER`
- `MYSQLPASSWORD`
- `MYSQLDATABASE`

✅ The code supports these automatically.

#### Option B: use DB_* variables (if you use TiDB Cloud or an external MySQL)
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

#### Option C: use a single connection string (TiDB/MySQL) via DB_URL / DATABASE_URL
You can set either:
- `DB_URL=mysql://user:pass@host:port/dbname?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D`
or
- `DATABASE_URL=...`

Notes:
- If your provider gives `?ssl={"rejectUnauthorized":true}`, it may need URL-encoding.
- TLS can also be controlled with:
  - `DB_SSL_REJECT_UNAUTHORIZED=true|false`
  - `DB_SSL_CA` (PEM string)
  - `DB_SSL_CA_B64` (base64 PEM; easiest for Railway)

### Optional (but recommended)

- `ADMIN_EMAIL=admin@heritagebank.com`
- `ADMIN_PASSWORD=<set only if you want auto-create admin on first boot>`

Password reset emails (only needed if you want forgot-password to send real emails):
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `SMTP_SECURE=true|false`
- `APP_BASE_URL=https://<your-railway-domain>`

Branding:
- `ROUTING_NUMBER=091238946`

## 4) Port / host binding

Railway sets `PORT` automatically.

The server listens on `0.0.0.0` and uses `process.env.PORT`, so it’s compatible with Railway.

## 5) Common “variables wrong” symptoms

- **DB connection errors** (`ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, `Unknown database`):
  - Ensure you deployed a **MySQL** plugin, not Postgres.
  - Ensure your service is **linked** to the MySQL plugin so it receives `MYSQL*` vars.

- **JWT_SECRET required**:
  - Set `JWT_SECRET` in Railway Variables.

- **Forgot password says email not configured**:
  - Set SMTP variables (or ignore if you don’t need email in production).

## 6) Safety note

Do **not** commit real credentials into `.env` files. Railway Variables are the correct place for production secrets.
