/**
 * Firebase API Helper
 * Communicates with Render backend powered by Firestore
 * 
 * SETUP:
 * 1. Include this file in your HTML: <script src="firebase-api-helper.js"></script>
 * 2. Call firebaseAPI() instead of fetch()
 * 3. Tokens are stored in localStorage as 'firebaseToken'
 */

// ==================== CONFIGURATION ====================
// Your Render backend URL (already running)
const API_BASE_URL = 'https://heritagebank-ku1y.onrender.com/api';

// For local development, use:
// const API_BASE_URL = 'http://localhost:3000/api';

// ==================== TOKEN MANAGEMENT ====================
function getAuthToken() {
  return localStorage.getItem('firebaseToken');
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem('firebaseToken', token);
  } else {
    localStorage.removeItem('firebaseToken');
  }
}

function clearAuthToken() {
  localStorage.removeItem('firebaseToken');
}

// ==================== API HELPER ====================
/**
 * Make authenticated API calls to Render backend
 * @param {string} endpoint - API endpoint (e.g., '/auth/login', '/user/balance')
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {object} data - Request body data
 * @returns {Promise<object>} Response JSON
 */
async function firebaseAPI(endpoint, method = 'GET', data = null) {
  try {
    const token = getAuthToken();
    const url = `${API_BASE_URL}${endpoint}`;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    // Add authorization header if token exists
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    // Add request body for POST/PUT
    if (data && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(data);
    }

    console.log(`📡 ${method} ${endpoint}`, data || '');

    const response = await fetch(url, options);
    const responseData = await response.json();

    if (!response.ok) {
      const errorMessage = responseData.message || `HTTP ${response.status}`;
      console.error(`❌ API Error: ${errorMessage}`);
      throw new Error(errorMessage);
    }

    console.log(`✅ ${method} ${endpoint}`, responseData);
    return responseData;

  } catch (error) {
    console.error('API Call Error:', error);
    throw error;
  }
}

// ==================== AUTHENTICATION ====================

/**
 * Register a new user
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{token, user}>}
 */
async function registerUser(firstName, lastName, email, password, phone = '', accountType = 'checking') {
  const response = await firebaseAPI('/auth/register', 'POST', {
    firstName,
    lastName,
    email,
    password,
    phone,
    accountType
  });

  if (response.token) {
    setAuthToken(response.token);
  }

  return response;
}

/**
 * Login user
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{token, user}>}
 */
async function loginUser(email, password) {
  const response = await firebaseAPI('/auth/login', 'POST', {
    email,
    password
  });

  if (response.token) {
    setAuthToken(response.token);
  }

  return response;
}

/**
 * Logout (just clear token)
 */
function logoutUser() {
  clearAuthToken();
  // Redirect to login or update UI
  window.location.href = '/signin.html';
}

/**
 * Get current user profile
 */
async function getUserProfile() {
  return firebaseAPI('/auth/profile', 'GET');
}

/**
 * Change password
 */
async function changePassword(currentPassword, newPassword) {
  return firebaseAPI('/auth/change-password', 'POST', {
    currentPassword,
    newPassword
  });
}

/**
 * Request password reset
 */
async function forgotPassword(email) {
  return firebaseAPI('/auth/forgot-password', 'POST', {
    email
  });
}

/**
 * Reset password with token
 */
async function resetPassword(resetToken, newPassword) {
  return firebaseAPI('/auth/reset-password', 'POST', {
    resetToken,
    newPassword
  });
}

// ==================== USER OPERATIONS ====================

/**
 * Get user balance
 */
async function getUserBalance() {
  return firebaseAPI('/user/balance', 'GET');
}

/**
 * Get user transactions
 */
async function getUserTransactions(userId) {
  return firebaseAPI(`/user/${userId}/transactions`, 'GET');
}

/**
 * Transfer money to another user
 */
async function transferMoney(toEmail, toAccountNumber, amount, description = '') {
  return firebaseAPI('/user/transfer', 'POST', {
    toEmail: toEmail || undefined,
    toAccountNumber: toAccountNumber || undefined,
    amount,
    description
  });
}

/**
 * Get user's recent transfers
 */
async function getTransfers() {
  return firebaseAPI('/user/transfers', 'GET');
}

// ==================== ADMIN OPERATIONS ====================

/**
 * Get all users (admin only)
 */
async function getAllUsers() {
  return firebaseAPI('/admin/users', 'GET');
}

/**
 * Get all transactions (admin only)
 */
async function getAllTransactions() {
  return firebaseAPI('/admin/transactions', 'GET');
}

