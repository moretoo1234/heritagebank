# Heritage Bank - Project Structure

## Root Directory Layout
```
HERITAGE AY/
├── backend/              # Node.js Express API (primary server)
│   ├── server.js         # Main production entrypoint
│   ├── server-old.js     # Legacy/reference server (not deployed)
│   ├── server-firestore.js # Experimental Firestore variant
│   ├── db.js             # TiDB/MySQL database module
│   ├── firebase-routes.js # Firebase auth route handlers
│   ├── package.json      # Backend dependencies
│   ├── .env              # Local env vars (gitignored)
│   └── .env.example      # Env var template
│
├── public/               # Frontend static files (served by backend)
│   ├── *.html            # Multi-page app (one HTML per feature)
│   ├── script.js         # Shared frontend logic
│   ├── styles.css        # Global styles
│   ├── dashboard.css     # Dashboard-specific styles
│   ├── app-layout.css    # Sidebar/layout styles
│   ├── app-sidebar.js    # Sidebar component logic
│   ├── sw.js             # Service worker (PWA)
│   ├── manifest.json     # PWA manifest
│   ├── settings-enhanced.js  # Settings page logic
│   ├── signup-enhanced.js    # Signup page logic
│   ├── firebase-config.js    # Firebase SDK config (frontend)
│   └── assets/           # Images, logos (bank + biller)
│
├── assets/               # Root-level asset mirror (legacy/dev use)
├── backup-design/        # Archived previous frontend design
├── amplify-gen2/         # AWS Amplify Gen2 config (unused/experimental)
├── amplify.old/          # Old Amplify backend config
│
├── *.html                # Root-level HTML (legacy, mirrors public/)
├── script.js             # Root-level JS (legacy compatibility)
├── styles.css            # Root-level CSS (legacy)
├── firebase-api-helper.js   # Firebase REST API helper (frontend)
├── firebase-auth.js         # Firebase auth helper
├── firebase-config.js       # Firebase SDK config
│
├── server.js             # Root server stub (legacy, not for production)
├── package.json          # Root package (orchestrates backend install)
│
├── firebase.json         # Firebase hosting config
├── firestore.rules       # Firestore security rules
├── firestore.indexes.json
├── railway.toml          # Railway deploy config
├── netlify.toml          # Netlify deploy config
├── vercel.json           # Vercel deploy config
├── amplify.yml           # AWS Amplify build spec
└── README.md             # Deployment guide
```

## Core Architecture

### Backend (MPA + REST API)
- Express.js serves both the static frontend (`public/`) and REST API under `/api/*`
- All API routes are in `backend/server.js` (monolithic, no router splitting)
- Database operations are isolated in `backend/db.js` (module pattern)
- JWT middleware (`authenticateToken`) guards all private routes
- Admin routes additionally use `requireAdmin` middleware

### Frontend (Multi-Page Application)
- Each feature is a standalone `.html` page; no SPA framework
- Pages use `fetch()` against the same-origin `/api/*` endpoints
- Auth token stored in `localStorage` as `token`
- Shared UI components: `app-sidebar.js` (navigation), `cookie-consent.js`
- PWA: `sw.js` provides basic caching; `manifest.json` enables install prompt

### Database (TiDB / MySQL)
- Two tables: `users`, `transactions`
- Connection via `mysql2/promise` connection pool (singleton in `db.js`)
- Schema auto-initialized on first boot if tables don't exist
- Supports both `password` and `passwordHash` column naming (dynamic detection)

## Key Relationships
- `backend/server.js` → requires `backend/db.js` for all data access
- `backend/server.js` → serves `public/` as static files
- `public/*.html` → calls `/api/*` endpoints defined in `backend/server.js`
- `firebase-routes.js` → optional Firebase auth route addon (loaded conditionally)
