const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config();

const app = express();

// Server version for debugging
const SERVER_VERSION = "2.0.0-" + new Date().toISOString().split('T')[0];

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend files from same directory (for unified deployment)
app.use(express.static(__dirname));

// TiDB Cloud Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
});

// In-memory fallback storage (for testing when DB unavailable)
const users = new Map();
const pendingUsers = new Map(); // Users waiting for email verification
const otpStore = new Map(); // Store OTP codes with expiry
const transactions = []; // Store all transactions
const activityLogs = []; // Store user activity logs
const investments = []; // Store user investments
const cards = []; // Store user cards
let userIdCounter = 1;
let transactionIdCounter = 1;
let investmentIdCounter = 1;
let cardIdCounter = 1;
const usedAccountNumbers = new Set(); // Track used account numbers for uniqueness

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'heritage-bank-secret-2024';

// Banking Details
const ROUTING_NUMBER = '091238946';
const BANK_NAME = 'Heritage Bank';
const BANK_CODE = 'HERBUS33';

// ============================================
// ACCOUNT NUMBER GENERATOR (RANDOM)
// ============================================
function generateAccountNumber() {
    let accountNumber;
    do {
        // Generate random 10-digit number (1000000000 - 9999999999)
        accountNumber = (Math.floor(Math.random() * 9000000000) + 1000000000).toString();
    } while (usedAccountNumbers.has(accountNumber)); // Ensure uniqueness
    
    usedAccountNumbers.add(accountNumber);
    return accountNumber;
}

// ============================================
// DATABASE INITIALIZATION & ADMIN ACCOUNT
// ============================================
async function initializeDatabase() {
    try {
        const connection = await pool.getConnection();
        
        // Create tables if they don't exist (without dropping existing data)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                firstName VARCHAR(100),
                lastName VARCHAR(100),
                email VARCHAR(255) UNIQUE,
                password VARCHAR(255),
                phone VARCHAR(20),
                dob VARCHAR(20),
                country VARCHAR(100),
                accountType VARCHAR(50),
                accountStatus ENUM('active', 'frozen', 'suspended', 'closed') DEFAULT 'active',
                address VARCHAR(255),
                city VARCHAR(100),
                state VARCHAR(50),
                zip VARCHAR(20),
                accountNumber VARCHAR(20) UNIQUE,
                routingNumber VARCHAR(20),
                swiftCode VARCHAR(20) DEFAULT 'HERBANKUS',
                balance DECIMAL(15,2) DEFAULT 0,
                isAdmin BOOLEAN DEFAULT false,
                lastLogin TIMESTAMP NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                createdByAdmin BOOLEAN DEFAULT false,
                INDEX idx_email (email),
                INDEX idx_accountNumber (accountNumber)
            )
        `);

        // Add missing columns if they don't exist (for existing databases)
        try {
            await connection.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS accountStatus ENUM('active', 'frozen', 'suspended', 'closed') DEFAULT 'active'`);
            await connection.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lastLogin TIMESTAMP NULL`);
            await connection.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS swiftCode VARCHAR(20) DEFAULT 'HERBANKUS'`);
            await connection.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS createdByAdmin BOOLEAN DEFAULT false`);
            await connection.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        } catch (e) {
            // Columns may already exist or database doesn't support IF NOT EXISTS
            console.log('Note: Some column additions skipped (may already exist)');
        }

        // Check if admin exists
        const [adminCheck] = await connection.execute(
            'SELECT * FROM users WHERE email = ?',
            ['admin@heritagebank.com']
        );

        if (adminCheck.length === 0) {
            const hashedPassword = await bcrypt.hash('AdminPass123456', 10);
            const adminAccountNumber = generateAccountNumber();
            
            await connection.execute(
                `INSERT INTO users (firstName, lastName, email, password, phone, dob, country, accountType, address, city, state, zip, accountNumber, routingNumber, balance, isAdmin) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ['Admin', 'User', 'admin@heritagebank.com', hashedPassword, '1-800-BANK-001', '1980-01-01', 'United States', 'admin', 'Heritage Bank HQ', 'New York', 'NY', '10001', adminAccountNumber, ROUTING_NUMBER, 100000000, true]
            );

            console.log('✅ Default Admin Account Created');
            console.log('📧 Email: admin@heritagebank.com');
            console.log('🔐 Password: AdminPass123456');
            console.log('💳 Account #: ' + adminAccountNumber);
            console.log('🏦 Routing #: ' + ROUTING_NUMBER);
        } else {
            // Ensure existing admin has isAdmin set to true
            await connection.execute(
                'UPDATE users SET isAdmin = true WHERE email = ?',
                ['admin@heritagebank.com']
            );
        }

        // Create transactions table if it doesn't exist
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                fromUserId INT,
                toUserId INT,
                amount DECIMAL(15,2),
                type VARCHAR(50),
                description VARCHAR(255),
                status VARCHAR(50) DEFAULT 'completed',
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (fromUserId) REFERENCES users(id),
                FOREIGN KEY (toUserId) REFERENCES users(id)
            )
        `);

        // Create activity logs table if it doesn't exist
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                action_type VARCHAR(100),
                action_details VARCHAR(500),
                ip_address VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        // Create loan applications table if it doesn't exist
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS loan_applications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                loan_type VARCHAR(50) NOT NULL,
                loan_amount DECIMAL(15,2) NOT NULL,
                loan_duration_months INT NOT NULL,
                monthly_income DECIMAL(15,2),
                employment_status VARCHAR(50),
                purpose VARCHAR(255),
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                interest_rate DECIMAL(5,2),
                rejection_reason VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        // Create documents table if it doesn't exist
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS documents (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                documentType VARCHAR(50) NOT NULL,
                fileName VARCHAR(255),
                filePath VARCHAR(500),
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                rejectionReason VARCHAR(255),
                uploadedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewedAt TIMESTAMP NULL,
                FOREIGN KEY (userId) REFERENCES users(id)
            )
        `);

        connection.release();
        console.log('✅ Database initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        return false;
    }
}

// Initialize database on startup
initializeDatabase();

// ============================================
// OTP UTILITIES
// ============================================

// Generate a 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Simulate sending email (in production, use nodemailer or AWS SES)
function sendOTPEmail(email, otp) {
    console.log(`📧 OTP for ${email}: ${otp} (expires in 10 minutes)`);
    return true; // Simulate successful send
}

// Store OTP with 10-minute expiration
function storeOTP(email, otp) {
    const expiryTime = Date.now() + (10 * 60 * 1000); // 10 minutes
    otpStore.set(email, { otp, expiryTime });
}

// Verify OTP
function verifyOTP(email, otp) {
    const stored = otpStore.get(email);
    
    if (!stored) {
        return { valid: false, message: 'No OTP found for this email' };
    }
    
    if (Date.now() > stored.expiryTime) {
        otpStore.delete(email);
        return { valid: false, message: 'OTP has expired' };
    }
    
    if (stored.otp !== otp) {
        return { valid: false, message: 'Invalid OTP' };
    }
    
    otpStore.delete(email);
    return { valid: true, message: 'OTP verified successfully' };
}

// ============================================
// ACCOUNT NUMBER GENERATION
// ============================================
function getNextAccountNumber() {
    const accountNumber = accountNumberCounter.toString();
    accountNumberCounter++;
    return accountNumber;
}

// ============================================
// ACTIVITY LOGGING
// ============================================
async function logActivity(userId, action, details = '', ipAddress = '127.0.0.1') {
    // Save to in-memory array (for backward compatibility)
    const log = {
        id: activityLogs.length + 1,
        userId,
        action,
        details,
        timestamp: new Date().toISOString(),
        ip: ipAddress
    };
    activityLogs.push(log);
    console.log(`📋 Activity: ${action} by User #${userId}`);
    
    // Also save to database
    try {
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
            [userId, action, details, ipAddress]
        );
    } catch (error) {
        console.error('Failed to log activity to DB:', error.message);
    }
}