/**
 * Get admin dashboard (admin only)
 */
async function getDashboard() {
  return firebaseAPI('/admin/dashboard', 'GET');
}

/**
 * Create new user account (admin only)
 */
async function createUserAccount(firstName, lastName, email, password, accountType = 'checking', initialBalance = 0) {
  return firebaseAPI('/admin/create-user', 'POST', {
    firstName,
    lastName,
    email,
    password,
    accountType,
    initialBalance
  });
}

/**
 * Fund user account (admin only)
 */
async function fundUserAccount(toEmail, toAccountNumber, amount, description = '') {
  return firebaseAPI('/admin/fund-user', 'POST', {
    toEmail: toEmail || undefined,
    toAccountNumber: toAccountNumber || undefined,
    amount,
    description
  });
}

/**
 * Adjust user balance (admin only)
 */
async function adjustBalance(email, accountNumber, amount, type = 'credit', reason = '') {
  return firebaseAPI('/admin/adjust-balance', 'POST', {
    email: email || undefined,
    accountNumber: accountNumber || undefined,
    amount,
    type,
    reason
  });
}

/**
 * Transfer between any accounts (admin only)
 */
async function adminTransfer(fromEmail, fromAccountNumber, toEmail, toAccountNumber, amount, description = '') {
  return firebaseAPI('/admin/transfer', 'POST', {
    fromEmail: fromEmail || undefined,
    fromAccountNumber: fromAccountNumber || undefined,
    toEmail: toEmail || undefined,
    toAccountNumber: toAccountNumber || undefined,
    amount,
    description
  });
}

/**
 * Get specific user details (admin only)
 */
async function getUser(userId) {
  return firebaseAPI(`/admin/users/${userId}`, 'GET');
}

/**
 * Update user (admin only)
 */
async function updateUser(userId, updates) {
  return firebaseAPI(`/admin/users/${userId}`, 'PUT', updates);
}

/**
 * Delete user (admin only)
 */
async function deleteUser(userId) {
  return firebaseAPI(`/admin/users/${userId}`, 'DELETE');
}

// ==================== EXAMPLE USAGE ====================

/*

// 1. REGISTRATION
async function handleSignUp() {
  try {
    const result = await registerUser(
      'John',
      'Doe',
      'john@example.com',
      'Password123!',
      '555-1234',
      'checking'
    );
    console.log('User registered:', result.user);
    // Redirect to dashboard
    window.location.href = '/dashboard.html';
  } catch (error) {
    console.error('Registration failed:', error.message);
    alert('Registration failed: ' + error.message);
  }
}

// 2. LOGIN
async function handleLogin() {
  try {
    const result = await loginUser('john@example.com', 'Password123!');
    console.log('Login successful:', result.user);
    window.location.href = '/dashboard.html';
  } catch (error) {
    console.error('Login failed:', error.message);
    alert('Invalid credentials');
  }
}

// 3. GET BALANCE
async function loadBalance() {
  try {
    const result = await getUserBalance();
    document.getElementById('balance').textContent = `$${result.balance.toFixed(2)}`;
  } catch (error) {
    console.error('Failed to load balance:', error);
  }
}

// 4. TRANSFER MONEY
async function handleTransfer() {
  try {
    const result = await transferMoney(
      'jane@example.com', // or account number
      null,
      500.00,
      'Payment for services'
    );
    alert('Transfer successful!');
    console.log('Transaction:', result.transaction);
  } catch (error) {
    alert('Transfer failed: ' + error.message);
  }
}

// 5. ADMIN: CREATE USER
async function handleCreateUser() {
  try {
    const result = await createUserAccount(
      'Jane',
      'Smith',
      'jane@example.com',
      'TempPassword123!',
      'savings',
      5000
    );
    alert('User created successfully!');
  } catch (error) {
    alert('Failed to create user: ' + error.message);
  }
}

// 6. ADMIN: GET DASHBOARD
async function loadAdminDashboard() {
  try {
    const result = await getDashboard();
    console.log('Dashboard stats:', result.stats);
    document.getElementById('totalUsers').textContent = result.stats.totalUsers;
    document.getElementById('totalBalance').textContent = `$${result.stats.totalBalance.toFixed(2)}`;
  } catch (error) {
    console.error('Failed to load dashboard:', error);
  }
}

*/

// ==================== EXPORT FOR USE ====================
// Include this script in your HTML:
// <script src="firebase-api-helper.js"></script>
// Then use functions like: firebaseAPI(), registerUser(), etc.
