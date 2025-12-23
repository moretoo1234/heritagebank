const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const path = require('path');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
// Load environment variables.
// - In production (Render/etc), values are typically provided via real environment variables.
// - For local development, explicitly load `backend/.env` even if the process is started from repo root.
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Process-level diagnostics to help catch unexpected exits during local/dev runs.
// (Useful when the server starts and immediately quits due to missing env, port binding errors, etc.)
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
});

process.on('exit', (code) => {
    console.error(`ℹ️ Process exiting with code ${code}`);
});

['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
        console.error(`ℹ️ Received ${sig}, shutting down...`);
        process.exit(0);
    });
});

const app = express();

// Server version for debugging (matches root server convention)
const SERVER_VERSION = "2.0.0-" + new Date().toISOString().split('T')[0];

// Middleware
// Render/Heroku-style deployments often sit behind a reverse proxy.
// This helps rate limiting and IP logging use the real client IP.
app.set('trust proxy', 1);

// Security headers. We keep CSP disabled for now because many pages use
// inline scripts and third-party CDNs; enabling CSP requires a full refactor.
app.use(
    helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false
    })
);

// Basic API rate limiting (helps against brute force + abuse)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/apply', authLimiter);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend files from parent directory (for unified deployment)
app.use(express.static(path.join(__dirname, '..')));

// Database Connection Pool - Uses Environment Variables
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: { rejectUnauthorized: false }
});

// Tracks whether DB schema initialization has completed.
let DB_READY = false;

// JWT Secret - Must be set in environment
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'dev-jwt-secret-change-me' : null);
if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET environment variable is required (set it in your environment or backend/.env)');
    process.exit(1);
}
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'production') {
    console.warn('⚠️ JWT_SECRET is not set; using an insecure development default. Set JWT_SECRET in backend/.env for proper local auth testing.');
}

// Auth helpers
function requireAuth(req, res, next) {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, message: 'Authorization token required' });
        }
        const decoded = jwt.verify(token, JWT_SECRET);
        req.auth = {
            id: decoded.id,
            email: decoded.email,
            isImpersonation: !!decoded.isImpersonation,
            impersonatedBy: decoded.impersonatedBy
        };
        return next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
}

function requireNotImpersonation(req, res, next) {
    if (req.auth?.isImpersonation) {
        return res.status(403).json({ success: false, message: 'Action not allowed in view-only mode' });
    }
    return next();
}

async function requireAdmin(req, res, next) {
    try {
        if (!req.auth?.id) {
            return res.status(401).json({ success: false, message: 'Authorization token required' });
        }
        const [rows] = await pool.execute('SELECT isAdmin FROM users WHERE id = ?', [req.auth.id]);
        const isAdmin = !!rows[0]?.isAdmin;
        if (!isAdmin) {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }
        return next();
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

// Banking Details
const ROUTING_NUMBER = process.env.ROUTING_NUMBER || '091238946';
const BANK_NAME = 'Heritage Bank';

// Generate random account number
function generateAccountNumber() {
    return (Math.floor(Math.random() * 9000000000) + 1000000000).toString();
}

// Initialize database
async function initializeDatabase() {
    try {
        const connection = await pool.getConnection();
        
        // Users table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                firstName VARCHAR(100),
                lastName VARCHAR(100),
                email VARCHAR(255) UNIQUE,
                password VARCHAR(255),
                phone VARCHAR(20),
                dateOfBirth DATE,
                address VARCHAR(255),
                city VARCHAR(100),
                state VARCHAR(50),
                zipCode VARCHAR(10),
                country VARCHAR(100) DEFAULT 'United States',
                accountNumber VARCHAR(20) UNIQUE,
                routingNumber VARCHAR(20),
                balance DECIMAL(15,2) DEFAULT 50000,
                accountType ENUM('checking', 'savings', 'business', 'premium') DEFAULT 'checking',
                accountStatus ENUM('active', 'frozen', 'suspended', 'closed') DEFAULT 'active',
                isAdmin BOOLEAN DEFAULT false,
                marketingConsent BOOLEAN DEFAULT false,
                lastLogin TIMESTAMP NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Compatibility: some older deployments and/or DB-side artifacts may still expect an `ssn` column.
        // Keep it as nullable rather than dropping to avoid runtime errors.
        try { await connection.execute('ALTER TABLE users ADD COLUMN ssn VARCHAR(32) NULL'); } catch (e) {}

        // Best-effort schema alignment for newer auth features.
        try { await connection.execute('ALTER TABLE users ADD COLUMN forcePasswordChange BOOLEAN DEFAULT false'); } catch (e) {}

        // Best-effort schema alignment for user profile fields (older DBs may be missing these columns).
        try { await connection.execute('ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN dateOfBirth DATE NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN address VARCHAR(255) NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN city VARCHAR(100) NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN state VARCHAR(50) NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN zipCode VARCHAR(10) NULL'); } catch (e) {}
        try { await connection.execute("ALTER TABLE users ADD COLUMN country VARCHAR(100) DEFAULT 'United States'"); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN routingNumber VARCHAR(20) NULL'); } catch (e) {}
        try { await connection.execute("ALTER TABLE users ADD COLUMN accountType VARCHAR(32) DEFAULT 'checking'"); } catch (e) {}
        try { await connection.execute("ALTER TABLE users ADD COLUMN accountStatus VARCHAR(32) DEFAULT 'active'"); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN isAdmin BOOLEAN DEFAULT false'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN marketingConsent BOOLEAN DEFAULT false'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN lastLogin TIMESTAMP NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP'); } catch (e) {}

        // Transactions table (core ledger for transfers/credits/debits)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                fromUserId INT NULL,
                toUserId INT NULL,
                amount DECIMAL(15,2) NOT NULL,
                type VARCHAR(50) NOT NULL,
                description VARCHAR(500),
                status VARCHAR(50) DEFAULT 'completed',
                reference VARCHAR(50),
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_tx_from (fromUserId),
                INDEX idx_tx_to (toUserId),
                INDEX idx_tx_created (createdAt)
            )
        `);

        // Best-effort schema alignment for existing databases.
        // (TiDB/MySQL may not support IF NOT EXISTS on all ALTERs; failures are safe to ignore.)
        try { await connection.execute(`ALTER TABLE transactions ADD COLUMN fromUserId INT NULL`); } catch (e) {}
        try { await connection.execute(`ALTER TABLE transactions ADD COLUMN toUserId INT NULL`); } catch (e) {}
        try { await connection.execute(`ALTER TABLE transactions ADD COLUMN reference VARCHAR(50) NULL`); } catch (e) {}
        try { await connection.execute(`ALTER TABLE transactions ADD COLUMN description VARCHAR(500) NULL`); } catch (e) {}
        try { await connection.execute(`ALTER TABLE transactions ADD COLUMN status VARCHAR(50) DEFAULT 'completed'`); } catch (e) {}
        try { await connection.execute(`ALTER TABLE transactions ADD COLUMN createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP`); } catch (e) {}

        // Best-effort data backfill for legacy schemas.
        // If an older `created_at` column exists, copy it into `createdAt` so date filters work.
        try { await connection.execute(`UPDATE transactions SET createdAt = created_at WHERE createdAt IS NULL`); } catch (e) {}

        // Beneficiaries table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS beneficiaries (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                name VARCHAR(255) NOT NULL,
                accountNumber VARCHAR(50) NOT NULL,
                bankName VARCHAR(255) DEFAULT 'Heritage Bank',
                email VARCHAR(255),
                nickname VARCHAR(100),
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_beneficiary (userId)
            )
        `);

        // Transaction limits table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS transaction_limits (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                dailyLimit DECIMAL(15,2) DEFAULT 10000.00,
                weeklyLimit DECIMAL(15,2) DEFAULT 50000.00,
                monthlyLimit DECIMAL(15,2) DEFAULT 200000.00,
                singleTransactionLimit DECIMAL(15,2) DEFAULT 5000.00,
                dailySpent DECIMAL(15,2) DEFAULT 0.00,
                weeklySpent DECIMAL(15,2) DEFAULT 0.00,
                monthlySpent DECIMAL(15,2) DEFAULT 0.00,
                lastResetDate DATE,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE KEY unique_user_limit (userId)
            )
        `);

        // Scheduled payments table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS scheduled_payments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                type ENUM('transfer', 'bill') NOT NULL,
                amount DECIMAL(15,2) NOT NULL,
                frequency ENUM('once', 'daily', 'weekly', 'monthly') NOT NULL,
                nextRunDate DATE NOT NULL,
                endDate DATE,
                toAccountNumber VARCHAR(50),
                toEmail VARCHAR(255),
                billerId INT,
                description VARCHAR(500),
                status ENUM('active', 'paused', 'completed', 'cancelled') DEFAULT 'active',
                lastRunDate DATE,
                runCount INT DEFAULT 0,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_scheduled (userId),
                INDEX idx_next_run (nextRunDate, status)
            )
        `);

        // Documents table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS documents (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                documentType ENUM('id_card', 'passport', 'drivers_license', 'utility_bill', 'bank_statement', 'other') NOT NULL,
                fileName VARCHAR(255) NOT NULL,
                filePath VARCHAR(500) NOT NULL,
                fileSize INT,
                mimeType VARCHAR(100),
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                reviewedBy INT,
                reviewedAt TIMESTAMP NULL,
                rejectionReason TEXT,
                uploadedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_documents (userId),
                INDEX idx_status (status)
            )
        `);

        // Login history table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS login_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                ipAddress VARCHAR(45),
                userAgent TEXT,
                device VARCHAR(255),
                location VARCHAR(255),
                city VARCHAR(100),
                country VARCHAR(100),
                loginStatus ENUM('success', 'failed') NOT NULL,
                failureReason VARCHAR(255),
                isSuspicious BOOLEAN DEFAULT false,
                loginAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_login (userId),
                INDEX idx_login_time (loginAt),
                INDEX idx_suspicious (isSuspicious)
            )
        `);

        // Roles table for RBAC
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS roles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(32) UNIQUE NOT NULL,
                description TEXT,
                permissions JSON,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // User roles mapping
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_roles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                roleId INT NOT NULL,
                assignedBy INT,
                assignedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (roleId) REFERENCES roles(id) ON DELETE CASCADE,
                UNIQUE KEY unique_user_role (userId, roleId)
            )
        `);

        // Bank Accounts table (multiple accounts per user)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS bank_accounts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                accountNumber VARCHAR(12) UNIQUE NOT NULL,
                accountType ENUM('checking', 'savings', 'money_market', 'cd') NOT NULL DEFAULT 'checking',
                accountName VARCHAR(100),
                ledgerBalance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
                availableBalance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
                status ENUM('pending', 'active', 'frozen', 'closed') DEFAULT 'active',
                overdraftEnabled BOOLEAN DEFAULT FALSE,
                overdraftLimit DECIMAL(15,2) DEFAULT 0.00,
                interestRate DECIMAL(8,6) DEFAULT 0.0000,
                minimumBalance DECIMAL(15,2) DEFAULT 0.00,
                isPrimary BOOLEAN DEFAULT FALSE,
                openedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                closedAt TIMESTAMP NULL,
                lastActivityAt TIMESTAMP NULL,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_accounts (userId),
                INDEX idx_account_status (status)
            )
        `);

        // Virtual Cards table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS cards (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                accountId INT NOT NULL,
                cardNumber CHAR(16) NOT NULL,
                cardNumberMasked VARCHAR(19),
                expirationDate CHAR(5) NOT NULL,
                cvv VARCHAR(255) NOT NULL,
                cardType ENUM('debit', 'credit', 'virtual') DEFAULT 'debit',
                cardNetwork ENUM('visa', 'mastercard') DEFAULT 'visa',
                cardholderName VARCHAR(100),
                status ENUM('active', 'frozen', 'blocked', 'expired', 'pending') DEFAULT 'pending',
                pin VARCHAR(255),
                dailyLimit DECIMAL(15,2) DEFAULT 5000.00,
                monthlyLimit DECIMAL(15,2) DEFAULT 25000.00,
                onlineEnabled BOOLEAN DEFAULT TRUE,
                internationalEnabled BOOLEAN DEFAULT FALSE,
                contactlessEnabled BOOLEAN DEFAULT TRUE,
                dailySpent DECIMAL(15,2) DEFAULT 0.00,
                monthlySpent DECIMAL(15,2) DEFAULT 0.00,
                lastUsedAt TIMESTAMP NULL,
                frozenAt TIMESTAMP NULL,
                blockedAt TIMESTAMP NULL,
                blockReason VARCHAR(500),
                issuedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                activatedAt TIMESTAMP NULL,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (accountId) REFERENCES bank_accounts(id) ON DELETE CASCADE,
                INDEX idx_user_cards (userId),
                INDEX idx_card_status (status)
            )
        `);

        // Notifications table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                type ENUM('login', 'transfer', 'deposit', 'withdrawal', 'low_balance', 'card', 'security', 'account', 'system', 'marketing') NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                data JSON,
                isRead BOOLEAN DEFAULT FALSE,
                readAt TIMESTAMP NULL,
                priority ENUM('low', 'normal', 'high', 'urgent') DEFAULT 'normal',
                expiresAt TIMESTAMP NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_notifications (userId),
                INDEX idx_unread (userId, isRead),
                INDEX idx_type (type)
            )
        `);

        // Activity logs table (powers "Recent Activity" feeds)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                action_type VARCHAR(100) NOT NULL,
                action_details TEXT,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_activity (user_id),
                INDEX idx_activity_created (created_at),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )
        `);

        // Support Tickets table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticketNumber VARCHAR(20) UNIQUE NOT NULL,
                userId INT NOT NULL,
                category ENUM('account', 'card', 'transfer', 'technical', 'fraud', 'dispute', 'general', 'feedback') NOT NULL,
                subject VARCHAR(255) NOT NULL,
                description TEXT NOT NULL,
                priority ENUM('low', 'normal', 'high', 'urgent') DEFAULT 'normal',
                status ENUM('open', 'in_progress', 'waiting_customer', 'resolved', 'closed') DEFAULT 'open',
                assignedTo INT,
                resolvedBy INT,
                resolution TEXT,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                resolvedAt TIMESTAMP NULL,
                closedAt TIMESTAMP NULL,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (assignedTo) REFERENCES users(id) ON DELETE SET NULL,
                FOREIGN KEY (resolvedBy) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_user_tickets (userId),
                INDEX idx_status (status),
                INDEX idx_ticket_number (ticketNumber)
            )
        `);

        // Ticket Replies table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ticket_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticketId INT NOT NULL,
                userId INT NOT NULL,
                message TEXT NOT NULL,
                isStaff BOOLEAN DEFAULT FALSE,
                attachments JSON,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticketId) REFERENCES support_tickets(id) ON DELETE CASCADE,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_ticket_replies (ticketId)
            )
        `);

        // FAQs table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS faqs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                category VARCHAR(64) NOT NULL,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                sortOrder INT DEFAULT 0,
                isPublished BOOLEAN DEFAULT TRUE,
                viewCount INT DEFAULT 0,
                helpfulCount INT DEFAULT 0,
                createdBy INT,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_category (category),
                INDEX idx_published (isPublished)
            )
        `);

        // Pending Signups table (for approval workflow)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS pending_signups (
                id INT AUTO_INCREMENT PRIMARY KEY,
                firstName VARCHAR(100) NOT NULL,
                lastName VARCHAR(100) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                phone VARCHAR(20),
                dateOfBirth DATE,
                address VARCHAR(255),
                city VARCHAR(100),
                state VARCHAR(50),
                zipCode VARCHAR(10),
                country VARCHAR(100) DEFAULT 'United States',
                accountType ENUM('checking', 'savings', 'business', 'premium') DEFAULT 'checking',
                initialDeposit DECIMAL(15,2) DEFAULT 0.00,
                govIdType VARCHAR(50),
                govIdNumber VARCHAR(50),
                termsAccepted BOOLEAN DEFAULT FALSE,
                privacyAccepted BOOLEAN DEFAULT FALSE,
                marketingConsent BOOLEAN DEFAULT FALSE,
                status ENUM('pending', 'under_review', 'approved', 'rejected') DEFAULT 'pending',
                reviewedBy INT,
                reviewedAt TIMESTAMP NULL,
                rejectionReason TEXT,
                ipAddress VARCHAR(45),
                userAgent TEXT,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (reviewedBy) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_status (status),
                INDEX idx_email (email)
            )
        `);

        // Compatibility: keep optional `ssn` on pending_signups for older environments.
        try { await connection.execute('ALTER TABLE pending_signups ADD COLUMN ssn VARCHAR(32) NULL'); } catch (e) {}

        // Bank Settings/Branding table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS bank_settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                settingKey VARCHAR(64) UNIQUE NOT NULL,
                settingValue TEXT,
                settingType ENUM('string', 'number', 'boolean', 'json', 'image') DEFAULT 'string',
                description TEXT,
                isPublic BOOLEAN DEFAULT FALSE,
                updatedBy INT,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (updatedBy) REFERENCES users(id) ON DELETE SET NULL
            )
        `);

        // Insert default roles
        await connection.execute(`
            INSERT IGNORE INTO roles (name, description, permissions) VALUES
            ('super_admin', 'Full system access with all permissions', '["all"]'),
            ('admin', 'Administrative access for user and account management', '["users.read","users.write","accounts.read","accounts.write","transactions.read","reports.read"]'),
            ('support', 'Customer support agent', '["users.read","tickets.read","tickets.write"]'),
            ('customer', 'Standard customer access', '["own.read","own.write"]')
        `);

        // Insert default FAQs
        await connection.execute(`
            INSERT IGNORE INTO faqs (category, question, answer, sortOrder) VALUES
            ('Account', 'How do I open a new account?', 'Click on "Open an Account" on our homepage and follow the simple 4-step registration process. You will need to provide your personal information, verify your identity, and make an initial deposit of at least $50.', 1),
            ('Account', 'What is the minimum balance requirement?', 'Checking accounts require no minimum balance. Savings accounts require a $100 minimum to earn interest. Premium accounts have a $1,500 minimum to waive monthly fees.', 2),
            ('Cards', 'How do I freeze my debit card?', 'You can instantly freeze your card from the Cards section in your dashboard. Click on your card and select "Freeze Card". You can unfreeze it anytime.', 3),
            ('Cards', 'What should I do if my card is lost or stolen?', 'Immediately freeze your card in the app, then contact our support team. We will block your card and issue a replacement within 5-7 business days.', 4),
            ('Transfers', 'What are the transfer limits?', 'Daily limit: $10,000. Weekly limit: $50,000. Monthly limit: $200,000. You can request limit increases through Settings.', 5),
            ('Transfers', 'How long do transfers take?', 'Internal transfers are instant. External ACH transfers take 1-3 business days. Wire transfers are same-day if initiated before 4 PM ET.', 6),
            ('Security', 'How do I enable two-factor authentication?', 'Go to Settings > Security > Two-Factor Authentication. You can choose SMS, email, or authenticator app as your 2FA method.', 7),
            ('Security', 'What should I do if I suspect unauthorized access?', 'Immediately change your password, freeze your accounts, and contact our fraud department at 1-800-HERITAGE. We will investigate and secure your account.', 8)
        `);

        // Insert default bank settings
        await connection.execute(`
            INSERT IGNORE INTO bank_settings (settingKey, settingValue, settingType, description, isPublic) VALUES
            ('bank_name', 'Heritage Bank', 'string', 'Bank display name', TRUE),
            ('bank_logo', '/assets/logo.png', 'image', 'Bank logo URL', TRUE),
            ('homepage_image', '/assets/family.jpg', 'image', 'Homepage hero image', TRUE),
            ('support_email', 'support@heritagebank.com', 'string', 'Support email address', TRUE),
            ('support_phone', '1-800-HERITAGE', 'string', 'Support phone number', TRUE),
            ('routing_number', '091238946', 'string', 'Bank routing number', TRUE),
            ('savings_apy', '4.25', 'number', 'Current savings APY percentage', TRUE),
            ('checking_apy', '0.01', 'number', 'Current checking APY percentage', TRUE)
        `);

        // Scheduled jobs table (required by the scheduled jobs runner)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS scheduled_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                jobType VARCHAR(100) NOT NULL,
                frequency ENUM('hourly','daily','weekly','monthly','quarterly','annually') DEFAULT 'daily',
                isActive BOOLEAN DEFAULT true,
                status ENUM('idle','running','failed') DEFAULT 'idle',
                nextRunAt DATETIME NOT NULL,
                lastRunAt DATETIME NULL,
                lastResult JSON NULL,
                recordsProcessed INT DEFAULT 0,
                errorMessage TEXT NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_scheduled_jobs_due (isActive, status, nextRunAt),
                INDEX idx_scheduled_jobs_type (jobType)
            )
        `);

        // Check if admin exists
        const [adminCheck] = await connection.execute(
            'SELECT * FROM users WHERE email = ?',
            [process.env.ADMIN_EMAIL || 'admin@heritagebank.com']
        );

        if (adminCheck.length === 0 && process.env.ADMIN_PASSWORD) {
            const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
            await connection.execute(
                `INSERT INTO users (firstName, lastName, email, password, phone, accountNumber, routingNumber, balance, accountStatus, isAdmin) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
                ['Admin', 'User', process.env.ADMIN_EMAIL || 'admin@heritagebank.com', hashedPassword, '1-800-BANK', generateAccountNumber(), ROUTING_NUMBER, 100000000, true]
            );
            console.log('✅ Admin account created');
        }

        connection.release();
        DB_READY = true;
        console.log('✅ Database initialized with all tables');
    } catch (error) {
        console.error('❌ Database error:', error.message);
    }
}

