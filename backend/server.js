/**
 * Heritage Bank Backend API
 * Simple Express server without Firebase
 * Works with both Vercel and Railway
 * Build deployment marker: 2026-06-09T17:15:00Z - CSP with unsafe-inline enabled
 */

// ============ STARTUP DIAGNOSTICS ============
const fs = require('fs');
const path = require('path');

console.log('[STARTUP] Starting server initialization...');
console.log(`[STARTUP] Current working directory: ${process.cwd()}`);
console.log(`[STARTUP] Script directory: ${__dirname}`);
console.log(`[STARTUP] Node version: ${process.version}`);
console.log(`[STARTUP] NODE_ENV: ${process.env.NODE_ENV || 'not set (defaulting to development)'}`);

// Check if node_modules exists and list structure
const backendNodeModules = path.join(__dirname, 'node_modules');
const rootNodeModules = path.join(__dirname, '..', 'node_modules');
console.log(`[STARTUP] Checking backend node_modules: ${backendNodeModules}`);
console.log(`[STARTUP] Backend node_modules exists: ${fs.existsSync(backendNodeModules)}`);
console.log(`[STARTUP] Checking root node_modules: ${rootNodeModules}`);
console.log(`[STARTUP] Root node_modules exists: ${fs.existsSync(rootNodeModules)}`);

// Try to load dependencies
console.log('[STARTUP] Attempting to load dependencies...');
const express = require('express');
console.log('[STARTUP] ✓ express loaded');
const cors = require('cors');
console.log('[STARTUP] ✓ cors loaded');
const bodyParser = require('body-parser');
console.log('[STARTUP] ✓ body-parser loaded');
const helmet = require('helmet');
console.log('[STARTUP] ✓ helmet loaded');
const rateLimit = require('express-rate-limit');
console.log('[STARTUP] ✓ express-rate-limit loaded');
const bcrypt = require('bcryptjs');
console.log('[STARTUP] ✓ bcryptjs loaded');
const jwt = require('jsonwebtoken');
console.log('[STARTUP] ✓ jsonwebtoken loaded');
const db = require('./db');
console.log('[STARTUP] ✓ database module loaded');

console.log('[STARTUP] All dependencies loaded successfully!');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@heritage.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123!@';

console.log(`[STARTUP] Port configured: ${PORT}`);
console.log('[STARTUP] JWT_SECRET: ' + (process.env.JWT_SECRET ? 'set' : 'using default'));
console.log('[STARTUP] Admin email: ' + (process.env.ADMIN_EMAIL ? 'set from env' : 'using default'));

// Database initialization (replaces in-memory Map)
console.log('[STARTUP] Database will be initialized on server start');

console.log('[STARTUP] Setting up middleware...');

// Middleware
// Disable helmet's CSP (we'll set our own custom policy that allows inline scripts)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    // Disable default CSP directives - we'll set them explicitly below
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrcAttr: ["'self'", "'unsafe-inline'"],  // Allow inline event handlers like onclick=
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
}));
console.log('[MIDDLEWARE] ✓ helmet configured with unsafe-inline scripts');

app.use(cors({
  origin: function(origin, callback) {
    // Define allowed origins - both local dev and production
    const allowedOrigins = [
      'http://localhost:3001',
      'http://localhost:5173',
      'http://127.0.0.1:3001',
      'https://heritage.up.railway.app',
      'https://heritagebank-production.up.railway.app',
      'https://heritagebank.up.railway.app'
    ];
    
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.warn(`[CORS] Rejected request from origin: ${origin}`);
      return callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  exposedHeaders: ['Content-Type', 'Authorization']
}));
console.log('[MIDDLEWARE] ✓ CORS configured');

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
console.log('[MIDDLEWARE] ✓ Body parser configured');

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later'
});
app.use('/api/', apiLimiter);
console.log('[MIDDLEWARE] ✓ Rate limiting configured');

// Request timeout middleware (30 seconds for all endpoints)
app.use((req, res, next) => {
  req.setTimeout(30000); // 30 second timeout for all requests
  res.setTimeout(30000);
  next();
});
console.log('[MIDDLEWARE] ✓ Request timeout middleware configured (30s)');

