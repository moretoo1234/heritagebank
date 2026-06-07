const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

admin.initializeApp();

const db = admin.firestore();
const ROUTING_NUMBER = '091238946';
const BANK_NAME = 'Heritage Bank';

// ==================== HELPERS ====================
function generateAccountNumber() {
  return (Math.floor(Math.random() * 9000000000) + 1000000000).toString();
}

function generateReferenceId(prefix = 'TXN') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

function sendJSON(res, data, statusCode = 200) {
  res.status(statusCode)
    .set('Content-Type', 'application/json')
    .set('Access-Control-Allow-Origin', '*')
    .set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    .set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    .json(data);
}

function handleCORS(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

async function requireAuth(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendJSON(res, { success: false, message: 'Authorization required' }, 401);
    return null;
  }
  
  const token = authHeader.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded;
  } catch (error) {
    sendJSON(res, { success: false, message: 'Invalid or expired token' }, 401);
    return null;
  }
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  
  const userDoc = await db.collection('users').doc(user.uid).get();
  if (!userDoc.exists || !userDoc.data().isAdmin) {
    sendJSON(res, { success: false, message: 'Admin access required' }, 403);
    return null;
  }
  return user;
}

// ==================== MAIN API HANDLER ====================
exports.api = functions.https.onRequest(async (req, res) => {
  if (handleCORS(req, res)) return;
  
  const path = req.path.replace(/^\/api/, '') || '/';
  const method = req.method;
  
  try {
    // ========== AUTH ENDPOINTS ==========
    if (path === '/auth/register' && method === 'POST') return handleRegister(req, res);
    if (path === '/auth/login' && method === 'POST') return handleLogin(req, res);
    if (path === '/auth/profile' && method === 'GET') return handleProfile(req, res);
    if (path === '/auth/change-password' && method === 'POST') return handleChangePassword(req, res);
    if (path === '/auth/forgot-password' && method === 'POST') return handleForgotPassword(req, res);
    if (path === '/auth/reset-password' && method === 'POST') return handleResetPassword(req, res);
    
    // ========== HEALTH CHECK ==========
    if (path === '/health') {
      return sendJSON(res, { status: 'ok', backend: 'Firebase Cloud Functions', database: 'Firestore' });
    }
    
    // ========== USER ENDPOINTS ==========
    if (path === '/user/profile' && method === 'GET') return handleGetProfile(req, res);
    if (path === '/user/balance' && method === 'GET') return handleGetBalance(req, res);
    if (path === '/user/transfers' && method === 'GET') return handleGetTransfers(req, res);
    if (path === '/user/transfer' && method === 'POST') return handleTransfer(req, res);
    if (path.match(/^\/user\/\d+\/transactions/) && method === 'GET') return handleUserTransactions(req, res);
    
    // ========== ADMIN ENDPOINTS ==========
    if (path === '/admin/users' && method === 'GET') return handleGetAllUsers(req, res);
    if (path === '/admin/transactions' && method === 'GET') return handleGetAllTransactions(req, res);
    if (path === '/admin/dashboard' && method === 'GET') return handleDashboard(req, res);
    if (path === '/admin/create-user' && method === 'POST') return handleCreateUser(req, res);
    if (path === '/admin/fund-user' && method === 'POST') return handleFundUser(req, res);
    if (path === '/admin/adjust-balance' && method === 'POST') return handleAdjustBalance(req, res);
    if (path === '/admin/transfer' && method === 'POST') return handleAdminTransfer(req, res);
    if (path.match(/^\/admin\/users\/\d+/) && method === 'DELETE') return handleDeleteUser(req, res);
    if (path.match(/^\/admin\/users\/\d+/) && method === 'GET') return handleGetUser(req, res);
    if (path.match(/^\/admin\/users\/\d+/) && method === 'PUT') return handleUpdateUser(req, res);
    
    sendJSON(res, { success: false, message: 'Endpoint not found' }, 404);
    
  } catch (error) {
    console.error('API Error:', error);
    sendJSON(res, { success: false, message: error.message }, 500);
  }
});