initializeDatabase();

// ==================== CARD GENERATION UTILITIES ====================

// Generate 16-digit card number (Luhn-valid)
function generateCardNumber() {
    // Start with 4 for Visa-like cards
    let cardNumber = '4';
    
    // Generate 14 random digits
    for (let i = 0; i < 14; i++) {
        cardNumber += Math.floor(Math.random() * 10);
    }
    
    // Calculate Luhn check digit
    let sum = 0;
    let isEven = true;
    for (let i = cardNumber.length - 1; i >= 0; i--) {
        let digit = parseInt(cardNumber[i]);
        if (isEven) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        isEven = !isEven;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    
    return cardNumber + checkDigit;
}

// Generate card expiry date (3 years from now)
function generateExpiryDate() {
    const now = new Date();
    const expiry = new Date(now.getFullYear() + 3, now.getMonth(), 1);
    const month = String(expiry.getMonth() + 1).padStart(2, '0');
    const year = String(expiry.getFullYear()).slice(-2);
    return `${month}/${year}`;
}

// Generate 3-digit CVV
function generateCVV() {
    return String(Math.floor(Math.random() * 900) + 100);
}

// Generate unique 12-digit account number
function generateBankAccountNumber() {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(Math.random() * 900000) + 100000;
    return timestamp + random.toString();
}

// Generate ticket number
function generateTicketNumber() {
    const prefix = 'TKT';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 4).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
}

// Create notification helper
async function createNotification(userId, type, title, message, data = null, priority = 'normal') {
    try {
        await pool.execute(
            `INSERT INTO notifications (userId, type, title, message, data, priority)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, type, title, message, data ? JSON.stringify(data) : null, priority]
        );
    } catch (error) {
        console.error('Failed to create notification:', error.message);
    }
}

// ==================== BANKING UTILITY FUNCTIONS ====================

// Generate unique reference ID for transactions
function generateReferenceId(prefix = 'TXN') {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
}

// Calculate available balance (ledger - holds)
async function getAvailableBalance(userId) {
    const [users] = await pool.execute('SELECT balance FROM users WHERE id = ?', [userId]);
    if (users.length === 0) return 0;
    
    const ledgerBalance = parseFloat(users[0].balance);
    
    // Get active holds
    const [holds] = await pool.execute(
        `SELECT COALESCE(SUM(amount), 0) as totalHolds FROM transaction_holds 
         WHERE accountId = ? AND status = 'active'`,
        [userId]
    );
    
    const totalHolds = parseFloat(holds[0]?.totalHolds || 0);
    return ledgerBalance - totalHolds;
}

// Check transaction limits
async function checkTransactionLimits(userId, amount, type = 'transfer') {
    const [limits] = await pool.execute(
        'SELECT * FROM transaction_limits WHERE userId = ?',
        [userId]
    );
    
    if (limits.length === 0) {
        // Create default limits
        await pool.execute(
            `INSERT INTO transaction_limits (userId) VALUES (?)`,
            [userId]
        );
        return { allowed: true };
    }
    
    const limit = limits[0];
    const amt = parseFloat(amount);
    
    // Check single transaction limit
    if (amt > parseFloat(limit.singleTransactionLimit)) {
        return { allowed: false, reason: `Exceeds single transaction limit of $${limit.singleTransactionLimit}` };
    }
    
    // Check daily limit
    if (parseFloat(limit.dailySpent) + amt > parseFloat(limit.dailyLimit)) {
        return { allowed: false, reason: `Exceeds daily limit of $${limit.dailyLimit}` };
    }
    
    // Check weekly limit
    if (parseFloat(limit.weeklySpent) + amt > parseFloat(limit.weeklyLimit)) {
        return { allowed: false, reason: `Exceeds weekly limit of $${limit.weeklyLimit}` };
    }
    
    // Check monthly limit
    if (parseFloat(limit.monthlySpent) + amt > parseFloat(limit.monthlyLimit)) {
        return { allowed: false, reason: `Exceeds monthly limit of $${limit.monthlyLimit}` };
    }
    
    return { allowed: true };
}

// Update spent limits after transaction
async function updateSpentLimits(userId, amount) {
    await pool.execute(
        `UPDATE transaction_limits 
         SET dailySpent = dailySpent + ?, weeklySpent = weeklySpent + ?, monthlySpent = monthlySpent + ?
         WHERE userId = ?`,
        [amount, amount, amount, userId]
    );
}

// Calculate daily interest for savings accounts
function calculateDailyInterest(balance, apy = 0.0425) {
    return (parseFloat(balance) * apy) / 365;
}

// Check for suspicious activity patterns
async function checkSuspiciousActivity(userId, amount, type) {
    const flags = [];
    
    // Check for large transaction (potential CTR)
    if (parseFloat(amount) >= 10000) {
        flags.push({ type: 'ctr_threshold', description: 'Transaction meets CTR reporting threshold ($10,000+)' });
    }
    
    // Check for rapid transactions (potential structuring)
    const [recentTxns] = await pool.execute(
        `SELECT COUNT(*) as count, SUM(amount) as total FROM transactions 
         WHERE userId = ? AND createdAt > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [userId]
    );
    
    if (recentTxns[0].count > 10) {
        flags.push({ type: 'velocity', description: 'High transaction velocity detected' });
    }
    
    // Check if multiple transactions just under $10k (structuring)
    const [underThreshold] = await pool.execute(
        `SELECT COUNT(*) as count FROM transactions 
         WHERE userId = ? AND amount BETWEEN 9000 AND 9999 
         AND createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        [userId]
    );
    
    if (underThreshold[0].count >= 2) {
        flags.push({ type: 'structuring', description: 'Potential structuring detected - multiple transactions just under $10,000' });
    }
    
    return flags;
}

// ==================== SCHEDULED JOBS ENGINE ====================

// Run scheduled jobs (call this via cron or setInterval)
async function runScheduledJobs() {
    console.log('🔄 Running scheduled jobs...');

    // During startup, database initialization can take time. Avoid querying tables
    // before schema creation finishes.
    if (!DB_READY) {
        return;
    }
    
    try {
        // Get due jobs
        const [jobs] = await pool.execute(
            `SELECT * FROM scheduled_jobs WHERE isActive = true AND nextRunAt <= NOW() AND status = 'idle'`
        );
        
        for (const job of jobs) {
            console.log(`⚙️ Running job: ${job.jobType}`);
            
            // Mark as running
            await pool.execute(
                `UPDATE scheduled_jobs SET status = 'running' WHERE id = ?`,
                [job.id]
            );
            
            try {
                let result = {};
                let recordsProcessed = 0;
                
                switch (job.jobType) {
                    case 'interest_calculation':
                        result = await runInterestCalculation();
                        recordsProcessed = result.accountsProcessed || 0;
                        break;
                        
                    case 'fee_assessment':
                        result = await runFeeAssessment();
                        recordsProcessed = result.feesAssessed || 0;
                        break;
                        
                    case 'balance_snapshot':
                        result = await runBalanceSnapshot();
                        recordsProcessed = result.snapshotsCreated || 0;
                        break;
                        
                    case 'dormant_account_check':
                        result = await runDormantAccountCheck();
                        recordsProcessed = result.accountsFlagged || 0;
                        break;
                        
                    case 'deletion_processing':
                        result = await runDeletionProcessing();
                        recordsProcessed = result.accountsProcessed || 0;
                        break;
                        
                    case 'daily_report':
                        result = await runDailyReport();
                        break;
                        
                    default:
                        result = { message: 'Unknown job type' };
                }
                
                // Calculate next run time
                let nextRun = new Date();
                switch (job.frequency) {
                    case 'hourly': nextRun.setHours(nextRun.getHours() + 1); break;
                    case 'daily': nextRun.setDate(nextRun.getDate() + 1); break;
                    case 'weekly': nextRun.setDate(nextRun.getDate() + 7); break;
                    case 'monthly': nextRun.setMonth(nextRun.getMonth() + 1); break;
                    case 'quarterly': nextRun.setMonth(nextRun.getMonth() + 3); break;
                    case 'annually': nextRun.setFullYear(nextRun.getFullYear() + 1); break;
                }
                
                // Mark as completed
                await pool.execute(
                    `UPDATE scheduled_jobs 
                     SET status = 'idle', lastRunAt = NOW(), nextRunAt = ?, lastResult = ?, recordsProcessed = ?
                     WHERE id = ?`,
                    [nextRun.toISOString().slice(0, 19).replace('T', ' '), JSON.stringify(result), recordsProcessed, job.id]
                );
                
                console.log(`✅ Job ${job.jobType} completed: ${recordsProcessed} records processed`);
                
            } catch (jobError) {
                // Mark as failed
                await pool.execute(
                    `UPDATE scheduled_jobs SET status = 'failed', errorMessage = ? WHERE id = ?`,
                    [jobError.message, job.id]
                );
                console.error(`❌ Job ${job.jobType} failed:`, jobError.message);
            }
        }
    } catch (error) {
        console.error('❌ Scheduled jobs error:', error.message);
    }
}

// Interest Calculation Job
async function runInterestCalculation() {
    const APY = 0.0425; // 4.25% APY for savings
    let accountsProcessed = 0;
    let totalInterest = 0;
    
    // Get all active savings accounts
    const [accounts] = await pool.execute(
        `SELECT id, balance, accountNumber FROM users WHERE accountType = 'savings' AND accountStatus = 'active'`
    );
    
    for (const account of accounts) {
        const balance = parseFloat(account.balance);
        if (balance <= 0) continue;
        
        const dailyInterest = calculateDailyInterest(balance, APY);
        
        // Record interest accrual
        await pool.execute(
            `INSERT INTO interest_accruals (accountId, periodStart, periodEnd, openingBalance, averageDailyBalance, interestRate, interestEarned, status)
             VALUES (?, CURDATE(), CURDATE(), ?, ?, ?, ?, 'accrued')`,
            [account.id, balance, balance, APY, dailyInterest]
        );
        
        totalInterest += dailyInterest;
        accountsProcessed++;
    }
    
    return { accountsProcessed, totalInterest: totalInterest.toFixed(4) };
}

// Post monthly interest (run on 1st of month)
async function postMonthlyInterest() {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const monthStart = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
    const monthEnd = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0);
    
    // Get accrued interest for each account
    const [accruals] = await pool.execute(
        `SELECT accountId, SUM(interestEarned) as totalInterest 
         FROM interest_accruals 
         WHERE status = 'accrued' AND periodStart >= ? AND periodEnd <= ?
         GROUP BY accountId`,
        [monthStart.toISOString().split('T')[0], monthEnd.toISOString().split('T')[0]]
    );
    
    for (const accrual of accruals) {
        const interest = parseFloat(accrual.totalInterest);
        if (interest < 0.01) continue; // Skip if less than 1 cent
        
        // Credit interest to account
        await pool.execute(
            `UPDATE users SET balance = balance + ? WHERE id = ?`,
            [interest, accrual.accountId]
        );
        
        // Create transaction record
        const refId = generateReferenceId('INT');
        await pool.execute(
            `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
             VALUES (NULL, ?, 'interest', ?, 'Monthly interest credit', 'completed', ?)`,
            [accrual.accountId, interest, refId]
        );
        
        // Mark accruals as posted
        await pool.execute(
            `UPDATE interest_accruals SET status = 'posted', postedAt = NOW() 
             WHERE accountId = ? AND status = 'accrued' AND periodStart >= ? AND periodEnd <= ?`,
            [accrual.accountId, monthStart.toISOString().split('T')[0], monthEnd.toISOString().split('T')[0]]
        );
    }
    
    return { accountsProcessed: accruals.length };
}

// Fee Assessment Job
async function runFeeAssessment() {
    let feesAssessed = 0;
    
    // Get fee schedule
    const [fees] = await pool.execute(
        `SELECT * FROM fee_schedule WHERE isActive = true AND feeType = 'monthly_maintenance'`
    );
    
    // Get all active checking accounts
    const [accounts] = await pool.execute(
        `SELECT id, balance, accountType, accountNumber FROM users 
         WHERE accountStatus = 'active' AND accountType IN ('checking', 'savings')`
    );
    
    for (const account of accounts) {
        // Find applicable fee
        const applicableFee = fees.find(f => 
            f.accountType === account.accountType || f.accountType === 'all'
        );
        
        if (!applicableFee || parseFloat(applicableFee.amount) === 0) continue;
        
        const feeAmount = parseFloat(applicableFee.amount);
        const balance = parseFloat(account.balance);
        
        // Check waiver conditions (e.g., minimum balance)
        if (account.accountType === 'checking' && balance >= 1500) continue; // Waive if balance >= $1500
        if (account.accountType === 'premium') continue; // Premium accounts have no fee
        
        // Record the fee
        await pool.execute(
            `INSERT INTO account_fees (accountId, feeType, amount, description, status)
             VALUES (?, 'monthly_maintenance', ?, 'Monthly account maintenance fee', 'pending')`,
            [account.id, feeAmount]
        );
        
        feesAssessed++;
    }
    
    return { feesAssessed };
}

// Charge pending fees (run after fee assessment)
async function chargePendingFees() {
    const [pendingFees] = await pool.execute(
        `SELECT af.*, u.balance, u.accountNumber FROM account_fees af
         JOIN users u ON af.accountId = u.id
         WHERE af.status = 'pending'`
    );
    
    let charged = 0;
    let waived = 0;
    
    for (const fee of pendingFees) {
        const feeAmount = parseFloat(fee.amount);
        const balance = parseFloat(fee.balance);
        
        // Check if sufficient balance
        if (balance >= feeAmount) {
            // Deduct fee
            await pool.execute(
                `UPDATE users SET balance = balance - ? WHERE id = ?`,
                [feeAmount, fee.accountId]
            );
            
            // Create transaction
            const refId = generateReferenceId('FEE');
            await pool.execute(
                `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
                 VALUES (?, NULL, 'fee', ?, ?, 'completed', ?)`,
                [fee.accountId, feeAmount, fee.description, refId]
            );
            
            // Update fee status
            await pool.execute(
                `UPDATE account_fees SET status = 'charged', chargedAt = NOW() WHERE id = ?`,
                [fee.id]
            );
            
            charged++;
        } else {
            // Waive fee if insufficient funds (or charge NSF)
            await pool.execute(
                `UPDATE account_fees SET status = 'waived', waiveReason = 'Insufficient funds' WHERE id = ?`,
                [fee.id]
            );
            waived++;
        }
    }
    
    return { charged, waived };
}

// Balance Snapshot Job
async function runBalanceSnapshot() {
    const [accounts] = await pool.execute(
        `SELECT id, balance FROM users WHERE accountStatus = 'active'`
    );
    
    let snapshotsCreated = 0;
    const today = new Date().toISOString().split('T')[0];
    
    for (const account of accounts) {
        // Get holds for this account
        const [holds] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as totalHolds FROM transaction_holds 
             WHERE accountId = ? AND status = 'active'`,
            [account.id]
        );
        
        const ledgerBalance = parseFloat(account.balance);
        const holdAmount = parseFloat(holds[0]?.totalHolds || 0);
        const availableBalance = ledgerBalance - holdAmount;
        
        // Insert or update snapshot
        await pool.execute(
            `INSERT INTO balance_snapshots (accountId, snapshotDate, ledgerBalance, availableBalance, holdAmount)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE ledgerBalance = ?, availableBalance = ?, holdAmount = ?`,
            [account.id, today, ledgerBalance, availableBalance, holdAmount, ledgerBalance, availableBalance, holdAmount]
        );
        
        snapshotsCreated++;
    }
    
    return { snapshotsCreated };
}

// Dormant Account Check Job
async function runDormantAccountCheck() {
    const DORMANT_DAYS = 365;
    
    // Find accounts with no transactions in X days
    const [dormantAccounts] = await pool.execute(
        `SELECT u.id, u.email, u.accountNumber, MAX(t.createdAt) as lastActivity
         FROM users u
         LEFT JOIN transactions t ON (u.id = t.fromUserId OR u.id = t.toUserId)
         WHERE u.accountStatus = 'active'
         GROUP BY u.id
         HAVING lastActivity < DATE_SUB(NOW(), INTERVAL ? DAY) OR lastActivity IS NULL`,
        [DORMANT_DAYS]
    );
    
    let accountsFlagged = 0;
    
    for (const account of dormantAccounts) {
        // Check if already flagged
        const [existingFlag] = await pool.execute(
            `SELECT id FROM compliance_flags WHERE userId = ? AND flagType = 'dormant_account' AND status = 'active'`,
            [account.id]
        );
        
        if (existingFlag.length === 0) {
            await pool.execute(
                `INSERT INTO compliance_flags (userId, flagType, severity, description, triggeredBy)
                 VALUES (?, 'under_review', 'low', 'Account dormant - no activity in 365+ days', 'system')`,
                [account.id]
            );
            accountsFlagged++;
        }
    }
    
    return { accountsFlagged, totalDormant: dormantAccounts.length };
}

// Deletion Processing Job
async function runDeletionProcessing() {
    // Get deletion requests past grace period
    const [requests] = await pool.execute(
        `SELECT * FROM account_deletion_requests 
         WHERE status = 'pending' AND scheduledDeletionDate <= CURDATE()`
    );
    
    let accountsProcessed = 0;
    
    for (const request of requests) {
        // Soft delete - mark as closed, anonymize PII
        await pool.execute(
            `UPDATE users SET 
                accountStatus = 'closed',
                firstName = 'DELETED',
                lastName = 'USER',
                email = CONCAT('deleted_', id, '@deleted.local'),
                phone = NULL,
                address = NULL,
                city = NULL,
                state = NULL,
                zipCode = NULL
             WHERE id = ?`,
            [request.userId]
        );
        
        // Update deletion request
        await pool.execute(
            `UPDATE account_deletion_requests SET status = 'completed', processedAt = NOW() WHERE id = ?`,
            [request.id]
        );
        
        accountsProcessed++;
    }
    
    return { accountsProcessed };
}

