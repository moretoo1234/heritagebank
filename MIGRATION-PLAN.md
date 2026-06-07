# Heritage Bank - Firebase Migration Plan

## Overview
Migrate the Heritage Bank application from Render + MySQL to entirely Firebase (Hosting + Cloud Functions + Firestore + Auth)

## Current State
- **Backend**: Express.js server with MySQL (TiDB) on Render
- **Auth**: JWT-based authentication stored in MySQL
- **Firebase**: Already configured (project: btc-a87b4d93), partially implemented

## Target State
- **Hosting**: Firebase Hosting
- **Database**: Firestore (NoSQL)
- **Auth**: Firebase Authentication
- **Backend**: Firebase Cloud Functions
- **Storage**: Firebase Storage for files/images

---

## Phase 1: Firebase Configuration Updates

### 1.1 Update firebase.json
- [ ] Proper hosting config with rewrites for Cloud Functions
- [ ] Add Storage configuration
- [ ] Configure emulators for local development

### 1.2 Firestore Security Rules
- [ ] Create proper firestore.rules
- [ ] User-specific read/write rules
- [ ] Admin elevated privileges

### 1.3 Storage Rules
- [ ] Create storage.rules for profile images, documents

---

## Phase 2: Data Migration Preparation

### 2.1 MySQL to Firestore Schema Mapping

| MySQL Table | Firestore Collection |
|-----------|-----------------|
| users | users |
| transactions | transactions |
| bank_accounts | bankAccounts |
| cards | cards |
| beneficiaries | beneficiaries |
| notifications | notifications |
| support_tickets | supportTickets |
| faqs | faqs |
| savings_goals | savingsGoals |
| scheduled_payments | scheduledPayments |

### 2.2 Migration Script (functions/migrate.js)
- [ ] Read from MySQL (via environment connection)
- [ ] Transform and import to Firestore
- [ ] Batch writes for efficiency
- [ ] Validation checks

---

## Phase 3: Backend Migration (Express → Cloud Functions)

### 3.1 Authentication Functions
- [ ] POST /api/auth/login → Firebase Function
- [ ] POST /api/auth/register → Firebase Function
- [ ] POST /api/auth/forgot-password → Firebase Function
- [ ] POST /api/auth/reset-password → Firebase Function
- [ ] POST /api/auth/change-password → Firebase Function
- [ ] POST /api/auth/logout → Firebase Function
- [ ] GET /api/auth/profile → Firebase Function

### 3.2 Account Functions
- [ ] GET /api/accounts → Firebase Function
- [ ] POST /api/accounts/open → Firebase Function

### 3.3 Transaction Functions
- [ ] GET /api/transactions → Firebase Function
- [ ] POST /api/user/transfer → Firebase Function
- [ ] POST /api/transfer/internal → Firebase Function
- [ ] GET /api/user/balance → Firebase Function

### 3.4 Card Functions
- [ ] GET /api/cards → Firebase Function
- [ ] POST /api/cards/issue → Firebase Function
- [ ] POST /api/cards/apply → Firebase Function
- [ ] PUT /api/cards/:id/freeze → Firebase Function
- [ ] PUT /api/cards/:id/unfreeze → Firebase Function

### 3.5 Support Functions
- [ ] GET /api/support/tickets → Firebase Function
- [ ] POST /api/support/tickets → Firebase Function
- [ ] GET /api/support/tickets/:number → Firebase Function
- [ ] POST /api/support/tickets/:number/reply → Firebase Function

### 3.6 Admin Functions
- [ ] GET /api/admin/users → Firebase Function
- [ ] POST /api/admin/fund-user → Firebase Function
- [ ] POST /api/admin/create-user → Firebase Function
- [ ] POST /api/admin/debit-user → Firebase Function
- [ ] GET /api/admin/transactions → Firebase Function
- [ ] GET /api/admin/signups/pending → Firebase Function
- [ ] POST /api/admin/signups/:id/approve → Firebase Function
- [ ] POST /api/admin/signups/:id/reject → Firebase Function

### 3.7 Other Functions
- [ ] GET /api/faqs → Firebase Function
- [ ] GET /api/notifications → Firebase Function
- [ ] PUT /api/notifications/:id/read → Firebase Function
- [ ] PUT /api/notifications/read-all → Firebase Function
- [ ] GET /api/settings/public → Firebase Function

---

## Phase 4: Frontend Updates

### 4.1 API Endpoint Changes
All HTML/JS files need API endpoint updates:
- Change from: `/api/...` (Render)
- Change to: `/api/...` (Firebase Functions via Rewrite)

### 4.2 Authentication Updates
- [ ] Update signin.html to use Firebase Auth
- [ ] Update signup.html to use Firebase Auth
- [ ] Update dashboard.html to use Firebase tokens

### 4.3 Storage Updates
- [ ] Add Firebase Storage for profile images
- [ ] Add Firebase Storage for document uploads

---

## Phase 5: Deployment

### 5.1 Pre-deployment
- [ ] Test all functions locally with emulators
- [ ] Run data migration script
- [ ] Verify all data imported correctly

### 5.2 Deployment
- [ ] DeployFirebase Functions: `firebase deploy --only functions`
- [ ] DeployFirestore Rules: `firebase deploy --only firestore`
- [ ] Deploy Storage Rules: `firebase deploy --only storage`
- [ ] Deploy Hosting: `firebase deploy --only hosting`

### 5.3 Post-deployment
- [ ] Update DNS records (if needed)
- [ ] Verify all endpoints work
- [ ] Monitor error logs
- [ ] Test all user flows

---

## Files to Edit/Update

| Priority | File | Changes |
|----------|------|---------|
| P0 | firebase.json | Hosting config |
| P0 | firestore.rules | Security rules |
| P0 | functions/index.js | Full API rewrite |
| P0 | functions/migrate.js | Data migration |
| P1 | signin.html | Auth update |
| P1 | signup.html | Auth update |
| P1 | dashboard.html | API updates |
| P2 | admin.html | Admin API updates |
| P2 | settings.html | API updates |
| P2 | script.js | API base URL |

---

## Rollback Plan
If issues occur:
1. Keep Render deployment active
2. Use Firebase as secondary
3. Switch primary when fully tested

---

## Notes
- Firebase function URL format: `https://REGION-PROJECT.cloudfunctions.net/api`
- Firestore used for all dynamic data
- Firebase Auth handles user management
- JWT still used for custom claims (isAdmin, etc.)