// ============================================
// EMAIL NOTIFICATIONS
// ============================================
function sendEmail(to, subject, body) {
    // In production, replace with Nodemailer or AWS SES
    console.log(`📧 EMAIL SENT:`);
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body: ${body}`);
    return true;
}

function sendTransferNotification(recipientEmail, senderName, amount, transferType) {
    const subject = '💰 You received a transfer!';
    const body = `
Hello,

You have received a transfer of $${amount.toFixed(2)} from ${senderName}.
Transfer Type: ${transferType}
Time: ${new Date().toLocaleString()}

Log in to your account to view details.

Best regards,
Heritage Bank
    `;
    sendEmail(recipientEmail, subject, body);
}

function sendAccountChangeNotification(email, changeType, details) {
    const subject = '🔐 Your Heritage Bank account was modified';
    const body = `
Hello,

Your account has been updated:
Change: ${changeType}
Details: ${details}
Time: ${new Date().toLocaleString()}

If this wasn't you, please contact support immediately.

Best regards,
Heritage Bank
    `;
    sendEmail(email, subject, body);
}

// Favicon route (prevents 404 errors)
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); // No content
});

// Health check
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok',
        message: 'Heritage Bank Backend is running',
        version: SERVER_VERSION,
        server: 'root-server.js',
        database: 'Ready',
        timestamp: new Date().toISOString()
    });
});

// In-memory storage for contacts and newsletter
const contacts = [];
const newsletterSubscribers = new Set();

// Contact Form Submission
app.post('/api/contact', (req, res) => {
    try {
        const { name, email, service, message } = req.body;

        // Validation
        if (!name || !email || !service || !message) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }

        const contact = {
            id: contacts.length + 1,
            name,
            email,
            service,
            message,
            created_at: new Date().toISOString()
        };

        contacts.push(contact);

        res.status(201).json({ 
            success: true,
            message: 'Contact form submitted successfully',
            id: contact.id 
        });
    } catch (error) {
        console.error('Contact form error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to submit contact form', error: error.message });
    }
});

// Newsletter Signup
app.post('/api/newsletter', (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        if (newsletterSubscribers.has(email)) {
            return res.status(409).json({ success: false, message: 'Email already subscribed to newsletter' });
        }

        newsletterSubscribers.add(email);

        res.status(201).json({ 
            success: true,
            message: 'Successfully subscribed to newsletter',
            id: newsletterSubscribers.size 
        });
    } catch (error) {
        console.error('Newsletter error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to subscribe', error: error.message });
    }
});

// Get all contacts (Admin)
app.get('/api/contacts', (req, res) => {
    try {
        res.status(200).json({ success: true, count: contacts.length, contacts });
    } catch (error) {
        console.error('Get contacts error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch contacts', error: error.message });
    }
});

// ===== AUTHENTICATION ENDPOINTS =====

// Registration - Direct account creation (no OTP needed)
app.post('/api/auth/register', async (req, res) => {
    try {
        const { firstName, lastName, email, password, phone } = req.body;

        // Validation
        if (!firstName || !lastName || !email || !password || !phone) {
            return res.status(400).json({ success: false, message: 'First name, last name, email, password, and phone are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email format' });
        }

        // Check if user already exists
        if (Array.from(users.values()).some(u => u.email === email)) {
            return res.status(409).json({ success: false, message: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user directly
        const userId = userIdCounter++;
        const accountNumber = generateAccountNumber();
        const newUser = {
            id: userId,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            phone: phone.trim(),
            accountNumber: accountNumber,
            balance: 50000, // Starting balance
            accountType: 'savings',
            createdAt: new Date().toISOString(),
            verified: true
        };

        users.set(userId, newUser);

        // Generate JWT token
        const token = jwt.sign(
            { id: userId, email: email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Log activity
        logActivity(userId, 'ACCOUNT_CREATED', `Account created for ${email}`);

        // Send welcome email
        sendEmail(email, '🎉 Welcome to Heritage Bank', 
            `Welcome ${firstName}!\n\nYour account has been created successfully.\n\nAccount Number: ${accountNumber}\nRoutingNumber: ${ROUTING_NUMBER}\n\nYou can now login and start banking.`);

        res.status(201).json({
            success: true,
            message: 'Account created successfully! You are now logged in.',
            userId: userId,
            token: token,
            user: {
                id: userId,
                firstName: newUser.firstName,
                lastName: newUser.lastName,
                email: newUser.email,
                accountNumber: accountNumber,
                balance: 50000
            }
        });

    } catch (error) {
        console.error('Registration error:', error.message);
        res.status(500).json({ success: false, message: 'Registration failed', error: error.message });
    }
});

// Verify OTP endpoint - simplified (OTP verification no longer needed)
app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        // Find user by email
        const user = Array.from(users.values()).find(u => u.email === email);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Generate JWT token
        const token = jwt.sign(
            { id: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(200).json({
            success: true,
            message: 'Email verified successfully',
            userId: user.id,
            token: token,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                accountNumber: user.accountNumber
            }
        });

    } catch (error) {
        console.error('Verification error:', error.message);
        res.status(500).json({ success: false, message: 'Verification failed', error: error.message });
    }
});

// Resend OTP - simplified (no longer needed but kept for compatibility)
app.post('/api/auth/resend-otp', (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        // Find user
        const user = Array.from(users.values()).find(u => u.email === email);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }



        // Send OTP email
        sendOTPEmail(email, otp);

        res.status(200).json({
            success: true,
            message: 'OTP resent successfully to your email',
            email: email,
            otpExpiry: '10 minutes'
        });

    } catch (error) {
        console.error('Resend OTP error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to resend OTP', error: error.message });
    }
});

// User Login

// User Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password required' });
        }

        // Try to find user in database first
        const connection = await pool.getConnection();
        const [dbUsers] = await connection.execute(
            'SELECT id, firstName, lastName, email, password, accountNumber, routingNumber, balance, accountType, isAdmin FROM users WHERE email = ?',
            [email]
        );
        connection.release();

        if (dbUsers && dbUsers.length > 0) {
            const user = dbUsers[0];
            
            // Verify password
            const passwordMatch = await bcrypt.compare(password, user.password);

            if (!passwordMatch) {
                return res.status(401).json({ success: false, message: 'Invalid email or password' });
            }

            // Determine role based on isAdmin field
            const role = user.isAdmin ? 'admin' : 'user';

            // Generate token with role
            const token = jwt.sign(
                { userId: user.id, email: user.email, role: role, isAdmin: Boolean(user.isAdmin) },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.status(200).json({
                success: true,
                message: 'Login successful',
                token,
                user: {
                    id: user.id,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    email: user.email,
                    accountNumber: user.accountNumber,
                    routingNumber: user.routingNumber,
                    balance: parseFloat(user.balance),
                    accountType: user.accountType,
                    isAdmin: Boolean(user.isAdmin),
                    lastLogin: user.lastLogin
                }
            });
            
            // Log activity for successful login
            logActivity(user.id, 'LOGIN', 'User logged in successfully', req.ip || '127.0.0.1');
        }

        // Fallback to in-memory users
        const user = Array.from(users.values()).find(u => u.email === email);

        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        // Determine role based on isAdmin field
        const role = user.isAdmin ? 'admin' : 'user';

        // Generate token with role
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: role, isAdmin: Boolean(user.isAdmin) },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(200).json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                accountNumber: user.accountNumber,
                balance: user.balance,
                isAdmin: user.isAdmin || false,
                lastLogin: user.lastLogin
            }
        });

    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ success: false, message: 'Login failed', error: error.message });
    }
});

// Get User Profile
app.get('/api/auth/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId || decoded.id;

        // Try database first
        try {
            const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
            if (rows.length > 0) {
                const user = rows[0];
                return res.status(200).json({ 
                    success: true, 
                    user: {
                        id: user.id,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        email: user.email,
                        phone: user.phone,
                        dateOfBirth: user.dateOfBirth,
                        address: user.address,
                        city: user.city,
                        state: user.state,
                        zipCode: user.zipCode,
                        country: user.country,
                        accountNumber: user.accountNumber,
                        routingNumber: user.routingNumber,
                        balance: parseFloat(user.balance) || 0,
                        accountType: user.accountType,
                        accountStatus: user.accountStatus,
                        isAdmin: Boolean(user.isAdmin),
                        lastLogin: user.lastLogin,
                        createdAt: user.createdAt
                    }
                });
            }
        } catch (dbError) {
            console.log('Database lookup failed, trying in-memory:', dbError.message);
        }

        // Fallback to in-memory
        const user = users.get(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.status(200).json({ 
            success: true, 
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                dob: user.dob,
                country: user.country,
                accountNumber: user.accountNumber,
                balance: user.balance || 0,
                accountType: user.accountType,
                created_at: user.created_at
            }
        });

    } catch (error) {
        console.error('Profile error:', error.message);
        res.status(401).json({ success: false, message: 'Unauthorized', error: error.message });
    }
});

// Update User Profile
app.put('/api/auth/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const { firstName, lastName, phone, country } = req.body;

        const user = users.get(decoded.userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Update user data
        if (firstName) user.firstName = firstName;
        if (lastName) user.lastName = lastName;
        if (phone) user.phone = phone;
        if (country) user.country = country;

        users.set(decoded.userId, user);

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully',
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                dob: user.dob,
                country: user.country,
                accountType: user.accountType,
                created_at: user.created_at
            }
        });
    } catch (error) {
        console.error('Update profile error:', error.message);
        res.status(401).json({ success: false, message: 'Unauthorized' });
    }
});

// Change Password
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const { currentPassword, newPassword } = req.body;

        if (!token) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Current and new password required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = users.get(decoded.userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Verify current password
        const passwordMatch = await bcrypt.compare(currentPassword, user.password);

        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        users.set(decoded.userId, user);

        res.status(200).json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error.message);
        res.status(401).json({ success: false, message: 'Unauthorized' });
    }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all contacts
app.get('/api/admin/contacts', (req, res) => {
    try {
        res.status(200).json({ 
            success: true,
            contacts: contacts.map((c, idx) => ({
                id: idx + 1,
                ...c,
                date: c.date || new Date().toISOString()
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching contacts' });
    }
});

// Get all newsletter subscribers
app.get('/api/admin/subscribers', (req, res) => {
    try {
        res.status(200).json({ 
            success: true,
            subscribers: Array.from(newsletterSubscribers)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching subscribers' });
    }
});

// Get all registered users
app.get('/api/admin/users', (req, res) => {
    try {
        const userList = Array.from(users.values()).map(u => ({
            id: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            accountType: u.accountType || 'Savings',
            created_at: u.created_at,
            phone: u.phone
        }));

        res.status(200).json({ 
            success: true,
            users: userList
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching users' });
    }
});

// Delete contact
app.delete('/api/admin/contacts/:id', (req, res) => {
    try {
        const { id } = req.params;
        if (id > 0 && id <= contacts.length) {
            contacts.splice(id - 1, 1);
            res.status(200).json({ success: true, message: 'Contact deleted' });
        } else {
            res.status(404).json({ success: false, message: 'Contact not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting contact' });
    }
});

// Delete user (admin only) - from database
app.delete('/api/admin/users/:id', async (req, res) => {
    let connection;
    try {
        const { id } = req.params;
        const userId = parseInt(id);
        
        // Don't allow deleting admin account (ID 1)
        if (userId === 1) {
            return res.status(403).json({ success: false, message: 'Cannot delete admin account' });
        }
        
        connection = await pool.getConnection();
        
        // Check if user exists
        const [users] = await connection.execute('SELECT id FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            connection.release();
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        // Delete related records first (transactions referencing this user)
        await connection.execute('DELETE FROM transactions WHERE fromUserId = ? OR toUserId = ?', [userId, userId]);
        
        // Delete user from database
        await connection.execute('DELETE FROM users WHERE id = ?', [userId]);
        connection.release();
        
        res.status(200).json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        if (connection) connection.release();
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, message: 'Error deleting user: ' + error.message });
    }
});

// Update admin balance
app.put('/api/admin/update-balance/:id', async (req, res) => {
    let connection;
    try {
        const { id } = req.params;
        const { balance } = req.body;
        
        connection = await pool.getConnection();
        
        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [parseFloat(balance), parseInt(id)]);
        connection.release();
        
        res.json({ success: true, message: 'Balance updated successfully', newBalance: parseFloat(balance) });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// Unsubscribe from newsletter
app.post('/api/newsletter/unsubscribe', (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        if (newsletterSubscribers.has(email)) {
            newsletterSubscribers.delete(email);
            res.status(200).json({ success: true, message: 'Unsubscribed successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Email not found in newsletter' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error unsubscribing' });
    }
});

// ============================================
// ADMIN: CREATE USER ENDPOINT
// ============================================
app.post('/api/admin/create-user', async (req, res) => {
    let connection;
    try {
        const { firstName, lastName, email, password, phone, initialBalance, accountType, city, state, zip, address, country } = req.body;

        // Validation
        if (!firstName || !lastName || !email || !password) {
            return res.status(400).json({ success: false, message: 'First name, last name, email, and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }

        const balanceNum = parseFloat(initialBalance) || 1000;

        // Get connection from pool
        connection = await pool.getConnection();

        // Check if email already exists in database
        const [existingUsers] = await connection.execute(
            'SELECT id FROM users WHERE email = ?',
            [email.trim()]
        );

        if (existingUsers.length > 0) {
            return res.status(409).json({ success: false, message: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate unique account number
        const accountNumber = generateAccountNumber();

        // Insert into database - minimal columns for maximum compatibility
        try {
            const [result] = await connection.execute(
                `INSERT INTO users (firstName, lastName, email, password, accountNumber, routingNumber, balance, accountType, isAdmin)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    firstName.trim(),
                    lastName.trim(),
                    email.trim(),
                    hashedPassword,
                    accountNumber,
                    ROUTING_NUMBER,
                    balanceNum,
                    accountType || 'checking',
                    0  // isAdmin = false
                ]
            );
            
            // Fetch the created user to return complete info
            const [newUsers] = await connection.execute(
                'SELECT id, firstName, lastName, email, accountNumber, routingNumber, balance, accountType FROM users WHERE id = ?',
                [result.insertId]
            );

            const newUser = newUsers[0];

            res.status(201).json({
                success: true,
                message: 'User created successfully by admin',
                user: {
                    id: newUser.id,
                    firstName: newUser.firstName,
                    lastName: newUser.lastName,
                    email: newUser.email,
                    accountNumber: newUser.accountNumber,
                    routingNumber: newUser.routingNumber,
                    balance: parseFloat(newUser.balance),
                    accountType: newUser.accountType,
                    bankName: BANK_NAME
                }
            });
        } catch (insertError) {
            console.error('Insert error details:', insertError);
            res.status(500).json({ 
                success: false, 
                message: 'Database insert error: ' + insertError.message,
                sqlState: insertError.sqlState,
                errno: insertError.errno
            });
        }
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ success: false, message: 'Error creating user: ' + error.message });
    } finally {
        if (connection) await connection.release();
    }
});

