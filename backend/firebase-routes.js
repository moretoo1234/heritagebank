/**
 * Firebase Authentication Routes
 * Add these endpoints to server.js via: require('./firebase-routes')(app);
 * 
 * Endpoints:
 * - POST /api/auth/firebase-sync: Sync Firebase user with backend
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

module.exports = function(app) {
  // Firebase sync endpoint - exchange Firebase token for JWT
  app.post('/api/auth/firebase-sync', async (req, res) => {
    try {
      const idToken = req.headers.authorization?.replace('Bearer ', '');
      
      if (!idToken) {
        return res.status(401).json({ success: false, message: 'No token provided' });
      }
      
      // Verify Firebase token (in production, verify with Firebase Admin SDK)
      // For now, we accept the token and extract user info from body
      const { action, email, displayName } = req.body;
      
      if (action === 'register') {
        // Check if user already exists
        const [existing] = await pool.execute(
          'SELECT id FROM users WHERE email = ?',
          [email]
        );
        
        if (existing.length > 0) {
          // User exists, just issue JWT
          const [user] = await pool.execute(
            'SELECT * FROM users WHERE email = ?',
            [email]
          );
          
          const token = jwt.sign(
            { id: user[0].id, email: user[0].email, isAdmin: user[0].isAdmin },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          
          return res.json({ success: true, token, user: user[0] });
        }
        
        // This would need more complete user data - redirect to registration flow
        return res.json({ 
          success: true, 
          needsRegistration: true,
          message: 'Please complete account setup' 
        });
      }
      
      // For login action, find or create user
      if (email) {
        const [users] = await pool.execute(
          'SELECT * FROM users WHERE email = ?',
          [email]
        );
        
        if (users.length === 0) {
          return res.status(404).json({ 
            success: false, 
            message: 'No account found. Please register first.' 
          });
        }
        
        const user = users[0];
        
        // Issue JWT token
        const token = jwt.sign(
          { id: user.id, email: user.email, isAdmin: user.isAdmin },
          JWT_SECRET,
          { expiresIn: '7d' }
        );
        
        return res.json({ success: true, token, user });
      }
      
      res.json({ success: false, message: 'Email required' });
      
    } catch (error) {
      console.error('Firebase sync error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  console.log('✅ Firebase auth routes loaded');
};