// Daily Report Job
async function runDailyReport() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];
    
    // Gather daily stats
    const [txnStats] = await pool.execute(
        `SELECT type, COUNT(*) as count, SUM(amount) as total FROM transactions 
         WHERE DATE(createdAt) = ? GROUP BY type`,
        [dateStr]
    );
    
    const [newUsers] = await pool.execute(
        `SELECT COUNT(*) as count FROM users WHERE DATE(createdAt) = ?`,
        [dateStr]
    );
    
    const [loginStats] = await pool.execute(
        `SELECT loginStatus, COUNT(*) as count FROM login_history 
         WHERE DATE(loginAt) = ? GROUP BY loginStatus`,
        [dateStr]
    );
    
    const summary = {
        date: dateStr,
        transactions: txnStats,
        newUsers: newUsers[0].count,
        logins: loginStats
    };
    
    // Save report
    await pool.execute(
        `INSERT INTO regulatory_reports (reportType, periodStart, periodEnd, status, summary, recordCount)
         VALUES ('daily_summary', ?, ?, 'generated', ?, ?)`,
        [dateStr, dateStr, JSON.stringify(summary), txnStats.reduce((sum, t) => sum + t.count, 0)]
    );
    
    return summary;
}

// Start scheduled job runner (every 5 minutes)
setInterval(() => {
    runScheduledJobs().catch((err) => {
        console.error('❌ Scheduled jobs runner error:', err?.message || err);
    });
}, 5 * 60 * 1000);

// Run once on startup after a short delay
setTimeout(() => {
    runScheduledJobs().catch((err) => {
        console.error('❌ Scheduled jobs runner error:', err?.message || err);
    });
}, 10000);

// ==================== SIGNUP APPROVAL WORKFLOW ====================

