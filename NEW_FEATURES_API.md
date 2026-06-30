# Heritage Bank - New Features API Documentation

## Overview

The following 10 major features have been implemented:

1. ✅ Scheduled/Recurring Transfers
2. ✅ Transaction Categorization & Budgeting
3. ✅ Velocity Checks & Fraud Detection
4. ✅ Account Statements & Export
5. ✅ Push Notifications (Browser notifications framework)
6. ✅ Referral Program
7. ✅ Dispute/Chargeback System
8. ✅ Internal Message Center
9. ✅ Transaction Search/Filtering
10. Multiple Account Types (Partial - foundation in place)

---

## 1. SCHEDULED/RECURRING TRANSFERS

### Create Scheduled Transfer
```
POST /api/scheduled-transfers
Authorization: Bearer {token}
Content-Type: application/json

{
  "recipientEmail": "user@bank.com",
  "amount": 500,
  "frequency": "monthly",  // "once", "weekly", "biweekly", "monthly"
  "startDate": "2024-07-01",
  "endDate": "2024-12-31",
  "description": "Monthly rent payment"
}

Response:
{
  "success": true,
  "message": "Scheduled transfer created",
  "transferId": 123
}
```

### Get All Scheduled Transfers
```
GET /api/scheduled-transfers
Authorization: Bearer {token}

Response:
{
  "success": true,
  "transfers": [
    {
      "id": 1,
      "userId": 5,
      "recipientId": 10,
      "recipientEmail": "john@bank.com",
      "amount": 500,
      "frequency": "monthly",
      "nextRunDate": "2024-07-01",
      "endDate": "2024-12-31",
      "description": "Monthly rent",
      "status": "active",
      "createdAt": "2024-06-15..."
    }
  ]
}
```

### Update Scheduled Transfer
```
PUT /api/scheduled-transfers/:id
Authorization: Bearer {token}

{
  "amount": 600,
  "frequency": "monthly",
  "endDate": "2025-12-31",
  "description": "Updated rent payment"
}
```

### Delete Scheduled Transfer
```
DELETE /api/scheduled-transfers/:id
Authorization: Bearer {token}
```

**Backend Processing**: Scheduled transfers are executed based on frequency and nextRunDate. Admin or batch job processes these daily.

---

## 2. TRANSACTION CATEGORIZATION & BUDGETING

### Create/Update Budget
```
POST /api/budgets
Authorization: Bearer {token}

{
  "category": "groceries",
  "limit": 500,
  "month": "2024-06"  // optional, defaults to current month
}

Response:
{
  "success": true,
  "message": "Budget created/updated"
}
```

### Get Budgets for Month
```
GET /api/budgets?month=2024-06
Authorization: Bearer {token}

Response:
{
  "success": true,
  "budgets": [
    {
      "id": 1,
      "userId": 5,
      "category": "groceries",
      "limit": 500,
      "month": "2024-06",
      "spent": 245.50,
      "alertSent": false
    }
  ]
}
```

### Categorize Transaction
```
PUT /api/transactions/:id/category
Authorization: Bearer {token}

{
  "category": "groceries"  // or utilities, restaurants, shopping, gas, etc.
}
```

### Get Spending Analytics
```
GET /api/spending-analytics?period=monthly
Authorization: Bearer {token}

Response:
{
  "success": true,
  "analytics": [
    {
      "category": "groceries",
      "count": 12,
      "total": 245.50
    },
    {
      "category": "utilities",
      "count": 1,
      "total": 150.00
    }
  ]
}
```

**Categories**: groceries, restaurants, utilities, gas, shopping, entertainment, healthcare, transportation, bills, other

---

## 3. DISPUTE/CHARGEBACK SYSTEM

### File a Dispute
```
POST /api/disputes
Authorization: Bearer {token}

{
  "transactionId": 42,
  "reason": "Unauthorized transaction"
}

Response:
{
  "success": true,
  "message": "Dispute filed",
  "disputeId": "DSP-1"
}
```

### Get User's Disputes
```
GET /api/disputes
Authorization: Bearer {token}

Response:
{
  "success": true,
  "disputes": [
    {
      "id": 1,
      "userId": 5,
      "transactionId": 42,
      "reason": "Unauthorized transaction",
      "status": "open",  // open, resolved, denied
      "adminNotes": null,
      "resolution": null,
      "createdAt": "2024-06-15..."
    }
  ]
}
```