// ========== COMPREHENSIVE REQUEST LOGGING MIDDLEWARE ==========
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  
  // Log incoming request
  console.log(`[REQUEST_IN] [${requestId}] ${req.method} ${req.path} - Query: ${JSON.stringify(req.query)}`);
  
  // Capture response
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    console.log(`[REQUEST_OUT] [${requestId}] ${req.method} ${req.path} -> STATUS ${res.statusCode} (${duration}ms)`);
    
    // Log response body for debugging (first 200 chars)
    if (typeof data === 'string' && data.length > 0) {
      const preview = data.substring(0, 200);
      console.log(`[REQUEST_OUT] [${requestId}] Response preview: ${preview}${data.length > 200 ? '...' : ''}`);
    }
    
    return originalSend.call(this, data);
  };
  
  next();
});
console.log('[MIDDLEWARE] ✓ Comprehensive request logging configured');

console.log('[STARTUP] Setting up routes...');

// ============ ROUTES ============

// Favicon - simple transparent PNG (prevents 404 errors)
app.get('/favicon.ico', (req, res) => {
  const favicon = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  res.type('image/png').send(favicon);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: 'fb1609f'  // Latest commit for tracking deployed version
  });
});

// Diagnostic endpoint - lists all registered routes
app.get('/api/diagnostic', (req, res) => {
  const routes = [];
  app._router.stack.forEach(middleware => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods);
      routes.push({
        path: middleware.route.path,
        methods: methods.map(m => m.toUpperCase())
      });
    } else if (middleware.name === 'router' && middleware.handle._stack) {
      middleware.handle._stack.forEach(handler => {
        if (handler.route) {
          const methods = Object.keys(handler.route.methods);
          routes.push({
            path: handler.route.path,
            methods: methods.map(m => m.toUpperCase())
          });
        }
      });
    }
  });
  
  res.json({
    status: 'ok',
    backend: 'running',
    timestamp: new Date().toISOString(),
    totalRoutes: routes.length,
    routes: routes.filter(r => r.path && r.path.startsWith('/api')).sort((a, b) => a.path.localeCompare(b.path))
  });
});

// Test endpoint
app.get('/api/test-register', (req, res) => {
  res.json({ message: 'Test endpoint works - code deployed at version fb1609f' });
});