// Submit signup application (public endpoint)
app.post('/api/auth/apply', async (req, res) => {
    try {
        const { 
            firstName, lastName, email, password, phone,
            dateOfBirth, address, city, state, zipCode, country,
            accountType, initialDeposit, govIdType, govIdNumber,
            termsAccepted, privacyAccepted, marketingConsent
        } = req.body;
        
        // Validate required fields
        if (!firstName || !lastName || !email || !password || !phone) {
            return res.status(400).json({ success: false, message: 'Required fields missing' });
        }
        
        if (!termsAccepted || !privacyAccepted) {
            return res.status(400).json({ success: false, message: 'You must accept Terms and Privacy Policy' });
        }
        
        // Check age (18+)
        if (dateOfBirth) {
            const age = Math.floor((new Date() - new Date(dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000));
            if (age < 18) {
                return res.status(400).json({ success: false, message: 'You must be at least 18 years old' });
            }
        }
        
        // Check minimum deposit
        const deposit = parseFloat(initialDeposit) || 0;
        if (deposit < 50) {
            return res.status(400).json({ success: false, message: 'Minimum initial deposit is $50.00' });
        }
        
        // Check if email already exists
        const [existingUsers] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ success: false, message: 'Email already registered' });
        }
        
        const [existingApps] = await pool.execute('SELECT id FROM pending_signups WHERE email = ? AND status = "pending"', [email]);
        if (existingApps.length > 0) {
            return res.status(400).json({ success: false, message: 'Application already pending for this email' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await pool.execute(
            `INSERT INTO pending_signups (
                firstName, lastName, email, password, phone, dateOfBirth,
                address, city, state, zipCode, country, accountType, initialDeposit,
                govIdType, govIdNumber, termsAccepted, privacyAccepted, marketingConsent,
                ipAddress, userAgent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                firstName, lastName, email, hashedPassword, phone, dateOfBirth || null,
                address || null, city || null, state || null, zipCode || null, country || 'United States',
                accountType || 'checking', deposit, govIdType || null, govIdNumber || null,
                termsAccepted, privacyAccepted, marketingConsent || false,
                req.ip, req.get('user-agent')
            ]
        );
        
        res.status(201).json({
            success: true,
            message: 'Application submitted successfully. You will receive an email once your account is approved.',
            status: 'pending'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get pending signups (Admin only)
app.get('/api/admin/signups/pending', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { status = 'pending' } = req.query;
        
        let query = 'SELECT * FROM pending_signups';
        const params = [];
        
        if (status !== 'all') {
            query += ' WHERE status = ?';
            params.push(status);
        }
        query += ' ORDER BY createdAt DESC';
        
        const [signups] = await pool.execute(query, params);
        
        // Mask sensitive data
        const maskedSignups = signups.map(s => ({
            ...s,
            password: undefined
        }));
        
        res.json({ success: true, signups: maskedSignups });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Approve signup (Admin only)
app.post('/api/admin/signups/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { id } = req.params;
        
        // Get pending signup
        const [signups] = await pool.execute('SELECT * FROM pending_signups WHERE id = ? AND status = "pending"', [id]);
        if (signups.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending signup not found' });
        }
        
        const signup = signups[0];
        const accountNumber = generateAccountNumber();
        
        // Create user account
        const [result] = await pool.execute(
            `INSERT INTO users (
                firstName, lastName, email, password, phone, dateOfBirth,
                address, city, state, zipCode, country, accountNumber, routingNumber,
                balance, accountType, accountStatus, marketingConsent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
            [
                signup.firstName, signup.lastName, signup.email, signup.password, signup.phone,
                signup.dateOfBirth, signup.address, signup.city, signup.state,
                signup.zipCode, signup.country, accountNumber, ROUTING_NUMBER,
                signup.initialDeposit, signup.accountType, signup.marketingConsent
            ]
        );
        
        const userId = result.insertId;
        
        // Create initial deposit transaction
        if (signup.initialDeposit > 0) {
            await pool.execute(
                `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
                 VALUES (NULL, ?, 'deposit', ?, 'Initial account deposit', 'completed', ?)`,
                [userId, signup.initialDeposit, generateReferenceId('DEP')]
            );
        }
        
        // Create bank account record
        const bankAccountNumber = generateBankAccountNumber();
        await pool.execute(
            `INSERT INTO bank_accounts (userId, accountNumber, accountType, accountName, ledgerBalance, availableBalance, status, isPrimary)
             VALUES (?, ?, ?, ?, ?, ?, 'active', TRUE)`,
            [userId, bankAccountNumber, signup.accountType, `Primary ${signup.accountType}`, signup.initialDeposit, signup.initialDeposit]
        );
        
        // Update pending signup status
        await pool.execute(
            `UPDATE pending_signups SET status = 'approved', reviewedBy = ?, reviewedAt = NOW() WHERE id = ?`,
            [decoded.id, id]
        );
        
        // Log admin action
        await logAdminAction(decoded.id, 'user_approve', userId, null, null, 
            { email: signup.email, accountNumber }, 'Approved new account application', null, req);
        
        res.json({
            success: true,
            message: 'Signup approved successfully',
            userId,
            accountNumber,
            email: signup.email
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Reject signup (Admin only)
app.post('/api/admin/signups/:id/reject', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { id } = req.params;
        const { reason } = req.body;
        
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Rejection reason is required' });
        }
        
        const [signups] = await pool.execute('SELECT * FROM pending_signups WHERE id = ? AND status = "pending"', [id]);
        if (signups.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending signup not found' });
        }
        
        await pool.execute(
            `UPDATE pending_signups SET status = 'rejected', reviewedBy = ?, reviewedAt = NOW(), rejectionReason = ? WHERE id = ?`,
            [decoded.id, reason, id]
        );
        
        await logAdminAction(decoded.id, 'user_reject', null, null, null, 
            { email: signups[0].email, reason }, reason, null, req);
        
        res.json({ success: true, message: 'Signup rejected' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== MULTIPLE ACCOUNTS PER USER ====================

// Get user's bank accounts
app.get('/api/accounts', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        const [accounts] = await pool.execute(
            `SELECT id, accountNumber, accountType, accountName, ledgerBalance, availableBalance, 
                    status, overdraftEnabled, interestRate, isPrimary, openedAt, lastActivityAt
             FROM bank_accounts WHERE userId = ? AND status != 'closed'
             ORDER BY isPrimary DESC, openedAt ASC`,
            [decoded.id]
        );
        
        res.json({ success: true, accounts });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Open additional account
app.post('/api/accounts/open', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.isImpersonation) {
            return res.status(403).json({ success: false, message: 'Action not allowed in view-only mode' });
        }
        
        const { accountType, accountName, initialDeposit = 0 } = req.body;
        
        if (!accountType || !['checking', 'savings', 'money_market'].includes(accountType)) {
            return res.status(400).json({ success: false, message: 'Invalid account type' });
        }
        
        // Check user status
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        if (users.length === 0 || users[0].accountStatus !== 'active') {
            return res.status(403).json({ success: false, message: 'Account must be active to open new accounts' });
        }
        
        const user = users[0];
        const deposit = parseFloat(initialDeposit) || 0;
        
        // Minimum deposit for savings
        if (accountType === 'savings' && deposit < 100) {
            return res.status(400).json({ success: false, message: 'Minimum $100 required to open a savings account' });
        }
        
        // Check if user has funds for initial deposit
        if (deposit > 0 && parseFloat(user.balance) < deposit) {
            return res.status(400).json({ success: false, message: 'Insufficient funds for initial deposit' });
        }
        
        const accountNumber = generateBankAccountNumber();
        const interestRate = accountType === 'savings' ? 0.0425 : 0.0001;
        
        // Create account
        const [result] = await pool.execute(
            `INSERT INTO bank_accounts (userId, accountNumber, accountType, accountName, ledgerBalance, availableBalance, interestRate)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [decoded.id, accountNumber, accountType, accountName || `${accountType} Account`, deposit, deposit, interestRate]
        );
        
        // Deduct from primary balance if transferring funds
        if (deposit > 0) {
            await pool.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [deposit, decoded.id]);
            
            // Create transfer transaction
            await pool.execute(
                `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
                 VALUES (?, NULL, 'transfer_out', ?, ?, 'completed', ?)`,
                [decoded.id, deposit, `Initial deposit to new ${accountType} account`, generateReferenceId('TRF')]
            );
        }
        
        await createNotification(decoded.id, 'account', 'New Account Opened',
            `Your new ${accountType} account (****${accountNumber.slice(-4)}) has been opened successfully.`,
            { accountId: result.insertId, accountType });
        
        res.json({
            success: true,
            message: 'Account opened successfully',
            account: {
                id: result.insertId,
                accountNumber,
                accountType,
                balance: deposit
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== VIRTUAL CARD SYSTEM ====================

// Get user's cards
app.get('/api/cards', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        const [cards] = await pool.execute(
            `SELECT c.id, c.cardNumberMasked, c.expirationDate, c.cardType, c.cardNetwork, c.cardholderName,
                    c.status, c.dailyLimit, c.monthlyLimit, c.onlineEnabled, c.internationalEnabled,
                    c.contactlessEnabled, c.dailySpent, c.monthlySpent, c.lastUsedAt, c.issuedAt, c.activatedAt,
                    ba.accountNumber as linkedAccount, ba.accountType as linkedAccountType
             FROM cards c
             JOIN bank_accounts ba ON c.accountId = ba.id
             WHERE c.userId = ?
             ORDER BY c.issuedAt DESC`,
            [decoded.id]
        );
        
        res.json({ success: true, cards });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Issue new virtual card
app.post('/api/cards/issue', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.isImpersonation) {
            return res.status(403).json({ success: false, message: 'Action not allowed in view-only mode' });
        }
        
        const { accountId, cardType = 'debit', cardholderName } = req.body;
        
        // Verify account ownership
        const [accounts] = await pool.execute(
            'SELECT * FROM bank_accounts WHERE id = ? AND userId = ? AND status = "active"',
            [accountId, decoded.id]
        );
        
        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'Account not found or not active' });
        }
        
        // Check for existing active card on this account
        const [existingCards] = await pool.execute(
            'SELECT id FROM cards WHERE accountId = ? AND status IN ("active", "pending")',
            [accountId]
        );
        
        if (existingCards.length > 0 && cardType === 'debit') {
            return res.status(400).json({ success: false, message: 'Account already has an active card' });
        }
        
        // Get user info for cardholder name
        const [users] = await pool.execute('SELECT firstName, lastName FROM users WHERE id = ?', [decoded.id]);
        const user = users[0];
        const holderName = cardholderName || `${user.firstName} ${user.lastName}`.toUpperCase();
        
        // Generate card details
        const cardNumber = generateCardNumber();
        const expiryDate = generateExpiryDate();
        const cvv = generateCVV();
        const hashedCvv = await bcrypt.hash(cvv, 10);
        const cardNumberMasked = `****-****-****-${cardNumber.slice(-4)}`;
        
        const [result] = await pool.execute(
            `INSERT INTO cards (userId, accountId, cardNumber, cardNumberMasked, expirationDate, cvv, cardType, cardholderName, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [decoded.id, accountId, cardNumber, cardNumberMasked, expiryDate, hashedCvv, cardType, holderName]
        );
        
        await pool.execute(
            'UPDATE cards SET activatedAt = NOW() WHERE id = ?',
            [result.insertId]
        );
        
        await createNotification(decoded.id, 'card', 'New Card Issued',
            `Your new ${cardType} card ending in ${cardNumber.slice(-4)} has been issued and is ready to use.`,
            { cardId: result.insertId });
        
        await logComplianceAudit(decoded.id, decoded.id, 'card', result.insertId, 'card_issued',
            null, { cardType, lastFour: cardNumber.slice(-4) }, 'User requested new card', req);
        
        // Return card details (CVV shown only once!)
        res.json({
            success: true,
            message: 'Card issued successfully',
            card: {
                id: result.insertId,
                cardNumber: cardNumber, // Full number shown only on issuance
                cardNumberMasked,
                expirationDate: expiryDate,
                cvv: cvv, // CVV shown only once!
                cardType,
                cardholderName: holderName,
                status: 'active'
            },
            warning: 'Please save your card details securely. The full card number and CVV will not be shown again.'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== NOTIFICATIONS SYSTEM ====================

// Get user notifications
app.get('/api/notifications', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { unreadOnly = false, limit = 50 } = req.query;
        
        let query = `SELECT * FROM notifications WHERE userId = ?`;
        if (unreadOnly === 'true') query += ' AND isRead = FALSE';
        query += ' ORDER BY createdAt DESC LIMIT ?';
        
        const [notifications] = await pool.execute(query, [decoded.id, parseInt(limit)]);
        
        // Get unread count
        const [[{ unreadCount }]] = await pool.execute(
            'SELECT COUNT(*) as unreadCount FROM notifications WHERE userId = ? AND isRead = FALSE',
            [decoded.id]
        );
        
        res.json({ success: true, notifications, unreadCount });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark notification as read
app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;
        
        await pool.execute(
            'UPDATE notifications SET isRead = TRUE, readAt = NOW() WHERE id = ? AND userId = ?',
            [id, decoded.id]
        );
        
        res.json({ success: true, message: 'Notification marked as read' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark all notifications as read
app.put('/api/notifications/read-all', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        await pool.execute(
            'UPDATE notifications SET isRead = TRUE, readAt = NOW() WHERE userId = ? AND isRead = FALSE',
            [decoded.id]
        );
        
        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== SUPPORT TICKET SYSTEM ====================

// Create support ticket
app.post('/api/support/tickets', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { category, subject, description, priority = 'normal' } = req.body;
        
        if (!category || !subject || !description) {
            return res.status(400).json({ success: false, message: 'Category, subject, and description are required' });
        }
        
        const ticketNumber = generateTicketNumber();
        
        const [result] = await pool.execute(
            `INSERT INTO support_tickets (ticketNumber, userId, category, subject, description, priority)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [ticketNumber, decoded.id, category, subject, description, priority]
        );
        
        await createNotification(decoded.id, 'system', 'Support Ticket Created',
            `Your support ticket ${ticketNumber} has been created. We'll respond within 24 hours.`,
            { ticketId: result.insertId, ticketNumber });
        
        res.json({
            success: true,
            message: 'Support ticket created',
            ticketNumber,
            ticketId: result.insertId
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get user's support tickets
app.get('/api/support/tickets', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { status } = req.query;
        
        let query = 'SELECT * FROM support_tickets WHERE userId = ?';
        const params = [decoded.id];
        
        if (status && status !== 'all') {
            query += ' AND status = ?';
            params.push(status);
        }
        query += ' ORDER BY createdAt DESC';
        
        const [tickets] = await pool.execute(query, params);
        res.json({ success: true, tickets });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get ticket details with replies
app.get('/api/support/tickets/:ticketNumber', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { ticketNumber } = req.params;
        
        const [tickets] = await pool.execute(
            'SELECT * FROM support_tickets WHERE ticketNumber = ? AND userId = ?',
            [ticketNumber, decoded.id]
        );
        
        if (tickets.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        
        const [replies] = await pool.execute(
            `SELECT tr.*, u.firstName, u.lastName, u.isAdmin
             FROM ticket_replies tr
             JOIN users u ON tr.userId = u.id
             WHERE tr.ticketId = ?
             ORDER BY tr.createdAt ASC`,
            [tickets[0].id]
        );
        
        res.json({ success: true, ticket: tickets[0], replies });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Reply to ticket
app.post('/api/support/tickets/:ticketNumber/reply', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { ticketNumber } = req.params;
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }
        
        // Get ticket
        const [tickets] = await pool.execute(
            'SELECT * FROM support_tickets WHERE ticketNumber = ? AND userId = ?',
            [ticketNumber, decoded.id]
        );
        
        if (tickets.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        
        const ticket = tickets[0];
        
        if (ticket.status === 'closed') {
            return res.status(400).json({ success: false, message: 'Cannot reply to closed ticket' });
        }
        
        await pool.execute(
            'INSERT INTO ticket_replies (ticketId, userId, message, isStaff) VALUES (?, ?, ?, FALSE)',
            [ticket.id, decoded.id, message]
        );
        
        // Update ticket status
        await pool.execute(
            'UPDATE support_tickets SET status = "open", updatedAt = NOW() WHERE id = ?',
            [ticket.id]
        );
        
        res.json({ success: true, message: 'Reply added' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Get all tickets
app.get('/api/admin/support/tickets', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { status, priority, limit = 50 } = req.query;
        
        let query = `SELECT st.*, u.firstName, u.lastName, u.email
                     FROM support_tickets st
                     JOIN users u ON st.userId = u.id WHERE 1=1`;
        const params = [];
        
        if (status && status !== 'all') { query += ' AND st.status = ?'; params.push(status); }
        if (priority) { query += ' AND st.priority = ?'; params.push(priority); }
        query += ' ORDER BY st.createdAt DESC LIMIT ?';
        params.push(parseInt(limit));
        
        const [tickets] = await pool.execute(query, params);
        res.json({ success: true, tickets });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Reply to ticket
app.post('/api/admin/support/tickets/:ticketNumber/reply', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { ticketNumber } = req.params;
        const { message, newStatus } = req.body;
        
        const [tickets] = await pool.execute('SELECT * FROM support_tickets WHERE ticketNumber = ?', [ticketNumber]);
        if (tickets.length === 0) return res.status(404).json({ success: false, message: 'Ticket not found' });
        
        const ticket = tickets[0];
        
        if (message) {
            await pool.execute(
                'INSERT INTO ticket_replies (ticketId, userId, message, isStaff) VALUES (?, ?, ?, TRUE)',
                [ticket.id, decoded.id, message]
            );
        }
        
        if (newStatus) {
            await pool.execute(
                'UPDATE support_tickets SET status = ?, assignedTo = ?, updatedAt = NOW() WHERE id = ?',
                [newStatus, decoded.id, ticket.id]
            );
            
            if (newStatus === 'resolved') {
                await pool.execute('UPDATE support_tickets SET resolvedBy = ?, resolvedAt = NOW() WHERE id = ?', [decoded.id, ticket.id]);
            }
        }
        
        // Notify customer
        await createNotification(ticket.userId, 'system', 'Support Ticket Update',
            `Your support ticket ${ticketNumber} has been updated.`,
            { ticketNumber });
        
        res.json({ success: true, message: 'Reply sent' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== FAQ & HELP CENTER ====================

// Get FAQs (public)
app.get('/api/faqs', async (req, res) => {
    try {
        const { category } = req.query;
        
        let query = 'SELECT id, category, question, answer, viewCount, helpfulCount FROM faqs WHERE isPublished = TRUE';
        const params = [];
        
        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }
        query += ' ORDER BY category, sortOrder';
        
        const [faqs] = await pool.execute(query, params);
        
        // Get categories
        const [categories] = await pool.execute(
            'SELECT DISTINCT category FROM faqs WHERE isPublished = TRUE ORDER BY category'
        );
        
        res.json({ success: true, faqs, categories: categories.map(c => c.category) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Track FAQ view
app.post('/api/faqs/:id/view', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.execute('UPDATE faqs SET viewCount = viewCount + 1 WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark FAQ as helpful
app.post('/api/faqs/:id/helpful', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.execute('UPDATE faqs SET helpfulCount = helpfulCount + 1 WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Create FAQ
app.post('/api/admin/faqs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { category, question, answer, sortOrder = 0 } = req.body;
        
        const [result] = await pool.execute(
            'INSERT INTO faqs (category, question, answer, sortOrder, createdBy) VALUES (?, ?, ?, ?, ?)',
            [category, question, answer, sortOrder, decoded.id]
        );
        
        res.json({ success: true, faqId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Update FAQ
app.put('/api/admin/faqs/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { id } = req.params;
        const { category, question, answer, sortOrder, isPublished } = req.body;
        
        await pool.execute(
            'UPDATE faqs SET category = ?, question = ?, answer = ?, sortOrder = ?, isPublished = ? WHERE id = ?',
            [category, question, answer, sortOrder, isPublished, id]
        );
        
        res.json({ success: true, message: 'FAQ updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== BANK SETTINGS & BRANDING ====================

// Get public bank settings
app.get('/api/settings/public', async (req, res) => {
    try {
        const [settings] = await pool.execute(
            'SELECT settingKey, settingValue, settingType FROM bank_settings WHERE isPublic = TRUE'
        );
        
        const settingsObj = {};
        settings.forEach(s => {
            let value = s.settingValue;
            if (s.settingType === 'number') value = parseFloat(value);
            if (s.settingType === 'boolean') value = value === 'true';
            if (s.settingType === 'json') value = JSON.parse(value);
            settingsObj[s.settingKey] = value;
        });
        
        res.json({ success: true, settings: settingsObj });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Update bank settings
app.put('/api/admin/settings/:key', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { key } = req.params;
        const { value } = req.body;
        
        const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        
        await pool.execute(
            'UPDATE bank_settings SET settingValue = ?, updatedBy = ? WHERE settingKey = ?',
            [stringValue, decoded.id, key]
        );
        
        res.json({ success: true, message: 'Setting updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        server: 'backend/server.js',
        version: SERVER_VERSION,
        database: 'Ready',
        timestamp: new Date().toISOString()
    });
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password, rememberMe } = req.body;
        
        // Allow login with email or account number
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE email = ? OR accountNumber = ?', 
            [email, email]
        );
        
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const user = users[0];
        
        // Check if account is frozen or suspended
        if (user.accountStatus === 'frozen' || user.accountStatus === 'suspended') {
            return res.status(403).json({ 
                success: false, 
                message: `Account is ${user.accountStatus}. Please contact support.` 
            });
        }
        
        if (user.accountStatus === 'closed') {
            return res.status(403).json({ 
                success: false, 
                message: 'Account is closed. Please contact support.' 
            });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            // Log failed login attempt
            await pool.execute(
                `INSERT INTO login_history (userId, ipAddress, userAgent, loginStatus) 
                 VALUES (?, ?, ?, ?)`,
                [user.id, req.ip, req.get('user-agent'), 'failed']
            );
            
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Log successful login
        await pool.execute(
            `INSERT INTO login_history (userId, ipAddress, userAgent, loginStatus) 
             VALUES (?, ?, ?, ?)`,
            [user.id, req.ip, req.get('user-agent'), 'success']
        );
        
        // Update last login timestamp
        await pool.execute(
            `UPDATE users SET lastLogin = NOW() WHERE id = ?`,
            [user.id]
        );
        
        const tokenExpiry = rememberMe ? '30d' : '24h';
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: tokenExpiry });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                accountNumber: user.accountNumber,
                balance: parseFloat(user.balance),
                isAdmin: Boolean(user.isAdmin) || user.isAdmin === 1 || user.isAdmin === '1',
                lastLogin: user.lastLogin
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { 
            firstName, 
            lastName, 
            email, 
            password, 
            phone, 
            dateOfBirth, 
            address, 
            city, 
            state, 
            zipCode, 
            country, 
            accountType, 
            initialDeposit, 
            referralCode, 
            marketingConsent 
        } = req.body;
        
        // Validate required fields
        if (!firstName || !lastName || !email || !password || !phone) {
            return res.status(400).json({ success: false, message: 'All required fields must be filled' });
        }
        
        // Validate age
        if (dateOfBirth) {
            const age = Math.floor((new Date() - new Date(dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000));
            if (age < 18) {
                return res.status(400).json({ success: false, message: 'You must be at least 18 years old' });
            }
        }
        
        // Validate initial deposit
        const deposit = parseFloat(initialDeposit) || 0;
        if (deposit < 50) {
            return res.status(400).json({ success: false, message: 'Minimum initial deposit is $50.00' });
        }
        
        // Check if email already exists
        const [existingUsers] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ success: false, message: 'Email already registered' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const accountNumber = generateAccountNumber();

        await pool.execute(
            `INSERT INTO users (
                firstName, lastName, email, password, phone, 
                dateOfBirth, address, city, state, zipCode, country,
                accountNumber, routingNumber, balance, accountType, 
                marketingConsent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                firstName, lastName, email, hashedPassword, phone,
                dateOfBirth || null, address || null, city || null, 
                state || null, zipCode || null, country || 'United States',
                accountNumber, ROUTING_NUMBER, deposit, accountType || 'checking',
                marketingConsent || false
            ]
        );

        const [newUser] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        const user = newUser[0];
        
        // Create initial deposit transaction
        if (deposit > 0) {
            await pool.execute(
                `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference) 
                 VALUES (NULL, ?, ?, ?, ?, ?, ?)`,
                [user.id, 'deposit', deposit, 'Initial account deposit', 'completed', `DEP-${Date.now()}`]
            );
        }
        
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

        res.status(201).json({
            success: true,
            token,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                accountNumber: user.accountNumber,
                balance: deposit,
                accountType: user.accountType
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get user profile
app.get('/api/user/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        
        if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = users[0];
        res.json({
            success: true,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                accountNumber: user.accountNumber,
                routingNumber: user.routingNumber,
                balance: parseFloat(user.balance),
                isAdmin: Boolean(user.isAdmin) || user.isAdmin === 1 || user.isAdmin === '1'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Frontend compatibility: several pages call /api/auth/profile
app.get('/api/auth/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);

        if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = users[0];
        res.json({
            success: true,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                accountNumber: user.accountNumber,
                routingNumber: user.routingNumber,
                balance: parseFloat(user.balance),
                isAdmin: Boolean(user.isAdmin) || user.isAdmin === 1 || user.isAdmin === '1'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Get all users with balances
app.get('/api/admin/users-with-balances', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [users] = await pool.execute(
            'SELECT id, firstName, lastName, email, accountNumber, balance, isAdmin, accountStatus, accountType, phone FROM users'
        );
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Fund user account
app.post('/api/admin/fund-user', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { toEmail, toAccountNumber, amount, description } = req.body;
        
        let user;
        if (toEmail) {
            const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [toEmail]);
            user = users[0];
        } else if (toAccountNumber) {
            const [users] = await pool.execute('SELECT * FROM users WHERE accountNumber = ?', [toAccountNumber]);
            user = users[0];
        }

        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const newBalance = parseFloat(user.balance) + parseFloat(amount);
        await pool.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id]);

        res.json({
            success: true,
            message: `$${amount} added to ${user.firstName} ${user.lastName}`,
            newBalance
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Create user with full details
app.post('/api/admin/create-user', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { 
            firstName, lastName, email, password, phone, 
            dateOfBirth, address, city, state, zipCode, country,
            accountType, initialBalance, isAdmin 
        } = req.body;

        if (!firstName || !lastName || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'firstName, lastName, email, and password are required'
            });
        }
        
        // Check if email already exists
        const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Email already registered' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const accountNumber = generateAccountNumber();
        const balance = (initialBalance !== undefined && initialBalance !== null && initialBalance !== '')
            ? parseFloat(initialBalance)
            : 0;

        const phoneValue = phone || null;
        const dobValue = dateOfBirth || null;
        const addressValue = address || null;
        const cityValue = city || null;
        const stateValue = state || null;
        const zipValue = (zipCode || req.body.zip) || null;
        const countryValue = country || 'United States';
        const accountTypeValue = accountType || 'checking';
        const isAdminValue = isAdmin ? 1 : 0;

        const [insertResult] = await pool.execute(
            `INSERT INTO users (firstName, lastName, email, password, phone, dateOfBirth,
             address, city, state, zipCode, country, accountNumber, routingNumber, balance, 
             accountType, isAdmin, accountStatus) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [
                firstName,
                lastName,
                email,
                hashedPassword,
                phoneValue,
                dobValue,
                addressValue,
                cityValue,
                stateValue,
                zipValue,
                countryValue,
                accountNumber,
                ROUTING_NUMBER,
                balance,
                accountTypeValue,
                isAdminValue
            ]
        );

        res.status(201).json({
            success: true,
            message: `User ${firstName} ${lastName} created successfully`,
            user: {
                id: insertResult.insertId,
                firstName,
                lastName,
                email,
                accountNumber,
                balance
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Auth: Change password (used by settings-enhanced.js)
app.post('/api/auth/change-password', requireAuth, requireNotImpersonation, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Current and new password required' });
        }

        const newPasswordStr = String(newPassword);
        if (newPasswordStr.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
        }

        const [users] = await pool.execute('SELECT id, password FROM users WHERE id = ?', [req.auth.id]);
        const user = users[0];
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const ok = await bcrypt.compare(String(currentPassword), user.password);
        if (!ok) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPasswordStr, 10);
        try {
            await pool.execute('UPDATE users SET password = ?, forcePasswordChange = 0 WHERE id = ?', [hashedPassword, req.auth.id]);
        } catch (e) {
            // In case the DB doesn't have forcePasswordChange yet.
            await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.auth.id]);
        }

        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [req.auth.id, 'PASSWORD_CHANGE', 'User changed password', req.ip]
            );
        } catch (e) {}

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Lookup user by email or account number
app.post('/api/admin/lookup-user', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { email, accountNumber } = req.body;
        const emailValue = email ? String(email).trim().toLowerCase() : '';
        const accountNumberValue = accountNumber ? String(accountNumber).trim() : '';
        
        let user;
        if (emailValue) {
            const [users] = await pool.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, accountType FROM users WHERE email = ?', 
                [emailValue]
            );
            user = users[0];
        } else if (accountNumberValue) {
            const [users] = await pool.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, accountType FROM users WHERE accountNumber = ?', 
                [accountNumberValue]
            );
            user = users[0];
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Lookup user by email or account number (GET version for frontend compatibility)
app.get('/api/admin/lookup-user', requireAuth, requireAdmin, async (req, res) => {
    try {
        const emailValue = req.query.email ? String(req.query.email).trim().toLowerCase() : '';
        const accountNumberValue = req.query.accountNumber ? String(req.query.accountNumber).trim() : '';

        let user;
        if (emailValue) {
            const [users] = await pool.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, accountType FROM users WHERE email = ?',
                [emailValue]
            );
            user = users[0];
        } else if (accountNumberValue) {
            const [users] = await pool.execute(
                'SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, accountType FROM users WHERE accountNumber = ?',
                [accountNumberValue]
            );
            user = users[0];
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Transfer between any accounts (with optional bypass)
app.post('/api/admin/transfer', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const {
            fromEmail,
            fromAccountNumber,
            toEmail,
            toAccountNumber,
            amount,
            description,
            bypassBalanceCheck,
            // tolerate alternate field names used in other clients
            senderEmail,
            senderAccountNumber,
            recipientEmail,
            recipientAccountNumber
        } = req.body;

        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        const senderEmailValue = (fromEmail || senderEmail) ? String(fromEmail || senderEmail).trim().toLowerCase() : '';
        const senderAccountValue = (fromAccountNumber || senderAccountNumber) ? String(fromAccountNumber || senderAccountNumber).trim() : '';
        const recipientEmailValue = (toEmail || recipientEmail) ? String(toEmail || recipientEmail).trim().toLowerCase() : '';
        const recipientAccountValue = (toAccountNumber || recipientAccountNumber) ? String(toAccountNumber || recipientAccountNumber).trim() : '';
        
        await connection.beginTransaction();

        // Find & lock sender
        let sender;
        if (senderEmailValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ? FOR UPDATE', [senderEmailValue]);
            sender = users[0];
        } else if (senderAccountValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ? FOR UPDATE', [senderAccountValue]);
            sender = users[0];
        }

        if (!sender) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: `Sender not found${senderAccountValue ? ` (accountNumber: ${senderAccountValue})` : ''}${senderEmailValue ? ` (email: ${senderEmailValue})` : ''}`
            });
        }

        // Find & lock recipient
        let recipient;
        if (recipientEmailValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ? FOR UPDATE', [recipientEmailValue]);
            recipient = users[0];
        } else if (recipientAccountValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ? FOR UPDATE', [recipientAccountValue]);
            recipient = users[0];
        }

        if (!recipient) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: `Recipient not found${recipientAccountValue ? ` (accountNumber: ${recipientAccountValue})` : ''}${recipientEmailValue ? ` (email: ${recipientEmailValue})` : ''}`
            });
        }

        if (sender.id === recipient.id) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Cannot transfer to the same account' });
        }

        // Check balance unless bypassing
        const senderBalance = parseFloat(sender.balance);
        if (!bypassBalanceCheck && senderBalance < amountValue) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `Insufficient funds. Sender balance: $${senderBalance.toLocaleString()}`
            });
        }

        // Execute transfer
        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amountValue, sender.id]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amountValue, recipient.id]);

        // Generate reference
        const reference = 'ADM' + Date.now().toString(36).toUpperCase();

        // Log transaction
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, status, description, reference)
             VALUES (?, ?, ?, 'admin_transfer', 'completed', ?, ?)`,
            [sender.id, recipient.id, amountValue, description || 'Admin Transfer', reference]
        );

        // Get updated balances
        const [updatedSender] = await connection.execute('SELECT balance FROM users WHERE id = ?', [sender.id]);
        const [updatedRecipient] = await connection.execute('SELECT balance FROM users WHERE id = ?', [recipient.id]);

        await connection.commit();

        res.json({
            success: true,
            message: `$${amountValue.toLocaleString()} transferred from ${sender.firstName} ${sender.lastName} to ${recipient.firstName} ${recipient.lastName}`,
            reference,
            senderNewBalance: updatedSender[0]?.balance,
            recipientNewBalance: updatedRecipient[0]?.balance
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Admin: Credit account (add money)
app.post('/api/admin/credit-account', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { email, accountNumber, amount, reason, notes, recipient, description } = req.body;

        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        // Support admin.html payload: { recipient: "email-or-account", description }
        const recipientValue = recipient ? String(recipient).trim() : '';
        const emailValue = email ? String(email).trim().toLowerCase() : (recipientValue.includes('@') ? recipientValue.toLowerCase() : '');
        const accountNumberValue = accountNumber ? String(accountNumber).trim() : (!recipientValue.includes('@') ? recipientValue : '');

        await connection.beginTransaction();

        let user;
        if (emailValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ? FOR UPDATE', [emailValue]);
            user = users[0];
        } else if (accountNumberValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ? FOR UPDATE', [accountNumberValue]);
            user = users[0];
        }

        if (!user) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const previousBalance = parseFloat(user.balance);
        const newBalance = previousBalance + amountValue;

        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id]);

        // Generate reference
        const reference = 'CRD' + Date.now().toString(36).toUpperCase();

        const txDescription = description || (reason ? `${reason}${notes ? `: ${notes}` : ''}` : 'Admin Credit');

        // Log transaction
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, status, description, reference)
             VALUES (NULL, ?, ?, 'credit', 'completed', ?, ?)`,
            [user.id, amountValue, txDescription, reference]
        );

        // Log activity
        try {
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details) VALUES (?, ?, ?)',
                [user.id, 'ADMIN_CREDIT', `$${amountValue} credited. ${txDescription}`]
            );
        } catch (e) {
            // activity_logs table may not exist in some environments; ignore.
        }

        await connection.commit();

        res.json({
            success: true,
            message: `$${amountValue.toLocaleString()} credited to ${user.firstName} ${user.lastName}`,
            reference,
            previousBalance,
            newBalance,
            user: {
                name: `${user.firstName} ${user.lastName}`,
                accountNumber: user.accountNumber
            }
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Admin: Debit account (remove money)
app.post('/api/admin/debit-account', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { email, accountNumber, amount, reason, notes, forceDebit, recipient, description } = req.body;

        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        const recipientValue = recipient ? String(recipient).trim() : '';
        const emailValue = email ? String(email).trim().toLowerCase() : (recipientValue.includes('@') ? recipientValue.toLowerCase() : '');
        const accountNumberValue = accountNumber ? String(accountNumber).trim() : (!recipientValue.includes('@') ? recipientValue : '');

        await connection.beginTransaction();

        let user;
        if (emailValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ? FOR UPDATE', [emailValue]);
            user = users[0];
        } else if (accountNumberValue) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ? FOR UPDATE', [accountNumberValue]);
            user = users[0];
        }

        if (!user) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const previousBalance = parseFloat(user.balance);

        if (!forceDebit && previousBalance < amountValue) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Current: $${previousBalance.toLocaleString()}, Debit: $${amountValue.toLocaleString()}. Use force debit to allow negative balance.`
            });
        }

        const newBalance = previousBalance - amountValue;
        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id]);

        const reference = 'DBT' + Date.now().toString(36).toUpperCase();
        const txDescription = description || (reason ? `${reason}${notes ? `: ${notes}` : ''}` : 'Admin Debit');

        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, status, description, reference)
             VALUES (?, NULL, ?, 'debit', 'completed', ?, ?)`,
            [user.id, amountValue, txDescription, reference]
        );

        try {
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details) VALUES (?, ?, ?)',
                [user.id, 'ADMIN_DEBIT', `$${amountValue} debited. ${txDescription}`]
            );
        } catch (e) {}

        await connection.commit();

        res.json({
            success: true,
            message: `$${amountValue.toLocaleString()} debited from ${user.firstName} ${user.lastName}`,
            reference,
            previousBalance,
            newBalance,
            user: {
                name: `${user.firstName} ${user.lastName}`,
                accountNumber: user.accountNumber
            }
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Transfer funds
app.post('/api/user/transfer', requireAuth, requireNotImpersonation, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { toEmail, toAccountNumber, amount, description, recipient } = req.body;

        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        // Support alternate payload shapes: { recipient: "email-or-accountNumber" }
        const recipientValue = recipient ? String(recipient).trim() : '';
        const toEmailValue = toEmail
            ? String(toEmail).trim().toLowerCase()
            : (recipientValue.includes('@') ? recipientValue.toLowerCase() : '');
        const toAccountValue = toAccountNumber
            ? String(toAccountNumber).trim()
            : (!recipientValue.includes('@') ? recipientValue : '');

        if (!toEmailValue && !toAccountValue) {
            return res.status(400).json({ success: false, message: 'Recipient email or account number required' });
        }

        await connection.beginTransaction();

        // Lock sender
        const [senders] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [req.auth.id]);
        const sender = senders[0];
        if (!sender) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Sender not found' });
        }

        if (sender.accountStatus && sender.accountStatus !== 'active') {
            await connection.rollback();
            return res.status(403).json({ success: false, message: `Account is ${sender.accountStatus}. Transfers not allowed.` });
        }

        // Lock recipient
        let recipientUser;
        if (toEmailValue) {
            const [rows] = await connection.execute('SELECT * FROM users WHERE email = ? FOR UPDATE', [toEmailValue]);
            recipientUser = rows[0];
        } else {
            const [rows] = await connection.execute('SELECT * FROM users WHERE accountNumber = ? FOR UPDATE', [toAccountValue]);
            recipientUser = rows[0];
        }

        if (!recipientUser) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Recipient not found' });
        }

        if (sender.id === recipientUser.id) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Cannot transfer to the same account' });
        }

        if (recipientUser.accountStatus && recipientUser.accountStatus !== 'active') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Recipient account is not active' });
        }

        const senderBalance = parseFloat(sender.balance);
        if (senderBalance < amountValue) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Insufficient funds' });
        }

        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amountValue, sender.id]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amountValue, recipientUser.id]);

        const reference = 'TRF' + Date.now().toString(36).toUpperCase();
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, status, description, reference)
             VALUES (?, ?, ?, 'transfer', 'completed', ?, ?)`,
            [sender.id, recipientUser.id, amountValue, description || 'Transfer', reference]
        );

        await connection.commit();

        res.json({
            success: true,
            message: `$${amountValue.toLocaleString()} sent to ${recipientUser.firstName} ${recipientUser.lastName}`,
            reference
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// User: Transaction history (latest 100)
// Compatible with the root server route used by the frontend.
app.get('/api/user/:userId/transactions', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, message: 'Authorization token required' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const requestedUserId = parseInt(req.params.userId, 10);

        const [requesterRows] = await pool.execute('SELECT id, isAdmin FROM users WHERE id = ?', [decoded.id]);
        const requester = requesterRows[0];
        const isAdmin = !!requester?.isAdmin;

        if (!isAdmin && decoded.id !== requestedUserId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const [transactions] = await pool.execute(
            `SELECT t.*,
                    uf.firstName AS fromFirstName, uf.lastName AS fromLastName,
                    ut.firstName AS toFirstName, ut.lastName AS toLastName
             FROM transactions t
             LEFT JOIN users uf ON t.fromUserId = uf.id
             LEFT JOIN users ut ON t.toUserId = ut.id
             WHERE t.fromUserId = ? OR t.toUserId = ?
             ORDER BY t.createdAt DESC
             LIMIT 100`,
            [requestedUserId, requestedUserId]
        );

        res.json({ success: true, transactions, txCount: transactions.length });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// User: Recent activity feed for dashboard
app.get('/api/user/:userId/activity', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, message: 'Authorization token required' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const requestedUserId = parseInt(req.params.userId, 10);
        if (!Number.isFinite(requestedUserId)) {
            return res.status(400).json({ success: false, message: 'Invalid userId' });
        }

        const [requesterRows] = await pool.execute('SELECT id, isAdmin FROM users WHERE id = ?', [decoded.id]);
        const requester = requesterRows[0];
        const isAdmin = !!requester?.isAdmin;

        if (!isAdmin && decoded.id !== requestedUserId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        let logs = [];
        try {
            const [rows] = await pool.execute(
                'SELECT id, action_type, action_details, ip_address, created_at FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
                [requestedUserId]
            );
            logs = rows;
        } catch (e) {
            // activity_logs may not exist on some older DBs; return empty list
            logs = [];
        }

        const activities = logs.map((l) => ({
            id: l.id,
            action: l.action_type,
            description: l.action_details,
            ipAddress: l.ip_address,
            timestamp: l.created_at
        }));

        res.json({ success: true, activities });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Bill Payment - Billers list
const BILLERS = [
    { id: 1, name: 'Electric Company', category: 'utilities', minAmount: 10, maxAmount: 5000 },
    { id: 2, name: 'Water Services', category: 'utilities', minAmount: 10, maxAmount: 1000 },
    { id: 3, name: 'Gas Company', category: 'utilities', minAmount: 10, maxAmount: 2000 },
    { id: 4, name: 'Internet Provider', category: 'internet', minAmount: 20, maxAmount: 500 },
    { id: 5, name: 'Mobile Phone', category: 'phone', minAmount: 10, maxAmount: 1000 },
    { id: 6, name: 'Cable TV', category: 'entertainment', minAmount: 20, maxAmount: 500 },
    { id: 7, name: 'Insurance Premium', category: 'insurance', minAmount: 50, maxAmount: 10000 },
    { id: 8, name: 'Credit Card', category: 'finance', minAmount: 25, maxAmount: 50000 }
];

app.get('/api/bills/billers', (req, res) => {
    res.json({ success: true, billers: BILLERS });
});

app.post('/api/bills/pay', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        
        const { billerId, accountNumber, amount } = req.body;
        
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        const user = users[0];
        
        if (parseFloat(user.balance) < parseFloat(amount)) {
            return res.status(400).json({ success: false, message: 'Insufficient funds' });
        }

        await pool.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, user.id]);

        // Record bill payment transaction
        const biller = BILLERS.find(b => String(b.id) === String(billerId));
        const referenceId = generateReferenceId('BILL');
        await pool.execute(
            `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
             VALUES (?, NULL, 'bill_payment', ?, ?, 'completed', ?)`,
            [
                user.id,
                parseFloat(amount),
                `Bill payment to ${biller?.name || 'Biller'} (${accountNumber})`,
                referenceId
            ]
        );

        res.json({
            success: true,
            message: `Bill payment of $${amount} processed successfully`
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ACCOUNT STATEMENTS ====================
app.get('/api/statements/download', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { format = 'pdf', startDate, endDate } = req.query;

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        const user = users[0];

        let query = `
            SELECT t.*, 
                   uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.email AS fromEmail,
                   ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.email AS toEmail
            FROM transactions t
            LEFT JOIN users uf ON t.fromUserId = uf.id
            LEFT JOIN users ut ON t.toUserId = ut.id
            WHERE (t.fromUserId = ? OR t.toUserId = ?)
        `;
        const params = [decoded.id, decoded.id];

        if (startDate) {
            query += ' AND t.createdAt >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND t.createdAt <= ?';
            params.push(endDate);
        }

        query += ' ORDER BY t.createdAt DESC';
        const [transactions] = await pool.execute(query, params);

        if (format === 'csv') {
            const csvPath = path.join(__dirname, `statement_${decoded.id}_${Date.now()}.csv`);
            const csvWriter = createCsvWriter({
                path: csvPath,
                header: [
                    { id: 'date', title: 'Date' },
                    { id: 'type', title: 'Type' },
                    { id: 'description', title: 'Description' },
                    { id: 'amount', title: 'Amount' },
                    { id: 'balance', title: 'Balance' }
                ]
            });

            const records = transactions.map(t => ({
                date: new Date(t.createdAt).toLocaleDateString(),
                type: t.type,
                description: t.description || t.type,
                amount: `$${parseFloat(t.amount).toFixed(2)}`,
                balance: `$${parseFloat(t.balanceAfter || user.balance).toFixed(2)}`
            }));

            await csvWriter.writeRecords(records);
            res.download(csvPath, `statement_${user.accountNumber}.csv`, () => {
                fs.unlinkSync(csvPath);
            });
        } else {
            // PDF Format
            const doc = new PDFDocument({ margin: 50 });
            const pdfPath = path.join(__dirname, `statement_${decoded.id}_${Date.now()}.pdf`);
            const stream = fs.createWriteStream(pdfPath);

            doc.pipe(stream);

            // Header
            doc.fontSize(24).text('HERITAGE BANK', { align: 'center' });
            doc.fontSize(10).text('Account Statement', { align: 'center' });
            doc.moveDown();

            // Account Info
            doc.fontSize(12).text(`Account Holder: ${user.firstName} ${user.lastName}`);
            doc.text(`Account Number: ${user.accountNumber}`);
            doc.text(`Routing Number: ${user.routingNumber || ROUTING_NUMBER}`);
            doc.text(`Statement Date: ${new Date().toLocaleDateString()}`);
            doc.text(`Current Balance: $${parseFloat(user.balance).toFixed(2)}`);
            doc.moveDown();

            // Transactions Table
            doc.fontSize(14).text('Transaction History', { underline: true });
            doc.moveDown();

            if (transactions.length === 0) {
                doc.fontSize(10).text('No transactions found for this period.');
            } else {
                doc.fontSize(9);
                const startY = doc.y;
                transactions.forEach((t, index) => {
                    const y = startY + (index * 20);
                    if (y > 700) {
                        doc.addPage();
                        doc.y = 50;
                    }
                    doc.text(new Date(t.createdAt).toLocaleDateString(), 50, y, { width: 80 });
                    doc.text(t.type, 140, y, { width: 100 });
                    doc.text(t.description || 'N/A', 250, y, { width: 150 });
                    doc.text(`$${parseFloat(t.amount).toFixed(2)}`, 410, y, { width: 100, align: 'right' });
                });
            }

            doc.end();

            stream.on('finish', () => {
                res.download(pdfPath, `statement_${user.accountNumber}.pdf`, () => {
                    fs.unlinkSync(pdfPath);
                });
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== TRANSACTION RECEIPTS ====================
app.get('/api/transactions/:id/receipt', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        const [requesterRows] = await pool.execute('SELECT id, isAdmin FROM users WHERE id = ?', [decoded.id]);
        const requester = requesterRows[0];
        const isAdmin = !!requester?.isAdmin;

        const [transactions] = await pool.execute(
            `SELECT t.*,
                    uf.firstName AS fromFirstName, uf.lastName AS fromLastName,
                    ut.firstName AS toFirstName, ut.lastName AS toLastName
             FROM transactions t
             LEFT JOIN users uf ON t.fromUserId = uf.id
             LEFT JOIN users ut ON t.toUserId = ut.id
             WHERE t.id = ?`,
            [id]
        );

        if (transactions.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const transaction = transactions[0];
        const isParticipant = (transaction.fromUserId === decoded.id) || (transaction.toUserId === decoded.id);

        if (!isAdmin && !isParticipant) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        const user = users[0];

        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const pdfPath = path.join(__dirname, `receipt_${id}_${Date.now()}.pdf`);
        const stream = fs.createWriteStream(pdfPath);

        doc.pipe(stream);

        // Header with bank branding
        doc.fontSize(28).fillColor('#2C5F7F').text('HERITAGE BANK', { align: 'center' });
        doc.fontSize(12).fillColor('black').text('Transaction Receipt', { align: 'center' });
        doc.moveDown(2);

        // Receipt details box
        doc.rect(50, doc.y, 500, 250).stroke();
        const boxStartY = doc.y + 20;

        doc.fontSize(10).fillColor('gray').text('TRANSACTION DETAILS', 70, boxStartY);
        doc.moveDown(1.5);

        const detailsY = doc.y;
        doc.fontSize(11).fillColor('black');
        doc.text('Receipt Number:', 70, detailsY);
        doc.text(`RCP-${String(id).padStart(8, '0')}`, 250, detailsY);
        
        doc.text('Date:', 70, detailsY + 20);
        doc.text(new Date(transaction.createdAt).toLocaleString(), 250, detailsY + 20);
        
        doc.text('Transaction Type:', 70, detailsY + 40);
        doc.text(transaction.type, 250, detailsY + 40);
        
        doc.text('Amount:', 70, detailsY + 60);
        doc.fontSize(16).fillColor('#28a745').text(`$${parseFloat(transaction.amount).toFixed(2)}`, 250, detailsY + 60);
        
        doc.fontSize(11).fillColor('black');
        doc.text('From:', 70, detailsY + 85);
        doc.text(`${user.firstName} ${user.lastName}`, 250, detailsY + 85);
        doc.text(`Account: ${user.accountNumber}`, 250, detailsY + 100);

        if (transaction.toUserId) {
            doc.text('To:', 70, detailsY + 120);
            doc.text(`${transaction.firstName || 'N/A'} ${transaction.lastName || ''}`, 250, detailsY + 120);
        }

        doc.text('Description:', 70, detailsY + 140);
        doc.text(transaction.description || 'N/A', 250, detailsY + 140, { width: 250 });

        doc.text('Status:', 70, detailsY + 180);
        doc.fillColor('#28a745').text('COMPLETED', 250, detailsY + 180);

        // Footer
        doc.fontSize(8).fillColor('gray');
        doc.text('Heritage Bank • 1-800-HERITAGE • www.heritagebank.com', 50, 750, { align: 'center' });
        doc.text('This is a computer-generated receipt and does not require a signature.', 50, 765, { align: 'center' });

        doc.end();

        stream.on('finish', () => {
            res.download(pdfPath, `receipt_${transaction.id}.pdf`, () => {
                fs.unlinkSync(pdfPath);
            });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== BENEFICIARY MANAGEMENT ====================
app.get('/api/beneficiaries', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const [beneficiaries] = await pool.execute(
            'SELECT * FROM beneficiaries WHERE userId = ? ORDER BY createdAt DESC',
            [decoded.id]
        );

        res.json({ success: true, beneficiaries });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/beneficiaries', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { name, accountNumber, bankName, email, nickname } = req.body;

        const [result] = await pool.execute(
            'INSERT INTO beneficiaries (userId, name, accountNumber, bankName, email, nickname) VALUES (?, ?, ?, ?, ?, ?)',
            [decoded.id, name, accountNumber, bankName || 'Heritage Bank', email, nickname]
        );

        res.json({ success: true, message: 'Beneficiary added successfully', beneficiaryId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/beneficiaries/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;
        const { name, accountNumber, bankName, email, nickname } = req.body;

        await pool.execute(
            'UPDATE beneficiaries SET name = ?, accountNumber = ?, bankName = ?, email = ?, nickname = ? WHERE id = ? AND userId = ?',
            [name, accountNumber, bankName, email, nickname, id, decoded.id]
        );

        res.json({ success: true, message: 'Beneficiary updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/beneficiaries/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute('DELETE FROM beneficiaries WHERE id = ? AND userId = ?', [id, decoded.id]);

        res.json({ success: true, message: 'Beneficiary deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== TRANSACTION SEARCH & FILTERS ====================
app.get('/api/transactions/search', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { startDate, endDate, type, minAmount, maxAmount, search } = req.query;

        let query = `
            SELECT t.*,
                   uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.email AS fromEmail,
                   ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.email AS toEmail
            FROM transactions t
            LEFT JOIN users uf ON t.fromUserId = uf.id
            LEFT JOIN users ut ON t.toUserId = ut.id
            WHERE (t.fromUserId = ? OR t.toUserId = ?)
        `;
        const params = [decoded.id, decoded.id];

        if (startDate) {
            query += ' AND t.createdAt >= ?';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND t.createdAt <= ?';
            params.push(endDate);
        }
        if (type) {
            query += ' AND t.type = ?';
            params.push(type);
        }
        if (minAmount) {
            query += ' AND t.amount >= ?';
            params.push(minAmount);
        }
        if (maxAmount) {
            query += ' AND t.amount <= ?';
            params.push(maxAmount);
        }
        if (search) {
            query += ' AND (t.description LIKE ? OR uf.firstName LIKE ? OR uf.lastName LIKE ? OR ut.firstName LIKE ? OR ut.lastName LIKE ?)';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        query += ' ORDER BY t.createdAt DESC LIMIT 500';
        const [transactions] = await pool.execute(query, params);

        res.json({ success: true, transactions });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== TRANSACTION LIMITS ====================
app.get('/api/limits', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        let [limits] = await pool.execute('SELECT * FROM transaction_limits WHERE userId = ?', [decoded.id]);
        
        if (limits.length === 0) {
            // Create default limits
            await pool.execute(
                'INSERT INTO transaction_limits (userId, dailyLimit, weeklyLimit, monthlyLimit, singleTransactionLimit) VALUES (?, ?, ?, ?, ?)',
                [decoded.id, 10000, 50000, 200000, 5000]
            );
            [limits] = await pool.execute('SELECT * FROM transaction_limits WHERE userId = ?', [decoded.id]);
        }

        res.json({ success: true, limits: limits[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/limits', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { dailyLimit, weeklyLimit, monthlyLimit, singleTransactionLimit } = req.body;

        await pool.execute(
            'UPDATE transaction_limits SET dailyLimit = ?, weeklyLimit = ?, monthlyLimit = ?, singleTransactionLimit = ? WHERE userId = ?',
            [dailyLimit, weeklyLimit, monthlyLimit, singleTransactionLimit, decoded.id]
        );

        res.json({ success: true, message: 'Limits updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== CARD MANAGEMENT ====================
app.put('/api/cards/:id/freeze', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute(
            'UPDATE cards SET status = ?, frozenAt = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?',
            ['frozen', id, decoded.id]
        );

        res.json({ success: true, message: 'Card frozen successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/cards/:id/unfreeze', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute(
            'UPDATE cards SET status = ?, frozenAt = NULL WHERE id = ? AND userId = ?',
            ['active', id, decoded.id]
        );

        res.json({ success: true, message: 'Card unfrozen successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/cards/:id/block', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;
        const { reason } = req.body;

        await pool.execute(
            'UPDATE cards SET status = ?, blockedAt = CURRENT_TIMESTAMP, blockReason = ? WHERE id = ? AND userId = ?',
            ['blocked', reason || 'User requested', id, decoded.id]
        );

        res.json({ success: true, message: 'Card blocked successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/cards/:id/change-pin', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;
        const { currentPin, newPin } = req.body;

        const [cards] = await pool.execute('SELECT * FROM cards WHERE id = ? AND userId = ?', [id, decoded.id]);
        
        if (cards.length === 0) {
            return res.status(404).json({ success: false, message: 'Card not found' });
        }

        const card = cards[0];
        if (card.pin && !(await bcrypt.compare(currentPin, card.pin))) {
            return res.status(400).json({ success: false, message: 'Current PIN is incorrect' });
        }

        const hashedPin = await bcrypt.hash(newPin, 10);
        await pool.execute('UPDATE cards SET pin = ? WHERE id = ?', [hashedPin, id]);

        res.json({ success: true, message: 'PIN changed successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== SCHEDULED PAYMENTS ====================
app.get('/api/scheduled-payments', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const [payments] = await pool.execute(
            'SELECT * FROM scheduled_payments WHERE userId = ? ORDER BY nextRunDate ASC',
            [decoded.id]
        );

        res.json({ success: true, payments });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/scheduled-payments', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { type, amount, frequency, nextRunDate, endDate, toAccountNumber, toEmail, billerId, description } = req.body;

        const [result] = await pool.execute(
            'INSERT INTO scheduled_payments (userId, type, amount, frequency, nextRunDate, endDate, toAccountNumber, toEmail, billerId, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [decoded.id, type, amount, frequency, nextRunDate, endDate, toAccountNumber, toEmail, billerId, description]
        );

        res.json({ success: true, message: 'Payment scheduled successfully', paymentId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/scheduled-payments/:id/pause', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute(
            'UPDATE scheduled_payments SET status = ? WHERE id = ? AND userId = ?',
            ['paused', id, decoded.id]
        );

        res.json({ success: true, message: 'Payment paused successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/scheduled-payments/:id/resume', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute(
            'UPDATE scheduled_payments SET status = ? WHERE id = ? AND userId = ?',
            ['active', id, decoded.id]
        );

        res.json({ success: true, message: 'Payment resumed successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/scheduled-payments/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute(
            'UPDATE scheduled_payments SET status = ? WHERE id = ? AND userId = ?',
            ['cancelled', id, decoded.id]
        );

        res.json({ success: true, message: 'Payment cancelled successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== KYC DOCUMENT UPLOAD ====================
app.post('/api/documents/upload', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { documentType, fileName, fileData } = req.body;

        // In production, you'd save to S3/cloud storage. Here we'll save locally for demo
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir);
        }

        const filePath = path.join(uploadsDir, `${decoded.id}_${Date.now()}_${fileName}`);
        const buffer = Buffer.from(fileData, 'base64');
        fs.writeFileSync(filePath, buffer);

        const [result] = await pool.execute(
            'INSERT INTO documents (userId, documentType, fileName, filePath, fileSize, status) VALUES (?, ?, ?, ?, ?, ?)',
            [decoded.id, documentType, fileName, filePath, buffer.length, 'pending']
        );

        res.json({ success: true, message: 'Document uploaded successfully', documentId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/documents', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const [documents] = await pool.execute(
            'SELECT id, documentType, fileName, status, uploadedAt, rejectionReason FROM documents WHERE userId = ? ORDER BY uploadedAt DESC',
            [decoded.id]
        );

        res.json({ success: true, documents });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Review documents
app.get('/api/admin/documents/pending', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const [users] = await pool.execute('SELECT isAdmin FROM users WHERE id = ?', [decoded.id]);
        if (!users[0]?.isAdmin) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const [documents] = await pool.execute(
            `SELECT d.*, u.firstName, u.lastName, u.email 
             FROM documents d 
             JOIN users u ON d.userId = u.id 
             WHERE d.status = 'pending' 
             ORDER BY d.uploadedAt ASC`
        );

        res.json({ success: true, documents });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/documents/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const [users] = await pool.execute('SELECT isAdmin FROM users WHERE id = ?', [decoded.id]);
        if (!users[0]?.isAdmin) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const { id } = req.params;
        await pool.execute(
            'UPDATE documents SET status = ?, reviewedBy = ?, reviewedAt = CURRENT_TIMESTAMP WHERE id = ?',
            ['approved', decoded.id, id]
        );

        res.json({ success: true, message: 'Document approved successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/documents/:id/reject', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const [users] = await pool.execute('SELECT isAdmin FROM users WHERE id = ?', [decoded.id]);
        if (!users[0]?.isAdmin) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const { id } = req.params;
        const { reason } = req.body;

        await pool.execute(
            'UPDATE documents SET status = ?, reviewedBy = ?, reviewedAt = CURRENT_TIMESTAMP, rejectionReason = ? WHERE id = ?',
            ['rejected', decoded.id, reason, id]
        );

        res.json({ success: true, message: 'Document rejected successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== LOGIN HISTORY ====================
app.get('/api/login-history', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const [history] = await pool.execute(
            'SELECT * FROM login_history WHERE userId = ? ORDER BY loginAt DESC LIMIT 50',
            [decoded.id]
        );

        res.json({ success: true, history });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ADMIN ENDPOINTS ====================
// Get all transactions (admin only)
app.get('/api/transactions/all', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [transactions] = await pool.execute(`
            SELECT t.*, 
                   u1.firstName as senderFirst, u1.lastName as senderLast,
                   u1.email as senderEmail, u1.accountNumber as senderAccountNumber,
                   u2.firstName as recipientFirst, u2.lastName as recipientLast,
                   u2.email as recipientEmail, u2.accountNumber as recipientAccountNumber
            FROM transactions t
            LEFT JOIN users u1 ON t.fromUserId = u1.id
            LEFT JOIN users u2 ON t.toUserId = u2.id
            ORDER BY t.createdAt DESC
            LIMIT 100
        `);
        
        res.json({ success: true, transactions });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get activity logs (admin only)
app.get('/api/admin/activity-logs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [logs] = await pool.execute(`
            SELECT a.*, u.firstName, u.lastName, u.email as userName
            FROM activity_logs a
            LEFT JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at DESC
            LIMIT 100
        `);
        
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Forgot password endpoint
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        
        if (users.length === 0) {
            return res.json({ success: true, message: 'If email exists, reset link sent' });
        }

        // Generate reset token (in production, send via email)
        const resetToken = Math.random().toString(36).substring(2, 15);
        const resetExpiry = new Date(Date.now() + 3600000); // 1 hour
        
        await pool.execute(
            'UPDATE users SET resetToken = ?, resetTokenExpiry = ? WHERE email = ?',
            [resetToken, resetExpiry, email]
        );

        res.json({ 
            success: true, 
            message: 'Password reset instructions sent to email',
            // For demo purposes only - remove in production
            resetToken: resetToken
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Reset password endpoint
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, resetToken, newPassword } = req.body;
        
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE email = ? AND resetToken = ? AND resetTokenExpiry > NOW()',
            [email, resetToken]
        );
        
        if (users.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        await pool.execute(
            'UPDATE users SET password = ?, resetToken = NULL, resetTokenExpiry = NULL WHERE email = ?',
            [hashedPassword, email]
        );

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ADMIN ACCOUNT MANAGEMENT ====================

// Get dashboard statistics
app.get('/api/admin/dashboard-stats', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Total users
        const [userCount] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE accountStatus != "deleted"');
        
        // Total deposits (sum of all balances)
        const [totalBalance] = await pool.execute('SELECT SUM(balance) as total FROM users WHERE accountStatus != "deleted"');
        
        // Today's transactions
        const [todayTxns] = await pool.execute(`
            SELECT COUNT(*) as count 
            FROM transactions 
            WHERE DATE(createdAt) = CURDATE()
        `);
        
        // Pending loans
        const [pendingLoans] = await pool.execute(`
            SELECT COUNT(*) as count 
            FROM loan_applications 
            WHERE status = 'pending'
        `);
        
        // Total transactions this month
        const [monthlyTxns] = await pool.execute(`
            SELECT COUNT(*) as count, SUM(amount) as volume
            FROM transactions 
            WHERE MONTH(createdAt) = MONTH(CURDATE()) AND YEAR(createdAt) = YEAR(CURDATE())
        `);
        
        // Active users (logged in last 30 days)
        const [activeUsers] = await pool.execute(`
            SELECT COUNT(DISTINCT userId) as count 
            FROM login_history 
            WHERE loginStatus = 'success' AND loginAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);
        
        // Failed login attempts today
        const [failedLogins] = await pool.execute(`
            SELECT COUNT(*) as count 
            FROM login_history 
            WHERE loginStatus = 'failed' AND DATE(loginAt) = CURDATE()
        `);

        res.json({ 
            success: true, 
            stats: {
                totalUsers: userCount[0].count,
                totalBalance: totalBalance[0].total || 0,
                todayTransactions: todayTxns[0].count,
                pendingLoans: pendingLoans[0].count,
                monthlyTransactions: monthlyTxns[0].count,
                monthlyVolume: monthlyTxns[0].volume || 0,
                activeUsers: activeUsers[0].count,
                failedLoginsToday: failedLogins[0].count
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update account status (freeze/unfreeze/deactivate)
app.put('/api/admin/account-status/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { status, reason } = req.body;
        
        if (!['active', 'frozen', 'suspended', 'closed'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        await pool.execute(
            'UPDATE users SET accountStatus = ? WHERE id = ?',
            [status, userId]
        );

        // Log the action
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
            [userId, 'ACCOUNT_STATUS_CHANGE', `Status changed to ${status}: ${reason || 'No reason provided'}`, req.ip]
        );

        res.json({ success: true, message: `Account ${status} successfully` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Search users
app.get('/api/admin/search-users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { query } = req.query;
        
        if (!query || query.length < 2) {
            return res.status(400).json({ success: false, message: 'Search query too short' });
        }

        const searchPattern = `%${query}%`;
        const [users] = await pool.execute(`
            SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, createdAt
            FROM users 
            WHERE (firstName LIKE ? OR lastName LIKE ? OR email LIKE ? OR accountNumber LIKE ?)
            AND accountStatus != 'deleted'
            LIMIT 50
        `, [searchPattern, searchPattern, searchPattern, searchPattern]);

        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Search transactions
app.get('/api/admin/search-transactions', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { query: searchQuery, accountNumber, startDate, endDate, minAmount, maxAmount, type } = req.query;
        
        let query = `
            SELECT t.*, 
                   sender.firstName as senderFirst, sender.lastName as senderLast,
                   sender.email as senderEmail, sender.accountNumber as senderAccountNumber,
                   recipient.firstName as recipientFirst, recipient.lastName as recipientLast,
                   recipient.email as recipientEmail, recipient.accountNumber as recipientAccountNumber
            FROM transactions t
            LEFT JOIN users sender ON t.fromUserId = sender.id
            LEFT JOIN users recipient ON t.toUserId = recipient.id
            WHERE 1=1
        `;
        const params = [];

        // Generic query search used by the admin UI (e.g. account number, email, reference, description)
        if (searchQuery) {
            const like = `%${String(searchQuery).trim()}%`;
            query += `
                AND (
                    t.reference LIKE ? OR t.description LIKE ?
                    OR sender.email LIKE ? OR recipient.email LIKE ?
                    OR sender.accountNumber LIKE ? OR recipient.accountNumber LIKE ?
                    OR sender.firstName LIKE ? OR sender.lastName LIKE ?
                    OR recipient.firstName LIKE ? OR recipient.lastName LIKE ?
                )
            `;
            params.push(like, like, like, like, like, like, like, like, like, like);
        }

        if (accountNumber) {
            query += ` AND (sender.accountNumber = ? OR recipient.accountNumber = ?)`;
            params.push(accountNumber, accountNumber);
        }
        
        if (startDate) {
            query += ` AND DATE(t.createdAt) >= ?`;
            params.push(startDate);
        }
        
        if (endDate) {
            query += ` AND DATE(t.createdAt) <= ?`;
            params.push(endDate);
        }
        
        if (minAmount) {
            query += ` AND t.amount >= ?`;
            params.push(parseFloat(minAmount));
        }
        
        if (maxAmount) {
            query += ` AND t.amount <= ?`;
            params.push(parseFloat(maxAmount));
        }
        
        if (type) {
            query += ` AND t.type = ?`;
            params.push(type);
        }

        query += ` ORDER BY t.createdAt DESC LIMIT 100`;

        const [transactions] = await pool.execute(query, params);
        res.json({ success: true, transactions });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Reverse transaction
app.post('/api/admin/reverse-transaction/:transactionId', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { transactionId } = req.params;
        const { reason } = req.body;

        // Get original transaction
        const [transactions] = await connection.execute(
            'SELECT * FROM transactions WHERE id = ?',
            [transactionId]
        );

        if (transactions.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const transaction = transactions[0];

        if (transaction.status === 'reversed') {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Transaction already reversed' });
        }

        // Reverse the balances
        if (transaction.fromUserId) {
            await connection.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [transaction.amount, transaction.fromUserId]
            );
        }

        if (transaction.toUserId) {
            await connection.execute(
                'UPDATE users SET balance = balance - ? WHERE id = ?',
                [transaction.amount, transaction.toUserId]
            );
        }

        // Mark as reversed
        await connection.execute(
            'UPDATE transactions SET status = ?, description = CONCAT(description, " [REVERSED: ", ?, "]") WHERE id = ?',
            ['reversed', reason || 'Admin reversal', transactionId]
        );

        // Create reversal transaction record
        await connection.execute(`
            INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status, reference)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            transaction.toUserId,
            transaction.fromUserId,
            transaction.amount,
            'reversal',
            `Reversal of transaction ${transaction.reference}: ${reason}`,
            'completed',
            `REV-${transaction.reference}`
        ]);

        // Log the action
        await connection.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
            [transaction.fromUserId || transaction.toUserId || null, 'TRANSACTION_REVERSED', `Transaction ${transaction.reference} reversed: ${reason}`, req.ip]
        );

        await connection.commit();
        res.json({ success: true, message: 'Transaction reversed successfully' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Force password reset for user
app.post('/api/admin/force-password-reset/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { temporaryPassword } = req.body;

        const temp = (temporaryPassword !== undefined && temporaryPassword !== null)
            ? String(temporaryPassword)
            : '';

        // Allow generating a temporary password if one isn't provided.
        const effectiveTemp = temp || (`Temp-${Math.random().toString(36).slice(2, 10)}!`);

        if (effectiveTemp.length < 8) {
            return res.status(400).json({ success: false, message: 'temporaryPassword must be at least 8 characters' });
        }

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const hashedPassword = await bcrypt.hash(effectiveTemp, 10);
        
        try {
            await pool.execute(
                'UPDATE users SET password = ?, forcePasswordChange = 1 WHERE id = ?',
                [hashedPassword, userId]
            );
        } catch (e) {
            // In case the DB doesn't have forcePasswordChange yet.
            await pool.execute(
                'UPDATE users SET password = ? WHERE id = ?',
                [hashedPassword, userId]
            );
        }

        // Log the action
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
            [userId, 'PASSWORD_RESET', 'Admin forced password reset', req.ip]
        );

        res.json({ 
            success: true, 
            message: 'Password reset successfully',
            temporaryPassword: effectiveTemp // Only for demo - send via secure channel in production
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Export users to CSV
app.get('/api/admin/export-users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [users] = await pool.execute(`
            SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, 
                   phone, address, city, state, zipCode, createdAt
            FROM users 
            WHERE accountStatus != 'deleted'
            ORDER BY createdAt DESC
        `);

        // Create CSV
        const headers = 'ID,First Name,Last Name,Email,Account Number,Balance,Status,Phone,Address,City,State,ZIP,Created\n';
        const rows = users.map(u => 
            `${u.id},"${u.firstName}","${u.lastName}","${u.email}",${u.accountNumber},${u.balance},"${u.accountStatus}","${u.phone || ''}","${u.address || ''}","${u.city || ''}","${u.state || ''}","${u.zipCode || ''}","${u.createdAt}"`
        ).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=users_export.csv');
        res.send(headers + rows);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Export transactions to CSV
app.get('/api/admin/export-transactions', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        let query = `
            SELECT t.*, 
                   sender.accountNumber as senderAccount, sender.firstName as senderFirst, sender.lastName as senderLast,
                   recipient.accountNumber as recipientAccount, recipient.firstName as recipientFirst, recipient.lastName as recipientLast
            FROM transactions t
            LEFT JOIN users sender ON t.fromUserId = sender.id
            LEFT JOIN users recipient ON t.toUserId = recipient.id
            WHERE 1=1
        `;
        const params = [];

        if (startDate) {
            query += ` AND DATE(t.createdAt) >= ?`;
            params.push(startDate);
        }
        
        if (endDate) {
            query += ` AND DATE(t.createdAt) <= ?`;
            params.push(endDate);
        }

        query += ` ORDER BY t.createdAt DESC LIMIT 10000`;

        const [transactions] = await pool.execute(query, params);

        // Create CSV
        const headers = 'ID,Reference,Type,Amount,Sender Account,Sender Name,Recipient Account,Recipient Name,Description,Status,Date\n';
        const rows = transactions.map(t => 
            `${t.id},"${t.reference}","${t.type}",${t.amount},"${t.senderAccount || ''}","${t.senderFirst || ''} ${t.senderLast || ''}","${t.recipientAccount || ''}","${t.recipientFirst || ''} ${t.recipientLast || ''}","${t.description}","${t.status}","${t.createdAt}"`
        ).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=transactions_export.csv');
        res.send(headers + rows);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get monthly report
app.get('/api/admin/monthly-report', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { year, month } = req.query;
        
        const yearVal = year || new Date().getFullYear();
        const monthVal = month || (new Date().getMonth() + 1);

        // Transaction summary
        const [txnSummary] = await pool.execute(`
            SELECT 
                COUNT(*) as totalTransactions,
                SUM(CASE WHEN type = 'transfer' THEN 1 ELSE 0 END) as transfers,
                SUM(CASE WHEN type = 'bill_payment' THEN 1 ELSE 0 END) as billPayments,
                SUM(CASE WHEN type = 'deposit' THEN 1 ELSE 0 END) as deposits,
                SUM(amount) as totalVolume,
                AVG(amount) as avgTransaction
            FROM transactions
            WHERE YEAR(createdAt) = ? AND MONTH(createdAt) = ?
        `, [yearVal, monthVal]);

        // New users
        const [newUsers] = await pool.execute(`
            SELECT COUNT(*) as count
            FROM users
            WHERE YEAR(createdAt) = ? AND MONTH(createdAt) = ?
        `, [yearVal, monthVal]);

        // Loans summary
        const [loansSummary] = await pool.execute(`
            SELECT 
                COUNT(*) as totalApplications,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                SUM(CASE WHEN status = 'approved' THEN loanAmount ELSE 0 END) as totalApproved
            FROM loan_applications
            WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?
        `, [yearVal, monthVal]);

        res.json({ 
            success: true,
            report: {
                period: `${yearVal}-${String(monthVal).padStart(2, '0')}`,
                transactions: txnSummary[0],
                newUsers: newUsers[0].count,
                loans: loansSummary[0]
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update transaction limits
app.put('/api/admin/transaction-limits/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { dailyLimit, singleTransactionLimit } = req.body;

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Check if limits record exists
        const [existing] = await pool.execute(
            'SELECT * FROM transaction_limits WHERE userId = ?',
            [userId]
        );

        if (existing.length > 0) {
            await pool.execute(
                'UPDATE transaction_limits SET dailyLimit = ?, singleTransactionLimit = ? WHERE userId = ?',
                [dailyLimit, singleTransactionLimit, userId]
            );
        } else {
            await pool.execute(
                'INSERT INTO transaction_limits (userId, dailyLimit, singleTransactionLimit) VALUES (?, ?, ?)',
                [userId, dailyLimit, singleTransactionLimit]
            );
        }

        // Log the action
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
            [userId, 'LIMITS_UPDATE', `Daily: ${dailyLimit}, Single: ${singleTransactionLimit}`, req.ip]
        );

        res.json({ success: true, message: 'Transaction limits updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Helper function to log login attempts
async function logLoginAttempt(userId, ipAddress, userAgent, status, failureReason = null) {
    try {
        await pool.execute(
            'INSERT INTO login_history (userId, ipAddress, userAgent, loginStatus, failureReason) VALUES (?, ?, ?, ?, ?)',
            [userId, ipAddress, userAgent, status, failureReason]
        );
    } catch (error) {
        console.error('Error logging login attempt:', error);
    }
}

// ==================== USER PROFILE (COMPLETE) ====================

// Get complete user profile with all banking details
app.get('/api/user/profile/complete', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        
        if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = users[0];
        res.json({
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
                accountType: user.accountType,
                accountStatus: user.accountStatus,
                balance: parseFloat(user.balance),
                createdAt: user.createdAt,
                lastLogin: user.lastLogin,
                emailVerified: user.emailVerified || false,
                phoneVerified: user.phoneVerified || false,
                marketingConsent: user.marketingConsent || false,
                // Transaction limits
                dailyTransferLimit: 10000,
                weeklyTransferLimit: 50000,
                monthlyTransferLimit: 200000,
                singleTransactionLimit: 25000,
                dailyTransferSpent: 0,
                weeklyTransferSpent: 0,
                monthlyTransferSpent: 0,
                // Account controls
                accountFrozen: user.accountStatus === 'frozen',
                internationalEnabled: true,
                preferences: {}
            }
        });
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update complete user profile
app.put('/api/user/profile/complete', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { 
            firstName, lastName, phone, address, city, state, zipCode, 
            dateOfBirth, country 
        } = req.body;

        await pool.execute(`
            UPDATE users SET 
                firstName = COALESCE(?, firstName),
                lastName = COALESCE(?, lastName),
                phone = COALESCE(?, phone),
                address = COALESCE(?, address),
                city = COALESCE(?, city),
                state = COALESCE(?, state),
                zipCode = COALESCE(?, zipCode),
                dateOfBirth = COALESCE(?, dateOfBirth),
                country = COALESCE(?, country)
            WHERE id = ?
        `, [firstName, lastName, phone, address, city, state, zipCode, dateOfBirth, country, decoded.id]);

        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== LOGIN HISTORY & SESSIONS ====================

// Get login history
app.get('/api/user/security/login-history', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [logins] = await pool.execute(
            'SELECT * FROM login_history WHERE userId = ? ORDER BY createdAt DESC LIMIT 20',
            [decoded.id]
        );

        res.json({ success: true, logins });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get active sessions
app.get('/api/user/security/active-sessions', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Return mock sessions for now - in production, track actual sessions
        const sessions = [
            {
                id: 'session_current',
                deviceName: 'Current Device',
                browserName: 'Chrome',
                location: 'Current Location',
                lastActivity: new Date()
            }
        ];

        res.json({ success: true, sessions });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Logout specific session
app.post('/api/user/security/logout-session/:sessionId', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        jwt.verify(token, JWT_SECRET);
        
        // In production, invalidate the session
        res.json({ success: true, message: 'Session logged out' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Logout all sessions
app.post('/api/user/security/logout-all', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        jwt.verify(token, JWT_SECRET);
        
        // In production, invalidate all user sessions
        res.json({ success: true, message: 'All sessions logged out' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== DOCUMENTS ====================

// Upload document
app.post('/api/user/documents/upload', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { fileName, fileData, documentType } = req.body;

        // In production, upload to S3. For demo, we'll just track in DB
        const [result] = await pool.execute(
            'INSERT INTO user_documents (userId, documentType, fileName, verificationStatus, uploadedAt) VALUES (?, ?, ?, ?, NOW())',
            [decoded.id, documentType || 'ID', fileName || 'document', 'pending']
        );

        res.json({ success: true, message: 'Document uploaded', documentId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get user documents
app.get('/api/user/documents', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [documents] = await pool.execute(
            'SELECT id, documentType, fileName, verificationStatus as verified, uploadedAt FROM user_documents WHERE userId = ? ORDER BY uploadedAt DESC',
            [decoded.id]
        );

        res.json({ success: true, documents });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete document
app.delete('/api/user/documents/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute(
            'DELETE FROM user_documents WHERE id = ? AND userId = ?',
            [id, decoded.id]
        );

        res.json({ success: true, message: 'Document deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== BENEFICIARIES (User API) ====================

// Frontend compatibility: some pages call /api/beneficiaries*
app.get('/api/beneficiaries', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [beneficiaries] = await pool.execute(
            'SELECT * FROM beneficiaries WHERE userId = ? ORDER BY createdAt DESC',
            [decoded.id]
        );
        res.json({ success: true, beneficiaries });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/beneficiaries', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { name, nickname, accountNumber, routingNumber, bankName, email } = req.body;

        if (!name || !accountNumber) {
            return res.status(400).json({ success: false, message: 'Name and account number required' });
        }

        const [result] = await pool.execute(
            'INSERT INTO beneficiaries (userId, name, nickname, accountNumber, routingNumber, bankName, email, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
            [decoded.id, name, nickname, accountNumber, routingNumber, bankName || 'Heritage Bank', email || null]
        );

        res.json({ success: true, message: 'Beneficiary added', beneficiaryId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/beneficiaries/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;
        const { name, nickname, accountNumber, routingNumber, bankName, email } = req.body;

        await pool.execute(
            'UPDATE beneficiaries SET name = ?, nickname = ?, accountNumber = ?, routingNumber = ?, bankName = ?, email = ? WHERE id = ? AND userId = ?',
            [name, nickname, accountNumber, routingNumber, bankName, email || null, id, decoded.id]
        );

        res.json({ success: true, message: 'Beneficiary updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/beneficiaries/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute('DELETE FROM beneficiaries WHERE id = ? AND userId = ?', [id, decoded.id]);
        res.json({ success: true, message: 'Beneficiary deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get user beneficiaries
app.get('/api/user/beneficiaries', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [beneficiaries] = await pool.execute(
            'SELECT * FROM beneficiaries WHERE userId = ? ORDER BY createdAt DESC',
            [decoded.id]
        );

        res.json({ success: true, beneficiaries });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Add beneficiary
app.post('/api/user/beneficiaries', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { name, nickname, accountNumber, routingNumber, bankName, email } = req.body;

        if (!name || !accountNumber) {
            return res.status(400).json({ success: false, message: 'Name and account number required' });
        }

        const [result] = await pool.execute(
            'INSERT INTO beneficiaries (userId, name, nickname, accountNumber, routingNumber, bankName, email, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
            [decoded.id, name, nickname, accountNumber, routingNumber, bankName || 'Heritage Bank', email || null]
        );

        res.json({ success: true, message: 'Beneficiary added', beneficiaryId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update beneficiary
app.put('/api/user/beneficiaries/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;
        const { name, nickname, accountNumber, routingNumber, bankName, email } = req.body;

        await pool.execute(
            'UPDATE beneficiaries SET name = ?, nickname = ?, accountNumber = ?, routingNumber = ?, bankName = ?, email = ? WHERE id = ? AND userId = ?',
            [name, nickname, accountNumber, routingNumber, bankName, email || null, id, decoded.id]
        );

        res.json({ success: true, message: 'Beneficiary updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete beneficiary
app.delete('/api/user/beneficiaries/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        await pool.execute(
            'DELETE FROM beneficiaries WHERE id = ? AND userId = ?',
            [id, decoded.id]
        );

        res.json({ success: true, message: 'Beneficiary deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== TWO-FACTOR AUTHENTICATION ====================

// Enable 2FA
app.post('/api/user/2fa/enable', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { method } = req.body;

        // Generate backup codes
        const codes = Array.from({ length: 8 }, () => 
            Math.random().toString(36).substring(2, 8).toUpperCase()
        );

        await pool.execute(
            'UPDATE users SET twoFactorEnabled = 1, twoFactorMethod = ? WHERE id = ?',
            [method || 'sms', decoded.id]
        );

        res.json({ success: true, message: '2FA enabled', codes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Disable 2FA
app.post('/api/user/2fa/disable', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        await pool.execute(
            'UPDATE users SET twoFactorEnabled = 0, twoFactorMethod = NULL WHERE id = ?',
            [decoded.id]
        );

        res.json({ success: true, message: '2FA disabled' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Generate backup codes
app.post('/api/user/2fa/backup-codes', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        // Generate backup codes
        const codes = Array.from({ length: 8 }, () => 
            Math.random().toString(36).substring(2, 8).toUpperCase()
        );

        res.json({ success: true, codes });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ACCOUNT CONTROLS ====================

// Freeze account
app.post('/api/user/account/freeze', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        await pool.execute(
            'UPDATE users SET accountStatus = ? WHERE id = ?',
            ['frozen', decoded.id]
        );

        res.json({ success: true, message: 'Account frozen' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Unfreeze account
app.post('/api/user/account/unfreeze', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        await pool.execute(
            'UPDATE users SET accountStatus = ? WHERE id = ?',
            ['active', decoded.id]
        );

        res.json({ success: true, message: 'Account unfrozen' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Toggle international transactions
app.post('/api/user/account/international', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { enabled } = req.body;

        // Store in preferences table (will create if needed)
        await pool.execute(
            'INSERT INTO user_preferences (userId, internationalEnabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE internationalEnabled = ?',
            [decoded.id, enabled ? 1 : 0, enabled ? 1 : 0]
        );

        res.json({ success: true, message: 'International transactions ' + (enabled ? 'enabled' : 'disabled') });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== PREFERENCES ====================

// Update preferences
app.put('/api/user/preferences', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // For each preference key, update or insert
        for (const [key, value] of Object.entries(req.body)) {
            await pool.execute(
                'INSERT INTO user_preferences (userId, preferenceKey, preferenceValue) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE preferenceValue = ?',
                [decoded.id, key, JSON.stringify(value), JSON.stringify(value)]
            );
        }

        res.json({ success: true, message: 'Preferences updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== PRIVACY & DATA ====================

// Export user data (GDPR)
app.get('/api/user/privacy/export-data', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        // Get all user data
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        const [transactions] = await pool.execute('SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC', [decoded.id]);
        const [beneficiaries] = await pool.execute('SELECT * FROM beneficiaries WHERE userId = ?', [decoded.id]);
        const [documents] = await pool.execute('SELECT * FROM user_documents WHERE userId = ?', [decoded.id]);
        const [logins] = await pool.execute('SELECT * FROM login_history WHERE userId = ? LIMIT 100', [decoded.id]);

        const data = {
            exported: new Date(),
            user: users[0],
            transactions,
            beneficiaries,
            documents,
            recentLogins: logins
        };

        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Request account deletion (GDPR)
app.post('/api/user/privacy/delete-request', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        // Mark for deletion in 30 days
        const deletionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await pool.execute(
            'UPDATE users SET deletionRequestedAt = NOW(), scheduledDeletionDate = ? WHERE id = ?',
            [deletionDate, decoded.id]
        );

        res.json({ success: true, message: 'Account deletion requested. Scheduled for ' + deletionDate.toDateString() });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Download statement
app.get('/api/user/statements/current', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        const user = users[0];

        // Get transactions for current month
        const [transactions] = await pool.execute(`
            SELECT * FROM transactions 
            WHERE userId = ? AND MONTH(createdAt) = MONTH(NOW()) AND YEAR(createdAt) = YEAR(NOW())
            ORDER BY createdAt DESC
        `, [decoded.id]);

        // Create PDF
        const doc = new PDFDocument({ margin: 50 });
        const pdfPath = path.join(__dirname, `statement_${decoded.id}_${Date.now()}.pdf`);
        const stream = fs.createWriteStream(pdfPath);

        doc.pipe(stream);

        doc.fontSize(24).text('HERITAGE BANK', { align: 'center' });
        doc.fontSize(12).text('Account Statement', { align: 'center' });
        doc.moveDown();

        doc.fontSize(11);
        doc.text(`Account Holder: ${user.firstName} ${user.lastName}`);
        doc.text(`Account Number: ${user.accountNumber}`);
        doc.text(`Routing Number: ${user.routingNumber || ROUTING_NUMBER}`);
        doc.text(`Current Balance: $${parseFloat(user.balance).toFixed(2)}`);
        doc.text(`Statement Date: ${new Date().toLocaleDateString()}`);
        doc.moveDown();

        doc.fontSize(10).text('Recent Transactions:', { underline: true });
        doc.moveDown(0.5);

        if (transactions.length === 0) {
            doc.text('No transactions this month.');
        } else {
            transactions.forEach((t, i) => {
                doc.text(`${new Date(t.createdAt).toLocaleDateString()} - ${t.type}: $${parseFloat(t.amount).toFixed(2)} - ${t.description || 'N/A'}`);
            });
        }

        doc.end();

        stream.on('finish', () => {
            res.download(pdfPath, `statement_${user.accountNumber}.pdf`, () => {
                fs.unlinkSync(pdfPath);
            });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== COMPLIANCE & AUDIT ENDPOINTS ====================

// Middleware: Log all admin actions
async function logAdminAction(adminId, actionType, targetUserId, targetAccountId, previousState, newState, reason, amount, req) {
    try {
        await pool.execute(
            `INSERT INTO admin_action_logs (adminId, targetUserId, targetAccountId, actionType, previousState, newState, reason, amount, ipAddress, userAgent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [adminId, targetUserId, targetAccountId, actionType, 
             previousState ? JSON.stringify(previousState) : null,
             newState ? JSON.stringify(newState) : null,
             reason, amount, req?.ip || null, req?.get('user-agent') || null]
        );
    } catch (error) {
        console.error('Failed to log admin action:', error);
    }
}

// Middleware: Log compliance audit events
async function logComplianceAudit(userId, targetUserId, entityType, entityId, action, oldValue, newValue, reason, req, sessionId = null) {
    try {
        const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await pool.execute(
            `INSERT INTO compliance_audit_logs (userId, targetUserId, entityType, entityId, action, oldValue, newValue, reason, ipAddress, userAgent, sessionId, requestId)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, targetUserId, entityType, entityId, action,
             oldValue ? JSON.stringify(oldValue) : null,
             newValue ? JSON.stringify(newValue) : null,
             reason, req?.ip || null, req?.get('user-agent') || null, sessionId, requestId]
        );
        return requestId;
    } catch (error) {
        console.error('Failed to log compliance audit:', error);
        return null;
    }
}

// Get compliance audit logs (Admin only)
app.get('/api/admin/compliance/audit-logs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { entityType, action, userId, startDate, endDate, limit = 100, offset = 0 } = req.query;
        
        let query = `SELECT cal.*, u.email as actorEmail, tu.email as targetEmail 
                     FROM compliance_audit_logs cal
                     LEFT JOIN users u ON cal.userId = u.id
                     LEFT JOIN users tu ON cal.targetUserId = tu.id
                     WHERE 1=1`;
        const params = [];

        if (entityType) { query += ' AND cal.entityType = ?'; params.push(entityType); }
        if (action) { query += ' AND cal.action LIKE ?'; params.push(`%${action}%`); }
        if (userId) { query += ' AND (cal.userId = ? OR cal.targetUserId = ?)'; params.push(userId, userId); }
        if (startDate) { query += ' AND cal.createdAt >= ?'; params.push(startDate); }
        if (endDate) { query += ' AND cal.createdAt <= ?'; params.push(endDate); }

        query += ' ORDER BY cal.createdAt DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [logs] = await pool.execute(query, params);
        const [[{ total }]] = await pool.execute('SELECT COUNT(*) as total FROM compliance_audit_logs');

        res.json({ success: true, logs, total, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get admin action logs (Super Admin only)
app.get('/api/admin/compliance/admin-actions', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { actionType, adminId, startDate, endDate, limit = 100, offset = 0 } = req.query;
        
        let query = `SELECT aal.*, a.email as adminEmail, u.email as targetEmail 
                     FROM admin_action_logs aal
                     LEFT JOIN users a ON aal.adminId = a.id
                     LEFT JOIN users u ON aal.targetUserId = u.id
                     WHERE 1=1`;
        const params = [];

        if (actionType) { query += ' AND aal.actionType = ?'; params.push(actionType); }
        if (adminId) { query += ' AND aal.adminId = ?'; params.push(adminId); }
        if (startDate) { query += ' AND aal.createdAt >= ?'; params.push(startDate); }
        if (endDate) { query += ' AND aal.createdAt <= ?'; params.push(endDate); }

        query += ' ORDER BY aal.createdAt DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [logs] = await pool.execute(query, params);
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Add compliance flag to user/account
app.post('/api/admin/compliance/flags', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { userId, accountId, flagType, severity, description, expiresAt } = req.body;
        
        if (!userId || !flagType) {
            return res.status(400).json({ success: false, message: 'userId and flagType are required' });
        }

        await pool.execute(
            `INSERT INTO compliance_flags (userId, accountId, flagType, severity, description, triggeredBy, triggeredById, expiresAt)
             VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)`,
            [userId, accountId || null, flagType, severity || 'medium', description || null, decoded.id, expiresAt || null]
        );

        await logAdminAction(decoded.id, 'flag_add', userId, accountId, null, { flagType, severity }, description, null, req);
        await logComplianceAudit(decoded.id, userId, 'compliance', null, 'flag_added', null, { flagType, severity, description }, description, req);

        res.json({ success: true, message: 'Compliance flag added successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Resolve compliance flag
app.put('/api/admin/compliance/flags/:flagId/resolve', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { flagId } = req.params;
        const { resolutionNotes, status = 'resolved' } = req.body;

        const [flags] = await pool.execute('SELECT * FROM compliance_flags WHERE id = ?', [flagId]);
        if (flags.length === 0) return res.status(404).json({ success: false, message: 'Flag not found' });

        const oldFlag = flags[0];

        await pool.execute(
            `UPDATE compliance_flags SET status = ?, resolvedBy = ?, resolvedAt = NOW(), resolutionNotes = ? WHERE id = ?`,
            [status, decoded.id, resolutionNotes || null, flagId]
        );

        await logAdminAction(decoded.id, 'flag_resolve', oldFlag.userId, oldFlag.accountId, oldFlag, { status, resolutionNotes }, resolutionNotes, null, req);
        await logComplianceAudit(decoded.id, oldFlag.userId, 'compliance', flagId, 'flag_resolved', oldFlag, { status, resolutionNotes }, resolutionNotes, req);

        res.json({ success: true, message: 'Flag resolved successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get compliance flags for user
app.get('/api/admin/compliance/flags/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { userId } = req.params;
        const { status = 'active' } = req.query;

        let query = 'SELECT * FROM compliance_flags WHERE userId = ?';
        const params = [userId];
        if (status !== 'all') { query += ' AND status = ?'; params.push(status); }
        query += ' ORDER BY createdAt DESC';

        const [flags] = await pool.execute(query, params);
        res.json({ success: true, flags });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Request account deletion (GDPR/CCPA)
app.post('/api/user/privacy/delete-account', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = users[0];
        const { reason } = req.body;

        // Check for existing pending request
        const [existing] = await pool.execute(
            'SELECT * FROM account_deletion_requests WHERE userId = ? AND status = "pending"',
            [decoded.id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'A deletion request is already pending' });
        }

        // 30-day grace period
        const scheduledDate = new Date();
        scheduledDate.setDate(scheduledDate.getDate() + 30);

        await pool.execute(
            `INSERT INTO account_deletion_requests (userId, scheduledDeletionDate, reason, finalBalance)
             VALUES (?, ?, ?, ?)`,
            [decoded.id, scheduledDate.toISOString().split('T')[0], reason || null, user.balance]
        );

        await logComplianceAudit(decoded.id, decoded.id, 'user', decoded.id, 'deletion_requested', null, { scheduledDate: scheduledDate.toISOString(), reason }, reason, req);

        res.json({ 
            success: true, 
            message: 'Account deletion scheduled',
            scheduledDeletionDate: scheduledDate.toISOString().split('T')[0],
            gracePeriodDays: 30
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Cancel account deletion request
app.post('/api/user/privacy/cancel-deletion', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { reason } = req.body;

        const [requests] = await pool.execute(
            'SELECT * FROM account_deletion_requests WHERE userId = ? AND status = "pending"',
            [decoded.id]
        );
        if (requests.length === 0) {
            return res.status(404).json({ success: false, message: 'No pending deletion request found' });
        }

        await pool.execute(
            `UPDATE account_deletion_requests SET status = "cancelled", cancelledAt = NOW(), cancelledReason = ? WHERE userId = ? AND status = "pending"`,
            [reason || 'User requested cancellation', decoded.id]
        );

        await logComplianceAudit(decoded.id, decoded.id, 'user', decoded.id, 'deletion_cancelled', null, { reason }, reason, req);

        res.json({ success: true, message: 'Account deletion request cancelled' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Export user data (GDPR)
app.get('/api/user/privacy/export-data', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        // Get all user data
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        const [transactions] = await pool.execute('SELECT * FROM transactions WHERE userId = ?', [decoded.id]);
        const [beneficiaries] = await pool.execute('SELECT * FROM beneficiaries WHERE userId = ?', [decoded.id]);
        const [loginHistory] = await pool.execute('SELECT * FROM login_history WHERE userId = ? ORDER BY loginAt DESC LIMIT 100', [decoded.id]);
        const [documents] = await pool.execute('SELECT id, documentType, fileName, status, uploadedAt FROM documents WHERE userId = ?', [decoded.id]);

        const user = users[0];
        // Remove sensitive fields
        delete user.password;

        const exportData = {
            exportDate: new Date().toISOString(),
            bankName: BANK_NAME,
            profile: user,
            transactions: transactions,
            beneficiaries: beneficiaries,
            loginHistory: loginHistory.map(l => ({ ...l, ipAddress: l.ipAddress ? l.ipAddress.replace(/\d+$/, '***') : null })),
            documents: documents
        };

        // Log the export
        await pool.execute(
            `INSERT INTO data_export_logs (userId, exportType, generatedAt, status)
             VALUES (?, 'all_data', NOW(), 'downloaded')`,
            [decoded.id]
        );

        await logComplianceAudit(decoded.id, decoded.id, 'user', decoded.id, 'data_exported', null, { exportType: 'all_data' }, 'User requested data export', req);

        res.json({ success: true, data: exportData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Generate regulatory report (Admin only)
app.post('/api/admin/compliance/reports', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { reportType, periodStart, periodEnd } = req.body;

        let summary = {};
        let recordCount = 0;
        let totalAmount = 0;

        switch (reportType) {
            case 'ctr':
                // Currency Transaction Report - transactions over $10,000
                const [ctrTxns] = await pool.execute(
                    `SELECT * FROM transactions WHERE amount >= 10000 AND createdAt BETWEEN ? AND ?`,
                    [periodStart, periodEnd]
                );
                recordCount = ctrTxns.length;
                totalAmount = ctrTxns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
                summary = { transactionsOver10k: recordCount, totalAmount };
                break;

            case 'daily_summary':
                const [dailyTxns] = await pool.execute(
                    `SELECT type, COUNT(*) as count, SUM(amount) as total FROM transactions 
                     WHERE DATE(createdAt) = ? GROUP BY type`,
                    [periodStart]
                );
                const [newAccounts] = await pool.execute(
                    `SELECT COUNT(*) as count FROM users WHERE DATE(createdAt) = ?`,
                    [periodStart]
                );
                summary = { transactions: dailyTxns, newAccounts: newAccounts[0].count };
                recordCount = dailyTxns.reduce((sum, t) => sum + t.count, 0);
                break;

            case 'monthly_summary':
                const [monthlyTxns] = await pool.execute(
                    `SELECT type, COUNT(*) as count, SUM(amount) as total FROM transactions 
                     WHERE createdAt BETWEEN ? AND ? GROUP BY type`,
                    [periodStart, periodEnd]
                );
                const [monthlyUsers] = await pool.execute(
                    `SELECT COUNT(*) as newUsers FROM users WHERE createdAt BETWEEN ? AND ?`,
                    [periodStart, periodEnd]
                );
                const [monthlyFlags] = await pool.execute(
                    `SELECT flagType, COUNT(*) as count FROM compliance_flags 
                     WHERE createdAt BETWEEN ? AND ? GROUP BY flagType`,
                    [periodStart, periodEnd]
                );
                summary = { 
                    transactions: monthlyTxns, 
                    newUsers: monthlyUsers[0].newUsers,
                    complianceFlags: monthlyFlags
                };
                break;

            case 'kyc_status':
                const [kycPending] = await pool.execute(
                    `SELECT COUNT(*) as count FROM documents WHERE status = 'pending'`
                );
                const [kycApproved] = await pool.execute(
                    `SELECT COUNT(*) as count FROM documents WHERE status = 'approved'`
                );
                const [kycRejected] = await pool.execute(
                    `SELECT COUNT(*) as count FROM documents WHERE status = 'rejected'`
                );
                summary = { pending: kycPending[0].count, approved: kycApproved[0].count, rejected: kycRejected[0].count };
                recordCount = kycPending[0].count + kycApproved[0].count + kycRejected[0].count;
                break;

            default:
                return res.status(400).json({ success: false, message: 'Invalid report type' });
        }

        // Save report record
        const [result] = await pool.execute(
            `INSERT INTO regulatory_reports (reportType, periodStart, periodEnd, generatedBy, status, summary, recordCount, totalAmount)
             VALUES (?, ?, ?, ?, 'generated', ?, ?, ?)`,
            [reportType, periodStart, periodEnd || periodStart, decoded.id, JSON.stringify(summary), recordCount, totalAmount]
        );

        await logAdminAction(decoded.id, 'report_generate', null, null, null, { reportType, periodStart, periodEnd }, `Generated ${reportType} report`, null, req);

        res.json({ 
            success: true, 
            reportId: result.insertId,
            reportType,
            periodStart,
            periodEnd,
            summary,
            recordCount,
            totalAmount,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get regulatory reports
app.get('/api/admin/compliance/reports', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { reportType, limit = 50 } = req.query;
        
        let query = `SELECT rr.*, u.email as generatedByEmail FROM regulatory_reports rr
                     LEFT JOIN users u ON rr.generatedBy = u.id WHERE 1=1`;
        const params = [];
        
        if (reportType) { query += ' AND rr.reportType = ?'; params.push(reportType); }
        query += ' ORDER BY rr.generatedAt DESC LIMIT ?';
        params.push(parseInt(limit));

        const [reports] = await pool.execute(query, params);
        res.json({ success: true, reports });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Adjust user balance (with full audit)
app.post('/api/admin/users/:userId/adjust-balance', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { userId } = req.params;
        const { amount, reason, adjustmentType } = req.body;

        if (!amount || !reason) {
            return res.status(400).json({ success: false, message: 'Amount and reason are required' });
        }

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = users[0];
        const previousBalance = parseFloat(user.balance);
        const adjustmentAmount = parseFloat(amount);
        const newBalance = adjustmentType === 'debit' ? previousBalance - adjustmentAmount : previousBalance + adjustmentAmount;

        if (newBalance < 0 && !user.overdraftEnabled) {
            return res.status(400).json({ success: false, message: 'Adjustment would result in negative balance' });
        }

        await pool.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);

        // Create transaction record
        const txType = adjustmentType === 'debit' ? 'admin_debit' : 'admin_credit';
        const referenceId = `ADJ-${Date.now()}`;
        if (adjustmentType === 'debit') {
            await pool.execute(
                `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
                 VALUES (?, NULL, ?, ?, ?, 'completed', ?)`,
                [userId, txType, adjustmentAmount, `Admin adjustment: ${reason}`, referenceId]
            );
        } else {
            await pool.execute(
                `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
                 VALUES (NULL, ?, ?, ?, ?, 'completed', ?)`,
                [userId, txType, adjustmentAmount, `Admin adjustment: ${reason}`, referenceId]
            );
        }

        await logAdminAction(decoded.id, 'balance_adjust', userId, null, 
            { balance: previousBalance }, { balance: newBalance }, reason, adjustmentAmount, req);

        await logComplianceAudit(decoded.id, userId, 'account', null, 'balance_adjusted',
            { balance: previousBalance }, { balance: newBalance, adjustmentType, amount: adjustmentAmount }, reason, req);

        res.json({ 
            success: true, 
            message: 'Balance adjusted successfully',
            previousBalance,
            newBalance,
            adjustment: adjustmentAmount,
            type: adjustmentType
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get system configuration
app.get('/api/admin/system/config', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        
        let query = 'SELECT * FROM system_config';
        if (admins.length === 0) {
            query += ' WHERE isPublic = true';
        }

        const [config] = await pool.execute(query);
        
        // Convert to key-value object
        const configObj = {};
        config.forEach(c => {
            let value = c.configValue;
            if (c.configType === 'number') value = parseFloat(value);
            if (c.configType === 'boolean') value = value === 'true';
            if (c.configType === 'json') value = JSON.parse(value);
            configObj[c.configKey] = value;
        });

        res.json({ success: true, config: configObj });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update system configuration (Admin only)
app.put('/api/admin/system/config/:key', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { key } = req.params;
        const { value } = req.body;

        const [existing] = await pool.execute('SELECT * FROM system_config WHERE configKey = ?', [key]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'Configuration key not found' });
        }

        const oldValue = existing[0].configValue;
        const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

        await pool.execute(
            'UPDATE system_config SET configValue = ?, updatedBy = ? WHERE configKey = ?',
            [stringValue, decoded.id, key]
        );

        await logAdminAction(decoded.id, 'system_config_change', null, null, 
            { [key]: oldValue }, { [key]: stringValue }, `Updated ${key}`, null, req);

        res.json({ success: true, message: 'Configuration updated', key, oldValue, newValue: stringValue });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Maintenance mode check middleware
app.get('/api/system/status', async (req, res) => {
    try {
        const [config] = await pool.execute(
            'SELECT * FROM system_config WHERE configKey IN ("maintenance_mode", "maintenance_message")'
        );
        
        const status = {};
        config.forEach(c => {
            status[c.configKey] = c.configType === 'boolean' ? c.configValue === 'true' : c.configValue;
        });

        res.json({ 
            success: true, 
            maintenanceMode: status.maintenance_mode || false,
            maintenanceMessage: status.maintenance_message || 'System is under maintenance',
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        res.json({ success: true, maintenanceMode: false, serverTime: new Date().toISOString() });
    }
});

// ==================== ADMIN IMPERSONATION (VIEW-ONLY) ====================

// Start impersonation session
app.post('/api/admin/impersonate/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ success: false, message: 'Reason for impersonation is required' });
        }

        // Get target user
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const targetUser = users[0];

        // Log impersonation start
        await logAdminAction(req.auth.id, 'impersonate_start', userId, null, null, 
            { targetEmail: targetUser.email }, reason, null, req);

        await logComplianceAudit(req.auth.id, userId, 'admin', null, 'impersonation_started',
            null, { adminId: req.auth.id, targetUserId: userId }, reason, req);

        // Generate impersonation token (short-lived, read-only flag)
        const impersonationToken = jwt.sign(
            { 
                id: targetUser.id, 
                email: targetUser.email,
                impersonatedBy: req.auth.id,
                isImpersonation: true,
                readOnly: true
            }, 
            JWT_SECRET, 
            { expiresIn: '30m' } // 30 minutes max
        );

        res.json({
            success: true,
            message: 'Impersonation session started (view-only)',
            impersonationToken,
            targetUser: {
                id: targetUser.id,
                firstName: targetUser.firstName,
                lastName: targetUser.lastName,
                email: targetUser.email,
                accountNumber: targetUser.accountNumber,
                balance: parseFloat(targetUser.balance),
                accountType: targetUser.accountType,
                accountStatus: targetUser.accountStatus
            },
            expiresIn: '30 minutes',
            isReadOnly: true
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// End impersonation session
app.post('/api/admin/impersonate/end', requireAuth, async (req, res) => {
    try {
        if (!req.auth.isImpersonation) {
            return res.status(400).json({ success: false, message: 'Not in impersonation mode' });
        }

        // Log impersonation end
        await logAdminAction(req.auth.impersonatedBy, 'impersonate_end', req.auth.id, null, 
            null, null, 'Impersonation session ended', null, req);

        res.json({ success: true, message: 'Impersonation session ended' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get impersonated user view (dashboard data)
app.get('/api/admin/impersonate/dashboard', requireAuth, async (req, res) => {
    try {
        if (!req.auth.isImpersonation) {
            return res.status(403).json({ success: false, message: 'Impersonation token required' });
        }

        // Get user data
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.auth.id]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = users[0];

        // Get recent transactions
        const [transactions] = await pool.execute(
            `SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC LIMIT 20`,
            [req.auth.id]
        );

        // Get beneficiaries
        const [beneficiaries] = await pool.execute(
            `SELECT * FROM beneficiaries WHERE userId = ?`,
            [decoded.id]
        );

        // Get cards
        const [cards] = await pool.execute(
            `SELECT id, cardNumber, expirationDate, status, cardType, createdAt FROM cards WHERE userId = ?`,
            [decoded.id]
        );

        // Get compliance flags
        const [flags] = await pool.execute(
            `SELECT * FROM compliance_flags WHERE userId = ? AND status = 'active'`,
            [decoded.id]
        );

        // Get login history
        const [logins] = await pool.execute(
            `SELECT * FROM login_history WHERE userId = ? ORDER BY loginAt DESC LIMIT 10`,
            [decoded.id]
        );

        res.json({
            success: true,
            isImpersonation: true,
            readOnly: true,
            impersonatedBy: decoded.impersonatedBy,
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                phone: user.phone,
                accountNumber: user.accountNumber,
                routingNumber: user.routingNumber || ROUTING_NUMBER,
                balance: parseFloat(user.balance),
                accountType: user.accountType,
                accountStatus: user.accountStatus,
                createdAt: user.createdAt,
                lastLogin: user.lastLogin,
                address: user.address,
                city: user.city,
                state: user.state,
                zipCode: user.zipCode
            },
            transactions: transactions.map(t => ({
                ...t,
                amount: parseFloat(t.amount)
            })),
            beneficiaries,
            cards: cards.map(c => ({
                ...c,
                cardNumber: c.cardNumber ? `****${c.cardNumber.slice(-4)}` : null
            })),
            complianceFlags: flags,
            loginHistory: logins.map(l => ({
                ...l,
                ipAddress: l.ipAddress ? l.ipAddress.replace(/\d+$/, '***') : null
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== TRANSFER WITH FULL VALIDATION ====================

// Internal transfer with compliance checks
app.post('/api/transfer/internal', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Block transfers in impersonation mode
        if (decoded.isImpersonation) {
            return res.status(403).json({ success: false, message: 'Transfers not allowed in view-only mode' });
        }

        const { toAccountNumber, amount, description } = req.body;

        if (!toAccountNumber || !amount) {
            return res.status(400).json({ success: false, message: 'Recipient account and amount required' });
        }

        const transferAmount = parseFloat(amount);
        if (transferAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount' });
        }

        // Get sender
        const [senders] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        if (senders.length === 0) return res.status(404).json({ success: false, message: 'Sender not found' });
        const sender = senders[0];

        // Check account status
        if (sender.accountStatus !== 'active') {
            return res.status(403).json({ success: false, message: `Account is ${sender.accountStatus}. Transfers not allowed.` });
        }

        // Get recipient
        const [recipients] = await pool.execute('SELECT * FROM users WHERE accountNumber = ?', [toAccountNumber]);
        if (recipients.length === 0) {
            return res.status(404).json({ success: false, message: 'Recipient account not found' });
        }
        const recipient = recipients[0];

        // Can't transfer to self
        if (sender.id === recipient.id) {
            return res.status(400).json({ success: false, message: 'Cannot transfer to yourself' });
        }

        // Check recipient status
        if (recipient.accountStatus !== 'active') {
            return res.status(400).json({ success: false, message: 'Recipient account is not active' });
        }

        // Check balance
        const senderBalance = parseFloat(sender.balance);
        if (senderBalance < transferAmount && !sender.overdraftEnabled) {
            return res.status(400).json({ success: false, message: 'Insufficient funds' });
        }

        // Check transaction limits
        const limitCheck = await checkTransactionLimits(sender.id, transferAmount, 'transfer');
        if (!limitCheck.allowed) {
            return res.status(400).json({ success: false, message: limitCheck.reason });
        }

        // Check for suspicious activity
        const suspiciousFlags = await checkSuspiciousActivity(sender.id, transferAmount, 'transfer');
        
        // Generate reference ID
        const referenceId = generateReferenceId('TRF');

        // Execute transfer
        await pool.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [transferAmount, sender.id]);
        await pool.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [transferAmount, recipient.id]);

        // Record transaction (single ledger entry)
        await pool.execute(
            `INSERT INTO transactions (fromUserId, toUserId, type, amount, description, status, reference)
             VALUES (?, ?, 'transfer', ?, ?, 'completed', ?)`,
            [
                sender.id,
                recipient.id,
                transferAmount,
                description || `Transfer to ${recipient.accountNumber}`,
                referenceId
            ]
        );

        // Record transfer log
        await pool.execute(
            `INSERT INTO transfer_logs (sender_account_id, receiver_account_id, amount, reference_id)
             VALUES (?, ?, ?, ?)`,
            [sender.id, recipient.id, transferAmount, referenceId]
        );

        // Update spent limits
        await updateSpentLimits(sender.id, transferAmount);

        // Log compliance audit
        await logComplianceAudit(sender.id, recipient.id, 'transaction', null, 'transfer_completed',
            { senderBalance: senderBalance },
            { amount: transferAmount, recipientAccount: recipient.accountNumber, referenceId },
            description, req);

        // Create compliance flags if suspicious
        for (const flag of suspiciousFlags) {
            await pool.execute(
                `INSERT INTO compliance_flags (userId, flagType, severity, description, triggeredBy)
                 VALUES (?, ?, 'medium', ?, 'system')`,
                [sender.id, flag.type === 'ctr_threshold' ? 'aml_review' : 'unusual_activity', flag.description]
            );
        }

        // Get updated balance
        const [updated] = await pool.execute('SELECT balance FROM users WHERE id = ?', [sender.id]);

        res.json({
            success: true,
            message: 'Transfer completed successfully',
            referenceId,
            amount: transferAmount,
            newBalance: parseFloat(updated[0].balance),
            recipient: {
                accountNumber: `****${recipient.accountNumber.slice(-4)}`,
                name: `${recipient.firstName} ${recipient.lastName.charAt(0)}.`
            },
            timestamp: new Date().toISOString(),
            warnings: suspiciousFlags.length > 0 ? 'This transaction has been flagged for review' : null
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== SCHEDULED JOBS API ====================

// Get scheduled jobs status (Admin only)
app.get('/api/admin/jobs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const [jobs] = await pool.execute('SELECT * FROM scheduled_jobs ORDER BY nextRunAt');
        res.json({ success: true, jobs });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Manually trigger a job (Admin only)
app.post('/api/admin/jobs/:jobType/run', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { jobType } = req.params;
        let result = {};

        switch (jobType) {
            case 'interest_calculation':
                result = await runInterestCalculation();
                break;
            case 'fee_assessment':
                result = await runFeeAssessment();
                break;
            case 'charge_fees':
                result = await chargePendingFees();
                break;
            case 'post_interest':
                result = await postMonthlyInterest();
                break;
            case 'balance_snapshot':
                result = await runBalanceSnapshot();
                break;
            case 'dormant_check':
                result = await runDormantAccountCheck();
                break;
            case 'daily_report':
                result = await runDailyReport();
                break;
            default:
                return res.status(400).json({ success: false, message: 'Unknown job type' });
        }

        await logAdminAction(decoded.id, 'system_config_change', null, null, null, 
            { jobType, result }, `Manually triggered ${jobType} job`, null, req);

        res.json({ success: true, jobType, result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Toggle job active status
app.put('/api/admin/jobs/:jobId/toggle', requireAuth, requireAdmin, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [admins] = await pool.execute('SELECT * FROM users WHERE id = ? AND isAdmin = true', [decoded.id]);
        if (admins.length === 0) return res.status(403).json({ success: false, message: 'Admin access required' });

        const { jobId } = req.params;

        const [jobs] = await pool.execute('SELECT * FROM scheduled_jobs WHERE id = ?', [jobId]);
        if (jobs.length === 0) return res.status(404).json({ success: false, message: 'Job not found' });

        const newStatus = !jobs[0].isActive;
        await pool.execute('UPDATE scheduled_jobs SET isActive = ? WHERE id = ?', [newStatus, jobId]);

        res.json({ success: true, jobId, isActive: newStatus });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== CARD MANAGEMENT ====================

// Freeze/Unfreeze card
app.post('/api/cards/:cardId/freeze', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.isImpersonation) {
            return res.status(403).json({ success: false, message: 'Action not allowed in view-only mode' });
        }

        const { cardId } = req.params;
        const { freeze } = req.body;

        // Verify card ownership
        const [cards] = await pool.execute('SELECT * FROM cards WHERE id = ? AND userId = ?', [cardId, decoded.id]);
        if (cards.length === 0) return res.status(404).json({ success: false, message: 'Card not found' });

        const card = cards[0];
        const newStatus = freeze ? 'frozen' : 'active';

        await pool.execute(
            `UPDATE cards SET status = ?, frozenAt = ? WHERE id = ?`,
            [newStatus, freeze ? new Date() : null, cardId]
        );

        await logComplianceAudit(decoded.id, decoded.id, 'card', cardId, 
            freeze ? 'card_frozen' : 'card_unfrozen',
            { status: card.status }, { status: newStatus }, 'User requested', req);

        res.json({ 
            success: true, 
            message: freeze ? 'Card frozen successfully' : 'Card unfrozen successfully',
            cardId,
            status: newStatus
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update card settings (spending limit, online, international)
app.put('/api/cards/:cardId/settings', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.isImpersonation) {
            return res.status(403).json({ success: false, message: 'Action not allowed in view-only mode' });
        }

        const { cardId } = req.params;
        const { spendingLimit, onlineEnabled, internationalEnabled } = req.body;

        // Verify card ownership
        const [cards] = await pool.execute('SELECT * FROM cards WHERE id = ? AND userId = ?', [cardId, decoded.id]);
        if (cards.length === 0) return res.status(404).json({ success: false, message: 'Card not found' });

        const card = cards[0];
        const updates = [];
        const params = [];

        if (spendingLimit !== undefined) {
            updates.push('dailyLimit = ?');
            params.push(spendingLimit);
        }
        if (onlineEnabled !== undefined) {
            updates.push('onlineEnabled = ?');
            params.push(onlineEnabled);
        }
        if (internationalEnabled !== undefined) {
            updates.push('internationalEnabled = ?');
            params.push(internationalEnabled);
        }

        if (updates.length > 0) {
            params.push(cardId);
            await pool.execute(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        await logComplianceAudit(decoded.id, decoded.id, 'card', cardId, 'card_settings_updated',
            { spendingLimit: card.dailyLimit, onlineEnabled: card.onlineEnabled, internationalEnabled: card.internationalEnabled },
            { spendingLimit, onlineEnabled, internationalEnabled },
            'User updated card settings', req);

        res.json({ success: true, message: 'Card settings updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Serve index.html for root and any unmatched routes (SPA support)
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, '..', 'index.html'));
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🏦 Heritage Bank running on port ${PORT}`);
    console.log(`📱 Frontend: http://localhost:${PORT}`);
    console.log(`🔌 API: http://localhost:${PORT}/api`);
    console.log(`⚙️ Scheduled jobs running every 5 minutes`);
});
