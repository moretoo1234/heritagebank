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
  origin: ['http://localhost:3001', 'http://localhost:5173', 'http://127.0.0.1:3001', 'https://heritagebank-production.up.railway.app', '*'],
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
    environment: process.env.NODE_ENV || 'development'
  });
});

// Register endpoint
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Validation
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: email, password, firstName, lastName'
      });
    }

    // Check if user exists
    const existingUser = await db.getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Store user in database
    const user = await db.createUser(null, email, firstName, lastName, hashedPassword, false);

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

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
  } catch (error) {
    console.error('[API] Registration error for', req.body.email || 'unknown', ':', error.message);
    console.error('[API] Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Server error during registration',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
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
        createdAt: user.createdAt
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