// Register endpoint
app.post('/api/auth/register', async (req, res) => {
  const REGISTRATION_MARKER = `[REGISTER_ENDPOINT_v${Date.now()}]`;
  console.log(REGISTRATION_MARKER, 'ENDPOINT CALLED - START');
  try {
    console.log('[API] ====== REGISTER START ======');
    const { email, password, firstName, lastName, phone, gender } = req.body;
    console.log('[API] Step 1: Received request for', email);

    // Validation
    if (!email || !password || !firstName || !lastName) {
      console.log('[API] Step 1: Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: email, password, firstName, lastName'
      });
    }
    console.log('[API] Step 2: Validation passed');

    // Check if user exists
    console.log('[API] Step 3: Checking if user exists...');
    const existingUser = await db.getUserByEmail(email);
    console.log('[API] Step 4: getUserByEmail returned:', existingUser ? 'user found' : 'no user');
    if (existingUser) {
      console.log('[API] User already exists');
      return res.status(409).json({
        success: false,
        message: 'Email already registered'
      });
    }
    console.log('[API] Step 5: User does not exist, proceeding');

    // Hash password
    console.log('[API] Step 6: Hashing password...');
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('[API] Step 7: Password hashed');

    // Store user in database
    console.log('[API] Step 8: Creating user in database...');
    const user = await db.createUser(null, email, firstName, lastName, hashedPassword, false, phone, gender);
    console.log('[API] Step 9: User created, id:', user?.id);

    // Generate JWT
    console.log('[API] Step 10: Generating JWT...');
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    console.log('[API] Step 11: JWT generated');

    console.log('[API] Step 12: Sending success response');
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isAdmin: user.isAdmin || false
      },
      token
    });
    console.log('[API] ====== REGISTER END (SUCCESS) ======');
  } catch (error) {
    console.error('[API] ======= REGISTRATION ERROR =======');
    console.error('[API] Error message:', error.message);
    console.error('[API] Stack:', error.stack);
    
    res.status(500).json({
      success: false,
      message: 'Error_' + error.message.substring(0, 50),
      errno: error.errno,
      code: error.code
    });
    console.log('[API] ====== REGISTER END (ERROR) ======');
  }
});

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('[API] Login attempt for:', email);

    if (!email || !password) {
      console.log('[API] Missing email or password');
      return res.status(400).json({
        success: false,
        message: 'Email and password required'
      });
    }

    // Find user in database
    const user = await db.getUserByEmail(email);
    if (!user) {
      console.log('[API] User not found:', email);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if user is locked
    if (user.isLocked) {
      console.log('[API] User account is locked:', email);
      return res.status(403).json({
        success: false,
        message: 'Account is locked. Please contact support.'
      });
    }

    // Check password
    const passwordHash = user.passwordHash || user.password;
    const passwordMatch = await bcrypt.compare(password, passwordHash);
    if (!passwordMatch) {
      console.log('[API] Password mismatch for:', email);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('[API] Login successful for:', email, '- Token generated');
    res.set('Content-Type', 'application/json');
    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        balance: parseFloat(user.balance),
        isAdmin: user.isAdmin || false
      },
      token
    });
  } catch (error) {
    console.error('[API] Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user profile (requires auth)
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const user = await db.getUserByEmail(req.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        balance: parseFloat(user.balance),
        isAdmin: user.isAdmin || false,
        createdAt: user.createdAt,
        // Expose account identifiers for the frontend dashboard. The frontend
        // expects `accountNumber` to be present (full value) so it can render
        // a masked display and allow the user to toggle visibility. To avoid
        // silently breaking the UI we provide the stored accountNumber here
        // (authenticated request only). In production you may decide to only
        // return a masked value depending on security policy.
        accountNumber: user.accountNumber || null,
        routingNumber: user.routingNumber || null,
        swiftCode: user.swiftCode || null
      }
    });
  } catch (error) {
    console.error('[API] Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get complete user profile (for settings page)
app.get('/api/user/profile/complete', authenticateToken, async (req, res) => {
  try {
    const user = await db.getUserByEmail(req.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        balance: parseFloat(user.balance),
        isAdmin: user.isAdmin || false,
        createdAt: user.createdAt,
        accountNumber: user.accountNumber || null,
        routingNumber: user.routingNumber || null,
        swiftCode: user.swiftCode || null,
        phoneNumber: user.phoneNumber || '',
        address: user.address || '',
        city: user.city || '',
        state: user.state || '',
        zipCode: user.zipCode || ''
      }
    });
  } catch (error) {
    console.error('[API] Complete profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch complete profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get dashboard data
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const user = await db.getUserByEmail(req.user.email);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const transactions = await db.getUserTransactions(user.id, 10);

    res.json({
      success: true,
      data: {
        accountBalance: parseFloat(user.balance),
        accountType: 'Checking',
        accountNumber: user.accountNumber
          ? '****' + String(user.accountNumber).slice(-4)
          : '****' + String(user.id).slice(-4),
        recentTransactions: transactions.map(tx => ({
          id: tx.id,
          type: tx.type,
          amount: parseFloat(tx.amount),
          date: tx.createdAt,
          description: tx.description
        }))
      }
    });
  } catch (error) {
    console.error('[API] Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Admin check middleware
async function requireAdmin(req, res, next) {
  try {
    const user = await db.getUserByEmail(req.user.email);
    if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Admin access required' });
    next();
  } catch (e) {
    console.error('[ADMIN] requireAdmin error', e);
    res.status(500).json({ success: false, message: 'Admin check failed' });
  }
}

// Minimal admin endpoints used by admin dashboard
app.get('/api/admin/dashboard-stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    const totalUsers = users.length;
    const totalBalance = users.reduce((s, u) => s + (parseFloat(u.balance || 0) || 0), 0);
    res.json({ success: true, stats: {
      totalUsers,
      totalBalance,
      todayTransactions: 0,
      pendingLoans: 0,
      pendingDeposits: 0,
      newContactMessages: 0,
      monthlyVolume: 0,
      activeUsers: totalUsers
    }});
  } catch (e) {
    console.error('[ADMIN] dashboard-stats error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats' });
  }
});

app.get('/api/admin/users-with-balances', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    const mapped = users.map(u => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      balance: parseFloat(u.balance || 0),
      accountNumber: u.accountNumber || null,
      accountStatus: u.accountStatus || 'active',
      transferRestricted: !!u.transferRestricted
    }));
    res.json({ success: true, users: mapped });
  } catch (e) {
    console.error('[ADMIN] users-with-balances error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});

app.get('/api/transactions/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const pool = await db.initializePool();
    const connection = await pool.getConnection();
    try {
      const [transactions] = await connection.execute(
        'SELECT * FROM transactions ORDER BY createdAt DESC LIMIT 200'
      );
      res.json({ success: true, transactions });
    } finally {
      await connection.release();
    }
  } catch (e) {
    console.error('[ADMIN] transactions/all error', e);
    res.status(500).json({ success: false, message: 'Failed to load transactions' });
  }
});

