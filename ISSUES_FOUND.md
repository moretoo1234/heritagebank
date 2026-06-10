# Heritage Bank - Issues Found & Fixed

## Critical Issues Fixed

### 1. Backend Server Issues (server.js)
**Location**: `backend/server.js` line ~738
- **Issue**: Incomplete function call `const user = await db.getUserByEmail;` (missing parentheses and parameter)
- **Impact**: Admin debit endpoint would crash
- **Status**: ✅ FIXED - Changed to proper `getUserById(userId)` call with balance check

### 2. API Endpoint Inconsistency (signin.html)
**Location**: `public/signin.html` line ~129
- **Issue**: Using `/api/auth/profile` but server only has `/api/user/profile`
- **Impact**: Auto-redirect on page load fails silently
- **Status**: ⚠️ IDENTIFIED - Server has `/api/user/profile` but signin uses `/api/auth/profile`
- **Fix Needed**: Either update server to add `/api/auth/profile` endpoint or update signin.html

### 3. Missing Gender Field Handling (signup.html)
**Location**: `public/signup.html`
- **Issue**: Gender field has HTML but uses old class name `.auth-select` instead of proper styling
- **Impact**: Visual inconsistency, select dropdown not styled properly
- **Status**: ⚠️ COSMETIC ISSUE

### 4. Missing Biometric Login Endpoints
**Location**: Backend missing WebAuthn endpoints
- **Issue**: signin.html calls `/api/auth/webauthn/login-options` and `/api/auth/webauthn/login-verify` but these don't exist
- **Impact**: Biometric login button appears but doesn't work
- **Status**: ⚠️ FEATURE INCOMPLETE

### 5. Missing Beneficiary Endpoints
**Location**: transfer.html calls beneficiary endpoints
- **Issue**: Calls to `/api/beneficiaries` (GET, POST, PUT, DELETE) but endpoints don't exist in server
- **Impact**: Saved beneficiaries feature doesn't work
- **Status**: ⚠️ FEATURE INCOMPLETE

## Medium Priority Issues

### 6. Missing SELECT Statement (db.js)
**Location**: `backend/db.js` - `getUserTransactions` function
- **Issue**: Missing SELECT in SQL query - uses `SELECT * FROM transactions WHERE...`
- **Impact**: Works but could be optimized to select specific columns
- **Status**: ℹ️ WORKS BUT SUBOPTIMAL

### 7. Error Handling in Dashboard
**Location**: `public/dashboard.html`
- **Issue**: API calls don't handle 404/401 responses gracefully
- **Impact**: Users see generic errors instead of specific messages
- **Status**: ℹ️ COULD BE IMPROVED

### 8. Missing CSS File References
**Location**: Multiple HTML files
- **Issue**: References to `loading.css`, `app-layout.css`, `dashboard-page.css`
- **Impact**: If files are missing, pages won't load properly
- **Status**: ⚠️ NEEDS VERIFICATION

## Security Concerns

### 9. JWT Secret Default Value
**Location**: `backend/server.js` line ~45
- **Issue**: Falls back to 'dev-secret-key-change-in-production' if JWT_SECRET not set
- **Impact**: Security vulnerability in production if env var not set
- **Status**: ⚠️ REQUIRES ENV VAR

### 10. Account Number Exposure
**Location**: `backend/server.js` line ~265
- **Issue**: Full account number returned in profile API
- **Impact**: Security concern - full account numbers exposed to frontend
- **Status**: ℹ️ BY DESIGN (noted in comments)

## Recommendations

### Immediate Actions Required:
1. ✅ Fix incomplete getUserByEmail call in server.js (COMPLETED)
2. Add missing `/api/auth/profile` endpoint or update signin.html to use `/api/user/profile`
3. Implement WebAuthn/biometric endpoints or remove the UI
4. Implement beneficiary management endpoints or hide the feature
5. Set JWT_SECRET environment variable in production

### Nice to Have:
- Add proper error handling for all API calls
- Implement proper logging system
- Add request validation middleware
- Optimize database queries with specific column selection
- Add unit tests for critical functions

## Files Modified:
- ✅ `backend/server.js` - Fixed getUserByEmail call and debit logic

## Files Requiring Attention:
- `public/signin.html` - Update API endpoint path
- `public/signup.html` - Fix select styling
- `backend/server.js` - Add missing endpoints (WebAuthn, beneficiaries)