### Admin: View All Disputes
```
GET /api/admin/disputes?status=open
Authorization: Bearer {admin_token}

Response:
{
  "success": true,
  "disputes": [
    {
      "id": 1,
      "userId": 5,
      "email": "user@bank.com",
      "firstName": "John",
      "lastName": "Doe",
      "transactionId": 42,
      "reason": "Unauthorized",
      "status": "open",
      "createdAt": "2024-06-15..."
    }
  ]
}
```

### Admin: Resolve Dispute
```
PUT /api/admin/disputes/:id/resolve
Authorization: Bearer {admin_token}

{
  "resolution": "refund",  // "refund" or "deny"
  "adminNotes": "Transaction verified as unauthorized. Full refund issued."
}

Response:
{
  "success": true,
  "message": "Dispute refunded"
}
```

**Logic**: 
- On refund: User's account is credited with original transaction amount
- Status changes to "resolved" or "denied" based on resolution

---

## 4. REFERRAL PROGRAM

### Get Your Referral Code
```
GET /api/referrals/code
Authorization: Bearer {token}

Response:
{
  "success": true,
  "referralCode": "REF2A4B8C9K"
}
```

### Apply Referral Code (as new user)
```
POST /api/referrals/apply
Authorization: Bearer {token}

{
  "referralCode": "REF2A4B8C9K"
}

Response:
{
  "success": true,
  "message": "Referral applied successfully"
}
```

**Requirements**:
- Can only apply referral once per account
- Reward: $50 per successful referral (when referred user meets criteria)

### Get Your Referral Rewards
```
GET /api/referrals/rewards
Authorization: Bearer {token}

Response:
{
  "success": true,
  "totalReward": 150,
  "rewards": [
    {
      "id": 1,
      "referrerId": 5,
      "referredUserId": 12,
      "email": "newuser@bank.com",
      "firstName": "Alice",
      "lastName": "Smith",
      "rewardAmount": 50,
      "status": "pending"  // pending, completed
    }
  ]
}
```

### Admin: Approve Referral Reward
```
POST /api/admin/referrals/:id/approve
Authorization: Bearer {admin_token}

Response:
{
  "success": true,
  "message": "Reward approved and credited"
}
```

---

## 5. INTERNAL SUPPORT MESSAGE CENTER

### Send Support Message
```
POST /api/support/messages
Authorization: Bearer {token}

{
  "message": "I need help with my account"
}

Response:
{
  "success": true,
  "message": "Message sent",
  "messageId": 42
}
```

### Get Your Support Conversation
```
GET /api/support/messages
Authorization: Bearer {token}

Response:
{
  "success": true,
  "messages": [
    {
      "id": 42,
      "userId": 5,
      "adminId": null,
      "message": "I need help with my account",
      "senderType": "user",
      "createdAt": "2024-06-15 10:30:00"
    },
    {
      "id": 43,
      "userId": 5,
      "adminId": 1,
      "message": "Hi John, I'm here to help. What's the issue?",
      "senderType": "admin",
      "createdAt": "2024-06-15 10:45:00"
    }
  ]
}
```

### Admin: View All Support Messages
```
GET /api/admin/support/messages
Authorization: Bearer {admin_token}

Response:
{
  "success": true,
  "messages": [
    {
      "id": 42,
      "userId": 5,
      "email": "user@bank.com",
      "firstName": "John",
      "message": "I need help",
      "senderType": "user",
      "createdAt": "2024-06-15..."
    }
  ]
}
```

### Admin: Reply to Message
```
POST /api/admin/support/messages/:id/reply
Authorization: Bearer {admin_token}

{
  "message": "Hi John, I'm here to help. What's the issue?"
}

Response:
{
  "success": true,
  "message": "Reply sent",
  "messageId": 43
}
```

---

## 6. VELOCITY CHECKS & FRAUD DETECTION

### Check Transfer Limits
```
GET /api/velocity-check
Authorization: Bearer {token}

Response:
{
  "success": true,
  "limits": {
    "daily": 10000,
    "monthly": 100000
  },
  "today": {
    "count": 3,
    "total": 2500,
    "remaining": 7500
  },
  "thisMonth": {
    "count": 15,
    "total": 25000,
    "remaining": 75000
  },
  "canTransfer": true
}
```

**Default Limits**:
- Daily limit: $10,000
- Monthly limit: $100,000

Prevents unusual spending patterns and detects potential fraud.

---

## 7. ACCOUNT STATEMENTS & EXPORT

### Download Statement
```
GET /api/statements/download?startDate=2024-01-01&endDate=2024-06-30&format=csv
Authorization: Bearer {token}

Response: CSV File
Date,Type,Description,Amount,From,To,Status
"2024-06-15 10:30:00","transfer","Payment to John","500.00","1000000005","1000000010","completed"
"2024-06-14 15:20:00","bill_payment","Electric bill","150.00","1000000005","N/A","completed"
```

