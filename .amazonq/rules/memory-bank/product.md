# Heritage Bank - Product Overview

## Purpose
Heritage Bank is a full-stack digital banking web application that provides users with a modern, online banking experience. It simulates core retail banking features via a self-hosted Node.js/MySQL backend and a static HTML/JS/CSS frontend.

## Key Features
- **User Authentication**: Registration, login, JWT-based session management, password reset
- **Account Management**: Unique account numbers, routing numbers, SWIFT codes per user
- **Fund Transfers**: Transfer money via email or account number to other users
- **Bill Payments**: Pay billers from a curated catalog (utilities, insurance, telecom, etc.)
- **Transaction History**: View recent and full transaction ledger with type/description
- **Dashboard**: Real-time balance, masked account number, recent transactions summary
- **Settings/Profile**: Full profile editing including phone, address, city, state, zip
- **Admin Panel**: User management, balance editing, activity logs, dashboard stats
- **PWA Support**: Service worker (`sw.js`), `manifest.json` for installability
- **Multi-bank External Logos**: Visual bank/biller logo catalog for UI enrichment

## Target Users
- **End users**: Individuals managing a digital checking account
- **Admins**: Bank staff accessing the admin panel to manage users, view logs, adjust balances

## Value Proposition
Provides a complete, deployable digital banking simulation with a production-ready Express API, MySQL schema, JWT auth, and a rich multi-page frontend — suitable for demos, portfolios, or as a foundation for a real banking product.

## Deployment Targets
- **Primary**: Render.com (Web Service, `node backend/server.js`)
- **Alternatives**: Railway (`railway.toml`), Netlify (`netlify.toml`), Vercel (`vercel.json`), Firebase Hosting (`firebase.json`)
- **Database**: TiDB (MySQL-compatible), supports Railway MySQL via `MYSQLHOST`/`MYSQLPORT` env vars
