# Heritage Bank

A modern digital banking application.

## Deploy to Render.com

### Step 1: Create Web Service
1. Go to [render.com](https://render.com) and sign up/login
2. Click **New +** → **Web Service**
3. Connect your GitHub account
4. Select repository: `Phillipjr9/heritage-bank`

### Step 2: Configure Service
- **Name**: `heritage-bank` (or any name)
- **Region**: Choose closest to you
- **Branch**: `main`
- **Root Directory**: *(leave empty)*
- **Runtime**: `Node`
- **Build Command**: `cd backend && npm install`
- **Start Command**: `node backend/server.js`

### Step 3: Add Environment Variables
Click **Advanced** → **Add Environment Variable** for each:

| Key | Value |
|-----|-------|
| `DB_HOST` | `<your-db-host>` |
| `DB_PORT` | `4000` |
| `DB_USER` | `<your-db-user>` |
| `DB_PASSWORD` | `<your-db-password>` |
| `DB_NAME` | `<your-db-name>` |
| `JWT_SECRET` | `<long-random-secret>` |
| `ADMIN_EMAIL` | `admin@heritagebank.com` |
| `ADMIN_PASSWORD` | `<strong-admin-password>` |

### Step 4: Deploy
Click **Create Web Service**

Your app will be live at: `https://<your-service>.onrender.com`

---

## Features
- User registration and authentication
- Account management with unique account numbers
- Fund transfers (via email or account number)
- Bill payments
- Admin panel for user management

## Admin Access
- **Email**: admin@heritagebank.com
- **Password**: Set via `ADMIN_PASSWORD` in your Render environment variables (do not hardcode in the repo).
