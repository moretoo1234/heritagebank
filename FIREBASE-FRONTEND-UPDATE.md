# Firebase Frontend Update Guide

## Quick Reference: Before & After

### 1. OLD (Render Backend)
```html
<!-- Old: Using Render backend -->
<script src="script.js"></script>

<script>
  async function login(email, password) {
    const response = await fetch('https://heritage-bank-13vo.onrender.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    localStorage.setItem('token', data.token);
    return data;
  }
</script>
```

### 1. NEW (Firebase Backend)
```html
<!-- New: Using Firebase Cloud Functions -->
<script src="firebase-api-helper.js"></script>

<script>
  async function login(email, password) {
    const result = await loginUser(email, password);
    // Token is automatically saved by loginUser()
    return result;
  }
</script>
```

## File-by-File Update Guide

### signin.html / signin-page

**OLD CODE:**
```javascript
async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const response = await fetch(
      'https://heritage-bank-13vo.onrender.com/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      }
    );

    const result = await response.json();
    
    if (result.success) {
      localStorage.setItem('token', result.token);
      localStorage.setItem('user', JSON.stringify(result.user));
      window.location.href = '/dashboard.html';
    } else {
      showError(result.message);
    }
  } catch (error) {
    showError(error.message);
  }
}
```

**NEW CODE:**
```javascript
async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const result = await loginUser(email, password);
    
    if (result.success) {
      localStorage.setItem('user', JSON.stringify(result.user));
      window.location.href = '/dashboard.html';
    } else {
      showError(result.message);
    }
  } catch (error) {
    showError('Login failed: ' + error.message);
  }
}
```

**HTML Changes:**
```html
<!-- Add this before closing </head> -->
<script src="firebase-api-helper.js"></script>
```

---

### signup.html / signup-enhanced.html

**OLD CODE:**
```javascript
async function handleSignUp(event) {
  event.preventDefault();
  
  const formData = {
    firstName: document.getElementById('firstName').value,
    lastName: document.getElementById('lastName').value,
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
    phone: document.getElementById('phone').value,
    accountType: document.getElementById('accountType').value
  };

  try {
    const response = await fetch(
      'https://heritage-bank-13vo.onrender.com/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      }
    );

    const result = await response.json();
    
    if (result.success) {
      localStorage.setItem('token', result.token);
      window.location.href = '/dashboard.html';
    } else {
      alert(result.message);
    }
  } catch (error) {
    alert('Registration failed: ' + error.message);
  }
}
```

**NEW CODE:**
```javascript
async function handleSignUp(event) {
  event.preventDefault();
  
  const firstName = document.getElementById('firstName').value;
  const lastName = document.getElementById('lastName').value;
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const phone = document.getElementById('phone').value || '';
  const accountType = document.getElementById('accountType').value;

  try {
    const result = await registerUser(
      firstName,
      lastName,
      email,
      password,
      phone,
      accountType
    );
    
    if (result.success) {
      window.location.href = '/dashboard.html';
    } else {
      alert(result.message);
    }
  } catch (error) {
    alert('Registration failed: ' + error.message);
  }
}
```

---

### dashboard.html

**OLD CODE:**
```javascript
async function loadDashboard() {
  const token = localStorage.getItem('token');
  
  try {
    // Get balance
    const balanceResponse = await fetch(
      'https://heritage-bank-13vo.onrender.com/api/user/balance',
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    const balanceData = await balanceResponse.json();
    
    // Get transactions
    const txnResponse = await fetch(
      'https://heritage-bank-13vo.onrender.com/api/user/transfers',
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    const txnData = await txnResponse.json();
    
    // Update UI
    document.getElementById('balance').textContent = 
      '$' + balanceData.balance.toFixed(2);
    
    txnData.transactions.forEach(txn => {
      // Display transaction...
    });
  } catch (error) {
    console.error('Failed to load dashboard:', error);
  }
}
```

**NEW CODE:**
```javascript
async function loadDashboard() {
  try {
    // Get balance
    const balanceData = await getUserBalance();
    
    // Get transactions
    const txnData = await getTransfers();
    
    // Update UI
    document.getElementById('balance').textContent = 
      '$' + balanceData.balance.toFixed(2);
    
    txnData.transactions.forEach(txn => {
      // Display transaction...
    });
  } catch (error) {
    console.error('Failed to load dashboard:', error);
  }
}
```

---

### settings-enhanced.html

**OLD CODE:**
```javascript
async function handleTransfer() {
  const token = localStorage.getItem('token');
  const toEmail = document.getElementById('recipientEmail').value;
  const amount = parseFloat(document.getElementById('amount').value);
  const description = document.getElementById('description').value;

  try {
    const response = await fetch(
      'https://heritage-bank-13vo.onrender.com/api/user/transfer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          toEmail,
          amount,
          description
        })
      }
    );

    const result = await response.json();
    
    if (result.success) {
      alert('Transfer successful!');
      // Reset form...
    } else {
      alert('Transfer failed: ' + result.message);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}
```

**NEW CODE:**
```javascript
async function handleTransfer() {
  const toEmail = document.getElementById('recipientEmail').value;
  const amount = parseFloat(document.getElementById('amount').value);
  const description = document.getElementById('description').value;

  try {
    const result = await transferMoney(toEmail, null, amount, description);
    
    if (result.success) {
      alert('Transfer successful!');
      // Reset form...
    } else {
      alert('Transfer failed: ' + result.message);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}
```