app.get('/api/admin/activity-logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const pool = await db.initializePool();
    const connection = await pool.getConnection();
    try {
      let logs = [];
      try {
        const [rows] = await connection.execute(
          'SELECT al.id, al.user_id, al.action_type, al.action_details, al.ip_address, al.created_at, u.firstName, u.lastName FROM activity_logs al LEFT JOIN users u ON al.user_id = u.id ORDER BY al.created_at DESC LIMIT 100'
        );
        logs = rows.map(row => ({
          id: row.id,
          user_id: row.user_id,
          userName: row.firstName && row.lastName ? `${row.firstName} ${row.lastName}` : null,
          action_type: row.action_type,
          action_details: row.action_details,
          ip_address: row.ip_address,
          created_at: row.created_at
        }));
      } catch (activityError) {
        if (!String(activityError.message).includes('activity_logs')) {
          throw activityError;
        }
        // Fallback to recent transactions if activity_logs table is absent.
        const [txRows] = await connection.execute(
          'SELECT t.id, t.fromUserId, t.toUserId, t.type, t.description, t.status, t.createdAt FROM transactions t ORDER BY t.createdAt DESC LIMIT 100'
        );
        logs = txRows.map(row => ({
          id: `tx_${row.id}`,
          user_id: row.fromUserId || row.toUserId || null,
          userName: null,
          action_type: row.type || 'transaction',
          action_details: row.description || '',
          ip_address: 'N/A',
          created_at: row.createdAt
        }));
      }
      res.json({ success: true, logs });
    } finally {
      await connection.release();
    }
  } catch (e) {
    console.error('[ADMIN] activity-logs error', e);
    res.status(500).json({ success: false, message: 'Failed to load activity logs' });
  }
});

