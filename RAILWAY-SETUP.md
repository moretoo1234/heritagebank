# 🚀 Railway Deployment Guide - One-Click Setup

Your Heritage Bank is **ready to deploy to Railway** with all code and configuration included!

## ⚡ Quick Start (5 minutes)

### Step 1: Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Click **Sign up** → **Continue with GitHub**
3. Authorize with your GitHub account (`Phillipjr9`)
4. Done!

### Step 2: Deploy from GitHub
1. In Railway dashboard, click **+ New Project**
2. Select **Deploy from GitHub repo**
3. Select your repo: `Phillipjr9/heritage-bank`
4. Railway auto-detects Node.js backend
5. Click **Deploy**

> Railway will automatically:
> - Install dependencies
> - Start `backend/server-firestore.js`
> - Give you a live URL (like `https://heritage-bank-prod.up.railway.app`)

### Step 3: Add Firebase Credentials
After deployment starts:

1. In Railway dashboard, go to your **heritage-bank** project
2. Click **Variables**
3. Add new variable:
   ```
   Name: FIREBASE_SERVICE_ACCOUNT
   Value: [SEE BELOW]
   ```

#### How to Get Your Firebase Credentials:

**On your computer, run:**
```bash
node -e "console.log(JSON.stringify(require('./functions/serviceAccountKey.json')))"
```

Copy the entire output (starts with `{`, ends with `}`), paste it as the value.

### Step 4: Deploy the Update
1. Click the **Redeploy** button (or wait for auto-deploy)
2. Check the logs to verify: `🚀 Heritage Bank API running on port...`
3. Test the health check:
   ```bash
   curl https://[YOUR-RAILWAY-URL]/api/health
   ```

## ✅ What You Get

| Feature | Status |
|---------|--------|
| Users (17 migrated) | ✅ Working |
| Transactions (41 migrated) | ✅ Working |
| Transfers | ✅ Working |
| Admin Panel | ✅ Working |
| Authentication | ✅ JWT Tokens |
| Database | ✅ Firestore |

## 📝 How It Works

```
Frontend (HTML) 
    ↓
firebase-api-helper.js (with Railway URL)
    ↓
Railway Backend (server-firestore.js)
    ↓
Firestore (Database)
```

## 🔄 Auto-Deployments

After initial setup:
- **Every push to GitHub** → Railway auto-deploys
- **Within 2-5 minutes** → Your changes are live
- **No manual steps needed**

Just commit and push:
```bash
git add -A
git commit -m "feat: update your feature"
git push origin main
```

## 🆘 Troubleshooting

### "Port already in use"
Railway assigns a port automatically via `process.env.PORT`. Already handled in code.

### "Firebase credentials error"
- Check the `FIREBASE_SERVICE_ACCOUNT` variable is the full JSON string
- Make sure no extra quotes or spaces
- Look at deployment logs (Railway shows errors clearly)

### "API returns 404"
- Verify your Railway URL in `firebase-api-helper.js`
- Update: `const API_BASE_URL = 'https://[YOUR-RAILWAY-URL]/api'`
- Or keep it dynamic from frontend config

## 📊 Your Environment Variables

Railway will use these from `backend/.env` if set:
```
JWT_SECRET=heritage-bank-secret-2024
ADMIN_EMAIL=admin@heritagebank.com
NODE_ENV=production
```

All others are optional (have defaults).

## 🎯 Next Steps After Deployment

### Update Frontend URL (Optional)
If you want to hardcode the Railway URL in frontend:

Edit `firebase-api-helper.js`:
```javascript
// Change this:
const API_BASE_URL = 'https://heritagebank-ku1y.onrender.com/api';

// To:
const API_BASE_URL = 'https://[YOUR-RAILWAY-URL]/api';
```

Then commit and push.

### Monitor Logs
In Railway dashboard:
- Click **heritage-bank** project
- Tab: **Logs**
- See real-time API activity

### Check Firestore Data
In [Firebase Console](https://console.firebase.google.com):
- Project: `btc-a87b4d93`
- Collections: users, transactions
- Verify data is syncing

## 💰 Pricing

Railway free tier:
- ✅ **$5 free credit** (automatic, no card)
- ✅ Usually lasts **2-3 months** for hobby projects
- ✅ Then pay as you go (very cheap)

---

## 🚀 Ready?

1. Go to [railway.app](https://railway.app) → Sign up with GitHub
2. Deploy the repo
3. Add `FIREBASE_SERVICE_ACCOUNT` variable
4. Test the health check
5. Your bank is live! 🎉

**Questions?** Check logs in Railway dashboard (most helpful for debugging).

---

**Created**: June 7, 2026  
**Status**: Ready to deploy ✅
