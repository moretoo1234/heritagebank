# Heritage Bank - Render Deployment Guide

## ✅ Pre-Deployment Checklist

- [x] `Procfile` created
- [x] `package.json` configured with `start` script
- [x] Server listens on `process.env.PORT`
- [x] All environment variables documented
- [x] Database connection uses TiDB Cloud
- [x] Static files serving configured

## 🚀 Deployment Steps on Render

### 1. **Create Render Account**
   - Go to [Render.com](https://render.com)
   - Sign up and create account

### 2. **Create Web Service**
   - Click "New +" → "Web Service"
   - Connect your GitHub repository (Phillipjr9/heritage-bank)
   - Select branch: `main`

### 3. **Configure Build Settings**
   - **Name:** `heritage-bank-api`
   - **Runtime:** `Node`
   - **Build Command:** `cd backend && npm install`
   - **Start Command:** `cd backend && node server.js`
   - **Region:** Select closest to you

### 4. **Set Environment Variables**

   In Render Dashboard → Environment:

   ```
   DB_HOST=<your-db-host>
   DB_PORT=4000
   DB_USER=<your-db-user>
   DB_PASSWORD=<your-db-password>
   DB_NAME=<your-db-name>
   JWT_SECRET=<long-random-secret>
   ADMIN_EMAIL=admin@heritagebank.com
   ADMIN_PASSWORD=<strong-admin-password>
   ROUTING_NUMBER=091238946
   PORT=3001
   NODE_ENV=production
   ```

   ⚠️ **IMPORTANT:** Use strong, unique values in production!

### 5. **Deploy**
   - Click "Create Web Service"
   - Render will automatically deploy on `git push`
   - Watch build logs in Render Dashboard

### 6. **Verify Deployment**

   Once deployed, test health endpoint:
   ```bash
   curl https://your-app-name.onrender.com/api/health
   ```

   Response should be:
   ```json
   {
     "status": "✅ Heritage Bank API is running!",
     "database": "✅ Connected to TiDB Cloud",
     "timestamp": "2024-12-22T10:30:00Z"
   }
   ```

## 📋 File Structure for Render

```
heritage-bank/
├── Procfile                    ← Tells Render how to start
├── package.json                ← Root (for frontend)
├── backend/
│   ├── package.json            ← Backend dependencies
│   ├── server.js               ← Main API server
│   ├── .env                    ← Local development
│   └── migrate-profile.js      ← Database setup
├── frontend files (*.html, *.js, *.css)
└── .git/                       ← Git repository
```

## 🔗 API Endpoints on Render

Once deployed, your API will be available at:
```
https://your-app-name.onrender.com/api/
```

Examples:
- Health Check: `https://your-app-name.onrender.com/api/health`
- Login: `POST https://your-app-name.onrender.com/api/auth/login`
- Profile: `GET https://your-app-name.onrender.com/api/user/profile`
- Transactions: `GET https://your-app-name.onrender.com/api/transactions`

## 🌐 Frontend Configuration

Update these URLs in frontend JavaScript files to use your Render API:

**From:**
```javascript
const API_URL = 'http://localhost:3001';
```

**To:**
```javascript
const API_URL = 'https://your-app-name.onrender.com';
```

Or use a smart detection:
```javascript
const API_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:3001' 
  : 'https://your-app-name.onrender.com';
```

## 📊 Database Connection

TiDB Cloud connection details are in `.env`:
- **Host:** <your-db-host>
- **Port:** 4000
- **Database:** <your-db-name>
- **User:** <your-db-user>

Server automatically creates tables on first run if they don't exist.

⚠️ Never commit real credentials to the repository. Use Render environment variables for production.

## 🐛 Troubleshooting

### Build Fails
- Check Render build logs
- Verify Node version compatibility
- Ensure all dependencies in `backend/package.json`

### Database Connection Failed
- Verify `.env` variables are correct
- Check TiDB Cloud IP whitelist (add Render IPs)
- Test connection locally first

### Static Files Not Serving
- Check `app.use(express.static())` in server.js
- Ensure HTML files exist in root directory

### API Returning 404
- Verify routes in server.js
- Check endpoint paths match frontend requests
- Test with `curl https://your-app-name.onrender.com/api/health`

## 🔐 Security Notes

⚠️ **For Production:**
1. Change `JWT_SECRET` to a strong random value
2. Change admin credentials
3. Use TiDB Cloud firewall rules
4. Enable HTTPS (Render does automatically)
5. Set `NODE_ENV=production`
6. Never commit real credentials to git

## 📈 Monitoring

In Render Dashboard:
- View real-time logs
- Monitor CPU/Memory usage
- Set up email alerts for crashes
- View deployment history

## 🔄 Auto-Deploy Setup

Render automatically deploys when you:
1. Push to `main` branch
2. Or manually trigger deploy in Render Dashboard

To disable auto-deploy:
- Go to Settings → Auto-Deploy → Toggle Off

## 💾 Database Backups

For TiDB Cloud:
1. Go to TiDB Cloud Dashboard
2. Select your cluster
3. Configure automated backups
4. Test restore procedures regularly

## 🎯 Next Steps

1. ✅ Create Procfile
2. ✅ Set environment variables
3. ✅ Push to GitHub
4. ✅ Create Web Service on Render
5. ✅ Test health endpoint
6. ✅ Test login/signup
7. ✅ Monitor logs
8. ✅ Set up alerts

## 📞 Support

**Render Documentation:** https://render.com/docs
**TiDB Cloud Docs:** https://docs.pingcap.com/tidbcloud
**Express.js Guide:** https://expressjs.com

---

**Last Updated:** December 22, 2024
**Status:** Ready for Production Deployment