---

### admin.html

**OLD CODE:**
```javascript
async function loadAllUsers() {
  const token = localStorage.getItem('token');

  try {
    const response = await fetch(
      'https://heritage-bank-13vo.onrender.com/api/admin/users',
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    const data = await response.json();

    // Display users in table
    displayUsers(data.users);
  } catch (error) {
    console.error('Failed to load users:', error);
  }
}

async function createNewUser() {
  const token = localStorage.getItem('token');
  const formData = {
    firstName: document.getElementById('firstName').value,
    lastName: document.getElementById('lastName').value,
    email: document.getElementById('email').value,
    accountType: document.getElementById('accountType').value
  };

  try {
    const response = await fetch(
      'https://heritage-bank-13vo.onrender.com/api/admin/create-user',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(formData)
      }
    );
    const result = await response.json();
    
    if (result.success) {
      alert('User created successfully!');
      loadAllUsers(); // Refresh list
    }
  } catch (error) {
    alert('Failed: ' + error.message);
  }
}
```

**NEW CODE:**
```javascript
async function loadAllUsers() {
  try {
    const data = await getAllUsers();
    displayUsers(data.users);
  } catch (error) {
    console.error('Failed to load users:', error);
  }
}

async function createNewUser() {
  const firstName = document.getElementById('firstName').value;
  const lastName = document.getElementById('lastName').value;
  const email = document.getElementById('email').value;
  const accountType = document.getElementById('accountType').value;

  try {
    const result = await createUserAccount(
      firstName,
      lastName,
      email,
      'TempPassword123!', // Temp password
      accountType
    );
    
    if (result.success) {
      alert('User created successfully!');
      loadAllUsers(); // Refresh list
    }
  } catch (error) {
    alert('Failed: ' + error.message);
  }
}
```

---

## HTML Template Checklist

Update these files by:

1. **Add Firebase API Helper Script**
   - Add `<script src="firebase-api-helper.js"></script>` to `<head>`

2. **Replace all fetch() calls** with helper functions:
   - `loginUser()`
   - `registerUser()`
   - `getUserBalance()`
   - `transferMoney()`
   - `getAllUsers()`
   - `createUserAccount()`
   - etc.

3. **Remove token from headers**
   - Token is now handled automatically by helper functions
   - Just use: `firebaseAPI('/endpoint')`

4. **Update error handling**
   - Catch errors from helper functions
   - Display user-friendly messages

### Files to Update

- [ ] `signin.html` - Login page
- [ ] `signup.html` / `signup-enhanced.html` - Registration
- [ ] `dashboard.html` - Main dashboard
- [ ] `dashboard-page.css` - No changes needed
- [ ] `transactions.html` - Transaction history
- [ ] `transfer.html` - Money transfers
- [ ] `settings-enhanced.html` - User settings
- [ ] `admin.html` - Admin panel
- [ ] `script.js` - Shared utilities (update API calls)
- [ ] `firebase-auth.js` - Auth logic (migrate to Cloud Functions)

## Common Patterns

### Pattern 1: Simple GET Request
```javascript
// Before
const response = await fetch(`${API}/endpoint`, {
  headers: { 'Authorization': `Bearer ${token}` }
});

// After
const result = await firebaseAPI('/endpoint', 'GET');
```

### Pattern 2: POST with Data
```javascript
// Before
const response = await fetch(`${API}/endpoint`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify(data)
});

// After
const result = await firebaseAPI('/endpoint', 'POST', data);
```

### Pattern 3: Check Success
```javascript
// Before
if (result.success) {
  // Do something
}

// After
if (result.success) {
  // Do something
}
// Or just catch errors:
try {
  const result = await firebaseAPI(...);
  // Success - result will have data
} catch (error) {
  // Error handling
}
```

## Testing Checklist

After updating each file:

1. ✅ Open browser DevTools → Network tab
2. ✅ Perform action (login, signup, transfer, etc.)
3. ✅ Verify API calls go to Firebase URL (not Render)
4. ✅ Check response is successful (status 200)
5. ✅ Verify UI updates correctly
6. ✅ Check localStorage has 'firebaseToken'
7. ✅ Test error cases (wrong password, insufficient balance, etc.)

## Common Issues & Fixes

### Issue: "Cannot find firebaseAPI function"
**Solution:** Make sure `firebase-api-helper.js` is included BEFORE any scripts that use it:
```html
<script src="firebase-api-helper.js"></script>
<!-- Your page scripts come after -->
<script src="script.js"></script>
```

### Issue: "API returns 401 Unauthorized"
**Solution:** Token not being sent. Check:
```javascript
// This should return the token
const token = getAuthToken();
console.log('Token:', token);

// If empty, re-login
if (!token) {
  window.location.href = '/signin.html';
}
```

### Issue: "CORS error"
**Solution:** Should not happen with Cloud Functions. If it does:
1. Check firestore.rules allows your app
2. Verify API_BASE_URL is correct
3. Check Cloud Functions deployed successfully

### Issue: "Token not saving"
**Solution:** Check localStorage is not blocked:
```javascript
// Test if localStorage works
localStorage.setItem('test', 'value');
console.log(localStorage.getItem('test'));
```

---

**Ready to update?** Start with the most important files:
1. `signin.html`
2. `signup.html`
3. `dashboard.html`
4. `admin.html`

Then update the rest gradually.