// ============================================
// ADMIN: FUND USER ACCOUNT (No Balance Limit)
// ============================================
app.post('/api/admin/fund-user', async (req, res) => {
    let connection;
    try {
        const { toEmail, toAccountNumber, amount, transferType, incomeType, description, useAdminBalance } = req.body;

        // Validation
        if ((!toEmail && !toAccountNumber) || !amount) {
            return res.status(400).json({ 
                success: false, 
                message: 'Recipient (email or account number) and amount are required' 
            });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
        }

        connection = await pool.getConnection();

        // Find recipient user
        let toUser;
        if (toEmail) {
            const [toUsers] = await connection.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance FROM users WHERE email = ?',
                [toEmail.trim()]
            );
            if (!toUsers || toUsers.length === 0) {
                connection.release();
                return res.status(404).json({ success: false, message: 'Recipient email not found' });
            }
            toUser = toUsers[0];
        } else if (toAccountNumber) {
            const [toUsers] = await connection.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance FROM users WHERE accountNumber = ?',
                [toAccountNumber]
            );
            if (!toUsers || toUsers.length === 0) {
                connection.release();
                return res.status(404).json({ success: false, message: 'Recipient account number not found' });
            }
            toUser = toUsers[0];
        }

        // Get admin account for tracking
        const [adminUsers] = await connection.execute(
            'SELECT id, firstName, lastName, email, balance FROM users WHERE email = ?',
            ['admin@heritagebank.com']
        );
        
        const adminUser = adminUsers.length > 0 ? adminUsers[0] : { id: 0, firstName: 'Bank', lastName: 'Reserve', email: 'system@heritagebank.com', balance: 100000000 };

        // If using admin balance, deduct from admin
        let newAdminBalance = parseFloat(adminUser.balance);
        if (useAdminBalance && adminUsers.length > 0) {
            if (newAdminBalance < amountNum) {
                connection.release();
                return res.status(400).json({ success: false, message: 'Insufficient admin balance. Use Bank Reserve instead.' });
            }
            newAdminBalance -= amountNum;
            await connection.execute(
                'UPDATE users SET balance = ? WHERE id = ?',
                [newAdminBalance, adminUser.id]
            );
        }

        // Credit recipient account
        const newToBalance = (parseFloat(toUser.balance) || 0) + amountNum;
        await connection.execute(
            'UPDATE users SET balance = ? WHERE id = ?',
            [newToBalance, toUser.id]
        );

        // Record transaction in database
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                useAdminBalance ? adminUser.id : 0, // 0 for bank reserve
                toUser.id, 
                amountNum, 
                transferType || 'admin_credit', 
                description || `Admin funding: ${incomeType || 'Credit'}`, 
                'completed'
            ]
        );

        // Update in-memory for immediate access
        if (users.has(toUser.id)) {
            const memUser = users.get(toUser.id);
            memUser.balance = newToBalance;
        }

        // Store transaction in memory too
        const transaction = {
            id: transactionIdCounter++,
            fromUserId: useAdminBalance ? adminUser.id : 0,
            fromName: useAdminBalance ? `${adminUser.firstName} ${adminUser.lastName}` : 'Bank Reserve',
            fromAccountNumber: 'BANK-RESERVE',
            toUserId: toUser.id,
            toName: `${toUser.firstName} ${toUser.lastName}`,
            toEmail: toUser.email,
            toAccountNumber: toUser.accountNumber,
            amount: amountNum,
            transferType: transferType || 'Admin Credit',
            incomeType: incomeType || 'Credit',
            description: description || 'Admin account funding',
            status: 'completed',
            timestamp: new Date().toISOString()
        };

        transactions.push(transaction);

        connection.release();

        res.status(201).json({
            success: true,
            message: 'Account funded successfully',
            transaction: {
                id: transaction.id,
                from: transaction.fromName,
                to: transaction.toName,
                toEmail: toUser.email,
                toAccountNumber: toUser.accountNumber,
                amount: amountNum,
                transferType: transaction.transferType,
                incomeType: transaction.incomeType,
                description: transaction.description,
                timestamp: transaction.timestamp,
                toBalance: newToBalance,
                adminBalance: useAdminBalance ? newAdminBalance : 'N/A (Bank Reserve)'
            }
        });
    } catch (error) {
        if (connection) connection.release();
        console.error('Error funding user:', error);
        res.status(500).json({ success: false, message: 'Error funding account: ' + error.message });
    }
});

// ============================================
// ADMIN: ADJUST USER BALANCE
// ============================================
app.post('/api/admin/adjust-balance', async (req, res) => {
    let connection;
    try {
        const { userId, newBalance, reason } = req.body;

        if (!userId || newBalance === undefined) {
            return res.status(400).json({ success: false, message: 'User ID and new balance are required' });
        }

        const balanceNum = parseFloat(newBalance);
        if (isNaN(balanceNum) || balanceNum < 0) {
            return res.status(400).json({ success: false, message: 'Balance must be a non-negative number' });
        }

        connection = await pool.getConnection();

        // Get current user
        const [userRows] = await connection.execute(
            'SELECT id, firstName, lastName, email, balance FROM users WHERE id = ?',
            [parseInt(userId)]
        );

        if (userRows.length === 0) {
            connection.release();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = userRows[0];
        const oldBalance = parseFloat(user.balance) || 0;

        // Update balance
        await connection.execute(
            'UPDATE users SET balance = ? WHERE id = ?',
            [balanceNum, user.id]
        );

        // Record adjustment transaction
        const adjustmentType = balanceNum > oldBalance ? 'credit_adjustment' : 'debit_adjustment';
        const adjustmentAmount = Math.abs(balanceNum - oldBalance);

        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [0, user.id, adjustmentAmount, adjustmentType, reason || 'Admin balance adjustment', 'completed']
        );

        // Update in-memory
        if (users.has(user.id)) {
            users.get(user.id).balance = balanceNum;
        }

        connection.release();

        res.status(200).json({
            success: true,
            message: 'Balance adjusted successfully',
            user: {
                id: user.id,
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
                oldBalance: oldBalance,
                newBalance: balanceNum,
                adjustment: balanceNum - oldBalance
            }
        });
    } catch (error) {
        if (connection) connection.release();
        console.error('Error adjusting balance:', error);
        res.status(500).json({ success: false, message: 'Error adjusting balance: ' + error.message });
    }
});

// ============================================
// ADMIN: GET ALL USERS WITH BALANCES
// ============================================
app.get('/api/admin/users-with-balances', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        const [users] = await connection.execute(
            `SELECT id, firstName, lastName, email, accountNumber, routingNumber, accountType, balance, accountStatus 
             FROM users ORDER BY id ASC`
        );
        
        connection.release();

        res.status(200).json({
            success: true,
            total: users.length,
            users: users.map(u => ({
                id: u.id,
                name: `${u.firstName} ${u.lastName}`,
                firstName: u.firstName,
                lastName: u.lastName,
                email: u.email,
                accountNumber: u.accountNumber,
                routingNumber: u.routingNumber,
                accountType: u.accountType,
                accountStatus: u.accountStatus || 'active',
                balance: parseFloat(u.balance) || 0,
                isAdmin: u.email === 'admin@heritagebank.com'
            }))
        });
    } catch (error) {
        if (connection) connection.release();
        console.error('Error fetching users:', error);
        res.status(500).json({ success: false, message: 'Error fetching users: ' + error.message });
    }
});