// ==================== AUTH HANDLERS ====================

async function handleRegister(req, res) {
  const { firstName, lastName, email, password, phone, accountType } = req.body;
  
  if (!firstName || !lastName || !email || !password) {
    return sendJSON(res, { success: false, message: 'All fields required' }, 400);
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    const accountNumber = generateAccountNumber();
    
    // Check if email exists in Firebase Auth
    const existingUser = await admin.auth().getUserByEmail(email).catch(() => null);
    if (existingUser) {
      return sendJSON(res, { success: false, message: 'Email already registered' }, 400);
    }
    
    // Create Firebase Auth user
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`
    });
    
    // Save to Firestore
    await db.collection('users').doc(userRecord.uid).set({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password: hashedPassword,
      phone: phone || '',
      accountNumber,
      routingNumber: ROUTING_NUMBER,
      balance: 0,
      accountType: accountType || 'checking',
      accountStatus: 'active',
      isAdmin: false,
      marketingConsent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLogin: null
    });
    
    sendJSON(res, {
      success: true,
      message: 'Registration successful',
      user: {
        id: userRecord.uid,
        firstName,
        lastName,
        email,
        accountNumber,
        accountType: accountType || 'checking'
      }
    }, 201);
    
  } catch (error) {
    console.error('Registration error:', error);
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleLogin(req, res) {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return sendJSON(res, { success: false, message: 'Email and password required' }, 400);
  }
  
  try {
    // Find user in Firestore
    const userSnapshot = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
    
    if (userSnapshot.empty) {
      return sendJSON(res, { success: false, message: 'Invalid credentials' }, 401);
    }
    
    const userDoc = userSnapshot.docs[0];
    const userData = userDoc.data();
    
    // Verify password
    const validPassword = await bcrypt.compare(password, userData.password || '');
    if (!validPassword) {
      return sendJSON(res, { success: false, message: 'Invalid credentials' }, 401);
    }
    
    // Check account status
    if (userData.accountStatus && userData.accountStatus !== 'active') {
      return sendJSON(res, { success: false, message: 'Account is ' + userData.accountStatus }, 401);
    }
    
    // Update last login
    await db.collection('users').doc(userDoc.id).update({
      lastLogin: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Create Firebase ID token
    const customClaims = {
      email: userData.email,
      isAdmin: userData.isAdmin || false
    };
    
    const idToken = await admin.auth().createCustomToken(userDoc.id, customClaims);
    
    const { password: _, ...safeUser } = userData;
    
    sendJSON(res, {
      success: true,
      token: idToken,
      user: {
        id: userDoc.id,
        ...safeUser
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    sendJSON(res, { success: false, message: 'Login failed' }, 500);
  }
}

async function handleProfile(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  try {
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (!userDoc.exists) {
      return sendJSON(res, { success: false, message: 'User not found' }, 404);
    }
    
    const { password: _, ...safeUser } = userDoc.data();
    sendJSON(res, { success: true, user: { id: userDoc.id, ...safeUser } });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleChangePassword(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return sendJSON(res, { success: false, message: 'Both passwords required' }, 400);
  }
  
  try {
    const userDoc = await db.collection('users').doc(user.uid).get();
    const userData = userDoc.data();
    
    const validPassword = await bcrypt.compare(currentPassword, userData.password);
    if (!validPassword) {
      return sendJSON(res, { success: false, message: 'Current password is incorrect' }, 401);
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await db.collection('users').doc(user.uid).update({ password: hashedPassword });
    
    sendJSON(res, { success: true, message: 'Password changed successfully' });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleForgotPassword(req, res) {
  const { email } = req.body;
  
  if (!email) {
    return sendJSON(res, { success: false, message: 'Email required' }, 400);
  }
  
  try {
    // Send password reset email via Firebase Auth
    await admin.auth().sendPasswordResetEmail(email);
    sendJSON(res, { success: true, message: 'Password reset email sent' });
    
  } catch (error) {
    // Don't reveal if email exists
    sendJSON(res, { success: true, message: 'If email exists, reset link will be sent' });
  }
}

async function handleResetPassword(req, res) {
  const { resetToken, newPassword } = req.body;
  
  if (!resetToken || !newPassword) {
    return sendJSON(res, { success: false, message: 'Reset token and new password required' }, 400);
  }
  
  try {
    // Verify the password reset token
    const decodedToken = await admin.auth().verifyPasswordResetCode(resetToken);
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    
    // Update password in Firestore
    const userSnapshot = await db.collection('users').where('email', '==', decodedToken.email).limit(1).get();
    if (userSnapshot.empty) {
      return sendJSON(res, { success: false, message: 'User not found' }, 404);
    }
    
    await db.collection('users').doc(userSnapshot.docs[0].id).update({ password: hashedPassword });
    
    // Confirm password reset
    await admin.auth().confirmPasswordReset(resetToken, newPassword);
    
    sendJSON(res, { success: true, message: 'Password reset successfully' });
    
  } catch (error) {
    sendJSON(res, { success: false, message: 'Invalid or expired reset token' }, 400);
  }
}

// ==================== USER HANDLERS ====================

async function handleGetProfile(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  try {
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (!userDoc.exists) {
      return sendJSON(res, { success: false, message: 'User not found' }, 404);
    }
    
    const userData = userDoc.data();
    delete userData.password;
    
    sendJSON(res, { success: true, user: { id: userDoc.id, ...userData } });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleGetBalance(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  try {
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (!userDoc.exists) {
      return sendJSON(res, { success: false, message: 'User not found' }, 404);
    }
    
    const userData = userDoc.data();
    sendJSON(res, {
      success: true,
      balance: userData.balance || 0,
      accountNumber: userData.accountNumber,
      name: `${userData.firstName} ${userData.lastName}`
    });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleGetTransfers(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  try {
    const transactionsRef = db.collection('transactions');
    const [fromTransactions, toTransactions] = await Promise.all([
      transactionsRef.where('fromUserId', '==', user.uid).orderBy('createdAt', 'desc').limit(50).get(),
      transactionsRef.where('toUserId', '==', user.uid).orderBy('createdAt', 'desc').limit(50).get()
    ]);
    
    const transactions = [];
    
    fromTransactions.forEach(doc => {
      transactions.push({
        id: doc.id,
        ...doc.data(),
        type: 'debit'
      });
    });
    
    toTransactions.forEach(doc => {
      transactions.push({
        id: doc.id,
        ...doc.data(),
        type: 'credit'
      });
    });
    
    // Sort by date
    transactions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    sendJSON(res, { success: true, transactions: transactions.slice(0, 100) });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleTransfer(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  const { toEmail, toAccountNumber, amount, description } = req.body;
  
  if ((!toEmail && !toAccountNumber) || !amount) {
    return sendJSON(res, { success: false, message: 'Recipient email/account and amount required' }, 400);
  }
  
  try {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return sendJSON(res, { success: false, message: 'Amount must be positive' }, 400);
    }
    
    // Get sender
    const fromUserDoc = await db.collection('users').doc(user.uid).get();
    const fromUser = fromUserDoc.data();
    
    if (!fromUser || (fromUser.balance || 0) < amountNum) {
      return sendJSON(res, { success: false, message: 'Insufficient balance' }, 400);
    }
    
    // Find recipient
    let toUser, toUserDoc;
    if (toEmail) {
      const toSnapshot = await db.collection('users').where('email', '==', toEmail.toLowerCase()).limit(1).get();
      if (toSnapshot.empty) {
        return sendJSON(res, { success: false, message: 'Recipient not found' }, 404);
      }
      toUserDoc = toSnapshot.docs[0];
      toUser = toUserDoc.data();
    } else if (toAccountNumber) {
      const toSnapshot = await db.collection('users').where('accountNumber', '==', toAccountNumber).limit(1).get();
      if (toSnapshot.empty) {
        return sendJSON(res, { success: false, message: 'Recipient not found' }, 404);
      }
      toUserDoc = toSnapshot.docs[0];
      toUser = toUserDoc.data();
    }
    
    // Perform transfer
    const batch = db.batch();
    const newFromBalance = (fromUser.balance || 0) - amountNum;
    const newToBalance = (toUser.balance || 0) + amountNum;
    
    batch.update(db.collection('users').doc(user.uid), { balance: newFromBalance });
    batch.update(db.collection('users').doc(toUserDoc.id), { balance: newToBalance });
    
    // Record transaction
    const transactionRef = db.collection('transactions').doc();
    batch.set(transactionRef, {
      fromUserId: user.uid,
      toUserId: toUserDoc.id,
      amount: amountNum,
      type: 'transfer',
      description: description || 'Transfer',
      status: 'completed',
      referenceId: generateReferenceId('TXN'),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await batch.commit();
    
    sendJSON(res, {
      success: true,
      message: 'Transfer completed',
      transaction: {
        id: transactionRef.id,
        from: `${fromUser.firstName} ${fromUser.lastName}`,
        to: `${toUser.firstName} ${toUser.lastName}`,
        amount: amountNum,
        status: 'completed',
        fromBalance: newFromBalance,
        toBalance: newToBalance
      }
    });
    
  } catch (error) {
    console.error('Transfer error:', error);
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleUserTransactions(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  
  try {
    const transactionsRef = db.collection('transactions');
    const [fromTransactions, toTransactions] = await Promise.all([
      transactionsRef.where('fromUserId', '==', user.uid).orderBy('createdAt', 'desc').limit(100).get(),
      transactionsRef.where('toUserId', '==', user.uid).orderBy('createdAt', 'desc').limit(100).get()
    ]);
    
    const transactions = [];
    
    fromTransactions.forEach(doc => {
      transactions.push({ id: doc.id, ...doc.data() });
    });
    
    toTransactions.forEach(doc => {
      transactions.push({ id: doc.id, ...doc.data() });
    });
    
    transactions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    sendJSON(res, { success: true, total: transactions.length, transactions });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

// ==================== ADMIN HANDLERS ====================

async function handleGetAllUsers(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  try {
    const usersSnapshot = await db.collection('users').limit(1000).get();
    const users = [];
    
    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      delete userData.password;
      users.push({ id: doc.id, ...userData });
    });
    
    sendJSON(res, { success: true, total: users.length, users });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleGetAllTransactions(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  try {
    const transactionsSnapshot = await db.collection('transactions').orderBy('createdAt', 'desc').limit(500).get();
    const transactions = [];
    
    transactionsSnapshot.forEach(doc => {
      transactions.push({ id: doc.id, ...doc.data() });
    });
    
    sendJSON(res, { success: true, total: transactions.length, transactions });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleDashboard(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  try {
    const usersSnapshot = await db.collection('users').get();
    const transactionsSnapshot = await db.collection('transactions').get();
    
    let totalBalance = 0;
    usersSnapshot.forEach(doc => {
      totalBalance += doc.data().balance || 0;
    });
    
    sendJSON(res, {
      success: true,
      stats: {
        totalUsers: usersSnapshot.size,
        totalTransactions: transactionsSnapshot.size,
        totalBalance,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleCreateUser(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  const { firstName, lastName, email, password, accountType, initialBalance } = req.body;
  
  if (!firstName || !lastName || !email) {
    return sendJSON(res, { success: false, message: 'First name, last name, and email required' }, 400);
  }
  
  try {
    const accountNumber = generateAccountNumber();
    const hashedPassword = await bcrypt.hash(password || 'TempPassword123!', 12);
    
    // Create Firebase Auth user
    const userRecord = await admin.auth().createUser({
      email,
      password: password || 'TempPassword123!',
      displayName: `${firstName} ${lastName}`
    });
    
    // Save to Firestore
    await db.collection('users').doc(userRecord.uid).set({
      firstName,
      lastName,
      email: email.toLowerCase(),
      password: hashedPassword,
      accountNumber,
      routingNumber: ROUTING_NUMBER,
      balance: parseFloat(initialBalance) || 0,
      accountType: accountType || 'checking',
      accountStatus: 'active',
      isAdmin: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    sendJSON(res, {
      success: true,
      message: 'User created successfully',
      user: {
        id: userRecord.uid,
        firstName,
        lastName,
        email,
        accountNumber,
        balance: parseFloat(initialBalance) || 0
      }
    }, 201);
    
  } catch (error) {
    console.error('Create user error:', error);
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleFundUser(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  const { toEmail, toAccountNumber, amount, description } = req.body;
  
  if ((!toEmail && !toAccountNumber) || !amount) {
    return sendJSON(res, { success: false, message: 'Recipient and amount required' }, 400);
  }
  
  try {
    const amountNum = parseFloat(amount);
    
    // Find recipient
    let toUserDoc;
    if (toEmail) {
      const toSnapshot = await db.collection('users').where('email', '==', toEmail.toLowerCase()).limit(1).get();
      if (toSnapshot.empty) {
        return sendJSON(res, { success: false, message: 'User not found' }, 404);
      }
      toUserDoc = toSnapshot.docs[0];
    } else {
      const toSnapshot = await db.collection('users').where('accountNumber', '==', toAccountNumber).limit(1).get();
      if (toSnapshot.empty) {
        return sendJSON(res, { success: false, message: 'User not found' }, 404);
      }
      toUserDoc = toSnapshot.docs[0];
    }
    
    const toUser = toUserDoc.data();
    const newBalance = (toUser.balance || 0) + amountNum;
    
    // Update balance
    await db.collection('users').doc(toUserDoc.id).update({ balance: newBalance });
    
    // Record transaction
    await db.collection('transactions').add({
      fromUserId: 'admin',
      toUserId: toUserDoc.id,
      amount: amountNum,
      type: 'admin-funding',
      description: description || 'Admin funding',
      status: 'completed',
      referenceId: generateReferenceId('FUND'),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    sendJSON(res, {
      success: true,
      message: 'Account funded successfully',
      user: {
        email: toUser.email,
        newBalance
      }
    });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleAdjustBalance(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  const { email, accountNumber, amount, type, reason } = req.body;
  
  if ((!email && !accountNumber) || amount === undefined || !type) {
    return sendJSON(res, { success: false, message: 'User identifier, amount, and type required' }, 400);
  }
  
  try {
    const amountNum = parseFloat(amount);
    
    // Find user
    let userDoc;
    if (email) {
      const snapshot = await db.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
      if (snapshot.empty) return sendJSON(res, { success: false, message: 'User not found' }, 404);
      userDoc = snapshot.docs[0];
    } else {
      const snapshot = await db.collection('users').where('accountNumber', '==', accountNumber).limit(1).get();
      if (snapshot.empty) return sendJSON(res, { success: false, message: 'User not found' }, 404);
      userDoc = snapshot.docs[0];
    }
    
    const user = userDoc.data();
    const newBalance = type === 'debit' ? (user.balance || 0) - amountNum : (user.balance || 0) + amountNum;
    
    await db.collection('users').doc(userDoc.id).update({ balance: newBalance });
    
    sendJSON(res, {
      success: true,
      message: 'Balance adjusted',
      user: { ...user, newBalance }
    });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleAdminTransfer(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  const { fromEmail, fromAccountNumber, toEmail, toAccountNumber, amount, description } = req.body;
  
  if ((!fromEmail && !fromAccountNumber) || (!toEmail && !toAccountNumber) || !amount) {
    return sendJSON(res, { success: false, message: 'From, to, and amount required' }, 400);
  }
  
  try {
    const amountNum = parseFloat(amount);
    
    // Find sender
    let fromUserDoc;
    if (fromEmail) {
      const snapshot = await db.collection('users').where('email', '==', fromEmail.toLowerCase()).limit(1).get();
      if (snapshot.empty) return sendJSON(res, { success: false, message: 'Sender not found' }, 404);
      fromUserDoc = snapshot.docs[0];
    } else {
      const snapshot = await db.collection('users').where('accountNumber', '==', fromAccountNumber).limit(1).get();
      if (snapshot.empty) return sendJSON(res, { success: false, message: 'Sender not found' }, 404);
      fromUserDoc = snapshot.docs[0];
    }
    
    // Find recipient
    let toUserDoc;
    if (toEmail) {
      const snapshot = await db.collection('users').where('email', '==', toEmail.toLowerCase()).limit(1).get();
      if (snapshot.empty) return sendJSON(res, { success: false, message: 'Recipient not found' }, 404);
      toUserDoc = snapshot.docs[0];
    } else {
      const snapshot = await db.collection('users').where('accountNumber', '==', toAccountNumber).limit(1).get();
      if (snapshot.empty) return sendJSON(res, { success: false, message: 'Recipient not found' }, 404);
      toUserDoc = snapshot.docs[0];
    }
    
    const fromUser = fromUserDoc.data();
    const toUser = toUserDoc.data();
    
    if ((fromUser.balance || 0) < amountNum) {
      return sendJSON(res, { success: false, message: 'Insufficient balance' }, 400);
    }
    
    // Perform transfer
    const batch = db.batch();
    const newFromBalance = (fromUser.balance || 0) - amountNum;
    const newToBalance = (toUser.balance || 0) + amountNum;
    
    batch.update(db.collection('users').doc(fromUserDoc.id), { balance: newFromBalance });
    batch.update(db.collection('users').doc(toUserDoc.id), { balance: newToBalance });
    
    batch.set(db.collection('transactions').doc(), {
      fromUserId: fromUserDoc.id,
      toUserId: toUserDoc.id,
      amount: amountNum,
      type: 'transfer',
      description: description || 'Admin transfer',
      status: 'completed',
      referenceId: generateReferenceId('TXN'),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await batch.commit();
    
    sendJSON(res, { success: true, message: 'Transfer completed' });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleDeleteUser(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  const userId = req.params[0];
  
  try {
    // Don't allow deleting admin accounts
    const userDoc = await db.collection('users').doc(userId).get();
    if (userDoc.data().isAdmin) {
      return sendJSON(res, { success: false, message: 'Cannot delete admin account' }, 403);
    }
    
    // Delete transactions related to this user
    const transactionsSnapshot = await db.collection('transactions')
      .where('fromUserId', 'in', [userId])
      .get();
    
    const batch = db.batch();
    transactionsSnapshot.forEach(doc => batch.delete(doc.ref));
    
    batch.delete(db.collection('users').doc(userId));
    await batch.commit();
    
    sendJSON(res, { success: true, message: 'User deleted' });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleGetUser(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  const userId = req.params[0];
  
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return sendJSON(res, { success: false, message: 'User not found' }, 404);
    }
    
    const userData = userDoc.data();
    delete userData.password;
    
    sendJSON(res, { success: true, user: { id: userDoc.id, ...userData } });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}

async function handleUpdateUser(req, res) {
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;
  
  const userId = req.params[0];
  const { firstName, lastName, email, phone, accountStatus } = req.body;
  
  try {
    const updateData = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;
    if (accountStatus) updateData.accountStatus = accountStatus;
    
    await db.collection('users').doc(userId).update(updateData);
    
    sendJSON(res, { success: true, message: 'User updated' });
    
  } catch (error) {
    sendJSON(res, { success: false, message: error.message }, 500);
  }
}