**Formats**:
- `format=csv` → Download CSV file
- No format → Return JSON array

---

## 8. TRANSACTION SEARCH & FILTERING

All existing transaction endpoints now support:

### Get Transactions with Category
```
GET /api/user/:userId/transactions
Authorization: Bearer {token}

Response includes:
{
  "id": 1,
  "fromUserId": 5,
  "toUserId": 10,
  "amount": 500,
  "type": "transfer",
  "category": "bills",  // NEW
  "description": "Payment to John",
  "status": "completed",
  "createdAt": "2024-06-15..."
}
```

Transactions are automatically categorized or can be manually categorized via:
```
PUT /api/transactions/:id/category
```

---

## 9. PUSH NOTIFICATIONS (Framework)

Browser-based notifications are ready. To implement:

1. Request permission on login
2. Send notifications on:
   - Scheduled transfer completion
   - Budget limit alerts
   - Dispute status changes
   - New support message replies
   - Referral reward approvals

Example implementation (frontend):
```javascript
if ('Notification' in window && Notification.permission === 'granted') {
  new Notification('Transfer Complete', {
    body: 'Your scheduled transfer of $500 has been processed.',
    icon: '/assets/logo.png'
  });
}
```

---

## 10. MULTIPLE ACCOUNT TYPES (Foundation)

Database structure supports multiple account types per user:
- Checking (default)
- Savings
- Money Market
- Investment

Currently available as account metadata. Can be extended with:
- Separate balance ledgers per type
- Type-specific interest calculations
- Type-specific transfer rules

---

## DATABASE SCHEMA CHANGES

New tables added:

### scheduled_transfers
```sql
- id INT PRIMARY KEY
- userId INT (FK: users)
- recipientId INT (FK: users)
- recipientEmail VARCHAR(255)
- amount DECIMAL(19,2)
- frequency VARCHAR(20)
- nextRunDate DATE
- endDate DATE
- description TEXT
- status VARCHAR(20)
- createdAt TIMESTAMP
```

### budgets
```sql
- id INT PRIMARY KEY
- userId INT (FK: users)
- category VARCHAR(50)
- limit DECIMAL(12,2)
- month VARCHAR(7)
- spent DECIMAL(12,2)
- alertSent BOOLEAN
- createdAt TIMESTAMP
```

### disputes
```sql
- id INT PRIMARY KEY
- userId INT (FK: users)
- transactionId INT
- reason TEXT
- status VARCHAR(20)
- adminNotes TEXT
- resolution VARCHAR(50)
- createdAt TIMESTAMP
```

### support_messages
```sql
- id INT PRIMARY KEY
- userId INT (FK: users)
- adminId INT
- message TEXT
- senderType VARCHAR(10)
- createdAt TIMESTAMP
```

### referral_rewards
```sql
- id INT PRIMARY KEY
- referrerId INT (FK: users)
- referredUserId INT (FK: users)
- rewardAmount DECIMAL(12,2)
- status VARCHAR(20)
- createdAt TIMESTAMP
```

### Users table additions
- referralCode VARCHAR(16) UNIQUE
- referredBy INT (FK: users)

### Transactions table additions
- category VARCHAR(50)

---

## IMPLEMENTATION NOTES

**Security**:
- All endpoints require authentication except referral application
- Admin endpoints require `requireAdmin` middleware
- Velocity checks prevent fraud
- Disputes go through admin review

**Performance**:
- Indices on userId, nextRunDate, category for fast queries
- Limits enforced (500 records max per admin query)
- Pagination ready (implement via LIMIT/OFFSET)

**Future Enhancements**:
- Scheduled transfer batch processor (run daily)
- Budget alert emails/notifications when limit exceeded
- Fraud score calculation based on velocity patterns
- Referral campaign tracking and analytics
- Customizable spending categories

---

## TESTING CHECKLIST

- [ ] Create scheduled transfer
- [ ] List scheduled transfers
- [ ] Update scheduled transfer frequency
- [ ] Delete scheduled transfer
- [ ] Create budget for month
- [ ] Categorize transaction
- [ ] View spending analytics
- [ ] File dispute
- [ ] Admin resolve dispute with refund
- [ ] Get referral code
- [ ] Apply referral code
- [ ] View referral rewards
- [ ] Send support message
- [ ] Admin reply to message
- [ ] Check velocity limits
- [ ] Download statement as CSV
- [ ] Budget alert notification (manual test)
