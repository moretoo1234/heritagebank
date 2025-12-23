# 🚀 Heritage Bank - Server Startup Guide

## ✅ Quick Start (Recommended)

### Option 1: PowerShell Script (Best for Windows)
```powershell
# Run in PowerShell in the Heritage AY directory
.\start-servers.ps1
```

This will:
- ✅ Kill any existing Node processes
- ✅ Start Backend API on port 3001
- ✅ Start Frontend on port 8000
- ✅ Display all URLs automatically

### Option 2: Manual Startup

**Terminal 1 - Backend Server:**
```bash
cd backend
node server.js
```
Expected output:
```
🏦 Heritage Bank running on port 3001
📱 Frontend: http://localhost:3001
🔌 API: http://localhost:3001/api
✅ Database initialized with all tables
```

**Terminal 2 - Frontend Server:**
```bash
npx http-server -p 8000 --cache=-1
```
Expected output:
```
Starting up http-server, serving .

Hit CTRL-C to stop the server
http-server version: x.x.x

http://localhost:8000
```

---

## 📋 CORS Configuration

**Status:** ✅ ENABLED

The backend (`http://localhost:3001`) is configured to accept requests from the frontend (`http://localhost:8000`) using CORS headers:

```javascript
// In backend/server.js
app.use(cors());  // Enables CORS for all routes
```

---

## 🔍 Verify Everything is Working

### Test Backend Health
```bash
curl http://localhost:3001/api/health
```

Expected response:
```json
{
  "status": "✅ Heritage Bank API is running!",
  "database": "✅ Connected to TiDB Cloud",
  "timestamp": "2024-12-22T..."
}
```

### Test Frontend Access
Open in browser:
```
http://localhost:8000
```

---

## 🚨 If You Get CORS Error

### Error: "Cross-Origin Request Blocked"

**Cause:** Frontend (port 8000) cannot reach Backend (port 3001)

**Solutions (in order):**

1. **Verify Backend is Running**
   ```bash
   # In PowerShell
   (Invoke-WebRequest -Uri "http://localhost:3001/api/health" -UseBasicParsing).Content
   ```
   
   If error, the backend isn't running:
   ```bash
   cd backend
   node server.js
   ```

2. **Verify Frontend is Running**
   ```bash
   npx http-server -p 8000 --cache=-1
   ```

3. **Check Port Conflicts**
   ```bash
   # See what's using ports
   netstat -ano | findstr ":3001"
   netstat -ano | findstr ":8000"
   ```
   
   Kill conflicting processes:
   ```bash
   taskkill /F /IM node.exe
   taskkill /F /IM http-server.exe
   ```

4. **Clear Browser Cache**
   - Press `Ctrl+Shift+Delete`
   - Clear all cache
   - Try again

---

## 📂 Project Structure

```
Heritage Bank/
├── backend/
│   ├── server.js          ← Main API server (port 3001)
│   ├── package.json       ← Dependencies
│   └── .env               ← Database credentials
├── frontend files (HTML, JS, CSS)
└── start-servers.ps1      ← Startup script
```

---

## 🔗 Important URLs

| Service | URL | Purpose |
|---------|-----|---------|
| Backend API | `http://localhost:3001` | REST API server |
| Frontend | `http://localhost:8000` | Web interface |
| Health Check | `http://localhost:3001/api/health` | API status |
| Login | `http://localhost:8000/signin.html` | User login |
| Register | `http://localhost:8000/open-account.html` | New account |
| Dashboard | `http://localhost:8000/dashboard.html` | User dashboard |
| Settings | `http://localhost:8000/settings.html` | Profile settings |
| Admin Panel | `http://localhost:8000/admin.html` | Admin controls |

---

## 💻 Admin Credentials

Set these via environment variables (local: `backend/.env`, production: Render dashboard):

```
ADMIN_EMAIL=admin@heritagebank.com
ADMIN_PASSWORD=<strong-admin-password>
```

---

## 🗄️ Database

- **Type:** TiDB Cloud (MySQL-compatible)
- **Host:** <your-db-host>:4000
- **Database:** <your-db-name>
- **Status:** Configured via environment variables (never commit credentials)

---

## ✨ Features Available

- ✅ User Registration & Login
- ✅ Complete Profile Management (50+ features)
- ✅ Money Transfer & Transactions
- ✅ Bill Pay
- ✅ Beneficiary Management
- ✅ Account Security (2FA, Login History)
- ✅ Document Upload & Verification
- ✅ Admin Dashboard
- ✅ Loan Management
- ✅ Investment Services
- ✅ Card Management

---

## 📊 Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 3001 in use | `taskkill /F /IM node.exe` then restart |
| Port 8000 in use | `taskkill /F /IM http-server.exe` then restart |
| Database connection error | Check .env credentials in backend/ |
| API returns 404 | Verify endpoint path matches server.js routes |
| Frontend blank | Open DevTools (F12) and check Console for errors |
| CORS error persists | Both servers must be running (3001 & 8000) |

---

## 🚀 Ready to Deploy on Render?

See: `RENDER_DEPLOYMENT_GUIDE.md`

---

**Last Updated:** December 22, 2024  
**Status:** ✅ Ready for use
