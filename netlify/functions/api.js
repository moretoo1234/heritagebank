/**
 * Netlify Function: Express API Wrapper
 * Routes all /api/* requests to the Express backend
 */

const serverless = require('serverless-http');
const path = require('path');

// Initialize Firebase Admin once at cold start
let admin;
let db;
let auth;
let app;

async function initializeApp() {
  if (app) return app;

  // Load Firebase Admin SDK
  admin = require('firebase-admin');
  
  // Load environment variables
  require('dotenv').config({ 
    path: path.join(__dirname, '../../backend/.env') 
  });

  let serviceAccount;

  // Try to load from environment variable (Netlify uses this)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error('❌ Could not parse FIREBASE_SERVICE_ACCOUNT env var:', err.message);
      throw err;
    }
  } else {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable not set');
  }

  // Initialize Firebase Admin
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  db = admin.firestore();
  auth = admin.auth();

  // Load Express app
  const express = require('express');
  const cors = require('cors');
  const bodyParser = require('body-parser');
  const helmet = require('helmet');
  const rateLimit = require('express-rate-limit');
  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const crypto = require('crypto');

  app = express();
  app.set('etag', false);

  // Constants
  const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@heritagebank.com';
  const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@heritagebank.com';

  // Rate limiting
  const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

  // CORS - Allow Netlify domain
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const DEFAULT_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173'
  ];

  app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      const allOrigins = [...ALLOWED_ORIGINS, ...DEFAULT_ORIGINS];
      if (allOrigins.indexOf(origin) !== -1) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use('/api/', apiLimiter);
  app.use(bodyParser.json({ limit: '1mb' }));

  // ============ HELPERS ============

  // JWT Token Verification
  function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.userId = decoded.userId;
      req.userEmail = decoded.email;
      next();
    } catch (err) {
      res.status(401).json({ success: false, message: 'Invalid token' });
    }
  }

  // Create JWT token
  function createToken(userId, email) {
    return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '7d' });
  }

  // ============ AUTH ENDPOINTS ============

  app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
      const { firstName, lastName, email, password, phone } = req.body;

      if (!email || !password || !firstName || !lastName) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      // Create Firebase Auth user
      const firebaseUser = await auth.createUser({
        email,
        password,
        displayName: `${firstName} ${lastName}`
      });

      // Create Firestore user document
      const accountNumber = 'ACC' + crypto.randomBytes(8).toString('hex').toUpperCase();
      
      await db.collection('users').doc(firebaseUser.uid).set({
        firstName,
        lastName,
        email: email.toLowerCase(),
        phone: phone || '',
        accountNumber,
        balance: 0,
        accountType: 'checking',
        accountStatus: 'active',
        isAdmin: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: null
      });

      const token = createToken(firebaseUser.uid, email);

      res.status(201).json({
        success: true,
        message: 'Account created successfully',
        token,
        user: {
          userId: firebaseUser.uid,
          email,
          firstName,
          lastName,
          accountNumber
        }
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password required' });
      }

      // Verify with Firebase Auth
      try {
        const userRecord = await auth.getUserByEmail(email);
        
        // Get user from Firestore
        const userDoc = await db.collection('users').doc(userRecord.uid).get();
        if (!userDoc.exists) {
          return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const userData = userDoc.data();
        const token = createToken(userRecord.uid, email);

        // Update last login
        await db.collection('users').doc(userRecord.uid).update({
          lastLogin: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
          success: true,
          message: 'Login successful',
          token,
          user: {
            userId: userRecord.uid,
            email: userData.email,
            firstName: userData.firstName,
            lastName: userData.lastName,
            accountNumber: userData.accountNumber,
            balance: userData.balance
          }
        });
      } catch (err) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Backend is running', timestamp: new Date().toISOString() });
  });

  return app;
}

// Netlify Function handler
exports.handler = async (event, context) => {
  try {
    const expressApp = await initializeApp();
    const handler = serverless(expressApp);
    return await handler(event, context);
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, message: error.message })
    };
  }
};