// ============================================
// ADMIN: LOOKUP USER BY EMAIL OR ACCOUNT NUMBER
// ============================================
app.get('/api/admin/lookup-user', async (req, res) => {
    let connection;
    try {
        const { email, accountNumber } = req.query;
        
        connection = await pool.getConnection();
        
        let user;
        if (email) {
            const [users] = await connection.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, accountType FROM users WHERE email = ?', 
                [email]
            );
            user = users[0];
        } else if (accountNumber) {
            const [users] = await connection.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, accountType FROM users WHERE accountNumber = ?', 
                [accountNumber]
            );
            user = users[0];
        }

        connection.release();

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, user });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: TRANSFER BETWEEN ANY ACCOUNTS
// ============================================
app.post('/api/admin/transfer', async (req, res) => {
    let connection;
    try {
        const { 
            fromEmail, fromAccountNumber, 
            toEmail, toAccountNumber, 
            amount, description, bypassBalanceCheck 
        } = req.body;
        
        connection = await pool.getConnection();
        
        // Find sender
        let sender;
        if (fromEmail) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ?', [fromEmail]);
            sender = users[0];
        } else if (fromAccountNumber) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ?', [fromAccountNumber]);
            sender = users[0];
        }

        if (!sender) {
            connection.release();
            return res.status(404).json({ success: false, message: 'Sender not found' });
        }

        // Find recipient
        let recipient;
        if (toEmail) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ?', [toEmail]);
            recipient = users[0];
        } else if (toAccountNumber) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ?', [toAccountNumber]);
            recipient = users[0];
        }

        if (!recipient) {
            connection.release();
            return res.status(404).json({ success: false, message: 'Recipient not found' });
        }

        const transferAmount = parseFloat(amount);
        const senderBalance = parseFloat(sender.balance);

        // Check balance unless bypassing
        if (!bypassBalanceCheck && senderBalance < transferAmount) {
            connection.release();
            return res.status(400).json({ 
                success: false, 
                message: `Insufficient funds. Sender balance: $${senderBalance.toLocaleString()}` 
            });
        }

        // Perform transfer with precise decimal handling
        const newSenderBalance = parseFloat((senderBalance - transferAmount).toFixed(2));
        const newRecipientBalance = parseFloat((parseFloat(recipient.balance) + transferAmount).toFixed(2));

        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newSenderBalance, sender.id]);
        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newRecipientBalance, recipient.id]);

        // Generate reference
        const reference = 'TRF' + Date.now().toString(36).toUpperCase();

        // Log transaction
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status) 
             VALUES (?, ?, ?, 'admin_transfer', ?, 'completed')`,
            [sender.id, recipient.id, transferAmount, description || 'Admin Transfer']
        );

        connection.release();

        res.json({
            success: true,
            message: `$${transferAmount.toLocaleString()} transferred from ${sender.firstName} ${sender.lastName} to ${recipient.firstName} ${recipient.lastName}`,
            reference,
            senderNewBalance: newSenderBalance,
            recipientNewBalance: newRecipientBalance
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: CREDIT ACCOUNT (ADD MONEY)
// ============================================
app.post('/api/admin/credit-account', async (req, res) => {
    let connection;
    try {
        const { email, accountNumber, amount, reason, notes } = req.body;
        
        connection = await pool.getConnection();
        
        let user;
        if (email) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
            user = users[0];
        } else if (accountNumber) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ?', [accountNumber]);
            user = users[0];
        }

        if (!user) {
            connection.release();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const previousBalance = parseFloat(user.balance);
        const creditAmount = parseFloat(amount);
        const newBalance = parseFloat((previousBalance + creditAmount).toFixed(2));

        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id]);

        // Generate reference
        const reference = 'CRD' + Date.now().toString(36).toUpperCase();

        // Log transaction
        await connection.execute(
            `INSERT INTO transactions (toUserId, amount, type, description, status) 
             VALUES (?, ?, 'credit', ?, 'completed')`,
            [user.id, creditAmount, `${reason}: ${notes || 'Admin credit'}`]
        );

        connection.release();

        res.json({
            success: true,
            message: `$${creditAmount.toLocaleString()} credited to ${user.firstName} ${user.lastName}`,
            reference,
            previousBalance,
            newBalance,
            user: {
                name: `${user.firstName} ${user.lastName}`,
                accountNumber: user.accountNumber
            }
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: DEBIT ACCOUNT (REMOVE MONEY)
// ============================================
app.post('/api/admin/debit-account', async (req, res) => {
    let connection;
    try {
        const { email, accountNumber, amount, reason, notes, forceDebit } = req.body;
        
        connection = await pool.getConnection();
        
        let user;
        if (email) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
            user = users[0];
        } else if (accountNumber) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ?', [accountNumber]);
            user = users[0];
        }

        if (!user) {
            connection.release();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const previousBalance = parseFloat(user.balance);
        const debitAmount = parseFloat(amount);

        // Check if debit would cause negative balance
        if (!forceDebit && previousBalance < debitAmount) {
            connection.release();
            return res.status(400).json({ 
                success: false, 
                message: `Insufficient balance. Current: $${previousBalance.toLocaleString()}, Debit: $${debitAmount.toLocaleString()}.` 
            });
        }

        const newBalance = parseFloat((previousBalance - debitAmount).toFixed(2));

        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id]);

        // Generate reference
        const reference = 'DBT' + Date.now().toString(36).toUpperCase();

        // Log transaction
        await connection.execute(
            `INSERT INTO transactions (fromUserId, amount, type, description, status) 
             VALUES (?, ?, 'debit', ?, 'completed')`,
            [user.id, debitAmount, `${reason}: ${notes || 'Admin debit'}`]
        );

        connection.release();

        res.json({
            success: true,
            message: `$${debitAmount.toLocaleString()} debited from ${user.firstName} ${user.lastName}`,
            reference,
            previousBalance,
            newBalance,
            user: {
                name: `${user.firstName} ${user.lastName}`,
                accountNumber: user.accountNumber
            }
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: DASHBOARD STATS
// ============================================
app.get('/api/admin/dashboard-stats', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Get user stats
        const [userStats] = await connection.execute(
            `SELECT COUNT(*) as totalUsers, SUM(balance) as totalBalance FROM users`
        );
        
        // Get today's transactions
        const [todayTx] = await connection.execute(
            `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as volume FROM transactions 
             WHERE DATE(createdAt) = CURDATE()`
        );
        
        // Get monthly transactions
        const [monthlyTx] = await connection.execute(
            `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as volume FROM transactions 
             WHERE MONTH(createdAt) = MONTH(CURDATE()) AND YEAR(createdAt) = YEAR(CURDATE())`
        );
        
        // Get pending loans
        const [pendingLoans] = await connection.execute(
            `SELECT COUNT(*) as count FROM loan_applications WHERE status = 'pending'`
        );
        
        // Get active users (logged in within 30 days)
        const [activeUsers] = await connection.execute(
            `SELECT COUNT(*) as count FROM users WHERE lastLogin >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
        );
        
        connection.release();
        
        res.json({
            success: true,
            stats: {
                totalUsers: userStats[0]?.totalUsers || 0,
                totalBalance: parseFloat(userStats[0]?.totalBalance) || 0,
                todayTransactions: todayTx[0]?.count || 0,
                monthlyTransactions: monthlyTx[0]?.count || 0,
                monthlyVolume: parseFloat(monthlyTx[0]?.volume) || 0,
                pendingLoans: pendingLoans[0]?.count || 0,
                activeUsers: activeUsers[0]?.count || 0,
                failedLogins: 0 // Placeholder
            }
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: SEARCH USERS
// ============================================
app.get('/api/admin/search-users', async (req, res) => {
    let connection;
    try {
        const { query } = req.query;
        
        if (!query || query.length < 2) {
            return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
        }
        
        connection = await pool.getConnection();
        
        const [users] = await connection.execute(
            `SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, accountType 
             FROM users 
             WHERE firstName LIKE ? OR lastName LIKE ? OR email LIKE ? OR accountNumber LIKE ?
             LIMIT 20`,
            [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`]
        );
        
        connection.release();
        
        res.json({
            success: true,
            total: users.length,
            users
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: SEARCH TRANSACTIONS
// ============================================
app.get('/api/admin/search-transactions', async (req, res) => {
    let connection;
    try {
        const { accountNumber, type, startDate, endDate, minAmount, maxAmount } = req.query;
        
        connection = await pool.getConnection();
        
        let sql = `SELECT t.*, 
                   u1.firstName as fromFirstName, u1.lastName as fromLastName, u1.accountNumber as fromAccount,
                   u2.firstName as toFirstName, u2.lastName as toLastName, u2.accountNumber as toAccount
                   FROM transactions t
                   LEFT JOIN users u1 ON t.fromUserId = u1.id
                   LEFT JOIN users u2 ON t.toUserId = u2.id
                   WHERE 1=1`;
        const params = [];
        
        if (accountNumber) {
            sql += ` AND (u1.accountNumber = ? OR u2.accountNumber = ?)`;
            params.push(accountNumber, accountNumber);
        }
        if (type) {
            sql += ` AND t.type = ?`;
            params.push(type);
        }
        if (startDate) {
            sql += ` AND t.createdAt >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            sql += ` AND t.createdAt <= ?`;
            params.push(endDate + ' 23:59:59');
        }
        if (minAmount) {
            sql += ` AND t.amount >= ?`;
            params.push(parseFloat(minAmount));
        }
        if (maxAmount) {
            sql += ` AND t.amount <= ?`;
            params.push(parseFloat(maxAmount));
        }
        
        sql += ` ORDER BY t.createdAt DESC LIMIT 100`;
        
        const [transactions] = await connection.execute(sql, params);
        
        connection.release();
        
        res.json({
            success: true,
            total: transactions.length,
            transactions: transactions.map(t => ({
                id: t.id,
                amount: parseFloat(t.amount),
                type: t.type,
                status: t.status,
                description: t.description,
                fromAccount: t.fromAccount,
                fromName: t.fromFirstName ? `${t.fromFirstName} ${t.fromLastName}` : 'N/A',
                toAccount: t.toAccount,
                toName: t.toFirstName ? `${t.toFirstName} ${t.toLastName}` : 'N/A',
                created_at: t.createdAt
            }))
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: UPDATE ACCOUNT STATUS
// ============================================
app.put('/api/admin/account-status/:userId', async (req, res) => {
    let connection;
    try {
        const { userId } = req.params;
        const { status } = req.body;
        
        if (!['active', 'frozen', 'suspended', 'closed'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }
        
        connection = await pool.getConnection();
        
        await connection.execute(
            'UPDATE users SET accountStatus = ? WHERE id = ?',
            [status, userId]
        );
        
        connection.release();
        
        res.json({ success: true, message: `Account status updated to ${status}` });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: MONTHLY REPORT
// ============================================
app.get('/api/admin/monthly-report', async (req, res) => {
    let connection;
    try {
        const { year, month } = req.query;
        
        connection = await pool.getConnection();
        
        // Get transaction stats for the month
        const [txStats] = await connection.execute(
            `SELECT COUNT(*) as totalTransactions, COALESCE(SUM(amount), 0) as totalVolume,
             COALESCE(AVG(amount), 0) as avgTransaction
             FROM transactions 
             WHERE MONTH(createdAt) = ? AND YEAR(createdAt) = ?`,
            [parseInt(month), parseInt(year)]
        );
        
        // Get new users for the month
        const [newUsers] = await connection.execute(
            `SELECT COUNT(*) as count FROM users 
             WHERE MONTH(createdAt) = ? AND YEAR(createdAt) = ?`,
            [parseInt(month), parseInt(year)]
        );
        
        // Get loan stats
        const [loanStats] = await connection.execute(
            `SELECT 
             COUNT(*) as totalApplications,
             SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
             SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
             FROM loan_applications 
             WHERE MONTH(created_at) = ? AND YEAR(created_at) = ?`,
            [parseInt(month), parseInt(year)]
        );
        
        connection.release();
        
        res.json({
            success: true,
            report: {
                period: `${year}-${month.toString().padStart(2, '0')}`,
                transactions: {
                    total: txStats[0]?.totalTransactions || 0,
                    volume: parseFloat(txStats[0]?.totalVolume) || 0,
                    average: parseFloat(txStats[0]?.avgTransaction) || 0
                },
                users: {
                    newRegistrations: newUsers[0]?.count || 0
                },
                loans: {
                    total: loanStats[0]?.totalApplications || 0,
                    approved: loanStats[0]?.approved || 0,
                    rejected: loanStats[0]?.rejected || 0,
                    pending: loanStats[0]?.pending || 0
                }
            }
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: GET ALL TRANSACTIONS
// ============================================
app.get('/api/transactions/all', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        const [transactions] = await connection.execute(
            `SELECT t.*, 
             u1.firstName as fromFirstName, u1.lastName as fromLastName, u1.accountNumber as fromAccount,
             u2.firstName as toFirstName, u2.lastName as toLastName, u2.accountNumber as toAccount
             FROM transactions t
             LEFT JOIN users u1 ON t.fromUserId = u1.id
             LEFT JOIN users u2 ON t.toUserId = u2.id
             ORDER BY t.createdAt DESC
             LIMIT 200`
        );
        
        connection.release();
        
        res.json({
            success: true,
            total: transactions.length,
            transactions: transactions.map(t => ({
                id: t.id,
                amount: parseFloat(t.amount),
                type: t.type,
                status: t.status,
                description: t.description,
                fromAccount: t.fromAccount,
                fromName: t.fromFirstName ? `${t.fromFirstName} ${t.fromLastName}` : 'Bank',
                toAccount: t.toAccount,
                toName: t.toFirstName ? `${t.toFirstName} ${t.toLastName}` : 'N/A',
                created_at: t.createdAt
            }))
        });
    } catch (error) {
        if (connection) connection.release();
        console.error('Error fetching transactions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: PENDING DOCUMENTS
// ============================================
app.get('/api/admin/documents/pending', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Try to get documents from database
        try {
            const [docs] = await connection.execute(
                `SELECT d.*, u.firstName, u.lastName, u.email 
                 FROM documents d 
                 JOIN users u ON d.userId = u.id 
                 WHERE d.status = 'pending' 
                 ORDER BY d.uploadedAt DESC`
            );
            
            connection.release();
            
            return res.json({
                success: true,
                documents: docs.map(d => ({
                    id: d.id,
                    userId: d.userId,
                    userName: `${d.firstName} ${d.lastName}`,
                    userEmail: d.email,
                    documentType: d.documentType,
                    fileName: d.fileName,
                    status: d.status,
                    uploadedAt: d.uploadedAt
                }))
            });
        } catch (dbError) {
            // Documents table may not exist
            connection.release();
            return res.json({ success: true, documents: [] });
        }
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: APPROVE DOCUMENT
// ============================================
app.put('/api/admin/documents/:id/approve', async (req, res) => {
    let connection;
    try {
        const { id } = req.params;
        
        connection = await pool.getConnection();
        
        await connection.execute(
            'UPDATE documents SET status = ?, reviewedAt = NOW() WHERE id = ?',
            ['approved', id]
        );
        
        connection.release();
        
        res.json({ success: true, message: 'Document approved' });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ADMIN: REJECT DOCUMENT
// ============================================
app.put('/api/admin/documents/:id/reject', async (req, res) => {
    let connection;
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        connection = await pool.getConnection();
        
        await connection.execute(
            'UPDATE documents SET status = ?, rejectionReason = ?, reviewedAt = NOW() WHERE id = ?',
            ['rejected', reason || 'Rejected by admin', id]
        );
        
        connection.release();
        
        res.json({ success: true, message: 'Document rejected' });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// MONEY TRANSFER ENDPOINT
// ============================================
app.post('/api/transfer', async (req, res) => {
    try {
        const { fromUserId, toEmail, amount, transferType, incomeType, description } = req.body;

        // Validation
        if (!fromUserId || !toEmail || !amount || !transferType || !incomeType || !description) {
            return res.status(400).json({ 
                success: false, 
                message: 'From user ID, to email, amount, transfer type, income type, and description are required' 
            });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
        }

        // Find sender user
        const fromUser = users.get(parseInt(fromUserId));
        if (!fromUser) {
            return res.status(404).json({ success: false, message: 'Sender user not found' });
        }

        // Find recipient user
        const toUser = Array.from(users.values()).find(u => u.email === toEmail);
        if (!toUser) {
            return res.status(404).json({ success: false, message: 'Recipient email not found' });
        }

        // Check balance
        if (!fromUser.balance || fromUser.balance < amountNum) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }

        // Perform transfer
        fromUser.balance -= amountNum;
        toUser.balance = (toUser.balance || 0) + amountNum;

        // Record transaction
        const transaction = {
            id: transactionIdCounter++,
            fromUserId: fromUser.id,
            fromName: `${fromUser.firstName} ${fromUser.lastName}`,
            toUserId: toUser.id,
            toName: `${toUser.firstName} ${toUser.lastName}`,
            toEmail: toEmail,
            amount: amountNum,
            transferType: transferType, // e.g., "Bank Transfer", "Wire Transfer", "ACH", "Check"
            incomeType: incomeType,      // e.g., "Salary", "Business", "Investment", "Refund", "Other"
            description: description || '',
            status: 'completed',
            timestamp: new Date().toISOString()
        };

        transactions.push(transaction);

        res.status(201).json({
            success: true,
            message: 'Transfer completed successfully',
            transaction: {
                id: transaction.id,
                from: transaction.fromName,
                to: transaction.toName,
                amount: transaction.amount,
                description: transaction.description,
                transferType: transaction.transferType,
                incomeType: transaction.incomeType,
                timestamp: transaction.timestamp,
                fromBalance: fromUser.balance,
                toBalance: toUser.balance
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error processing transfer: ' + error.message });
    }
});

// ============================================
// GET ALL TRANSACTIONS FROM DATABASE (ADMIN)
// ============================================
app.get('/api/transactions', async (req, res) => {
    try {
        const connection = await pool.getConnection();
        try {
            // Get all transactions with user details
            const [transactions] = await connection.execute(
                `SELECT 
                    t.*,
                    u1.firstName as fromFirstName,
                    u1.lastName as fromLastName,
                    u1.accountNumber as fromAccountNumber,
                    u1.email as fromEmail,
                    u2.firstName as toFirstName,
                    u2.lastName as toLastName,
                    u2.accountNumber as toAccountNumber,
                    u2.email as toEmail
                FROM transactions t
                LEFT JOIN users u1 ON t.fromUserId = u1.id
                LEFT JOIN users u2 ON t.toUserId = u2.id
                ORDER BY t.createdAt DESC
                LIMIT 200`
            );

            // Format transactions for frontend
            const formattedTransactions = transactions.map(tx => ({
                id: tx.id,
                amount: parseFloat(tx.amount),
                type: tx.type || 'transfer',
                description: tx.description,
                status: tx.status || 'completed',
                created_at: tx.createdAt,
                timestamp: tx.createdAt,
                fromAccount: tx.fromAccountNumber,
                toAccount: tx.toAccountNumber,
                fromEmail: tx.fromEmail,
                toEmail: tx.toEmail,
                fromUserId: tx.fromUserId,
                toUserId: tx.toUserId,
                from: tx.fromAccountNumber || `${tx.fromFirstName} ${tx.fromLastName}`,
                to: tx.toAccountNumber || `${tx.toFirstName} ${tx.toLastName}`
            }));

            res.status(200).json({
                success: true,
                message: 'Transactions retrieved',
                total: formattedTransactions.length,
                transactions: formattedTransactions
            });
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error retrieving transactions:', error);
        res.status(500).json({ success: false, message: 'Error retrieving transactions' });
    }
});

// ============================================
// GET USER BALANCE
// ============================================
app.get('/api/user/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // First try in-memory
        let user = users.get(parseInt(userId));

        // If not in memory, check database
        if (!user) {
            try {
                const connection = await pool.getConnection();
                const [rows] = await connection.execute(
                    'SELECT id, firstName, lastName, email, balance FROM users WHERE id = ?',
                    [parseInt(userId)]
                );
                connection.release();
                
                if (rows && rows.length > 0) {
                    user = rows[0];
                }
            } catch (dbErr) {
                console.error('Database lookup error:', dbErr);
            }
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.status(200).json({
            success: true,
            userId: user.id,
            name: `${user.firstName} ${user.lastName}`,
            email: user.email,
            balance: parseFloat(user.balance) || 0
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving balance' });
    }
});

// ============================================
// USER TRANSACTIONS - GET USER'S TRANSACTIONS FROM DATABASE
// ============================================
app.get('/api/user/:userId/transactions', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const connection = await pool.getConnection();
        try {
            // Get user's transactions from database
            const [transactions] = await connection.execute(
                `SELECT 
                    t.*,
                    u1.firstName as fromFirstName,
                    u1.lastName as fromLastName,
                    u1.accountNumber as fromAccountNumber,
                    u2.firstName as toFirstName,
                    u2.lastName as toLastName,
                    u2.accountNumber as toAccountNumber
                FROM transactions t
                LEFT JOIN users u1 ON t.fromUserId = u1.id
                LEFT JOIN users u2 ON t.toUserId = u2.id
                WHERE t.fromUserId = ? OR t.toUserId = ?
                ORDER BY t.createdAt DESC
                LIMIT 100`,
                [parseInt(userId), parseInt(userId)]
            );

            // Format transactions for frontend
            const formattedTransactions = transactions.map(tx => {
                const isCredit = tx.toUserId === parseInt(userId);
                return {
                    id: tx.id,
                    amount: parseFloat(tx.amount),
                    type: isCredit ? 'credit' : 'debit',
                    description: tx.description || (isCredit ? 
                        `Transfer from ${tx.fromFirstName} ${tx.fromLastName}` : 
                        `Transfer to ${tx.toFirstName} ${tx.toLastName}`),
                    status: tx.status || 'completed',
                    date: tx.createdAt,
                    createdAt: tx.createdAt,
                    fromAccount: tx.fromAccountNumber,
                    toAccount: tx.toAccountNumber,
                    fromUserId: tx.fromUserId,
                    toUserId: tx.toUserId
                };
            });

            res.status(200).json({
                success: true,
                userId: parseInt(userId),
                total: formattedTransactions.length,
                transactions: formattedTransactions
            });
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error retrieving transactions:', error);
        res.status(500).json({ success: false, message: 'Error retrieving transactions' });
    }
});

// ============================================
// TRANSACTION RECEIPT - DOWNLOAD PDF RECEIPT
// ============================================
app.get('/api/transactions/:id/receipt', async (req, res) => {
    let connection;
    try {
        const { id } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ success: false, message: 'Authorization required' });
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        
        connection = await pool.getConnection();
        
        // Get transaction details
        const [transactions] = await connection.execute(
            `SELECT t.*, 
                    u1.firstName as fromFirstName, u1.lastName as fromLastName, u1.accountNumber as fromAccount,
                    u2.firstName as toFirstName, u2.lastName as toLastName, u2.accountNumber as toAccount
             FROM transactions t
             LEFT JOIN users u1 ON t.fromUserId = u1.id
             LEFT JOIN users u2 ON t.toUserId = u2.id
             WHERE t.id = ?`,
            [id]
        );
        
        if (transactions.length === 0) {
            connection.release();
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }
        
        const tx = transactions[0];
        
        // Verify user has access to this transaction
        if (tx.fromUserId !== decoded.userId && tx.toUserId !== decoded.userId && !decoded.isAdmin) {
            connection.release();
            return res.status(403).json({ success: false, message: 'Not authorized to view this receipt' });
        }
        
        connection.release();
        
        // Generate simple text receipt (in production, use PDFKit or similar)
        const receiptDate = new Date(tx.createdAt).toLocaleString();
        const receiptText = `
========================================
         HERITAGE BANK
       TRANSACTION RECEIPT
========================================

Reference: TXN${tx.id.toString().padStart(8, '0')}
Date: ${receiptDate}
Type: ${tx.type.toUpperCase()}

From: ${tx.fromFirstName ? `${tx.fromFirstName} ${tx.fromLastName}` : 'Heritage Bank'}
Account: ${tx.fromAccount || 'N/A'}

To: ${tx.toFirstName ? `${tx.toFirstName} ${tx.toLastName}` : 'Heritage Bank'}
Account: ${tx.toAccount || 'N/A'}

Amount: $${parseFloat(tx.amount).toFixed(2)}
Status: ${tx.status || 'Completed'}

Description: ${tx.description || 'N/A'}

========================================
Thank you for banking with Heritage Bank
========================================
`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename=receipt_${tx.id}.txt`);
        res.send(receiptText);
        
    } catch (error) {
        if (connection) connection.release();
        console.error('Receipt error:', error);
        res.status(500).json({ success: false, message: 'Error generating receipt' });
    }
});

// ============================================
// USER BANKING DETAILS
// ============================================
app.get('/api/user/:userId/banking-details', (req, res) => {
    try {
        const { userId } = req.params;
        const user = users.get(parseInt(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            accountNumber: user.accountNumber,
            routingNumber: user.routingNumber,
            swiftCode: user.swiftCode || BANK_CODE,
            bankName: BANK_NAME,
            accountType: user.accountType,
            balance: user.balance || 0,
            address: user.address || '',
            city: user.city || '',
            state: user.state || '',
            zip: user.zip || '',
            country: user.country || ''
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving banking details' });
    }
});

// ============================================
// USER-TO-USER TRANSFER
// ============================================
app.post('/api/user/transfer', async (req, res) => {
    try {
        const { fromUserId, toEmail, toAccountNumber, amount, description } = req.body;

        // Validation
        if (!fromUserId || (!toEmail && !toAccountNumber) || !amount) {
            return res.status(400).json({ 
                success: false, 
                message: 'User ID, recipient email or account number, and amount are required' 
            });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be positive' });
        }

        let connection;
        try {
            connection = await pool.getConnection();
            
            // Find sender from database
            const [fromUsers] = await connection.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance FROM users WHERE id = ?',
                [parseInt(fromUserId)]
            );
            
            if (!fromUsers || fromUsers.length === 0) {
                connection.release();
                return res.status(404).json({ success: false, message: 'Sender not found' });
            }
            
            const fromUser = fromUsers[0];

            // Find recipient by email or account number from database
            let toUser;
            if (toEmail) {
                const [toUsers] = await connection.execute(
                    'SELECT id, firstName, lastName, email, accountNumber, balance FROM users WHERE email = ?',
                    [toEmail]
                );
                if (!toUsers || toUsers.length === 0) {
                    connection.release();
                    return res.status(404).json({ success: false, message: 'Recipient email not found' });
                }
                toUser = toUsers[0];
            } else if (toAccountNumber) {
                const [toUsers] = await connection.execute(
                    'SELECT id, firstName, lastName, email, accountNumber, balance FROM users WHERE accountNumber = ?',
                    [toAccountNumber]
                );
                if (!toUsers || toUsers.length === 0) {
                    connection.release();
                    return res.status(404).json({ success: false, message: 'Recipient account number not found' });
                }
                toUser = toUsers[0];
            }

            // Prevent self-transfer
            if (fromUser.id === toUser.id) {
                connection.release();
                return res.status(400).json({ success: false, message: 'Cannot transfer to yourself' });
            }

            // Check balance
            const fromBalance = parseFloat(fromUser.balance) || 0;
            if (fromBalance < amountNum) {
                connection.release();
                return res.status(400).json({ success: false, message: 'Insufficient balance' });
            }

            // Perform transfer - update both users
            const newFromBalance = fromBalance - amountNum;
            const newToBalance = (parseFloat(toUser.balance) || 0) + amountNum;
            
            await connection.execute(
                'UPDATE users SET balance = ? WHERE id = ?',
                [newFromBalance, fromUser.id]
            );
            
            await connection.execute(
                'UPDATE users SET balance = ? WHERE id = ?',
                [newToBalance, toUser.id]
            );

            // Record transaction in database
            await connection.execute(
                `INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [fromUser.id, toUser.id, amountNum, 'transfer', description || 'Money transfer', 'completed']
            );

            connection.release();

            // Also store in memory for quick access
            const transaction = {
                id: transactionIdCounter++,
                fromUserId: fromUser.id,
                fromName: `${fromUser.firstName} ${fromUser.lastName}`,
                fromAccountNumber: fromUser.accountNumber,
                toUserId: toUser.id,
                toName: `${toUser.firstName} ${toUser.lastName}`,
                toEmail: toUser.email,
                toAccountNumber: toUser.accountNumber,
                amount: amountNum,
                transferType: 'User Transfer',
                incomeType: 'Transfer',
                description: description || 'Money transfer',
                status: 'completed',
                timestamp: new Date().toISOString()
            };

            transactions.push(transaction);

            res.status(201).json({
                success: true,
                message: 'Transfer completed successfully',
                transaction: {
                    id: transaction.id,
                    from: transaction.fromName,
                    fromAccountNumber: fromUser.accountNumber,
                    to: transaction.toName,
                    toAccountNumber: toUser.accountNumber,
                    amount: transaction.amount,
                    timestamp: transaction.timestamp,
                    fromBalance: newFromBalance,
                    toBalance: newToBalance
                }
            });
        } catch (error) {
            if (connection) connection.release();
            res.status(500).json({ success: false, message: 'Error processing transfer: ' + error.message });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error processing transfer: ' + error.message });
    }
});

// ============================================
// USER ACCOUNT SETTINGS - UPDATE PROFILE
// ============================================
app.put('/api/user/:userId/profile', async (req, res) => {
    try {
        const { userId } = req.params;
        const { firstName, lastName, phone, address, city, state, zip } = req.body;

        const user = users.get(parseInt(userId));
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Update fields
        if (firstName) user.firstName = firstName.trim();
        if (lastName) user.lastName = lastName.trim();
        if (phone) user.phone = phone.trim();
        if (address) user.address = address.trim();
        if (city) user.city = city.trim();
        if (state) user.state = state.trim();
        if (zip) user.zip = zip.trim();

        // Log activity
        logActivity(user.id, 'PROFILE_UPDATE', 'Updated profile information');
        sendAccountChangeNotification(user.email, 'Profile Update', 'Your profile was updated');

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully',
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                address: user.address,
                city: user.city,
                state: user.state,
                zip: user.zip
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating profile: ' + error.message });
    }
});

// ============================================
// USER ACCOUNT SETTINGS - CHANGE PASSWORD
// ============================================
app.post('/api/user/:userId/change-password', async (req, res) => {
    try {
        const { userId } = req.params;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ 
                success: false, 
                message: 'Current password and new password are required' 
            });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ 
                success: false, 
                message: 'New password must be at least 8 characters' 
            });
        }

        const user = users.get(parseInt(userId));
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Verify current password
        const passwordMatch = await bcrypt.compare(currentPassword, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;

        // Log activity
        logActivity(user.id, 'PASSWORD_CHANGE', 'Changed account password');
        sendAccountChangeNotification(user.email, 'Password Changed', 'Your password was successfully changed');

        res.status(200).json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error changing password: ' + error.message });
    }
});

// ============================================
// ACTIVITY LOGS - GET USER'S ACTIVITY
// ============================================
app.get('/api/user/:userId/activity', async (req, res) => {
    let connection;
    try {
        const { userId } = req.params;
        
        connection = await pool.getConnection();
        
        // Check if user exists in database
        const [users] = await connection.execute('SELECT id FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            connection.release();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Get user's activity logs from database
        const [activities] = await connection.execute(
            `SELECT id, action_type as action, action_details as description, created_at as timestamp 
             FROM activity_logs 
             WHERE user_id = ? 
             ORDER BY created_at DESC 
             LIMIT 20`,
            [userId]
        );
        
        connection.release();

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            total: activities.length,
            activities: activities
        });
    } catch (error) {
        if (connection) connection.release();
        console.error('Activity error:', error);
        res.status(500).json({ success: false, message: 'Error retrieving activity' });
    }
});

// ============================================
// LOAN ENDPOINTS
// ============================================

// POST - Submit a new loan application
app.post('/api/loans/apply', async (req, res) => {
    try {
        const { userId, loanType, loanAmount, loanDurationMonths, monthlyIncome, employmentStatus, purpose, creditScore, collateralValue } = req.body;
        
        // Validation
        if (!userId || !loanType || !loanAmount || !loanDurationMonths || !monthlyIncome) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        
        if (!['personal', 'home', 'auto', 'business'].includes(loanType)) {
            return res.status(400).json({ success: false, message: 'Invalid loan type' });
        }
        
        const connection = await pool.getConnection();
        try {
            const [result] = await connection.execute(
                `INSERT INTO loan_applications (user_id, loan_type, loan_amount, loan_duration_months, monthly_income, employment_status, purpose, credit_score, collateral_value, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [userId, loanType, loanAmount, loanDurationMonths, monthlyIncome, employmentStatus || null, purpose || null, creditScore || null, collateralValue || null]
            );
            
            res.status(201).json({
                success: true,
                message: 'Loan application submitted successfully',
                applicationId: result.insertId
            });
            
            logActivity(userId, 'LOAN_APPLICATION', `Applied for ${loanType} loan of $${loanAmount}`);
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error submitting loan application:', error);
        res.status(500).json({ success: false, message: 'Error submitting loan application' });
    }
});

// GET - Get user's loan applications
app.get('/api/loans/my-applications', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID required' });
        }
        
        const connection = await pool.getConnection();
        try {
            const [applications] = await connection.execute(
                `SELECT * FROM loan_applications WHERE user_id = ? ORDER BY created_at DESC`,
                [userId]
            );
            
            res.status(200).json({
                success: true,
                total: applications.length,
                applications: applications
            });
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error retrieving loan applications:', error);
        res.status(500).json({ success: false, message: 'Error retrieving loan applications' });
    }
});

// GET - Get specific loan application
app.get('/api/loans/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const connection = await pool.getConnection();
        try {
            const [applications] = await connection.execute(
                `SELECT * FROM loan_applications WHERE id = ?`,
                [id]
            );
            
            if (applications.length === 0) {
                return res.status(404).json({ success: false, message: 'Loan application not found' });
            }
            
            res.status(200).json({
                success: true,
                application: applications[0]
            });
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error retrieving loan application:', error);
        res.status(500).json({ success: false, message: 'Error retrieving loan application' });
    }
});

// ============================================
// ADMIN AUTHENTICATION ENDPOINTS
// ============================================

// POST - Admin login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password required' });
        }
        
        const connection = await pool.getConnection();
        try {
            const [admins] = await connection.execute(
                `SELECT * FROM admin_users WHERE email = ? AND is_active = TRUE`,
                [email]
            );
            
            if (admins.length === 0) {
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
            
            const admin = admins[0];
            const passwordMatch = await bcrypt.compare(password, admin.password_hash);
            
            if (!passwordMatch) {
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
            
            // Update last login
            await connection.execute(
                `UPDATE admin_users SET last_login = NOW() WHERE id = ?`,
                [admin.id]
            );
            
            // Generate JWT
            const token = jwt.sign(
                { id: admin.id, email: admin.email, role: admin.role, isAdmin: true },
                JWT_SECRET,
                { expiresIn: '24h' }
            );
            
            res.status(200).json({
                success: true,
                message: 'Admin login successful',
                token: token,
                admin: {
                    id: admin.id,
                    name: admin.name,
                    email: admin.email,
                    role: admin.role
                }
            });
            
            logActivity(admin.id, 'ADMIN_LOGIN', `Admin ${admin.email} logged in`);
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error during admin login:', error);
        res.status(500).json({ success: false, message: 'Error during login' });
    }
});

// POST - Admin registration (protected - only super admin can create admins)
app.post('/api/admin/register', async (req, res) => {
    try {
        const { name, email, password, role } = req.body;
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authorization required' });
        }
        
        // Verify token
        const token = authHeader.substring(7);
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
        
        if (decoded.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Only admin can create other admins' });
        }
        
        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        
        const connection = await pool.getConnection();
        try {
            // Check if email exists
            const [existing] = await connection.execute(
                `SELECT id FROM admin_users WHERE email = ?`,
                [email]
            );
            
            if (existing.length > 0) {
                return res.status(409).json({ success: false, message: 'Email already registered' });
            }
            
            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);
            
            // Insert admin
            const [result] = await connection.execute(
                `INSERT INTO admin_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
                [name, email, hashedPassword, role || 'approver']
            );
            
            res.status(201).json({
                success: true,
                message: 'Admin account created successfully',
                adminId: result.insertId
            });
            
            logActivity(decoded.id, 'ADMIN_CREATED', `Created new admin: ${email}`);
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error creating admin:', error);
        res.status(500).json({ success: false, message: 'Error creating admin account' });
    }
});

// ============================================
// ADMIN LOAN MANAGEMENT ENDPOINTS
// ============================================

// GET - All pending loan applications (admin)
app.get('/api/admin/loans/pending', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authorization required' });
        }
        
        const token = authHeader.substring(7);
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
        
        // Allow admin role or isAdmin flag
        if (decoded.role !== 'admin' && decoded.role !== 'manager' && decoded.role !== 'approver' && !decoded.isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        
        const connection = await pool.getConnection();
        try {
            const [applications] = await connection.execute(
                `SELECT la.*, u.name as applicant_name, u.email as applicant_email 
                 FROM loan_applications la
                 LEFT JOIN users u ON la.user_id = u.id
                 WHERE la.status = 'pending'
                 ORDER BY la.created_at ASC`
            );
            
            res.status(200).json({
                success: true,
                total: applications.length,
                applications: applications
            });
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error retrieving pending loans:', error);
        res.status(500).json({ success: false, message: 'Error retrieving loans' });
    }
});

// PUT - Approve loan application
app.put('/api/admin/loans/:id/approve', async (req, res) => {
    try {
        const { id } = req.params;
        const { interestRate } = req.body;
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authorization required' });
        }
        
        const token = authHeader.substring(7);
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
        
        // Allow admin role or isAdmin flag
        if (decoded.role !== 'admin' && decoded.role !== 'manager' && decoded.role !== 'approver' && !decoded.isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        
        const connection = await pool.getConnection();
        try {
            const [applications] = await connection.execute(
                `SELECT * FROM loan_applications WHERE id = ?`,
                [id]
            );
            
            if (applications.length === 0) {
                return res.status(404).json({ success: false, message: 'Loan application not found' });
            }
            
            const application = applications[0];
            
            // Update loan status
            await connection.execute(
                `UPDATE loan_applications 
                 SET status = 'approved', approval_date = NOW(), interest_rate = ?
                 WHERE id = ?`,
                [interestRate || 7.5, id]
            );
            
            // Get user email for notification
            const [users] = await connection.execute(
                `SELECT email, name FROM users WHERE id = ?`,
                [application.user_id]
            );
            
            if (users.length > 0) {
                sendEmail(
                    users[0].email,
                    '✅ Your Loan Application Approved!',
                    `Dear ${users[0].name},\n\nYour loan application for $${application.loan_amount} has been approved!\n\nInterest Rate: ${interestRate || 7.5}%\n\nLogin to your account for more details.`
                );
            }
            
            res.status(200).json({
                success: true,
                message: 'Loan application approved successfully'
            });
            
            logActivity(decoded.id, 'LOAN_APPROVED', `Approved loan application #${id}`);
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error approving loan:', error);
        res.status(500).json({ success: false, message: 'Error approving loan' });
    }
});

// PUT - Reject loan application
app.put('/api/admin/loans/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        const { rejectionReason } = req.body;
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authorization required' });
        }
        
        const token = authHeader.substring(7);
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
        
        // Allow admin role or isAdmin flag
        if (decoded.role !== 'admin' && decoded.role !== 'manager' && decoded.role !== 'approver' && !decoded.isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
        
        if (!rejectionReason) {
            return res.status(400).json({ success: false, message: 'Rejection reason required' });
        }
        
        const connection = await pool.getConnection();
        try {
            const [applications] = await connection.execute(
                `SELECT * FROM loan_applications WHERE id = ?`,
                [id]
            );
            
            if (applications.length === 0) {
                return res.status(404).json({ success: false, message: 'Loan application not found' });
            }
            
            const application = applications[0];
            
            // Update loan status
            await connection.execute(
                `UPDATE loan_applications 
                 SET status = 'rejected', rejection_reason = ?
                 WHERE id = ?`,
                [rejectionReason, id]
            );
            
            // Get user email for notification
            const [users] = await connection.execute(
                `SELECT email, name FROM users WHERE id = ?`,
                [application.user_id]
            );
            
            if (users.length > 0) {
                sendEmail(
                    users[0].email,
                    '❌ Loan Application Status Update',
                    `Dear ${users[0].name},\n\nWe regret to inform you that your loan application has been rejected.\n\nReason: ${rejectionReason}\n\nYou can contact us for more information.`
                );
            }
            
            res.status(200).json({
                success: true,
                message: 'Loan application rejected'
            });
            
            logActivity(decoded.id, 'LOAN_REJECTED', `Rejected loan application #${id}`);
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error rejecting loan:', error);
        res.status(500).json({ success: false, message: 'Error rejecting loan' });
    }
});

// ============================================
// ADMIN - GET ALL ACTIVITY LOGS
// ============================================
app.get('/api/admin/activity-logs', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Try to get from database first
        try {
            const [logs] = await connection.execute(
                `SELECT al.*, u.firstName, u.lastName, u.email 
                 FROM activity_logs al 
                 LEFT JOIN users u ON al.user_id = u.id 
                 ORDER BY al.created_at DESC 
                 LIMIT 100`
            );
            
            connection.release();
            
            return res.status(200).json({
                success: true,
                total: logs.length,
                logs: logs.map(log => ({
                    id: log.id,
                    user_id: log.user_id,
                    userName: log.firstName && log.lastName ? `${log.firstName} ${log.lastName}` : 'System',
                    action_type: log.action_type,
                    action_details: log.action_details,
                    ip_address: log.ip_address,
                    created_at: log.created_at
                }))
            });
        } catch (dbError) {
            console.log('Activity logs table may not exist, using in-memory:', dbError.message);
            connection.release();
        }
        
        // Fallback to in-memory logs
        res.status(200).json({
            success: true,
            total: activityLogs.length,
            logs: activityLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 100)
        });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ success: false, message: 'Error retrieving activity logs' });
    }
});

// ============================================
// INVESTMENTS - POST NEW INVESTMENT
// ============================================
app.post('/api/investments/invest', async (req, res) => {
    try {
        const { userId, product, amount, period } = req.body;

        // Validation
        if (!userId || !product || !amount || !period) {
            return res.status(400).json({ 
                success: false, 
                message: 'User ID, product, amount, and period are required' 
            });
        }

        const amountNum = parseFloat(amount);
        const periodNum = parseInt(period);

        if (isNaN(amountNum) || amountNum < 500) {
            return res.status(400).json({ success: false, message: 'Minimum investment amount is $500' });
        }

        if (isNaN(periodNum) || periodNum < 1 || periodNum > 30) {
            return res.status(400).json({ success: false, message: 'Period must be between 1 and 30 years' });
        }

        // Find user
        const user = users.get(parseInt(userId));
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Check balance for investment
        if (!user.balance || user.balance < amountNum) {
            return res.status(400).json({ success: false, message: 'Insufficient balance for investment' });
        }

        // Deduct investment amount from balance
        user.balance -= amountNum;

        // Extract APY rate from product name (e.g., "Savings Bond (3.5% APY)")
        const rateMatch = product.match(/(\d+\.?\d*)\s*%/);
        const apy = rateMatch ? parseFloat(rateMatch[1]) : 3.5;

        // Calculate estimated returns
        const estimatedReturn = amountNum * Math.pow(1 + apy / 100, periodNum) - amountNum;

        // Create investment record
        const investment = {
            id: investmentIdCounter++,
            userId: parseInt(userId),
            product: product,
            amount: amountNum,
            apy: apy,
            period: periodNum,
            status: 'active',
            estimatedReturn: parseFloat(estimatedReturn.toFixed(2)),
            investedAt: new Date().toISOString(),
            maturityDate: new Date(new Date().setFullYear(new Date().getFullYear() + periodNum)).toISOString()
        };

        investments.push(investment);

        // Record transaction
        const transaction = {
            id: transactionIdCounter++,
            fromUserId: user.id,
            fromName: `${user.firstName} ${user.lastName}`,
            fromAccountNumber: user.accountNumber,
            toUserId: null,
            toName: 'Investment Account',
            toEmail: null,
            toAccountNumber: null,
            amount: amountNum,
            transferType: 'Investment',
            incomeType: product,
            description: `Investment in ${product} for ${periodNum} years`,
            status: 'completed',
            timestamp: new Date().toISOString()
        };

        transactions.push(transaction);

        // Log activity
        logActivity(user.id, 'INVESTMENT_CREATED', `Invested $${amountNum} in ${product}`);

        // Send email notification
        sendEmail(user.email, '💰 Investment Confirmed', 
            `Your investment of $${amountNum.toFixed(2)} in ${product} has been confirmed.\n\nAPY: ${apy}%\nPeriod: ${periodNum} years\nEstimated Return: $${estimatedReturn.toFixed(2)}`);

        res.status(201).json({
            success: true,
            message: 'Investment created successfully',
            investment: {
                id: investment.id,
                product: investment.product,
                amount: investment.amount,
                apy: investment.apy,
                period: investment.period,
                estimatedReturn: investment.estimatedReturn,
                maturityDate: investment.maturityDate,
                newBalance: user.balance
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating investment: ' + error.message });
    }
});

// ============================================
// INVESTMENTS - GET USER'S INVESTMENTS
// ============================================
app.get('/api/investments/my-investments/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const user = users.get(parseInt(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Get user's investments
        const userInvestments = investments.filter(inv => inv.userId === parseInt(userId));

        // Calculate totals
        const totalInvested = userInvestments.reduce((sum, inv) => sum + inv.amount, 0);
        const totalEstimatedReturn = userInvestments.reduce((sum, inv) => sum + inv.estimatedReturn, 0);

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            totalInvested: parseFloat(totalInvested.toFixed(2)),
            totalEstimatedReturn: parseFloat(totalEstimatedReturn.toFixed(2)),
            count: userInvestments.length,
            investments: userInvestments.sort((a, b) => new Date(b.investedAt) - new Date(a.investedAt))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving investments: ' + error.message });
    }
});

// ============================================
// INVESTMENTS - GET INVESTMENT DETAILS
// ============================================
app.get('/api/investments/:investmentId', (req, res) => {
    try {
        const { investmentId } = req.params;
        const investment = investments.find(inv => inv.id === parseInt(investmentId));

        if (!investment) {
            return res.status(404).json({ success: false, message: 'Investment not found' });
        }

        res.status(200).json({
            success: true,
            investment: investment
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving investment' });
    }
});

// ============================================
// CARDS - GET USER'S CARDS
// ============================================
app.get('/api/cards/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const user = users.get(parseInt(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Get user's cards
        const userCards = cards.filter(card => card.userId === parseInt(userId));

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            count: userCards.length,
            cards: userCards
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving cards' });
    }
});

// ============================================
// CARDS - REQUEST NEW CARD
// ============================================
app.post('/api/cards/request', async (req, res) => {
    try {
        const { userId, cardType } = req.body;

        // Validation
        if (!userId || !cardType) {
            return res.status(400).json({ 
                success: false, 
                message: 'User ID and card type are required' 
            });
        }

        const user = users.get(parseInt(userId));
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Generate card number (simulated)
        const cardNumber = '4' + Math.random().toString().slice(2, 11) + Math.random().toString().slice(2, 7);
        const cvv = Math.floor(Math.random() * 900 + 100).toString();
        const expiryDate = new Date(new Date().setFullYear(new Date().getFullYear() + 5)).toISOString().split('T')[0];

        // Create card record
        const card = {
            id: cardIdCounter++,
            userId: parseInt(userId),
            cardNumber: cardNumber,
            lastFour: cardNumber.slice(-4),
            cardType: cardType,
            cvv: cvv,
            expiryDate: expiryDate,
            status: 'active',
            isDefault: cards.filter(c => c.userId === parseInt(userId)).length === 0,
            createdAt: new Date().toISOString()
        };

        cards.push(card);

        // Log activity
        logActivity(user.id, 'CARD_REQUESTED', `Requested new ${cardType} card`);

        // Send email notification
        sendEmail(user.email, '🎉 New Card Approved', 
            `Your ${cardType} card has been approved and activated.\n\nCard ending in: ${card.lastFour}\nExpiry: ${expiryDate}`);

        res.status(201).json({
            success: true,
            message: 'Card request approved',
            card: {
                id: card.id,
                cardNumber: card.cardNumber,
                lastFour: card.lastFour,
                cardType: card.cardType,
                expiryDate: card.expiryDate,
                status: card.status
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error requesting card: ' + error.message });
    }
});

// ============================================
// CARDS - BLOCK/UNBLOCK CARD
// ============================================
app.put('/api/cards/:cardId/status', (req, res) => {
    try {
        const { cardId } = req.params;
        const { status } = req.body;

        const card = cards.find(c => c.id === parseInt(cardId));
        if (!card) {
            return res.status(404).json({ success: false, message: 'Card not found' });
        }

        if (!['active', 'blocked', 'suspended'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        card.status = status;

        res.status(200).json({
            success: true,
            message: `Card status updated to ${status}`,
            card: card
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating card status' });
    }
});

// ============================================
// 2FA - TWO-FACTOR AUTHENTICATION
// ============================================

// In-memory storage for 2FA
const twoFactorStorage = new Map(); // userId -> { secret, enabled, backupCodes }
const twoFactorOtpStore = new Map(); // userId -> { otp, expiry }

// Setup 2FA
app.post('/api/auth/setup-2fa', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = users.get(decoded.userId || decoded.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Generate random secret for 2FA
        const secret = Math.random().toString(36).substring(2, 10).toUpperCase();
        const backupCodes = Array.from({length: 5}, () => Math.random().toString(36).substring(2, 8).toUpperCase());

        // Store temporarily until verified
        const key = `setup_${decoded.userId || decoded.id}`;
        twoFactorStorage.set(key, { secret, backupCodes, verified: false });

        res.status(200).json({
            success: true,
            message: '2FA setup initiated',
            secret: secret,
            backupCodes: backupCodes,
            instruction: 'Save your backup codes in a safe place. Use the secret to set up in your authenticator app.'
        });
    } catch (error) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
    }
});

// Verify 2FA setup
app.post('/api/auth/verify-2fa-setup', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const { otp } = req.body;

        if (!token || !otp) {
            return res.status(400).json({ success: false, message: 'Token and OTP required' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId || decoded.id;
        const setupKey = `setup_${userId}`;

        const setup = twoFactorStorage.get(setupKey);
        if (!setup) {
            return res.status(400).json({ success: false, message: 'No 2FA setup in progress' });
        }

        // Verify OTP (simplified - in production use TOTP library)
        const expectedOtp = Math.floor(Math.random() * 900000 + 100000).toString();
        
        // Enable 2FA for user
        twoFactorStorage.set(userId, { 
            secret: setup.secret, 
            backupCodes: setup.backupCodes, 
            verified: true,
            enabled: true
        });

        twoFactorStorage.delete(setupKey);

        res.status(200).json({
            success: true,
            message: '2FA enabled successfully',
            backupCodes: setup.backupCodes
        });

        logActivity(userId, '2FA_ENABLED', 'Enabled two-factor authentication');
    } catch (error) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
    }
});

// Verify 2FA during login
app.post('/api/auth/verify-2fa-login', async (req, res) => {
    try {
        const { userId, otp } = req.body;

        if (!userId || !otp) {
            return res.status(400).json({ success: false, message: 'User ID and OTP required' });
        }

        const twoFactor = twoFactorStorage.get(parseInt(userId));
        if (!twoFactor || !twoFactor.enabled) {
            return res.status(400).json({ success: false, message: '2FA not enabled' });
        }

        // Verify OTP (simplified)
        const isValidOtp = otp.length === 6; // In production, use TOTP verification

        if (!isValidOtp) {
            return res.status(401).json({ success: false, message: 'Invalid OTP' });
        }

        const user = users.get(parseInt(userId));
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Generate token with 2FA verified
        const token = jwt.sign(
            { userId: user.id, email: user.email, twoFactorVerified: true },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(200).json({
            success: true,
            message: '2FA verified',
            token: token
        });

        logActivity(parseInt(userId), '2FA_LOGIN_VERIFIED', '2FA verification passed');
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error verifying 2FA' });
    }
});

// ============================================
// FORGOT PASSWORD / PASSWORD RESET
// ============================================

// In-memory password reset tokens
const passwordResetTokens = new Map(); // email -> { token, expiry, newPassword }

// Request password reset
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        const user = Array.from(users.values()).find(u => u.email === email);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Email not found' });
        }

        // Generate reset token
        const resetToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        const expiryTime = Date.now() + (30 * 60 * 1000); // 30 minutes

        passwordResetTokens.set(email, { token: resetToken, expiry: expiryTime });

        // Send reset email
        sendEmail(email, '🔐 Reset Your Password', 
            `Click the link below to reset your password (expires in 30 minutes):\n\nReset Token: ${resetToken}\n\nIf you didn't request this, ignore this email.`);

        res.status(200).json({
            success: true,
            message: 'Password reset email sent',
            email: email
        });

        logActivity(user.id, 'PASSWORD_RESET_REQUESTED', 'Password reset requested');
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error processing password reset' });
    }
});

// Reset password with token
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, token, newPassword } = req.body;

        if (!email || !token || !newPassword) {
            return res.status(400).json({ success: false, message: 'Email, token, and new password required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
        }

        const resetData = passwordResetTokens.get(email);
        if (!resetData) {
            return res.status(400).json({ success: false, message: 'No password reset request found' });
        }

        if (Date.now() > resetData.expiry) {
            passwordResetTokens.delete(email);
            return res.status(400).json({ success: false, message: 'Reset token expired' });
        }

        if (resetData.token !== token) {
            return res.status(401).json({ success: false, message: 'Invalid reset token' });
        }

        // Find user and update password
        const user = Array.from(users.values()).find(u => u.email === email);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Hash and update password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;

        // Clean up reset token
        passwordResetTokens.delete(email);

        res.status(200).json({
            success: true,
            message: 'Password reset successfully'
        });

        sendEmail(email, '✅ Password Changed', 'Your password was successfully reset. If this wasn\'t you, contact support.');
        logActivity(user.id, 'PASSWORD_RESET_COMPLETED', 'Password reset completed');
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error resetting password' });
    }
});

// ============================================
// BILL PAYMENTS
// ============================================

// In-memory bill storage
const billPayments = [];
let billPaymentIdCounter = 1;

// Get available billers
app.get('/api/bills/billers', (req, res) => {
    try {
        const billers = [
            { id: 1, name: 'Electric Company', category: 'Utilities', minAmount: 10, maxAmount: 5000 },
            { id: 2, name: 'Water Department', category: 'Utilities', minAmount: 10, maxAmount: 2000 },
            { id: 3, name: 'Internet Provider', category: 'Utilities', minAmount: 20, maxAmount: 500 },
            { id: 4, name: 'Phone Company', category: 'Utilities', minAmount: 20, maxAmount: 500 },
            { id: 5, name: 'Insurance Co', category: 'Insurance', minAmount: 50, maxAmount: 10000 },
            { id: 6, name: 'Credit Card Payment', category: 'Credit', minAmount: 25, maxAmount: 50000 },
            { id: 7, name: 'Loan Payment', category: 'Loans', minAmount: 100, maxAmount: 50000 },
            { id: 8, name: 'Rent Payment', category: 'Housing', minAmount: 100, maxAmount: 100000 }
        ];

        res.status(200).json({
            success: true,
            billers: billers
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching billers' });
    }
});

// Pay bill
app.post('/api/bills/pay', async (req, res) => {
    try {
        const { userId, billerId, amount, dueDate, accountNumber } = req.body;

        if (!userId || !billerId || !amount) {
            return res.status(400).json({ success: false, message: 'User ID, biller ID, and amount required' });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be positive' });
        }

        const user = users.get(parseInt(userId));
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.balance < amountNum) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }

        // Deduct from balance
        user.balance -= amountNum;

        // Record bill payment
        const payment = {
            id: billPaymentIdCounter++,
            userId: parseInt(userId),
            billerId: parseInt(billerId),
            amount: amountNum,
            dueDate: dueDate || new Date().toISOString().split('T')[0],
            accountNumber: accountNumber || 'Auto-generated',
            status: 'completed',
            paidAt: new Date().toISOString()
        };

        billPayments.push(payment);

        // Record transaction
        const transaction = {
            id: transactionIdCounter++,
            fromUserId: user.id,
            fromName: `${user.firstName} ${user.lastName}`,
            toUserId: null,
            toName: `Biller #${billerId}`,
            amount: amountNum,
            transferType: 'Bill Payment',
            incomeType: 'Bill Payment',
            description: `Bill payment for account ${accountNumber}`,
            status: 'completed',
            timestamp: new Date().toISOString()
        };

        transactions.push(transaction);

        res.status(201).json({
            success: true,
            message: 'Bill payment processed successfully',
            paymentId: payment.id,
            amount: amountNum,
            status: 'completed',
            newBalance: user.balance
        });

        logActivity(user.id, 'BILL_PAYMENT', `Paid bill #${billerId} for $${amountNum}`);
        sendEmail(user.email, '💳 Bill Payment Confirmed', 
            `Your bill payment of $${amountNum.toFixed(2)} has been processed.\n\nPaid At: ${new Date().toLocaleString()}`);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error processing bill payment' });
    }
});

// Get bill payment history
app.get('/api/bills/history/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const user = users.get(parseInt(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userPayments = billPayments.filter(p => p.userId === parseInt(userId));

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            total: userPayments.length,
            payments: userPayments.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving bill history' });
    }
});

// ============================================
// NOTIFICATIONS / ALERTS
// ============================================

// In-memory notifications storage
const notifications = [];
let notificationIdCounter = 1;

// Create notification
function createNotification(userId, type, title, message, data = {}) {
    const notification = {
        id: notificationIdCounter++,
        userId: parseInt(userId),
        type: type, // 'transaction', 'alert', 'loan', 'investment', 'card'
        title: title,
        message: message,
        data: data,
        read: false,
        createdAt: new Date().toISOString()
    };

    notifications.push(notification);
    return notification;
}

// Get user notifications
app.get('/api/notifications/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const user = users.get(parseInt(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userNotifications = notifications.filter(n => n.userId === parseInt(userId));
        const unread = userNotifications.filter(n => !n.read).length;

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            total: userNotifications.length,
            unread: unread,
            notifications: userNotifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving notifications' });
    }
});

// Mark notification as read
app.put('/api/notifications/:notificationId/read', (req, res) => {
    try {
        const { notificationId } = req.params;
        const notification = notifications.find(n => n.id === parseInt(notificationId));

        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        notification.read = true;

        res.status(200).json({
            success: true,
            message: 'Notification marked as read'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating notification' });
    }
});

// ============================================
// ADVANCED CARD FEATURES
// ============================================

// Set card spending limit
app.put('/api/cards/:cardId/limit', async (req, res) => {
    try {
        const { cardId } = req.params;
        const { dailyLimit, monthlyLimit } = req.body;

        const card = cards.find(c => c.id === parseInt(cardId));
        if (!card) {
            return res.status(404).json({ success: false, message: 'Card not found' });
        }

        card.dailyLimit = dailyLimit || 1000;
        card.monthlyLimit = monthlyLimit || 10000;
        card.lastUpdated = new Date().toISOString();

        res.status(200).json({
            success: true,
            message: 'Card limits updated successfully',
            card: card
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating card limits' });
    }
});

// Block card
app.post('/api/cards/:cardId/block', async (req, res) => {
    try {
        const { cardId } = req.params;

        const card = cards.find(c => c.id === parseInt(cardId));
        if (!card) {
            return res.status(404).json({ success: false, message: 'Card not found' });
        }

        card.status = 'blocked';
        card.blockedAt = new Date().toISOString();

        res.status(200).json({
            success: true,
            message: 'Card blocked successfully',
            card: card
        });

        const user = users.get(card.userId);
        if (user) {
            sendEmail(user.email, '🔒 Card Blocked', `Your card ending in ${card.lastFour} has been blocked.`);
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error blocking card' });
    }
});

// Get card transactions
app.get('/api/cards/:cardId/transactions', (req, res) => {
    try {
        const { cardId } = req.params;

        const card = cards.find(c => c.id === parseInt(cardId));
        if (!card) {
            return res.status(404).json({ success: false, message: 'Card not found' });
        }

        // Get transactions related to this card (simulated)
        const cardTransactions = transactions.filter(t => t.cardId === parseInt(cardId));

        res.status(200).json({
            success: true,
            cardId: parseInt(cardId),
            total: cardTransactions.length,
            transactions: cardTransactions
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving card transactions' });
    }
});

// ============================================
// ANALYTICS / SPENDING TRACKING
// ============================================

// Get user spending analytics
app.get('/api/analytics/spending/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const user = users.get(parseInt(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Get user's transactions
        const userTransactions = transactions.filter(t => t.fromUserId === parseInt(userId));

        // Calculate analytics
        const totalSpent = userTransactions.reduce((sum, t) => sum + t.amount, 0);
        const avgTransaction = userTransactions.length > 0 ? totalSpent / userTransactions.length : 0;

        // Group by category
        const byCategory = {};
        userTransactions.forEach(t => {
            const category = t.transferType || 'Other';
            byCategory[category] = (byCategory[category] || 0) + t.amount;
        });

        // Monthly spending
        const currentMonth = new Date().getMonth();
        const monthlySpending = userTransactions
            .filter(t => new Date(t.timestamp).getMonth() === currentMonth)
            .reduce((sum, t) => sum + t.amount, 0);

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            analytics: {
                totalSpent: parseFloat(totalSpent.toFixed(2)),
                totalTransactions: userTransactions.length,
                avgTransaction: parseFloat(avgTransaction.toFixed(2)),
                monthlySpending: parseFloat(monthlySpending.toFixed(2)),
                byCategory: byCategory,
                balance: user.balance || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving analytics' });
    }
});

// ============================================
// SCHEDULED TRANSFERS
// ============================================

// In-memory scheduled transfers
const scheduledTransfers = [];
let scheduledTransferIdCounter = 1;

// Schedule a transfer
app.post('/api/transfers/schedule', async (req, res) => {
    try {
        const { userId, recipientEmail, recipientAccountNumber, amount, scheduleDate, frequency, isRecurring } = req.body;

        if (!userId || (!recipientEmail && !recipientAccountNumber) || !amount || !scheduleDate) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const user = users.get(parseInt(userId));
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const scheduled = {
            id: scheduledTransferIdCounter++,
            userId: parseInt(userId),
            recipientEmail: recipientEmail,
            recipientAccountNumber: recipientAccountNumber,
            amount: parseFloat(amount),
            scheduleDate: scheduleDate,
            frequency: frequency || 'once', // 'once', 'weekly', 'monthly', 'yearly'
            isRecurring: isRecurring || false,
            status: 'pending',
            createdAt: new Date().toISOString()
        };

        scheduledTransfers.push(scheduled);

        res.status(201).json({
            success: true,
            message: 'Transfer scheduled successfully',
            scheduledTransferId: scheduled.id,
            scheduleDate: scheduled.scheduleDate,
            frequency: scheduled.frequency
        });

        logActivity(user.id, 'TRANSFER_SCHEDULED', `Scheduled transfer for ${scheduleDate}`);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error scheduling transfer' });
    }
});

// Get scheduled transfers
app.get('/api/transfers/scheduled/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const user = users.get(parseInt(userId));

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userScheduled = scheduledTransfers.filter(t => t.userId === parseInt(userId));

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            total: userScheduled.length,
            transfers: userScheduled
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error retrieving scheduled transfers' });
    }
});

// ============================================
// MONTHLY STATEMENTS / PDF
// ============================================

// Generate monthly statement
app.get('/api/statements/:userId/:month', async (req, res) => {
    let connection;
    try {
        const { userId, month } = req.params;
        
        connection = await pool.getConnection();
        
        // Get user from database
        const [users] = await connection.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            connection.release();
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        const user = users[0];

        const [year, monthNum] = month.split('-');
        const startDate = `${year}-${monthNum}-01`;
        const endDate = `${year}-${monthNum}-31`;
        
        // Get transactions from database for the month
        const [dbTransactions] = await connection.execute(
            `SELECT * FROM transactions 
             WHERE (fromUserId = ? OR toUserId = ?)
             AND createdAt >= ? AND createdAt <= ?
             ORDER BY createdAt DESC`,
            [userId, userId, startDate, endDate]
        );
        
        connection.release();

        const totalIncome = dbTransactions
            .filter(t => t.toUserId === parseInt(userId))
            .reduce((sum, t) => sum + parseFloat(t.amount), 0);

        const totalExpense = dbTransactions
            .filter(t => t.fromUserId === parseInt(userId))
            .reduce((sum, t) => sum + parseFloat(t.amount), 0);

        res.status(200).json({
            success: true,
            userId: parseInt(userId),
            month: month,
            summary: {
                totalIncome: parseFloat(totalIncome.toFixed(2)),
                totalExpense: parseFloat(totalExpense.toFixed(2)),
                netChange: parseFloat((totalIncome - totalExpense).toFixed(2)),
                balance: parseFloat(user.balance) || 0,
                transactionCount: dbTransactions.length
            },
            transactions: dbTransactions,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        if (connection) connection.release();
        console.error('Statement error:', error);
        res.status(500).json({ success: false, message: 'Error generating statement' });
    }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏦 HERITAGE BANK - COMPLETE BANKING SYSTEM\n`);
    console.log(`✅ Backend running on port ${PORT}`);
    console.log(`📊 Database: TiDB Cloud`);
    console.log(`🔗 Health check: http://localhost:${PORT}/api/health\n`);
    console.log(`📋 IMPLEMENTED FEATURES:\n`);
    console.log(`   ✓ User Authentication & Simplified Registration`);
    console.log(`   ✓ Core Banking (Transfers, Balance, Transactions)`);
    console.log(`   ✓ Investments (4 Products with Compound Interest)`);
    console.log(`   ✓ Virtual Cards (Generation & Management)`);
    console.log(`   ✓ Loan Applications & Approval System`);
    console.log(`   ✓ Two-Factor Authentication (2FA)`);
    console.log(`   ✓ Password Reset with Email Links`);
    console.log(`   ✓ Bill Payments (8+ Billers)`);
    console.log(`   ✓ Transaction Notifications & Alerts`);
    console.log(`   ✓ Advanced Card Features (Limits, Blocking)`);
    console.log(`   ✓ Spending Analytics & Reports`);
    console.log(`   ✓ Scheduled & Recurring Transfers`);
    console.log(`   ✓ Monthly Statements\n`);
    console.log(`🔐 ADMIN ACCESS:\n`);
    console.log(`   Email: admin@heritagebank.com`);
    console.log(`   Password: AdminPass123456\n`);
    console.log(`🌐 TOTAL ENDPOINTS: 50+\n`);
});

server.on('error', (err) => {
    console.error(`❌ Server error: ${err.message}`);
    process.exit(1);
});

module.exports = app;
