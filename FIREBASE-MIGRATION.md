# Firebase Migration Guide - Heritage Bank

## Overview
This guide will help you migrate your Heritage Bank application from:
- **Old**: MySQL database on Render backend + Express
- **New**: Firebase Firestore + Cloud Functions

## ✅ Prerequisites

1. **Firebase Project**: Create one at [console.firebase.google.com](https://console.firebase.google.com)
2. **Firebase CLI**: Install with `npm install -g firebase-tools`
3. **Google Cloud Account**: With billing enabled (Cloud Functions require it)
4. **Node.js 20+**: Required for Cloud Functions
5. **MySQL Access**: Needed for data migration (can be local or remote)

## 🚀 Step 1: Set Up Firebase Project

### 1.1 Create Firebase Project
```bash
# Login to Firebase
firebase login

# Initialize Firebase in your project
firebase init

# Select:
# - Firestore
# - Cloud Functions  
# - Hosting
# - Storage (optional)
```

### 1.2 Get Firebase Credentials

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Settings → Service Accounts → Node.js
4. Click "Generate new private key"
5. Save as `functions/serviceAccountKey.json` (DO NOT COMMIT THIS FILE!)

### 1.3 Update .gitignore
```bash
# Add to .gitignore
functions/serviceAccountKey.json
.env
backend/.env
```

## 🔄 Step 2: Prepare for Migration

### 2.1 Enable Required Services
In Firebase Console → APIs & Services, enable:
- Firestore API
- Cloud Functions API
- Firebase Authentication API
- Identity Toolkit API

### 2.2 Create Firebase Authentication
In Firebase Console → Authentication:
1. Click "Get Started"
2. Enable "Email/Password" provider
3. Enable "Google" (optional, for social login)

### 2.3 Set Up Environment Variables

Create or update `backend/.env`:
```env
# MySQL Connection (for migration)
DB_HOST=your-mysql-host.com
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=heritage_bank

# Firebase
GOOGLE_APPLICATION_CREDENTIALS=functions/serviceAccountKey.json

# JWT Secret (for Firebase custom tokens)
JWT_SECRET=your-long-random-secret-here

# Other config
ADMIN_EMAIL=admin@heritagebank.com
SUPPORT_EMAIL=support@heritagebank.com
```

### 2.4 Install Dependencies

```bash
# Install root dependencies
npm install

# Install backend dependencies  
cd backend && npm install && cd ..

# Install functions dependencies
cd functions && npm install && cd ..
```

## 📤 Step 3: Migrate Data from MySQL to Firestore

### 3.1 Run Migration Script

```bash
# Make sure MySQL server is running and accessible
# Run from project root:
npm run migrate

# Or manually:
cd functions && npm run migrate && cd ..
```

### 3.2 What Gets Migrated
- ✅ All users (with hashed passwords)
- ✅ All transactions
- ✅ All loan applications
- ✅ All documents
- ✅ Activity logs (if exists)

### 3.3 Migration Safety Features
- Data is NEVER deleted from MySQL
- Firestore documents are created with `migratedFromMySQLId` for tracking
- User IDs are re-mapped to Firebase UID
- Transactions are date-preserved

### 3.4 Verify Migration

```bash
# Check Firestore in Firebase Console:
# 1. Firestore Database → Collections
# 2. Verify "users", "transactions", "loanApplications", "documents" collections exist
# 3. Check document counts match your MySQL tables
```

## 🔧 Step 4: Deploy Firebase Backend

### 4.1 Deploy Cloud Functions

```bash
# From project root:
firebase deploy --only functions

# This deploys the API endpoints at:
# https://your-region-your-project.cloudfunctions.net/api
```

### 4.2 Get Your Firebase Functions URL

After deployment, you'll see output like:
```
Function URL (api): https://us-central1-your-project.cloudfunctions.net/api
```

Save this URL - you'll need it for the frontend!

### 4.3 Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
```

### 4.4 Deploy Firestore Indexes

```bash
firebase deploy --only firestore:indexes
```

## 🖥️ Step 5: Update Frontend

### 5.1 Update API Configuration

Create `firebase-api-config.js`:
```javascript
// Your Firebase Functions API endpoint
const API_BASE_URL = 'https://us-central1-your-project.cloudfunctions.net/api';

// Helper function to make API calls
async function callFirebaseAPI(endpoint, method = 'GET', data = null) {
  const token = localStorage.getItem('firebaseToken');
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` })
    }
  };

  if (data && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}
```

### 5.2 Update All API Calls

Replace all backend API calls. Example:

**Before (Render):**
```javascript
const response = await fetch('https://heritage-bank.onrender.com/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});
```

**After (Firebase):**
```javascript
const response = await callFirebaseAPI('/auth/login', 'POST', { email, password });
```

### 5.3 Update Existing Files

Files to update:
- `firebase-auth.js` - Authentication logic
- `script.js` - Main API calls
- `dashboard.html` - Dashboard calls
- `admin.html` - Admin panel calls
- `settings-enhanced.js` - Settings API calls
- `signup-enhanced.js` - Registration logic
- `signin.html` - Login logic

### 5.4 Redeploy Frontend

```bash
# Firebase Hosting deployment
firebase deploy --only hosting

# Or if using Render/another host, push and redeploy
git push origin main
```

## 🧪 Step 6: Testing

### 6.1 Test Authentication
```bash
# Test registration
curl -X POST https://your-functions-url/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","lastName":"User","email":"test@example.com","password":"Test123!"}'

# Test login
curl -X POST https://your-functions-url/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!"}'
```

### 6.2 Test User Operations
```bash
# Get profile (requires token)
curl -X GET https://your-functions-url/api/user/profile \
  -H "Authorization: Bearer YOUR_TOKEN"

# Get balance
curl -X GET https://your-functions-url/api/user/balance \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 6.3 Manual Testing
1. Go to your frontend URL
2. Try signing up with a new account
3. Try logging in
4. Check Firestore to see new user created
5. Try transferring money between accounts
6. Check admin panel

## 📊 Step 7: Monitor & Maintain

### 7.1 View Logs
```bash
# View Cloud Functions logs
firebase functions:log

# Or in Firebase Console:
# Functions → Logs
```

### 7.2 Monitor Firestore Usage
Firebase Console → Firestore → Usage tab shows:
- Read/Write operations
- Storage usage
- Costs

### 7.3 Set Up Firestore Backups
Firebase Console → Firestore → Backups:
1. Click "Create schedule"
2. Set daily backups
3. Choose retention period

## 🧹 Step 8: Clean Up Render (Optional)

Once you're confident everything works:

### 8.1 Keep or Delete Render Backend
- **Option A**: Keep running as backup (costs ~$7/month)
- **Option B**: Delete to save costs

### 8.2 Database Considerations
- MySQL data stays on Render (if kept)
- Create backup before deleting anything
- Consider monthly exports as safety measure

### 8.3 Delete Render Service
1. Go to [render.com](https://render.com)
2. Select your service
3. Settings → Delete Service
4. Confirm deletion

## ⚠️ Troubleshooting

### "Firebase credentials not found"
```bash
# Make sure serviceAccountKey.json exists in functions/
# And GOOGLE_APPLICATION_CREDENTIALS is set in .env
```

### "Migration fails to connect to MySQL"
```bash
# Check MySQL connection in .env
# Ensure MySQL server is running
# Try: mysql -h DB_HOST -u DB_USER -p DB_PASSWORD
```

### "Functions deploy fails"
```bash
# Update dependencies:
cd functions && npm update && cd ..

# Rebuild:
firebase deploy --only functions --debug

# Check logs for specific error
```

### "Frontend can't connect to Firebase"
```bash
# Verify API_BASE_URL is correct
# Check Network tab in browser DevTools
# Ensure CORS is enabled in firestore.rules
```

## 📚 Additional Resources

- [Firebase Documentation](https://firebase.google.com/docs)
- [Cloud Functions Guide](https://firebase.google.com/docs/functions)
- [Firestore Best Practices](https://firebase.google.com/docs/firestore/best-practices)
- [Firebase Pricing](https://firebase.google.com/pricing)

## 💰 Cost Estimation

### Firebase Free Tier
- 1 GB storage
- 50,000 reads/day
- 20,000 writes/day
- 20,000 deletes/day
- Perfect for small-medium apps

### Estimated Monthly Costs (with growth)
- Small (100 users): FREE
- Medium (1,000 users): $10-50/month
- Large (10,000+ users): $100-500/month

## ✅ Migration Checklist

- [ ] Firebase project created
- [ ] Firebase credentials downloaded
- [ ] Environment variables configured
- [ ] Dependencies installed
- [ ] Data migrated successfully
- [ ] Cloud Functions deployed
- [ ] Frontend updated with new API URLs
- [ ] Authentication tested
- [ ] User operations tested
- [ ] Admin functions tested
- [ ] Firestore security rules deployed
- [ ] Backups configured
- [ ] Old infrastructure archived/deleted (optional)

---

**Need Help?**
- Check Firebase Console logs
- Review `functions/migrate-mysql-to-firestore.js` for migration details
- Compare `functions/index.js` with old backend for API compatibility
