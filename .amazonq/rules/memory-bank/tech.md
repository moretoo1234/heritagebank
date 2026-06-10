# Heritage Bank - Technology Stack

## Languages
- **JavaScript (Node.js)** — backend server, DB module, all API logic
- **JavaScript (Vanilla ES6+)** — frontend pages, no framework
- **HTML5 / CSS3** — multi-page frontend UI
- **SQL (MySQL dialect)** — schema DDL and queries via mysql2

## Backend Runtime & Framework
| Package | Version | Purpose |
|---|---|---|
| Node.js | ≥18 (implied by Render) | Runtime |
| express | ^4.18.2 | HTTP server & routing |
| mysql2 | ^3.6.5 | MySQL/TiDB async driver |
| jsonwebtoken | ^9.0.2 | JWT creation & verification |
| bcryptjs | ^2.4.3 | Password hashing |
| helmet | ^8.1.0 | HTTP security headers |
| cors | ^2.8.5 | Cross-origin resource sharing |
| express-rate-limit | ^8.2.1 | API rate limiting |
| dotenv | ^16.3.1 | Environment variable loading |
| body-parser | ^1.20.2 | JSON/URL-encoded body parsing |

## Database
- **TiDB** (MySQL-compatible, primary production target)
- **Railway MySQL** (alternate, via `MYSQLHOST`/`MYSQLPORT` env vars)
- Connection pool: `mysql2/promise`, limit 10 connections
- SSL: enabled by default; disable via `DB_SSL=false`

## Frontend Dependencies
- No npm packages — pure vanilla HTML/CSS/JS
- **Firebase JS SDK** (loaded via CDN in some pages for optional auth)
- **Service Worker API** for PWA caching

## Environment Variables
| Variable | Description |
|---|---|
| `DB_HOST` / `MYSQLHOST` | Database host |
| `DB_PORT` / `MYSQLPORT` | Database port (default 4000 for TiDB) |
| `DB_USER` / `MYSQLUSER` | Database user |
| `DB_PASSWORD` / `MYSQLPASSWORD` | Database password |
| `DB_NAME` / `MYSQLDATABASE` | Database name |
| `DB_SSL` | Set to `false` to disable SSL |
| `JWT_SECRET` | Secret for signing JWTs |
| `ADMIN_EMAIL` | Seed admin account email |
| `ADMIN_PASSWORD` | Seed admin account password |
| `PORT` | HTTP listen port (default 3000) |
| `NODE_ENV` | `development` or `production` |

## Build & Deployment
| Platform | Config File | Command |
|---|---|---|
| Render.com | README / dashboard | Build: `cd backend && npm install` · Start: `node backend/server.js` |
| Railway | `railway.toml` | `npm run start` → `node backend/server.js` |
| Netlify | `netlify.toml` | Static hosting only (no backend) |
| Vercel | `vercel.json` | Serverless (limited backend support) |
| Firebase | `firebase.json` | Hosting only |

## Development Commands
```bash
# Install backend dependencies
cd backend && npm install

# Run backend server (from project root)
node backend/server.js

# Run backend server (from backend/)
cd backend && npm start
```

## CI/CD
- GitHub Actions: `.github/workflows/node.js.yml` (Node.js CI)
- Mirror workflow: `.github/workflows/mirror-to-moretoo.yml`