app.get('/api/user/:userId/transactions', authenticateToken, async (req, res) => {
  try {
    const requestedUserId = Number(req.params.userId);
    if (!Number.isFinite(requestedUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }

    const currentUser = await db.getUserByEmail(req.user.email);
    if (!currentUser) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    const isAdmin = !!currentUser.isAdmin;
    if (!isAdmin && currentUser.id !== requestedUserId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const transactions = await db.getUserTransactions(requestedUserId, 100);
    
    // Calculate running balance for each transaction
    const user = await db.getUserById(requestedUserId);
    let runningBalance = user.balance;
    
    const txnsWithBalance = transactions.map(tx => {
      const amount = Number(tx.amount) || 0;
      const isCredit = tx.toUserId === requestedUserId;
      const previousBalance = isCredit ? runningBalance - amount : runningBalance + amount;
      runningBalance = previousBalance;
      
      return {
        ...tx,
        balanceAfter: runningBalance,
        balanceBefore: previousBalance,
        direction: isCredit ? 'credit' : 'debit',
        amountFormatted: `$${amount.toFixed(2)}`
      };
    });
    
    res.json({ success: true, transactions: txnsWithBalance });
  } catch (e) {
    console.error('[API] user transactions error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

app.get('/api/user/:userId/activity', authenticateToken, async (req, res) => {
  try {
    const requestedUserId = Number(req.params.userId);
    if (!Number.isFinite(requestedUserId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }

    const currentUser = await db.getUserByEmail(req.user.email);
    if (!currentUser) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    const isAdmin = !!currentUser.isAdmin;
    if (!isAdmin && currentUser.id !== requestedUserId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const pool = await db.initializePool();
    const connection = await pool.getConnection();
    try {
      let activities = [];
      try {
        const [logRows] = await connection.execute(
          'SELECT id, user_id, action_type, action_details, ip_address, created_at FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
          [requestedUserId]
        );
        activities = logRows.map(row => ({
          id: `log_${row.id}`,
          user_id: row.user_id,
          action: row.action_type,
          description: row.action_details,
          ip_address: row.ip_address,
          timestamp: row.created_at
        }));
      } catch (activityError) {
        if (!String(activityError.message).includes('activity_logs')) {
          throw activityError;
        }
      }

      const transactions = await db.getUserTransactions(requestedUserId, 50);
      const transactionActivities = transactions.map(tx => ({
        id: `tx_${tx.id}`,
        user_id: tx.fromUserId === requestedUserId ? tx.fromUserId : tx.toUserId,
        action: tx.fromUserId === requestedUserId ? `Outgoing ${tx.type || 'transaction'}` : `Incoming ${tx.type || 'transaction'}`,
        description: tx.description || '',
        timestamp: tx.createdAt || tx.created_at,
        transactionId: tx.id
      }));

      activities = [...activities, ...transactionActivities]
        .filter(a => a.timestamp)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 50);

      res.json({ success: true, activities });
    } finally {
      await connection.release();
    }
  } catch (e) {
    console.error('[API] user activity error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch activity' });
  }
});

// ============ NOTIFICATIONS ENDPOINTS ============
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const currentUser = await db.getUserByEmail(req.user.email);
    
    if (!currentUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Get user-specific notifications from transactions
    const [transactions] = await db.pool.query(
      'SELECT * FROM transactions WHERE fromUserId = ? OR toUserId = ? ORDER BY createdAt DESC LIMIT ?',
      [currentUser.id, currentUser.id, limit]
    );
    
    // Build notifications from user's transactions only
    const notifications = (transactions || []).map(tx => {
      let message = '';
      if (tx.fromUserId === currentUser.id) {
        message = `You transferred $${parseFloat(tx.amount).toFixed(2)}`;
      } else {
        message = `You received $${parseFloat(tx.amount).toFixed(2)}`;
      }
      return {
        id: tx.id,
        type: 'transaction',
        title: 'Transaction ' + (tx.status === 'completed' ? 'Completed' : 'Pending'),
        message: message,
        amount: tx.amount,
        read: false,
        createdAt: tx.createdAt
      };
    });
    
    // Add account notifications only for this user
    if (currentUser.createdAt) {
      const daysSinceCreation = Math.floor((Date.now() - new Date(currentUser.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSinceCreation === 0) {
        notifications.unshift({
          id: 0,
          type: 'account',
          title: 'Welcome',
          message: 'Welcome to Heritage Bank! Your account is now active.',
          read: false,
          createdAt: new Date()
        });
      }
    }
    
    res.json({ success: true, notifications: notifications.slice(0, limit) });
  } catch (e) {
    console.error('[API] notifications error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
});

app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (e) {
    console.error('[API] read-all notifications error', e);
    res.status(500).json({ success: false, message: 'Failed to mark notifications as read' });
  }
});

// ============ SAVINGS GOALS ENDPOINTS ============
app.get('/api/savings-goals', authenticateToken, async (req, res) => {
  try {
    const currentUser = await db.getUserByEmail(req.user.email);
    
    // Mock savings goals
    const goals = [
      { id: 1, name: 'Emergency Fund', targetAmount: 10000, currentAmount: 5234.50, deadline: '2026-12-31', created: new Date() },
      { id: 2, name: 'Vacation', targetAmount: 5000, currentAmount: 2100.00, deadline: '2026-08-31', created: new Date() }
    ];
    
    res.json({ success: true, goals });
  } catch (e) {
    console.error('[API] savings-goals error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch savings goals' });
  }
});

// ============ TRANSACTION RECEIPT ENDPOINT ============
app.get('/api/transactions/:id/receipt', authenticateToken, async (req, res) => {
  try {
    const transactionId = req.params.id;
    const currentUser = await db.getUserByEmail(req.user.email);
    
    // In production, generate PDF here
    res.json({
      success: true,
      receipt: {
        id: transactionId,
        transactionNumber: `TXN-${transactionId}`,
        date: new Date().toISOString(),
        amount: 500.00,
        type: 'Transfer',
        status: 'Completed',
        from: currentUser.email,
        to: 'recipient@bank.com'
      }
    });
  } catch (e) {
    console.error('[API] transaction receipt error', e);
    res.status(500).json({ success: false, message: 'Failed to generate receipt' });
  }
});

// ============ BULK PAYMENTS ENDPOINTS ============
app.post('/api/bulk-payments/upload', authenticateToken, async (req, res) => {
  try {
    // Mock file upload handler
    res.json({ 
      success: true, 
      batchId: `BATCH-${Date.now()}`,
      message: 'File uploaded successfully',
      preview: {
        totalRecords: 10,
        estimatedAmount: 50000.00
      }
    });
  } catch (e) {
    console.error('[API] bulk-payments upload error', e);
    res.status(500).json({ success: false, message: 'Failed to upload file' });
  }
});

app.get('/api/bulk-payments/template/sample', authenticateToken, async (req, res) => {
  try {
    // Return CSV template
    const template = 'Recipient Email,Amount,Description\nexample@bank.com,500.00,Payment for services\ntest@bank.com,1000.00,Transfer to account';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=bulk-payments-template.csv');
    res.send(template);
  } catch (e) {
    console.error('[API] bulk-payments template error', e);
    res.status(500).json({ success: false, message: 'Failed to generate template' });
  }
});

app.post('/api/bulk-payments/:batchId/execute', authenticateToken, async (req, res) => {
  try {
    const batchId = req.params.batchId;
    res.json({
      success: true,
      message: 'Bulk payment executed successfully',
      batchId,
      results: {
        total: 10,
        successful: 10,
        failed: 0,
        totalAmount: 50000.00
      }
    });
  } catch (e) {
    console.error('[API] bulk-payments execute error', e);
    res.status(500).json({ success: false, message: 'Failed to execute bulk payment' });
  }
});

app.get('/api/bulk-payments', authenticateToken, async (req, res) => {
  try {
    const batches = [
      { id: 'BATCH-1717944000000', date: new Date(), status: 'completed', count: 10, amount: 50000.00 },
      { id: 'BATCH-1717857600000', date: new Date(Date.now() - 86400000), status: 'completed', count: 5, amount: 25000.00 }
    ];
    res.json({ success: true, batches });
  } catch (e) {
    console.error('[API] bulk-payments list error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch bulk payments' });
  }
});

app.get('/api/bulk-payments/:batchId', authenticateToken, async (req, res) => {
  try {
    const batchId = req.params.batchId;
    res.json({
      success: true,
      batch: {
        id: batchId,
        date: new Date(),
        status: 'completed',
        records: [
          { email: 'user1@bank.com', amount: 500.00, status: 'completed' },
          { email: 'user2@bank.com', amount: 1000.00, status: 'completed' }
        ]
      }
    });
  } catch (e) {
    console.error('[API] bulk-payments detail error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch batch details' });
  }
});

// ============ ANALYTICS ENDPOINTS ============
app.get('/api/analytics', authenticateToken, async (req, res) => {
  try {
    const period = req.query.period || 'monthly';
    const currentUser = await db.getUserByEmail(req.user.email);
    
    res.json({
      success: true,
      period,
      analytics: {
        totalIncome: 50000.00,
        totalExpense: 15000.00,
        netChange: 35000.00,
        transactionCount: 42,
        categoryBreakdown: {
          'Salary': 50000.00,
          'Transfers': 12000.00,
          'Utilities': 3000.00
        }
      }
    });
  } catch (e) {
    console.error('[API] analytics error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
  }
});

// ============ CONTACT FORM ENDPOINTS ============
app.post('/api/contact', async (req, res) => {
  try {
    const { email, subject, message, name } = req.body;
    
    if (!email || !subject || !message) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Mock: log to console (in production, send email or store in DB)
    console.log(`[CONTACT] New message from ${name || email}: ${subject}`);
    
    res.json({
      success: true,
      message: 'Your message has been received. We will get back to you soon.',
      ticketId: `TICKET-${Date.now()}`
    });
  } catch (e) {
    console.error('[API] contact error', e);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

// ============ NEWSLETTER ENDPOINTS ============
app.post('/api/newsletter', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    
    console.log(`[NEWSLETTER] Subscribed: ${email}`);
    
    res.json({
      success: true,
      message: 'Successfully subscribed to our newsletter'
    });
  } catch (e) {
    console.error('[API] newsletter error', e);
    res.status(500).json({ success: false, message: 'Failed to subscribe' });
  }
});

// ============ ADDITIONAL ADMIN ENDPOINTS (from admin.html) ============
app.get('/api/admin/cards', authenticateToken, async (req, res) => {
  try {
    const query = req.query.q || '';
    res.json({ success: true, cards: [] });
  } catch (e) {
    console.error('[API] admin cards error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch cards' });
  }
});

app.get('/api/admin/search-users', authenticateToken, async (req, res) => {
  try {
    const query = req.query.query || '';
    res.json({ success: true, users: [] });
  } catch (e) {
    console.error('[API] admin search users error', e);
    res.status(500).json({ success: false, message: 'Failed to search users' });
  }
});

app.post('/api/admin/create-user', authenticateToken, async (req, res) => {
  try {
    res.json({ success: true, message: 'User created' });
  } catch (e) {
    console.error('[API] admin create user error', e);
    res.status(500).json({ success: false, message: 'Failed to create user' });
  }
});

app.get('/api/admin/pending-transactions', authenticateToken, async (req, res) => {
  try {
    res.json({ success: true, transactions: [] });
  } catch (e) {
    console.error('[API] admin pending transactions error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch pending transactions' });
  }
});

app.get('/api/admin/pending-transfers', authenticateToken, async (req, res) => {
  try {
    res.json({ success: true, transfers: [] });
  } catch (e) {
    console.error('[API] admin pending transfers error', e);
    res.status(500).json({ success: false, message: 'Failed to fetch pending transfers' });
  }
});

// ============ TRANSFER & PAYMENT ENDPOINTS ============

// User-to-user transfer
app.post('/api/user/transfer', authenticateToken, async (req, res) => {
  try {
    const { recipientEmail, amount, description } = req.body;
    const currentUser = await db.getUserByEmail(req.user.email);
    
    if (!recipientEmail || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid transfer details' });
    }
    
    const recipient = await db.getUserByEmail(recipientEmail);
    if (!recipient) {
      return res.status(404).json({ success: false, message: 'Recipient not found' });
    }
    
    if (currentUser.balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }
    
    // Create transaction record
    const pool = await db.initializePool();
    const connection = await pool.getConnection();
    try {
      const transactionId = `TXN-${Date.now()}`;
      
      // Debit from sender
      await connection.execute(
        'UPDATE users SET balance = balance - ? WHERE id = ?',
        [amount, currentUser.id]
      );
      
      // Credit to recipient
      await connection.execute(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [amount, recipient.id]
      );
      
      // Log transaction
      await connection.execute(
        'INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [currentUser.id, recipient.id, amount, 'transfer', description || 'User transfer', 'completed']
      );
      
      console.log(`[TRANSFER] ${currentUser.email} -> ${recipientEmail}: $${amount}`);
      
      res.json({
        success: true,
        message: 'Transfer completed successfully',
        transactionId,
        from: currentUser.email,
        to: recipientEmail,
        amount,
        timestamp: new Date().toISOString()
      });
    } finally {
      await connection.release();
    }
  } catch (e) {
    console.error('[API] user transfer error', e);
    res.status(500).json({ success: false, message: 'Transfer failed: ' + e.message });
  }
});

// Admin transfer (admin to user or between users)
app.post('/api/admin/transfer', authenticateToken, async (req, res) => {
  try {
    const currentUser = await db.getUserByEmail(req.user.email);
    if (!currentUser.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    
    const { fromEmail, toEmail, amount, description, reason } = req.body;
    
    if (!toEmail || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid transfer details' });
    }
    
    const recipient = await db.getUserByEmail(toEmail);
    if (!recipient) {
      return res.status(404).json({ success: false, message: 'Recipient not found' });
    }
    
    const pool = await db.initializePool();
    const connection = await pool.getConnection();
    try {
      if (fromEmail) {
        // Transfer from one user to another
        const sender = await db.getUserByEmail(fromEmail);
        if (!sender) {
          return res.status(404).json({ success: false, message: 'Sender not found' });
        }
        
        if (sender.balance < amount) {
          return res.status(400).json({ success: false, message: 'Sender has insufficient balance' });
        }
        
        await connection.execute(
          'UPDATE users SET balance = balance - ? WHERE id = ?',
          [amount, sender.id]
        );
      }
      
      // Credit to recipient
      await connection.execute(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [amount, recipient.id]
      );
      
      // Log transaction
      const senderId = fromEmail ? (await db.getUserByEmail(fromEmail)).id : 1; // 1 is admin
      await connection.execute(
        'INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [senderId, recipient.id, amount, 'admin_transfer', description || reason || 'Admin transfer', 'completed']
      );
      
      console.log(`[ADMIN_TRANSFER] Admin -> ${toEmail}: $${amount} (${reason || description || 'no reason'})`);
      
      res.json({
        success: true,
        message: 'Admin transfer completed successfully',
        to: toEmail,
        amount,
        timestamp: new Date().toISOString()
      });
    } finally {
      await connection.release();
    }
  } catch (e) {
    console.error('[API] admin transfer error', e);
    res.status(500).json({ success: false, message: 'Admin transfer failed: ' + e.message });
  }
});

// Admin credit account
app.post('/api/admin/credit-account', authenticateToken, async (req, res) => {
  try {
    const currentUser = await db.getUserByEmail(req.user.email);
    if (!currentUser.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    
    const { userId, amount, reason } = req.body;
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid credit details' });
    }
    
    const pool = await db.initializePool();
    const connection = await pool.getConnection();
    try {
      await connection.execute(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [amount, userId]
      );
      
      await connection.execute(
        'INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [1, userId, amount, 'admin_credit', reason || 'Account credit', 'completed']
      );
      
      console.log(`[ADMIN_CREDIT] User ${userId}: +$${amount} (${reason})`);
      
      res.json({
        success: true,
        message: 'Account credited successfully',
        userId,
        amount,
        timestamp: new Date().toISOString()
      });
    } finally {
      await connection.release();
    }
  } catch (e) {
    console.error('[API] admin credit error', e);
    res.status(500).json({ success: false, message: 'Credit failed: ' + e.message });
  }
});

// Admin debit account
app.post('/api/admin/debit-account', authenticateToken, async (req, res) => {
  try {
    const currentUser = await db.getUserByEmail(req.user.email);
    if (!currentUser.isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    
    const { userId, amount, reason } = req.body;
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid debit details' });
    }
    
    // Get user by ID first
    const user = await db.getUserById(userId);
    if (!user || user.balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }
    
    const pool = await db.initializePool();
    const connection = await pool.getConnection();
    try {
      
      await connection.execute(
        'UPDATE users SET balance = balance - ? WHERE id = ?',
        [amount, userId]
      );
      
      await connection.execute(
        'INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [userId, 1, amount, 'admin_debit', reason || 'Account debit', 'completed']
      );
      
      console.log(`[ADMIN_DEBIT] User ${userId}: -$${amount} (${reason})`);
      
      res.json({
        success: true,
        message: 'Amount debited successfully',
        userId,
        amount,
        timestamp: new Date().toISOString()
      });
    } finally {
      await connection.release();
    }
  } catch (e) {
    console.error('[API] admin debit error', e);
    res.status(500).json({ success: false, message: 'Debit failed: ' + e.message });
  }
});

// ============ STATIC FILES & SPA ============

// Serve static files from root directory
const rootPath = path.join(__dirname, '..');
console.log(`[STARTUP] Static files root path: ${rootPath}`);
console.log(`[STARTUP] Root directory exists: ${fs.existsSync(rootPath)}`);

const indexHtmlPath = path.join(rootPath, 'index.html');
console.log(`[STARTUP] index.html path: ${indexHtmlPath}`);
console.log(`[STARTUP] index.html exists: ${fs.existsSync(indexHtmlPath)}`);

app.use(express.static(rootPath, {
  maxAge: '1d',
  etag: false,
  index: ['index.html']
}));
console.log('[MIDDLEWARE] ✓ Static file serving configured');

// SPA fallback - serve index.html for non-API routes
app.get('*', (req, res, next) => {
  // If it's an API request, skip to next middleware
  if (req.path.startsWith('/api/')) {
    return next();
  }
  // Serve index.html for all other requests (SPA routing)
  res.sendFile(path.join(rootPath, 'index.html'));
});
console.log('[MIDDLEWARE] ✓ SPA fallback configured');

// ============ MIDDLEWARE ============

// Token authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(403).json({ success: false, message: 'Invalid token' });
  }
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    path: req.path
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============ SEED DATA ============
// Initialize default admin account for production
async function initializeSeedData() {
  try {
    const adminEmail = ADMIN_EMAIL;
    const existingAdmin = await db.getUserByEmail(adminEmail);
    
    if (!existingAdmin) {
      const adminPassword = ADMIN_PASSWORD;
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await db.createUser(null, adminEmail, 'Admin', 'Account', hashedPassword, true);
      console.log(`[SEED] ✓ Admin account initialized: ${adminEmail}`);
    } else {
      console.log('[SEED] ℹ Admin account already exists');
    }
  } catch (err) {
    console.error('[SEED] ✗ Failed to initialize seed data:', err);
    throw err;
  }
}

// ============ START SERVER ============

if (require.main === module) {
  // Initialize database, then seed data, then start server
  async function startup() {
    try {
      console.log('\n[STARTUP] *** DATABASE INITIALIZATION SEQUENCE ***\n');
      
      // Initialize database connection pool
      await db.initializePool();
      console.log('[STARTUP] ✓ Database connection pool ready');
      
      // Create tables if they don't exist
      await db.initializeSchema();
      console.log('[STARTUP] ✓ Database schema initialized');
      
      // Initialize seed data (admin account)
      await initializeSeedData();
      console.log('[STARTUP] ✓ Seed data initialized');
      
      console.log('[STARTUP] *** DATABASE INITIALIZATION COMPLETE ***\n');
      
      // Start server
      app.listen(PORT, '0.0.0.0', () => {
        console.log('\n========================================');
        console.log('[SERVER] ✓ Server started successfully!');
        console.log(`[SERVER] Listening on port: ${PORT}`);
        console.log(`[SERVER] Address: 0.0.0.0:${PORT}`);
        console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log('[SERVER] Health check: GET /api/health');
        console.log(`[SERVER] Timestamp: ${new Date().toISOString()}`);
        console.log('========================================\n');
      }).on('error', (err) => {
        console.error('[SERVER] ✗ Failed to start server:', err);
        process.exit(1);
      });
    } catch (error) {
      console.error('[STARTUP] ✗ Startup failed:', error);
      process.exit(1);
    }
  }
  
  startup();
}

module.exports = app;
// Force rebuild at 2026-06-09 13:07:04
// Force redeploy 06/09/2026 14:59:07
