# Render Setup: Firebase/Firestore Backend

Your Heritage Bank is now running on **Firestore** (Firebase) instead of TiDB, but still deployed on **Render**.

## ✅ What's Ready
- ✅ New Firestore backend code (`backend/server-firestore.js`)
- ✅ Data migrated: 17 users + 41 transactions in Firestore
- ✅ Frontend API helper updated to use Render endpoint
- ✅ Package.json configured to use new server

## 🔧 Next: Add Credentials to Render

Your Render service is at: **https://heritagebank-ku1y.onrender.com**

### Step 1: Read Your Firebase Credentials

The file `functions/serviceAccountKey.json` contains your Firebase credentials. You need to add it as an **environment variable** in Render (don't commit to git!).

### Step 2: Get the Credentials as a String

Run this command to print your credentials as a single-line JSON string:

```bash
# Windows PowerShell
Get-Content functions/serviceAccountKey.json | ConvertTo-Json -Compress

# Or use Node.js
node -e "console.log(JSON.stringify(require('./functions/serviceAccountKey.json')))"
```

Copy the entire output (it should start with `{` and end with `}`).

### Step 3: Add to Render Dashboard

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Find your **heritage-bank** web service
3. Click **Settings** → **Environment**
4. Add a new environment variable:
   - **Name**: `FIREBASE_SERVICE_ACCOUNT`
   - **Value**: Paste the JSON string from Step 2 (the long `{...}` block)
   - Click **Save**

### Step 4: Redeploy

After saving the environment variable:

1. Go back to **Deployments**
2. Click the three dots (⋯) on the latest deployment
3. Select **Redeploy**
4. Wait for deployment to complete (~2 minutes)

Or, just push your code to GitHub and Render will auto-deploy:

```bash
git add -A
git commit -m "feat: migrate backend to Firestore"
git push origin main
```

## ✅ Verify Deployment

Test your API:

```bash
# Health check
curl https://heritagebank-ku1y.onrender.com/api/health

# Should return:
# {
#   "success": true,
#   "message": "API is healthy",
#   "database": "Firestore"
# }
```

## 🚀 What Happens Next

Once deployed:

1. **Users can sign up** → Creates account in Firestore
2. **Users can log in** → Retrieves data from Firestore
3. **Transfers work** → Updates balances in Firestore
4. **Admin panel works** → Sees all users and transactions in Firestore

All requests go: **Frontend** → **Render backend** → **Firestore**

## ❓ FAQ

**Q: Do I need to commit serviceAccountKey.json?**
A: No! Never commit it. It's in `.gitignore`. Use the environment variable instead.

**Q: Can I still use TiDB?**
A: No, the new backend only uses Firestore. The old TiDB server.js still exists if needed, but the start script now uses server-firestore.js.

**Q: What if I want to switch back?**
A: Change `package.json` `"start"` back to `"node server.js"` and redeploy.

**Q: Is Firestore free?**
A: Yes! Spark plan (free) includes 1GB storage + 50K reads/month. Perfect for testing.

---

**Status**: Ready to deploy! Follow the steps above. 🚀
