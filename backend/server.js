const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
let nodemailer = null;
try {
    // Optional dependency: only needed when SMTP is configured.
    // If not installed, password reset endpoints will return a clear config error.
    nodemailer = require('nodemailer');
} catch (e) {
    nodemailer = null;
}
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

// Reduce 304/stale asset issues. In some CDN/browser setups, ETags can cause
// clients to keep using an older HTML even after deploy.
app.set('etag', false);

function setNoStoreHeaders(res) {
    try {
        // Browser + proxy caches
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        // Helpful hints for CDNs (e.g., Cloudflare) - best effort.
        res.setHeader('Surrogate-Control', 'no-store');
        res.setHeader('CDN-Cache-Control', 'no-store');
    } catch (e) {
        // best-effort
    }
}

// Server version for debugging (matches root server convention)
const SERVER_VERSION = "2.0.0-" + new Date().toISOString().split('T')[0];

// Middleware
// Render/Heroku-style deployments often sit behind a reverse proxy.
// This helps rate limiting and IP logging use the real client IP.
app.set('trust proxy', 1);

// Security headers with a permissive CSP that allows our inline scripts and CDN sources.
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://ka-f.fontawesome.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "https://ka-f.fontawesome.com"],
                imgSrc: ["'self'", "data:", "https://flagcdn.com", "https://cdnjs.cloudflare.com"],
                connectSrc: ["'self'"],
                frameSrc: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"]
            }
        },
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

// Prevent stale API JSON responses (e.g., transaction history) from being cached by browsers/CDNs.
app.use('/api', (req, res, next) => {
    setNoStoreHeaders(res);
    next();
});

// Avoid stale HTML in production (e.g., admin.html cached by browser/CDN).
// Static assets like CSS/JS can still be cached normally, but HTML should generally be revalidated.
app.use((req, res, next) => {
    try {
        if (req.path && req.path.toLowerCase().endsWith('.html')) {
            setNoStoreHeaders(res);
        }
    } catch (e) {
        // best-effort
    }
    next();
});

// "Latest" HTML endpoints to bypass stale cached /admin.html and /dashboard.html
// in environments where a CDN ignores querystrings and/or caches HTML too aggressively.
app.get(['/admin-new', '/admin-latest'], (req, res) => {
    setNoStoreHeaders(res);
    return res.sendFile(path.join(__dirname, '..', 'admin.html'));
});

app.get(['/dashboard-new', '/dashboard-latest'], (req, res) => {
    setNoStoreHeaders(res);
    return res.sendFile(path.join(__dirname, '..', 'dashboard.html'));
});

// Serve static frontend files from parent directory (for unified deployment)
// NOTE: We explicitly disable caching for HTML so that admin.html updates propagate reliably.
app.use(express.static(path.join(__dirname, '..'), {
    setHeaders: (res, filePath) => {
        try {
            if (filePath && filePath.toLowerCase().endsWith('.html')) {
                setNoStoreHeaders(res);
            }
        } catch (e) {
            // best-effort
        }
    }
}));

// Build/runtime diagnostics to help verify what code+assets are actually deployed.
// NOTE: Keep this non-sensitive (no DB creds, no secrets).
app.get('/api/build-info', async (req, res) => {
    try {
        const adminPath = path.join(__dirname, '..', 'admin.html');
        let adminStat = null;
        try {
            const s = fs.statSync(adminPath);
            adminStat = {
                exists: true,
                size: s.size,
                mtime: s.mtime,
            };
        } catch (e) {
            adminStat = { exists: false };
        }

        return res.json({
            success: true,
            server: 'backend/server.js',
            serverVersion: SERVER_VERSION,
            node: process.version,
            env: {
                nodeEnv: process.env.NODE_ENV || null,
                renderGitCommit: process.env.RENDER_GIT_COMMIT || null,
                renderServiceId: process.env.RENDER_SERVICE_ID || null,
                renderInstanceId: process.env.RENDER_INSTANCE_ID || null,
            },
            staticAssets: {
                adminHtml: adminStat,
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Database Connection Pool
//
// Supported env var formats:
// 1) Generic (Render/TiDB/etc): DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
// 2) Railway MySQL plugin:      MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE
//
// Note: This backend uses MySQL-compatible databases (MySQL, TiDB, PlanetScale, etc).
// If you provision PostgreSQL on Railway, it will NOT work with mysql2.
function getMySqlEnv(name, fallback = null) {
    const v = process.env[name];
    if (v === undefined || v === null) return fallback;
    const s = String(v).trim();
    return s.length ? s : fallback;
}

function getBoolEnv(name, fallback = null) {
    const raw = process.env[name];
    if (raw === undefined || raw === null) return fallback;
    const v = String(raw).trim().toLowerCase();
    if (!v.length) return fallback;
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    return fallback;
}

function decodeMaybe(s) {
    try {
        return decodeURIComponent(String(s || ''));
    } catch {
        return String(s || '');
    }
}

function parseMySqlUrl(urlString) {
    const raw = String(urlString || '').trim();
    if (!raw) return null;

    let u;
    try {
        // Accept mysql:// or mysql2://
        u = new URL(raw);
    } catch {
        return null;
    }

    const protocol = String(u.protocol || '').toLowerCase();
    if (protocol !== 'mysql:' && protocol !== 'mysql2:') return null;

    const host = u.hostname || null;
    const port = u.port ? Number(u.port) : null;
    const user = u.username ? decodeMaybe(u.username) : null;
    const password = u.password ? decodeMaybe(u.password) : null;
    const database = u.pathname ? decodeMaybe(u.pathname.replace(/^\//, '')) : null;

    // TiDB Cloud commonly provides a query param like:
    //   ?ssl={"rejectUnauthorized":true}
    // The value should ideally be URL-encoded, but we parse best-effort.
    let ssl = null;
    const sslParam = u.searchParams.get('ssl');
    if (sslParam) {
        const s = decodeMaybe(sslParam).trim();
        if (s === 'true' || s === '1') {
            ssl = { rejectUnauthorized: true };
        } else if (s === 'false' || s === '0') {
            ssl = false;
        } else {
            try {
                const parsed = JSON.parse(s);
                ssl = parsed;
            } catch {
                // ignore
            }
        }
    }

    return { host, port, user, password, database, ssl };
}

function resolveDbConfig() {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

    // Prefer URL-based configuration when provided (common on Railway/Heroku and also works for TiDB).
    const urlCfg = parseMySqlUrl(
        getMySqlEnv('DB_URL', getMySqlEnv('DATABASE_URL', getMySqlEnv('MYSQL_URL')))
    );

    const host = (urlCfg?.host) || getMySqlEnv('DB_HOST', getMySqlEnv('MYSQLHOST'));
    const portRaw = (urlCfg?.port != null ? String(urlCfg.port) : null) || getMySqlEnv('DB_PORT', getMySqlEnv('MYSQLPORT', isProd ? '3306' : '4000'));
    const user = (urlCfg?.user) || getMySqlEnv('DB_USER', getMySqlEnv('MYSQLUSER'));
    const password = (urlCfg?.password) || getMySqlEnv('DB_PASSWORD', getMySqlEnv('MYSQLPASSWORD'));
    const database = (urlCfg?.database) || getMySqlEnv('DB_NAME', getMySqlEnv('MYSQLDATABASE'));

    const port = portRaw ? Number(portRaw) : undefined;

    // TLS/SSL configuration
    // - Default is permissive (rejectUnauthorized=false) for ease of deployment.
    // - TiDB Cloud typically works best with rejectUnauthorized=true.
    const looksLikeTiDb = !!(host && String(host).toLowerCase().includes('tidbcloud.com'));
    const envRejectUnauthorized = getBoolEnv('DB_SSL_REJECT_UNAUTHORIZED', null);
    const defaultRejectUnauthorized = looksLikeTiDb ? true : false;

    let ssl = { rejectUnauthorized: envRejectUnauthorized ?? defaultRejectUnauthorized };

    // If URL explicitly provides ssl=false, disable TLS.
    if (urlCfg?.ssl === false) {
        ssl = null;
    } else if (urlCfg?.ssl && typeof urlCfg.ssl === 'object') {
        // Merge URL-provided SSL object but allow env var to override rejectUnauthorized.
        ssl = {
            ...urlCfg.ssl,
            rejectUnauthorized: envRejectUnauthorized ?? urlCfg.ssl.rejectUnauthorized ?? defaultRejectUnauthorized
        };
    }

    // Optional custom CA (some providers require providing a CA bundle).
    // Prefer base64 to support multiline values in Railway.
    const caB64 = getMySqlEnv('DB_SSL_CA_B64');
    const ca = getMySqlEnv('DB_SSL_CA');
    if (ssl && (caB64 || ca)) {
        try {
            ssl.ca = caB64 ? Buffer.from(caB64, 'base64').toString('utf8') : ca;
        } catch {
            // ignore malformed CA
        }
    }

    return {
        host,
        port,
        user,
        password,
        database,
        ssl
    };
}

const dbCfg = resolveDbConfig();
const pool = mysql.createPool({
    host: dbCfg.host,
    port: dbCfg.port,
    user: dbCfg.user,
    password: dbCfg.password,
    database: dbCfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // For TiDB Cloud and some managed MySQL providers, TLS is required.
    // Controlled via DB_SSL_REJECT_UNAUTHORIZED / DB_SSL_CA(_B64) and/or DB_URL ?ssl=...
    ...(dbCfg.ssl ? { ssl: dbCfg.ssl } : {})
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

        // Password reset fields (used by forgot-password / admin password reset)
        try { await connection.execute('ALTER TABLE users ADD COLUMN resetToken VARCHAR(255) NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN resetTokenExpiry TIMESTAMP NULL'); } catch (e) {}

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

        // Transfer restriction flag - when true, user needs admin approval for transfers
        try { await connection.execute('ALTER TABLE users ADD COLUMN transferRestricted BOOLEAN DEFAULT false'); } catch (e) {}

        // Account verification (admin-controlled)
        try { await connection.execute('ALTER TABLE users ADD COLUMN isVerified BOOLEAN DEFAULT false'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN documentRequested BOOLEAN DEFAULT false'); } catch (e) {}
        try { await connection.execute('ALTER TABLE users ADD COLUMN documentRequestMessage VARCHAR(500) NULL'); } catch (e) {}

        // Pending transfers table (for accounts with transfer restrictions)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS pending_transfers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                fromUserId INT NOT NULL,
                toUserId INT NOT NULL,
                toEmail VARCHAR(255),
                toAccountNumber VARCHAR(50),
                amount DECIMAL(15,2) NOT NULL,
                description VARCHAR(500),
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                rejectionReason VARCHAR(500),
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewedAt TIMESTAMP NULL,
                reviewedBy INT NULL,
                INDEX idx_pending_from (fromUserId),
                INDEX idx_pending_status (status),
                INDEX idx_pending_created (createdAt)
            )
        `);

        // Best-effort schema alignment for pending_transfers
        try { await connection.execute('ALTER TABLE pending_transfers ADD COLUMN rejectionReason VARCHAR(500) NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE pending_transfers ADD COLUMN reviewedAt TIMESTAMP NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE pending_transfers ADD COLUMN reviewedBy INT NULL'); } catch (e) {}

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

        // Session revocation tracking (best-effort). Note: JWTs are stateless; this mainly powers
        // the UI “active sessions” list and “logout session/all” buttons.
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_session_revocations (
                userId INT NOT NULL PRIMARY KEY,
                revokedAfter TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_session_revocations_specific (
                userId INT NOT NULL,
                sessionKey VARCHAR(64) NOT NULL,
                revokedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (userId, sessionKey),
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_session_revoked (userId, revokedAt)
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
                status ENUM('active', 'frozen', 'paused', 'blocked', 'expired', 'pending') DEFAULT 'pending',
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
                pausedAt TIMESTAMP NULL,
                blockedAt TIMESTAMP NULL,
                blockReason VARCHAR(500),
                deliveryAddress TEXT NULL,
                deliveryEtaText VARCHAR(64) NULL,
                deliveryStatus ENUM('not_applicable','processing','shipped','delivered') DEFAULT 'not_applicable',
                issuedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                activatedAt TIMESTAMP NULL,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (accountId) REFERENCES bank_accounts(id) ON DELETE CASCADE,
                INDEX idx_user_cards (userId),
                INDEX idx_card_status (status)
            )
        `);

        // Compatibility alters for existing environments (safe best-effort).
        // Add paused status support and delivery metadata without breaking older DBs.
        try {
            await connection.execute(
                "ALTER TABLE cards MODIFY COLUMN status ENUM('active','frozen','paused','blocked','expired','pending') DEFAULT 'pending'"
            );
        } catch (e) {}

        try { await connection.execute('ALTER TABLE cards ADD COLUMN pausedAt TIMESTAMP NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE cards ADD COLUMN deliveryAddress TEXT NULL'); } catch (e) {}
        try { await connection.execute('ALTER TABLE cards ADD COLUMN deliveryEtaText VARCHAR(64) NULL'); } catch (e) {}
        try {
            await connection.execute(
                "ALTER TABLE cards ADD COLUMN deliveryStatus ENUM('not_applicable','processing','shipped','delivered') DEFAULT 'not_applicable'"
            );
        } catch (e) {}

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

        // ==================== NEW FEATURE TABLES ====================

        // Transaction PIN for security (4-digit PIN for high-value transfers)
        try { await connection.execute('ALTER TABLE users ADD COLUMN transactionPin VARCHAR(255) NULL'); } catch (e) {}
        
        // User preferences table (dark mode, etc.)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_preferences (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL UNIQUE,
                darkMode BOOLEAN DEFAULT FALSE,
                language VARCHAR(10) DEFAULT 'en',
                currency VARCHAR(10) DEFAULT 'USD',
                sessionTimeout INT DEFAULT 15,
                autoLogout BOOLEAN DEFAULT TRUE,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Savings goals table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS savings_goals (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                name VARCHAR(100) NOT NULL,
                targetAmount DECIMAL(15,2) NOT NULL,
                currentAmount DECIMAL(15,2) DEFAULT 0.00,
                targetDate DATE,
                category VARCHAR(50) DEFAULT 'general',
                icon VARCHAR(50) DEFAULT 'piggy-bank',
                color VARCHAR(20) DEFAULT '#1a472a',
                status ENUM('active', 'completed', 'cancelled') DEFAULT 'active',
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                completedAt TIMESTAMP NULL,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_goals (userId),
                INDEX idx_goal_status (status)
            )
        `);

        // Internal messages table (between admin and users)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS internal_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                fromUserId INT NOT NULL,
                toUserId INT NOT NULL,
                subject VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                isRead BOOLEAN DEFAULT FALSE,
                readAt TIMESTAMP NULL,
                isArchived BOOLEAN DEFAULT FALSE,
                isDeleted BOOLEAN DEFAULT FALSE,
                parentMessageId INT NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (fromUserId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (toUserId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (parentMessageId) REFERENCES internal_messages(id) ON DELETE SET NULL,
                INDEX idx_to_user (toUserId, isRead),
                INDEX idx_from_user (fromUserId)
            )
        `);

        // Transaction categories table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS transaction_categories (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                transactionId INT NOT NULL,
                category VARCHAR(50) NOT NULL,
                notes VARCHAR(255),
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (transactionId) REFERENCES transactions(id) ON DELETE CASCADE,
                UNIQUE KEY unique_tx_category (transactionId),
                INDEX idx_user_categories (userId, category)
            )
        `);

        // Add transaction category column to transactions table
        try { await connection.execute('ALTER TABLE transactions ADD COLUMN category VARCHAR(50) DEFAULT NULL'); } catch (e) {}
        // Add destination country column for flag display
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN destinationCountry VARCHAR(2) DEFAULT NULL"); } catch (e) {}
        // Add recipient name column for admin-created debits (where toUserId is NULL)
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN recipientName VARCHAR(255) DEFAULT NULL"); } catch (e) {}
        // Wire transfer detail columns
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN recipientAddress TEXT DEFAULT NULL"); } catch (e) {}
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN bankName VARCHAR(255) DEFAULT NULL"); } catch (e) {}
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN swiftCode VARCHAR(20) DEFAULT NULL"); } catch (e) {}
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN iban VARCHAR(50) DEFAULT NULL"); } catch (e) {}
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN exchangeRate VARCHAR(50) DEFAULT NULL"); } catch (e) {}
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN recipientCurrency VARCHAR(10) DEFAULT NULL"); } catch (e) {}
        try { await connection.execute("ALTER TABLE transactions ADD COLUMN recipientAmount DECIMAL(15,2) DEFAULT NULL"); } catch (e) {}

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
        }

        // ── One-time migration: update $5,000 debit from seeleyjonesxx@gmail.com to show Santander UK transfer ──
        try {
            // First check if already migrated
            const [alreadyDone] = await connection.execute(
                `SELECT t.id, t.destinationCountry FROM transactions t
                 JOIN users u ON t.fromUserId = u.id
                 WHERE u.email = 'seeleyjonesxx@gmail.com' AND t.destinationCountry = 'GB'
                 LIMIT 1`
            );
            if (alreadyDone.length > 0) {
                // already applied
            } else {
                // Find ANY debit-like transaction from this user (broad match)
                const [santRows] = await connection.execute(
                    `SELECT t.id, t.description, t.reference, t.type, t.amount, t.destinationCountry FROM transactions t
                     JOIN users u ON t.fromUserId = u.id
                     WHERE u.email = 'seeleyjonesxx@gmail.com'
                       AND ABS(t.amount) BETWEEN 5190 AND 5200
                       AND (t.destinationCountry IS NULL OR t.destinationCountry = '' OR t.destinationCountry != 'GB')
                     ORDER BY t.createdAt DESC LIMIT 1`
                );
                if (santRows.length > 0) {
                    const stx = santRows[0];
                    await connection.execute(
                        `UPDATE transactions SET
                            destinationCountry = 'GB',
                            recipientName = 'Santander Mortga',
                            recipientAddress = 'Floor 1\n33 princeway\nRedhill\nredhill\nRH1 1SR',
                            bankName = 'SANTANDER UK PLC',
                            swiftCode = 'ABBYGB2LXXX',
                            iban = 'GB10ABBY09009290004049',
                            exchangeRate = '1 USD = 0.78610 GBP',
                            recipientCurrency = 'GBP',
                            recipientAmount = 4084.04
                        WHERE id = ?`,
                        [stx.id]
                    );
                } else {
                    // Last resort: try ANY transaction from this user that isn't already GB
                    const [allTx] = await connection.execute(
                        `SELECT t.id, t.amount, t.type, t.destinationCountry FROM transactions t
                         JOIN users u ON t.fromUserId = u.id
                         WHERE u.email = 'seeleyjonesxx@gmail.com'
                         ORDER BY t.createdAt DESC LIMIT 10`
                    );
                    // no matching transaction found
                }
            }
        } catch (migErr) {
            console.error('❌ Santander migration error:', migErr.message);
        }

        // ── One-time migration: update $44 bill payment → AT&T US bill payment ──
        try {
            const [attAlready] = await connection.execute(
                `SELECT t.id FROM transactions t
                 JOIN users u ON t.fromUserId = u.id
                 WHERE u.email = 'seeleyjonesxx@gmail.com' AND t.description LIKE '%AT&T%'
                 LIMIT 1`
            );
            if (attAlready.length > 0) {
                // already applied
            } else {
                const [attRows] = await connection.execute(
                    `SELECT t.id, t.amount, t.type, t.description FROM transactions t
                     JOIN users u ON t.fromUserId = u.id
                     WHERE u.email = 'seeleyjonesxx@gmail.com'
                       AND ABS(t.amount) BETWEEN 43 AND 45
                     ORDER BY t.createdAt DESC LIMIT 1`
                );
                if (attRows.length > 0) {
                    const btx = attRows[0];
                    await connection.execute(
                        `UPDATE transactions SET
                            description = 'AT&T Phone Payment - Monthly Service',
                            destinationCountry = 'US',
                            recipientName = 'AT&T',
                            recipientAddress = NULL,
                            bankName = NULL,
                            swiftCode = NULL,
                            iban = NULL,
                            exchangeRate = NULL,
                            recipientCurrency = NULL,
                            recipientAmount = NULL
                        WHERE id = ?`,
                        [btx.id]
                    );
                } else {
                    // no matching transaction found
                }
            }
        } catch (attErr) {
            console.error('❌ AT&T bill migration error:', attErr.message);
        }

        // Check Deposits table (mobile check deposit with images)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS check_deposits (
                id INT AUTO_INCREMENT PRIMARY KEY,
                userId INT NOT NULL,
                amount DECIMAL(15,2) NOT NULL,
                accountType VARCHAR(50) DEFAULT 'checking',
                checkNumber VARCHAR(20),
                payer VARCHAR(255),
                memo VARCHAR(500),
                frontImage LONGTEXT,
                backImage LONGTEXT,
                reference VARCHAR(50),
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                rejectionReason VARCHAR(500),
                reviewedAt TIMESTAMP NULL,
                reviewedBy INT NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_cd_user (userId),
                INDEX idx_cd_status (status)
            )
        `);

        connection.release();
        DB_READY = true;
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

function getSmtpConfig() {
    return {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        appBaseUrl: process.env.APP_BASE_URL
    };
}

async function sendTransactionalEmail({ to, subject, text, html }) {
    const cfg = getSmtpConfig();
    const hasAll = !!(cfg.host && cfg.port && cfg.user && cfg.pass && cfg.from);
    if (!hasAll) {
        const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
            .filter((k) => !process.env[k]);
        const msg = `Email service not configured. Missing: ${missing.join(', ')}`;
        const err = new Error(msg);
        err.code = 'EMAIL_NOT_CONFIGURED';
        throw err;
    }
    if (!nodemailer) {
        const err = new Error('Email dependency not installed (nodemailer).');
        err.code = 'EMAIL_NOT_CONFIGURED';
        throw err;
    }

    const transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: {
            user: cfg.user,
            pass: cfg.pass
        }
    });

    await transporter.sendMail({
        from: cfg.from,
        to,
        subject,
        text,
        html
    });
}

// ==================== BANKING UTILITY FUNCTIONS ====================

// Generate unique reference ID for transactions
function generateReferenceId(prefix = 'TXN') {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
}

// Schema compatibility helpers (some deployments may have older/snake_case schemas)
let _txColumnsCache = null;
let _txColumnsCacheAt = 0;
async function getTransactionsTableColumns() {
    const now = Date.now();
    if (_txColumnsCache && (now - _txColumnsCacheAt) < 5 * 60 * 1000) {
        return _txColumnsCache;
    }
    try {
        const [rows] = await pool.execute('SHOW COLUMNS FROM transactions');
        const cols = Array.isArray(rows) ? rows.map(r => String(r.Field || '')).filter(Boolean) : [];
        _txColumnsCache = cols;
        _txColumnsCacheAt = now;
        return cols;
    } catch (e) {
        // If the table doesn't exist or DB doesn't support SHOW COLUMNS, return null and let callers fall back.
        return null;
    }
}

function normalizeTransactionRow(row) {
    const r = row || {};
    const fromUserId = r.fromUserId ?? r.from_user_id ?? r.from_userId ?? r.fromuserid ?? null;
    const toUserId = r.toUserId ?? r.to_user_id ?? r.to_userId ?? r.touserid ?? null;
    const createdAt = r.createdAt ?? r.created_at ?? r.date ?? r.timestamp ?? r.created ?? null;
    const reference = r.reference ?? r.reference_id ?? r.referenceId ?? r.ref ?? null;
    const description = r.description ?? r.details ?? r.memo ?? r.note ?? null;

    return {
        ...r,
        fromUserId,
        toUserId,
        createdAt,
        reference,
        description,
        destinationCountry: r.destinationCountry ?? r.destination_country ?? null
    };
}

function detectCountryFromDescription(desc) {
    const d = String(desc || '').toLowerCase();
    if (d.includes('uk bank transfer') || d.includes('uk transfer') || d.includes('united kingdom')) return 'GB';
    if (d.includes('canada') || d.includes('canadian')) return 'CA';
    if (d.includes('nigeria') || d.includes('nigerian')) return 'NG';
    if (d.includes('ghana') || d.includes('ghanaian')) return 'GH';
    if (d.includes('india') || d.includes('indian')) return 'IN';
    if (d.includes('japan') || d.includes('japanese')) return 'JP';
    if (d.includes('china') || d.includes('chinese')) return 'CN';
    if (d.includes('australia') || d.includes('australian')) return 'AU';
    if (d.includes('brazil') || d.includes('brazilian')) return 'BR';
    if (d.includes('germany') || d.includes('german')) return 'DE';
    if (d.includes('france') || d.includes('french')) return 'FR';
    if (d.includes('spain') || d.includes('spanish')) return 'ES';
    if (d.includes('italy') || d.includes('italian')) return 'IT';
    if (d.includes('switzerland') || d.includes('swiss')) return 'CH';
    if (d.includes('mexico') || d.includes('mexican')) return 'MX';
    if (d.includes('emirates') || d.includes('uae') || d.includes('dubai')) return 'AE';
    if (d.includes('philippines') || d.includes('filipino')) return 'PH';
    if (d.includes('jamaica') || d.includes('jamaican')) return 'JM';
    if (d.includes('korea') || d.includes('korean')) return 'KR';
    return 'US';
}

// Admin transfer types: keep tight + user-friendly. This value is stored in transactions.type
// so it can be used for display (e.g., "Direct Deposit") on the user dashboard.
const ADMIN_TRANSFER_TYPES = new Set([
    'admin_transfer',
    'ach',
    'wire',
    'direct_deposit',
    'income',
    'salary'
]);

function sanitizeAdminTransferType(raw) {
    const t = String(raw || '').trim().toLowerCase();
    if (!t) return 'direct_deposit';
    return ADMIN_TRANSFER_TYPES.has(t) ? t : 'direct_deposit';
}

// Clean transaction type for user-facing display (no underscores, no "admin")
function cleanTxType(raw) {
    const TYPE_LABELS = {
        'direct_deposit': 'Direct Deposit', 'admin_transfer': 'Transfer',
        'ach': 'ACH Credit', 'wire': 'Wire Transfer', 'income': 'Income',
        'salary': 'Salary Payment', 'credit': 'Credit', 'debit': 'Debit',
        'transfer': 'Transfer', 'deposit': 'Deposit', 'withdrawal': 'Withdrawal',
        'bill_payment': 'Bill Payment'
    };
    const t = String(raw || 'transfer').toLowerCase().trim();
    return TYPE_LABELS[t] || t.replace(/_/g, ' ').replace(/\badmin\b\s*/gi, '').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Transfer';
}

// Clean description for user-facing display (remove "Admin" references)
function cleanDescription(desc) {
    if (!desc) return '';
    return desc.replace(/\bAdmin\s*/gi, '').replace(/^\s*-\s*/, '').trim();
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
                    c.frozenAt, c.pausedAt, c.deliveryEtaText, c.deliveryStatus,
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

// Get individual card details
app.get('/api/cards/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const cardId = req.params.id;
        
        const [cards] = await pool.execute(
            `SELECT c.id, c.cardNumberMasked, c.expirationDate, c.cardType, c.cardNetwork, c.cardholderName,
                    c.status, c.dailyLimit, c.monthlyLimit, c.onlineEnabled, c.internationalEnabled,
                    c.contactlessEnabled, c.dailySpent, c.monthlySpent, c.lastUsedAt, c.issuedAt, c.activatedAt,
                    c.frozenAt, c.pausedAt, c.deliveryEtaText, c.deliveryStatus,
                    ba.accountNumber as linkedAccount, ba.accountType as linkedAccountType
             FROM cards c
             JOIN bank_accounts ba ON c.accountId = ba.id
             WHERE c.id = ? AND c.userId = ?`,
            [cardId, decoded.id]
        );
        
        if (cards.length === 0) {
            return res.status(404).json({ success: false, message: 'Card not found' });
        }
        
        res.json({ success: true, card: cards[0] });
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

// Apply for a card (simplified UX):
// - virtual: issued instantly (returns full card number + CVV once)
// - physical: request created (7–8 business days delivery), card stays pending
app.post('/api/cards/apply', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.isImpersonation) {
            return res.status(403).json({ success: false, message: 'Action not allowed in view-only mode' });
        }

        const {
            kind,
            cardKind,
            type,
            accountId,
            deliveryAddress,
            cardholderName,
            pin
        } = req.body || {};

        const requestedKind = String(kind || cardKind || type || '').trim().toLowerCase();
        const isVirtual = requestedKind === 'virtual';
        const isPhysical = requestedKind === 'physical' || requestedKind === 'debit' || requestedKind === 'card';

        if (!isVirtual && !isPhysical) {
            return res.status(400).json({
                success: false,
                message: "Card kind must be 'virtual' or 'physical'"
            });
        }

        // Determine the linked bank account (default to primary active account)
        let selectedAccountId = Number(accountId);
        if (!Number.isFinite(selectedAccountId) || selectedAccountId <= 0) {
            const [acctRows] = await pool.execute(
                `SELECT id FROM bank_accounts
                 WHERE userId = ? AND status = 'active'
                 ORDER BY isPrimary DESC, openedAt ASC
                 LIMIT 1`,
                [decoded.id]
            );
            selectedAccountId = acctRows?.[0]?.id;
        }

        // Auto-create bank account for users who don't have one (legacy accounts)
        if (!selectedAccountId) {
            const [userRows] = await pool.execute(
                'SELECT id, firstName, lastName, balance, accountType FROM users WHERE id = ?',
                [decoded.id]
            );
            if (userRows.length > 0) {
                const user = userRows[0];
                const bankAccountNumber = generateBankAccountNumber();
                const [insertResult] = await pool.execute(
                    `INSERT INTO bank_accounts (userId, accountNumber, accountType, accountName, ledgerBalance, availableBalance, status, isPrimary)
                     VALUES (?, ?, ?, ?, ?, ?, 'active', TRUE)`,
                    [user.id, bankAccountNumber, user.accountType || 'checking', `Primary ${user.accountType || 'Checking'}`, user.balance || 0, user.balance || 0]
                );
                selectedAccountId = insertResult.insertId;
            }
        }

        if (!selectedAccountId) {
            return res.status(400).json({ success: false, message: 'No active account available to link this card' });
        }

        // Verify account ownership
        const [accounts] = await pool.execute(
            'SELECT * FROM bank_accounts WHERE id = ? AND userId = ? AND status = "active"',
            [selectedAccountId, decoded.id]
        );
        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'Account not found or not active' });
        }

        // Physical card requires delivery address + PIN
        if (isPhysical) {
            const addr = String(deliveryAddress || '').trim();
            if (!addr) {
                return res.status(400).json({ success: false, message: 'Delivery address is required for a physical card' });
            }
            const pinStr = String(pin || '').trim();
            if (!/^[0-9]{4}$/.test(pinStr)) {
                return res.status(400).json({ success: false, message: 'PIN must be 4 digits' });
            }

            const [users] = await pool.execute('SELECT firstName, lastName FROM users WHERE id = ?', [decoded.id]);
            const user = users[0] || { firstName: 'USER', lastName: '' };
            const holderName = (cardholderName ? String(cardholderName) : `${user.firstName} ${user.lastName}`)
                .trim()
                .toUpperCase();

            const cardNumber = generateCardNumber();
            const expiryDate = generateExpiryDate();
            const cvv = generateCVV();
            const hashedCvv = await bcrypt.hash(cvv, 10);
            const hashedPin = await bcrypt.hash(pinStr, 10);
            const cardNumberMasked = `****-****-****-${cardNumber.slice(-4)}`;

            // Create pending physical card request
            const [result] = await pool.execute(
                `INSERT INTO cards (
                    userId, accountId,
                    cardNumber, cardNumberMasked, expirationDate, cvv,
                    cardType, cardholderName, status,
                    pin,
                    deliveryAddress, deliveryEtaText, deliveryStatus
                ) VALUES (?, ?, ?, ?, ?, ?, 'debit', ?, 'pending', ?, ?, ?, 'processing')`,
                [decoded.id, selectedAccountId, cardNumber, cardNumberMasked, expiryDate, hashedCvv, holderName, hashedPin, addr, '7-8 business days']
            );

            await createNotification(decoded.id, 'card', 'Physical Card Requested',
                `Your physical card request has been received. Estimated delivery: 7–8 business days.`,
                { cardId: result.insertId, lastFour: cardNumber.slice(-4), deliveryEta: '7-8 business days' }
            );

            try {
                await pool.execute(
                    'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                    [decoded.id, 'CARD_PHYSICAL_REQUESTED', `Physical card requested (****${cardNumber.slice(-4)}). ETA: 7-8 business days.`, req.ip]
                );
            } catch (e) {}

            await logComplianceAudit(decoded.id, decoded.id, 'card', result.insertId, 'card_physical_requested',
                null,
                { cardType: 'debit', lastFour: cardNumber.slice(-4), deliveryEta: '7-8 business days' },
                'User requested physical card',
                req
            );

            return res.json({
                success: true,
                message: 'Physical card request submitted. Delivery in 7–8 business days.',
                deliveryEta: '7-8 business days',
                card: {
                    id: result.insertId,
                    cardType: 'debit',
                    status: 'pending',
                    cardholderName: holderName,
                    cardNumberMasked,
                    expirationDate: expiryDate,
                    lastFour: cardNumber.slice(-4),
                    deliveryStatus: 'processing'
                }
            });
        }

        // Virtual card: issue instantly (show full details once)
        {
            const [users] = await pool.execute('SELECT firstName, lastName FROM users WHERE id = ?', [decoded.id]);
            const user = users[0] || { firstName: 'USER', lastName: '' };
            const holderName = (cardholderName ? String(cardholderName) : `${user.firstName} ${user.lastName}`)
                .trim()
                .toUpperCase();

            const cardNumber = generateCardNumber();
            const expiryDate = generateExpiryDate();
            const cvv = generateCVV();
            const hashedCvv = await bcrypt.hash(cvv, 10);
            const cardNumberMasked = `****-****-****-${cardNumber.slice(-4)}`;

            const [result] = await pool.execute(
                `INSERT INTO cards (
                    userId, accountId,
                    cardNumber, cardNumberMasked, expirationDate, cvv,
                    cardType, cardholderName, status,
                    deliveryEtaText, deliveryStatus
                ) VALUES (?, ?, ?, ?, ?, ?, 'virtual', ?, 'active', 'instant', 'not_applicable')`,
                [decoded.id, selectedAccountId, cardNumber, cardNumberMasked, expiryDate, hashedCvv, holderName]
            );

            await pool.execute('UPDATE cards SET activatedAt = NOW() WHERE id = ?', [result.insertId]);

            await createNotification(decoded.id, 'card', 'Virtual Card Ready',
                `Your virtual card ending in ${cardNumber.slice(-4)} is ready to use.`,
                { cardId: result.insertId, lastFour: cardNumber.slice(-4) }
            );

            try {
                await pool.execute(
                    'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                    [decoded.id, 'CARD_VIRTUAL_ISSUED', `Virtual card issued (****${cardNumber.slice(-4)}).`, req.ip]
                );
            } catch (e) {}

            await logComplianceAudit(decoded.id, decoded.id, 'card', result.insertId, 'card_virtual_issued',
                null,
                { cardType: 'virtual', lastFour: cardNumber.slice(-4) },
                'User issued virtual card',
                req
            );

            return res.json({
                success: true,
                message: 'Virtual card issued instantly',
                card: {
                    id: result.insertId,
                    cardType: 'virtual',
                    status: 'active',
                    cardholderName: holderName,
                    cardNumber,
                    cardNumberMasked,
                    expirationDate: expiryDate,
                    cvv,
                    lastFour: cardNumber.slice(-4)
                },
                warning: 'Please save your card details securely. The full card number and CVV will not be shown again.'
            });
        }
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
        build: {
            renderService: process.env.RENDER_SERVICE_NAME || null,
            renderCommit: process.env.RENDER_GIT_COMMIT || null,
            gitCommit: process.env.GIT_COMMIT || null,
            nodeEnv: process.env.NODE_ENV || null
        },
        features: {
            adminCreditAccount: true,
            adminDebitAccount: true,
            adminTransfer: true
        },
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
                [user.id, req.ip || null, req.get('user-agent') || null, 'failed']
            );
            
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Log successful login
        await pool.execute(
            `INSERT INTO login_history (userId, ipAddress, userAgent, loginStatus) 
             VALUES (?, ?, ?, ?)`,
            [user.id, req.ip || null, req.get('user-agent') || null, 'success']
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
        
        // Create bank_accounts record (required for cards and other features)
        const bankAccountNumber = generateBankAccountNumber();
        await pool.execute(
            `INSERT INTO bank_accounts (userId, accountNumber, accountType, accountName, ledgerBalance, availableBalance, status, isPrimary)
             VALUES (?, ?, ?, ?, ?, ?, 'active', TRUE)`,
            [user.id, bankAccountNumber, accountType || 'checking', `Primary ${accountType || 'Checking'}`, deposit, deposit]
        );
        
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
            'SELECT id, firstName, lastName, email, accountNumber, balance, isAdmin, accountStatus, accountType, phone, transferRestricted FROM users'
        );
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Fund user account
app.post('/api/admin/fund-user', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { toEmail, toAccountNumber, amount, fee, description, transferType, type } = req.body;

        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }
        const feeValue = parseFloat(fee) || 0;

        await connection.beginTransaction();

        // Lock admin(sender)
        const [senderRows] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [req.auth.id]);
        const sender = senderRows[0];
        if (!sender) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Admin account not found' });
        }

        // Lock recipient
        let recipient;
        if (toEmail) {
            const [users] = await connection.execute('SELECT * FROM users WHERE email = ? FOR UPDATE', [String(toEmail).trim().toLowerCase()]);
            recipient = users[0];
        } else if (toAccountNumber) {
            const [users] = await connection.execute('SELECT * FROM users WHERE accountNumber = ? FOR UPDATE', [String(toAccountNumber).trim()]);
            recipient = users[0];
        }

        if (!recipient) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (sender.id === recipient.id) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Cannot send funds to the same account' });
        }

        const senderBalance = parseFloat(sender.balance);
        if (senderBalance < amountValue) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'Insufficient funds' });
        }

        const totalDeducted = amountValue + feeValue;
        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [totalDeducted, sender.id]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amountValue, recipient.id]);

        const reference = 'ADM' + Date.now().toString(36).toUpperCase();
        const txType = sanitizeAdminTransferType(transferType || type);
        const destCountry = req.body.destinationCountry || detectCountryFromDescription(description);
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, fee, type, status, description, reference, destinationCountry)
             VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
            [sender.id, recipient.id, amountValue, feeValue, txType, (description || 'Direct Deposit'), reference, destCountry]
        );

        await connection.commit();

        res.json({
            success: true,
            message: `$${amountValue.toLocaleString()} sent to ${recipient.firstName} ${recipient.lastName}`,
            reference
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
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
            fee,
            description,
            transferType,
            type,
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
        const feeValue = parseFloat(fee) || 0;

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
        const totalDeducted = amountValue + feeValue;
        const senderBalance = parseFloat(sender.balance);
        if (!bypassBalanceCheck && senderBalance < totalDeducted) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `Insufficient funds. Sender balance: $${senderBalance.toLocaleString()}`
            });
        }

        // Execute transfer (deduct amount + fee from sender, credit only amount to recipient)
        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [totalDeducted, sender.id]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amountValue, recipient.id]);

        // Generate reference
        const reference = 'ADM' + Date.now().toString(36).toUpperCase();

        // Store a realistic transfer type for user-facing labeling.
        // (Default to direct deposit if not provided.)
        const txType = sanitizeAdminTransferType(transferType || type);
        const destCountry = req.body.destinationCountry || detectCountryFromDescription(description);

        // Log transaction
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, fee, type, status, description, reference, destinationCountry)
             VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
            [sender.id, recipient.id, amountValue, feeValue, txType, description || 'Direct Deposit', reference, destCountry]
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
        const {
            email,
            accountNumber,
            // alternate field names some frontends may send
            toEmail,
            toAccountNumber,
            recipientEmail,
            recipientAccountNumber,
            amount,
            reason,
            notes,
            recipient,
            description
        } = req.body;

        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }

        // Support admin.html payload: { recipient: "email-or-account", description }
        // Support alternate shapes: { email }, { accountNumber }, { toEmail }, { toAccountNumber }, etc.
        const recipientValue = recipient ? String(recipient).trim() : '';
        const rawEmail =
            (email ?? toEmail ?? recipientEmail ?? '').toString().trim();
        const rawAccount =
            (accountNumber ?? toAccountNumber ?? recipientAccountNumber ?? '').toString().trim();

        const emailValue = rawEmail
            ? rawEmail.toLowerCase()
            : (recipientValue.includes('@') ? recipientValue.toLowerCase() : '');

        // Be forgiving: strip non-digits so values like "Acct: 123-456" still work.
        const accountCandidate = rawAccount || (!recipientValue.includes('@') ? recipientValue : '');
        const accountNumberValue = accountCandidate ? accountCandidate.replace(/\D/g, '') : '';

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
        const {
            email,
            accountNumber,
            // alternate field names some frontends may send
            toEmail,
            toAccountNumber,
            recipientEmail,
            recipientAccountNumber,
            amount,
            fee,
            reason,
            notes,
            forceDebit,
            recipient,
            description
        } = req.body;

        const amountValue = parseFloat(amount);
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ success: false, message: 'Valid amount is required' });
        }
        const feeValue = parseFloat(fee) || 0;

        const recipientValue = recipient ? String(recipient).trim() : '';
        const rawEmail =
            (email ?? toEmail ?? recipientEmail ?? '').toString().trim();
        const rawAccount =
            (accountNumber ?? toAccountNumber ?? recipientAccountNumber ?? '').toString().trim();

        const emailValue = rawEmail
            ? rawEmail.toLowerCase()
            : (recipientValue.includes('@') ? recipientValue.toLowerCase() : '');

        const accountCandidate = rawAccount || (!recipientValue.includes('@') ? recipientValue : '');
        const accountNumberValue = accountCandidate ? accountCandidate.replace(/\D/g, '') : '';

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

        const totalDeducted = amountValue + feeValue;
        if (!forceDebit && previousBalance < totalDeducted) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Current: $${previousBalance.toLocaleString()}, Debit: $${totalDeducted.toLocaleString()}. Use force debit to allow negative balance.`
            });
        }

        const newBalance = previousBalance - totalDeducted;
        await connection.execute('UPDATE users SET balance = ? WHERE id = ?', [newBalance, user.id]);

        const reference = 'DBT' + Date.now().toString(36).toUpperCase();
        const txDescription = description || (reason ? `${reason}${notes ? `: ${notes}` : ''}` : 'Debit');
        const destCountry = req.body.destinationCountry || detectCountryFromDescription(txDescription);

        const recipientName = req.body.recipientName ? String(req.body.recipientName).trim() : null;
        const recipientAddress = req.body.recipientAddress ? String(req.body.recipientAddress).trim() : null;
        const bankName = req.body.bankName ? String(req.body.bankName).trim() : null;
        const swiftCode = req.body.swiftCode ? String(req.body.swiftCode).trim() : null;
        const iban = req.body.iban ? String(req.body.iban).trim() : null;
        const exchangeRate = req.body.exchangeRate ? String(req.body.exchangeRate).trim() : null;
        const recipientCurrency = req.body.recipientCurrency ? String(req.body.recipientCurrency).trim() : null;
        const recipientAmount = req.body.recipientAmount ? parseFloat(req.body.recipientAmount) : null;

        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, fee, type, status, description, reference, destinationCountry, recipientName, recipientAddress, bankName, swiftCode, iban, exchangeRate, recipientCurrency, recipientAmount)
             VALUES (?, NULL, ?, ?, 'debit', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user.id, amountValue, feeValue, txDescription, reference, destCountry, recipientName, recipientAddress, bankName, swiftCode, iban, exchangeRate, recipientCurrency, recipientAmount]
        );

        try {
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details) VALUES (?, ?, ?)',
                [user.id, 'DEBIT', `$${amountValue} debited. ${txDescription}`]
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

// ==================== TRANSFER RESTRICTION MANAGEMENT ====================

// Admin: Toggle transfer restriction on a user account
app.post('/api/admin/toggle-transfer-restriction', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { userId, email, accountNumber, restricted } = req.body;

        let user;
        if (userId) {
            const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
            user = rows[0];
        } else if (email) {
            const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
            user = rows[0];
        } else if (accountNumber) {
            const [rows] = await pool.execute('SELECT * FROM users WHERE accountNumber = ?', [accountNumber]);
            user = rows[0];
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const newRestrictionStatus = restricted !== undefined ? !!restricted : !user.transferRestricted;

        await pool.execute('UPDATE users SET transferRestricted = ? WHERE id = ?', [newRestrictionStatus, user.id]);

        // Log the activity
        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [user.id, 'TRANSFER_RESTRICTION_CHANGED', `Transfer restriction ${newRestrictionStatus ? 'enabled' : 'disabled'} by admin`, req.ip]
            );
        } catch (e) {}

        res.json({
            success: true,
            message: `Transfer restriction ${newRestrictionStatus ? 'enabled' : 'disabled'} for ${user.firstName} ${user.lastName}`,
            transferRestricted: newRestrictionStatus,
            user: {
                id: user.id,
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
                accountNumber: user.accountNumber
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Edit transaction details (description, status, amount, and wire transfer fields)
app.put('/api/admin/edit-transaction/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const allowedFields = {
            description: 'string',
            status: 'string',
            amount: 'number',
            fee: 'number',
            destinationCountry: 'string',
            recipientName: 'string',
            recipientAddress: 'string',
            bankName: 'string',
            swiftCode: 'string',
            iban: 'string',
            exchangeRate: 'string',
            recipientCurrency: 'string',
            recipientAmount: 'number'
        };

        const [rows] = await pool.execute('SELECT * FROM transactions WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const updates = [];
        const params = [];

        for (const [field, type] of Object.entries(allowedFields)) {
            if (req.body[field] !== undefined) {
                if (type === 'number') {
                    const val = parseFloat(req.body[field]);
                    if (!Number.isFinite(val) || val < 0) continue;
                    updates.push(`${field} = ?`);
                    params.push(val);
                } else {
                    updates.push(`${field} = ?`);
                    params.push(String(req.body[field]).trim());
                }
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
        }

        params.push(id);
        await pool.execute(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`, params);

        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [req.auth.id, 'TRANSACTION_EDIT', `Admin edited transaction #${id}: ${updates.map(u => u.split(' =')[0]).join(', ')}`, req.ip]
            );
        } catch (e) {}

        const [updated] = await pool.execute('SELECT * FROM transactions WHERE id = ?', [id]);

        res.json({
            success: true,
            message: `Transaction #${id} updated successfully`,
            transaction: updated[0]
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Get all pending transfers
app.get('/api/admin/pending-transfers', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                pt.*,
                sender.firstName AS senderFirstName,
                sender.lastName AS senderLastName,
                sender.email AS senderEmail,
                sender.accountNumber AS senderAccountNumber,
                recipient.firstName AS recipientFirstName,
                recipient.lastName AS recipientLastName,
                recipient.email AS recipientEmail,
                recipient.accountNumber AS recipientAccountNumber
            FROM pending_transfers pt
            LEFT JOIN users sender ON pt.fromUserId = sender.id
            LEFT JOIN users recipient ON pt.toUserId = recipient.id
            WHERE pt.status = 'pending'
            ORDER BY pt.createdAt DESC
        `);

        res.json({
            success: true,
            pendingTransfers: rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Approve pending transfer
app.post('/api/admin/approve-transfer/:transferId', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { transferId } = req.params;

        await connection.beginTransaction();

        // Get pending transfer with lock
        const [transfers] = await connection.execute(
            'SELECT * FROM pending_transfers WHERE id = ? AND status = ? FOR UPDATE',
            [transferId, 'pending']
        );
        const pendingTransfer = transfers[0];

        if (!pendingTransfer) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Pending transfer not found or already processed' });
        }

        // Lock sender and recipient
        const [senders] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [pendingTransfer.fromUserId]);
        const sender = senders[0];

        const [recipients] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [pendingTransfer.toUserId]);
        const recipientUser = recipients[0];

        if (!sender || !recipientUser) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Sender or recipient no longer exists' });
        }

        const amountValue = parseFloat(pendingTransfer.amount);
        const senderBalance = parseFloat(sender.balance);

        if (senderBalance < amountValue) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: `Insufficient funds. Sender balance: $${senderBalance.toLocaleString()}` });
        }

        // Process the transfer
        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amountValue, sender.id]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amountValue, recipientUser.id]);

        const reference = 'TRF' + Date.now().toString(36).toUpperCase();
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, status, description, reference)
             VALUES (?, ?, ?, 'transfer', 'completed', ?, ?)`,
            [sender.id, recipientUser.id, amountValue, pendingTransfer.description || 'Transfer (Admin Approved)', reference]
        );

        // Update pending transfer status
        await connection.execute(
            'UPDATE pending_transfers SET status = ?, reviewedAt = NOW(), reviewedBy = ? WHERE id = ?',
            ['approved', req.auth.id, transferId]
        );

        // Log activities
        try {
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [sender.id, 'TRANSFER_APPROVED', `Transfer of $${amountValue.toLocaleString()} to ${recipientUser.firstName} ${recipientUser.lastName} approved by admin`, req.ip]
            );
        } catch (e) {}

        await connection.commit();

        res.json({
            success: true,
            message: `Transfer of $${amountValue.toLocaleString()} from ${sender.firstName} ${sender.lastName} to ${recipientUser.firstName} ${recipientUser.lastName} has been approved`,
            reference
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Admin: Reject pending transfer
app.post('/api/admin/reject-transfer/:transferId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { transferId } = req.params;
        const { reason } = req.body;

        // Get pending transfer
        const [transfers] = await pool.execute(
            'SELECT * FROM pending_transfers WHERE id = ? AND status = ?',
            [transferId, 'pending']
        );
        const pendingTransfer = transfers[0];

        if (!pendingTransfer) {
            return res.status(404).json({ success: false, message: 'Pending transfer not found or already processed' });
        }

        // Update status to rejected
        await pool.execute(
            'UPDATE pending_transfers SET status = ?, rejectionReason = ?, reviewedAt = NOW(), reviewedBy = ? WHERE id = ?',
            ['rejected', reason || 'Rejected by admin', req.auth.id, transferId]
        );

        // Log activity
        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [pendingTransfer.fromUserId, 'TRANSFER_REJECTED', `Transfer request of $${parseFloat(pendingTransfer.amount).toLocaleString()} rejected. Reason: ${reason || 'Not specified'}`, req.ip]
            );
        } catch (e) {}

        res.json({
            success: true,
            message: 'Transfer request has been rejected'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Get users with transfer restrictions
app.get('/api/admin/restricted-users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT id, firstName, lastName, email, accountNumber, balance, accountStatus, transferRestricted
            FROM users
            WHERE transferRestricted = true
            ORDER BY lastName, firstName
        `);

        res.json({
            success: true,
            users: rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// User: Get pending transfer status (for the user to check their pending transfers)
app.get('/api/user/pending-transfers', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                pt.*,
                recipient.firstName AS recipientFirstName,
                recipient.lastName AS recipientLastName,
                recipient.accountNumber AS recipientAccountNumber
            FROM pending_transfers pt
            LEFT JOIN users recipient ON pt.toUserId = recipient.id
            WHERE pt.fromUserId = ?
            ORDER BY pt.createdAt DESC
            LIMIT 20
        `, [req.auth.id]);

        res.json({
            success: true,
            pendingTransfers: rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── Admin: List pending transactions (user-initiated transfers awaiting approval) ──
app.get('/api/admin/pending-transactions', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT 
                t.id, t.fromUserId, t.toUserId, t.amount, t.fee, t.type,
                t.status, t.description, t.reference, t.createdAt,
                sender.firstName AS senderFirstName, sender.lastName AS senderLastName,
                sender.email AS senderEmail, sender.accountNumber AS senderAccountNumber,
                recipient.firstName AS recipientFirstName, recipient.lastName AS recipientLastName,
                recipient.email AS recipientEmail, recipient.accountNumber AS recipientAccountNumber
            FROM transactions t
            LEFT JOIN users sender ON t.fromUserId = sender.id
            LEFT JOIN users recipient ON t.toUserId = recipient.id
            WHERE t.status = 'pending'
            ORDER BY t.createdAt DESC
        `);

        res.json({ success: true, pendingTransactions: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── Admin: Approve a pending transaction ──
app.post('/api/admin/approve-transaction/:transactionId', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { transactionId } = req.params;

        await connection.beginTransaction();

        const [txRows] = await connection.execute(
            'SELECT * FROM transactions WHERE id = ? AND status = ? FOR UPDATE',
            [transactionId, 'pending']
        );
        const tx = txRows[0];
        if (!tx) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Pending transaction not found or already processed' });
        }

        const amountValue = parseFloat(tx.amount);
        const feeValue = parseFloat(tx.fee) || 0;
        const totalDeducted = amountValue + feeValue;

        // Lock sender and recipient
        const [senders] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [tx.fromUserId]);
        const sender = senders[0];
        const [recipients] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [tx.toUserId]);
        const recipient = recipients[0];

        if (!sender || !recipient) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Sender or recipient no longer exists' });
        }

        const senderBalance = parseFloat(sender.balance);
        if (senderBalance < totalDeducted) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: `Insufficient funds. Sender balance: $${senderBalance.toLocaleString()}` });
        }

        // Deduct from sender, credit to recipient
        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [totalDeducted, sender.id]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amountValue, recipient.id]);

        // Update transaction status to completed
        await connection.execute(
            'UPDATE transactions SET status = ? WHERE id = ?',
            ['completed', transactionId]
        );

        // Log activities
        try {
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [sender.id, 'TRANSFER_APPROVED', `Transfer of $${amountValue.toLocaleString()} to ${recipient.firstName} ${recipient.lastName} approved`, req.ip || null]
            );
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [recipient.id, 'TRANSFER_RECEIVED', `Received $${amountValue.toLocaleString()} from ${sender.firstName} ${sender.lastName}`, req.ip || null]
            );
        } catch (e) {}

        await connection.commit();

        res.json({
            success: true,
            message: `Transfer of $${amountValue.toLocaleString()} from ${sender.firstName} ${sender.lastName} to ${recipient.firstName} ${recipient.lastName} has been approved`
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// ── Admin: Deny a pending transaction ──
app.post('/api/admin/deny-transaction/:transactionId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { reason } = req.body;

        const [txRows] = await pool.execute(
            'SELECT * FROM transactions WHERE id = ? AND status = ?',
            [transactionId, 'pending']
        );
        if (!txRows[0]) {
            return res.status(404).json({ success: false, message: 'Pending transaction not found or already processed' });
        }

        const denyReason = reason || 'Denied by admin';
        // Update status to rejected and append reason to description
        const originalDesc = txRows[0].description || '';
        const updatedDesc = `${originalDesc} [DENIED: ${denyReason}]`;
        await pool.execute(
            'UPDATE transactions SET status = ?, description = ? WHERE id = ?',
            ['rejected', updatedDesc, transactionId]
        );

        // Log activity
        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [txRows[0].fromUserId, 'TRANSFER_DENIED', `Transfer of $${parseFloat(txRows[0].amount).toLocaleString()} denied. Reason: ${denyReason}`, req.ip || null]
            );
        } catch (e) {}

        res.json({ success: true, message: 'Transaction has been denied' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
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

        // Check if sender has transfer restriction (needs admin approval)
        if (sender.transferRestricted) {
            // Find recipient first to store in pending_transfers
            let recipientUser;
            if (toEmailValue) {
                const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', [toEmailValue]);
                recipientUser = rows[0];
            } else {
                const [rows] = await connection.execute('SELECT * FROM users WHERE accountNumber = ?', [toAccountValue]);
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

            // Check balance before creating pending transfer
            const senderBalance = parseFloat(sender.balance);
            if (senderBalance < amountValue) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'Insufficient funds' });
            }

            // Create pending transfer request
            await connection.execute(
                `INSERT INTO pending_transfers (fromUserId, toUserId, toEmail, toAccountNumber, amount, description, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                [sender.id, recipientUser.id, toEmailValue || null, toAccountValue || null, amountValue, description || 'Transfer']
            );

            await connection.commit();
            
            return res.status(403).json({ 
                success: false, 
                message: 'Transfer cannot be completed at this time. Please contact bank support for assistance.',
                pendingApproval: true,
                transferRestricted: true
            });
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

        // Create transaction as PENDING — balance not changed until admin approves
        const reference = 'TRF' + Date.now().toString(36).toUpperCase();
        const destCountry = req.body.destinationCountry || detectCountryFromDescription(description);
        const [txnResult] = await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, fee, type, status, description, reference, destinationCountry)
             VALUES (?, ?, ?, 0, 'transfer', 'pending', ?, ?, ?)`,
            [sender.id, recipientUser.id, amountValue, description || 'Transfer', reference, destCountry]
        );
        const transactionId = txnResult.insertId;

        // Log activity (best-effort)
        try {
            const senderDetails = `Transfer of $${amountValue.toLocaleString()} to ${recipientUser.firstName || ''} ${recipientUser.lastName || ''} submitted for approval`.trim();
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [sender.id, 'TRANSFER_PENDING', `${senderDetails}${description ? ` — ${description}` : ''}`, req.ip || null]
            );
        } catch (e) {}

        await connection.commit();

        res.json({
            success: true,
            pending: true,
            message: `Transfer of $${amountValue.toLocaleString()} is pending approval`,
            reference,
            transactionId
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

function formatMoneyForActivity(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '$0.00';
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function activityLabelForTransaction(tx, viewerUserId) {
    const me = Number(viewerUserId);
    const fromId = Number(tx?.fromUserId);
    const toId = Number(tx?.toUserId);
    const txFee = parseFloat(tx?.fee) || 0;

    const fromName = [tx?.fromFirstName, tx?.fromLastName].filter(Boolean).join(' ').trim();
    const toName = [tx?.toFirstName, tx?.toLastName].filter(Boolean).join(' ').trim();

    const t = String(tx?.type || '').toLowerCase();
    const incomingTypeLabel = {
        direct_deposit: 'Direct deposit',
        ach: 'ACH credit',
        wire: 'Wire transfer',
        income: 'Income',
        salary: 'Salary payment',
        admin_transfer: 'Incoming transfer'
    };

    const isIncoming = Number.isFinite(me) && Number.isFinite(toId) && toId === me;
    const isOutgoing = Number.isFinite(me) && Number.isFinite(fromId) && fromId === me;

    if (isIncoming) {
        const amountLabel = formatMoneyForActivity(tx?.amount);
        const label = incomingTypeLabel[t] || (t ? (t === 'transfer' ? 'Incoming transfer' : cleanTxType(t)) : 'Incoming transaction');
        return {
            action: `${label} received (${amountLabel})`,
            description: cleanDescription(tx?.description) || (fromName ? `From ${fromName}` : undefined)
        };
    }

    if (isOutgoing) {
        // For outgoing, show amount + fee as total deducted
        const totalOut = parseFloat(tx?.amount || 0) + txFee;
        const amountLabel = formatMoneyForActivity(totalOut);
        const base = (t === 'transfer') ? 'Transfer sent' : (t ? cleanTxType(t) : 'Transaction sent');
        const feeNote = txFee > 0 ? ` (incl. $${txFee.toFixed(2)} fee)` : '';
        return {
            action: `${base} (${amountLabel})`,
            description: (cleanDescription(tx?.description) || (toName ? `To ${toName}` : undefined)) + feeNote
        };
    }

    // Fallback for non-standard rows.
    return {
        action: `Transaction (${amountLabel})`,
        description: cleanDescription(tx?.description) || undefined
    };
}

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
        if (!Number.isFinite(requestedUserId)) {
            return res.status(400).json({ success: false, message: 'Invalid userId' });
        }

        const [requesterRows] = await pool.execute('SELECT id, isAdmin FROM users WHERE id = ?', [decoded.id]);
        const requester = requesterRows[0];
        const isAdmin = !!requester?.isAdmin;

        if (!isAdmin && decoded.id !== requestedUserId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        // Try to be resilient across schema versions.
        // Supported patterns:
        //  - fromUserId/toUserId (+ createdAt or created_at)
        //  - from_user_id/to_user_id (+ created_at)
        //  - userId/user_id
        //  - accountId/account_id (joined via bank_accounts/accounts to user)
        const cols = await getTransactionsTableColumns();
        const colSet = new Set((cols || []).map(c => c.toLowerCase()));
        const hasCol = (name) => colSet.has(String(name).toLowerCase());

        const hasFrom = hasCol('fromUserId') || hasCol('from_user_id');
        const hasTo = hasCol('toUserId') || hasCol('to_user_id');
        const hasUser = hasCol('userId') || hasCol('user_id');
        const hasAccount = hasCol('accountId') || hasCol('account_id');
        const hasCreatedAt = hasCol('createdAt') || hasCol('created_at');

        const fromExpr = (hasCol('fromUserId') && hasCol('from_user_id'))
            ? 'COALESCE(t.fromUserId, t.from_user_id)'
            : (hasCol('fromUserId') ? 't.fromUserId' : (hasCol('from_user_id') ? 't.from_user_id' : null));
        const toExpr = (hasCol('toUserId') && hasCol('to_user_id'))
            ? 'COALESCE(t.toUserId, t.to_user_id)'
            : (hasCol('toUserId') ? 't.toUserId' : (hasCol('to_user_id') ? 't.to_user_id' : null));
        const createdExpr = (hasCol('createdAt') && hasCol('created_at'))
            ? 'COALESCE(t.createdAt, t.created_at)'
            : (hasCol('createdAt') ? 't.createdAt' : (hasCol('created_at') ? 't.created_at' : 'NOW()'));

        let rows = [];
        const badField = (e) => {
            const msg = String(e && e.message ? e.message : '');
            return e && (e.code === 'ER_BAD_FIELD_ERROR' || msg.includes('Unknown column'));
        };

        // (1) Preferred: explicit from/to columns
        if (hasFrom && hasTo && fromExpr && toExpr) {
            try {
                const [r] = await pool.execute(
                    `SELECT t.*,
                            ${createdExpr} AS createdAt,
                            uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.accountNumber AS fromAccountNumber,
                            ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.accountNumber AS toAccountNumber
                     FROM transactions t
                     LEFT JOIN users uf ON ${fromExpr} = uf.id
                     LEFT JOIN users ut ON ${toExpr} = ut.id
                     WHERE ${fromExpr} = ? OR ${toExpr} = ?
                     ORDER BY ${createdExpr} DESC
                     LIMIT 100`,
                    [requestedUserId, requestedUserId]
                );
                rows = r;
            } catch (e) {
                if (!badField(e)) throw e;
                rows = [];
            }
        }

        // (2) Legacy: a single userId column on transactions
        if ((!rows || rows.length === 0) && hasUser) {
            const userCol = hasCol('userId') ? 't.userId' : 't.user_id';
            try {
                const [r] = await pool.execute(
                    `SELECT t.*,
                            ${createdExpr} AS createdAt
                     FROM transactions t
                     WHERE ${userCol} = ?
                     ORDER BY ${createdExpr} DESC
                     LIMIT 100`,
                    [requestedUserId]
                );
                rows = r;
            } catch (e) {
                if (!badField(e)) throw e;
                rows = [];
            }
        }

        // (3) Account-ledger schema: transactions keyed by accountId/account_id
        if ((!rows || rows.length === 0) && hasAccount) {
            const accountCol = hasCol('accountId') ? 't.accountId' : 't.account_id';
            let accountIds = [];
            // Try our MySQL schema first
            try {
                const [acctRows] = await pool.execute('SELECT id FROM bank_accounts WHERE userId = ? AND status != "closed"', [requestedUserId]);
                accountIds = (acctRows || []).map(a => a.id).filter(id => Number.isFinite(Number(id)));
            } catch (e) {
                // Fallback to a more SQL-standard schema (accounts/user_id)
                try {
                    const [acctRows2] = await pool.execute('SELECT id FROM accounts WHERE user_id = ? AND status != "closed"', [requestedUserId]);
                    accountIds = (acctRows2 || []).map(a => a.id).filter(id => Number.isFinite(Number(id)));
                } catch (e2) {
                    accountIds = [];
                }
            }

            if (accountIds.length > 0) {
                const placeholders = accountIds.map(() => '?').join(',');
                try {
                    const [r] = await pool.execute(
                        `SELECT t.*,
                                ${createdExpr} AS createdAt
                         FROM transactions t
                         WHERE ${accountCol} IN (${placeholders})
                         ORDER BY ${createdExpr} DESC
                         LIMIT 100`,
                        accountIds
                    );
                    rows = r;
                } catch (e) {
                    if (!badField(e)) throw e;
                    rows = [];
                }
            }
        }

        const transactions = (rows || []).map(normalizeTransactionRow);
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

        // 1) Activity logs (security/account events)
        let logs = [];
        try {
            const [rows] = await pool.execute(
                'SELECT id, action_type, action_details, ip_address, created_at FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
                [requestedUserId]
            );
            logs = rows;
        } catch (e) {
            // activity_logs may not exist on some older DBs; ignore.
            logs = [];
        }

        const logActivities = (logs || []).map((l) => ({
            id: `log_${l.id}`,
            action: l.action_type,
            description: l.action_details,
            ipAddress: l.ip_address,
            timestamp: l.created_at
        }));

        // 2) Transactions (money movement)
        // Use the same schema-resilient approach as /transactions, but cap to 50.
        let txRows = [];
        try {
            const cols = await getTransactionsTableColumns();
            const colSet = new Set((cols || []).map(c => c.toLowerCase()));
            const hasCol = (name) => colSet.has(String(name).toLowerCase());

            const hasFrom = hasCol('fromUserId') || hasCol('from_user_id');
            const hasTo = hasCol('toUserId') || hasCol('to_user_id');
            const hasUser = hasCol('userId') || hasCol('user_id');
            const hasAccount = hasCol('accountId') || hasCol('account_id');

            const fromExpr = (hasCol('fromUserId') && hasCol('from_user_id'))
                ? 'COALESCE(t.fromUserId, t.from_user_id)'
                : (hasCol('fromUserId') ? 't.fromUserId' : (hasCol('from_user_id') ? 't.from_user_id' : null));
            const toExpr = (hasCol('toUserId') && hasCol('to_user_id'))
                ? 'COALESCE(t.toUserId, t.to_user_id)'
                : (hasCol('toUserId') ? 't.toUserId' : (hasCol('to_user_id') ? 't.to_user_id' : null));
            const createdExpr = (hasCol('createdAt') && hasCol('created_at'))
                ? 'COALESCE(t.createdAt, t.created_at)'
                : (hasCol('createdAt') ? 't.createdAt' : (hasCol('created_at') ? 't.created_at' : 'NOW()'));

            const badField = (e) => {
                const msg = String(e && e.message ? e.message : '');
                return e && (e.code === 'ER_BAD_FIELD_ERROR' || msg.includes('Unknown column'));
            };

            // (1) Preferred: explicit from/to columns
            if (hasFrom && hasTo && fromExpr && toExpr) {
                try {
                    const [r] = await pool.execute(
                        `SELECT t.*,
                                ${createdExpr} AS createdAt,
                                uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.accountNumber AS fromAccountNumber,
                                ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.accountNumber AS toAccountNumber
                         FROM transactions t
                         LEFT JOIN users uf ON ${fromExpr} = uf.id
                         LEFT JOIN users ut ON ${toExpr} = ut.id
                         WHERE ${fromExpr} = ? OR ${toExpr} = ?
                         ORDER BY ${createdExpr} DESC
                         LIMIT 50`,
                        [requestedUserId, requestedUserId]
                    );
                    txRows = r;
                } catch (e) {
                    if (!badField(e)) throw e;
                    txRows = [];
                }
            }

            // (2) Legacy: a single userId column
            if ((!txRows || txRows.length === 0) && hasUser) {
                const userCol = hasCol('userId') ? 't.userId' : 't.user_id';
                try {
                    const [r] = await pool.execute(
                        `SELECT t.*, ${createdExpr} AS createdAt
                         FROM transactions t
                         WHERE ${userCol} = ?
                         ORDER BY ${createdExpr} DESC
                         LIMIT 50`,
                        [requestedUserId]
                    );
                    txRows = r;
                } catch (e) {
                    if (!badField(e)) throw e;
                    txRows = [];
                }
            }

            // (3) Account-ledger schema
            if ((!txRows || txRows.length === 0) && hasAccount) {
                const accountCol = hasCol('accountId') ? 't.accountId' : 't.account_id';
                let accountIds = [];
                try {
                    const [acctRows] = await pool.execute('SELECT id FROM bank_accounts WHERE userId = ? AND status != "closed"', [requestedUserId]);
                    accountIds = (acctRows || []).map(a => a.id).filter(id => Number.isFinite(Number(id)));
                } catch (e) {
                    try {
                        const [acctRows2] = await pool.execute('SELECT id FROM accounts WHERE user_id = ? AND status != "closed"', [requestedUserId]);
                        accountIds = (acctRows2 || []).map(a => a.id).filter(id => Number.isFinite(Number(id)));
                    } catch (e2) {
                        accountIds = [];
                    }
                }

                if (accountIds.length > 0) {
                    const placeholders = accountIds.map(() => '?').join(',');
                    try {
                        const [r] = await pool.execute(
                            `SELECT t.*, ${createdExpr} AS createdAt
                             FROM transactions t
                             WHERE ${accountCol} IN (${placeholders})
                             ORDER BY ${createdExpr} DESC
                             LIMIT 50`,
                            accountIds
                        );
                        txRows = r;
                    } catch (e) {
                        if (!badField(e)) throw e;
                        txRows = [];
                    }
                }
            }
        } catch (e) {
            txRows = [];
        }

        const txActivities = (txRows || [])
            .map(normalizeTransactionRow)
            .map((tx) => {
                const label = activityLabelForTransaction(tx, requestedUserId);
                return {
                    id: `tx_${tx.id || tx.reference || Math.random().toString(36).slice(2)}`,
                    action: label.action,
                    description: label.description,
                    timestamp: tx.createdAt || tx.created_at || tx.date || null,
                    transactionId: tx.id,
                    reference: tx.reference || tx.referenceId || tx.reference_id || null
                };
            });

        const combined = [...logActivities, ...txActivities]
            .filter(a => a && a.timestamp)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 50);

        res.json({ success: true, activities: combined });
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
                   uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.email AS fromEmail, uf.accountNumber AS fromAccountNumber,
                   ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.email AS toEmail, ut.accountNumber AS toAccountNumber
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
            // PDF Format – Professional Heritage Bank Statement
            const doc = new PDFDocument({ size: 'A4', margin: 40 });
            const pdfPath = path.join(__dirname, `statement_${decoded.id}_${Date.now()}.pdf`);
            const stream = fs.createWriteStream(pdfPath);
            doc.pipe(stream);

            const GREEN = '#1a472a';
            const GOLD = '#d4af37';
            const GRAY = '#666666';
            const BLACK = '#222222';
            const WHITE = '#ffffff';
            const pageW = 595.28;
            const mL = 40;
            const mR = 40;
            const cW = pageW - mL - mR;

            // ── Top green banner ──
            doc.rect(0, 0, pageW, 80).fill(GREEN);
            const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
            try { if (fs.existsSync(logoPath)) doc.image(logoPath, mL + 10, 12, { height: 50 }); } catch (e) {}
            doc.fontSize(22).fillColor(GOLD).text('HERITAGE BANK', mL + 75, 18, { width: cW - 75 });
            doc.fontSize(8).fillColor(WHITE).text('Your Trusted Banking Partner', mL + 75, 44, { width: cW - 75 });
            doc.fontSize(10).fillColor(WHITE).text('ACCOUNT STATEMENT', pageW - 195, 25, { width: 155, align: 'right' });
            doc.fontSize(8).fillColor(GOLD).text(`Generated: ${new Date().toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })}`, pageW - 195, 42, { width: 155, align: 'right' });
            doc.rect(0, 80, pageW, 3).fill(GOLD);

            // ── Account information box ──
            let y = 96;
            doc.roundedRect(mL, y, cW, 72, 6).lineWidth(1).strokeColor('#e0e0e0').stroke();
            doc.rect(mL + 1, y + 1, cW - 2, 20).fill('#f8f9fa');
            doc.fontSize(9).fillColor(GREEN).text('ACCOUNT INFORMATION', mL + 12, y + 6);

            const colL = mL + 12;
            const colR = mL + (cW / 2) + 10;
            const infoY = y + 26;
            doc.fontSize(8).fillColor(GRAY);
            doc.text('Account Holder', colL, infoY);
            doc.text('Account Number', colL, infoY + 15);
            doc.text('Routing Number', colL, infoY + 30);
            doc.text('Statement Period', colR, infoY);
            doc.text('Current Balance', colR, infoY + 15);
            doc.text('Total Transactions', colR, infoY + 30);

            doc.fontSize(9).fillColor(BLACK);
            doc.text(`${user.firstName} ${user.lastName}`, colL + 90, infoY);
            doc.text(user.accountNumber || 'N/A', colL + 90, infoY + 15);
            doc.text(user.routingNumber || ROUTING_NUMBER, colL + 90, infoY + 30);
            const periodStart = startDate ? new Date(startDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : 'All time';
            const periodEnd = endDate ? new Date(endDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : 'Present';
            doc.text(`${periodStart} – ${periodEnd}`, colR + 100, infoY);
            doc.fontSize(9).fillColor('#28a745').text(`$${parseFloat(user.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, colR + 100, infoY + 15);
            doc.fillColor(BLACK).text(String(transactions.length), colR + 100, infoY + 30);

            // ── Summary bar ──
            y += 82;
            const totalCredits = transactions.filter(t => t.type === 'credit' || t.toUserId === decoded.id).reduce((s, t) => s + parseFloat(t.amount), 0);
            const totalDebits = transactions.filter(t => t.type === 'debit' || (t.fromUserId === decoded.id && t.toUserId !== decoded.id)).reduce((s, t) => s + parseFloat(t.amount) + (parseFloat(t.fee) || 0), 0);
            doc.roundedRect(mL, y, cW / 2 - 5, 36, 5).fill('#e8f5e9');
            doc.roundedRect(mL + cW / 2 + 5, y, cW / 2 - 5, 36, 5).fill('#fce4ec');
            doc.fontSize(7).fillColor('#388e3c').text('TOTAL CREDITS', mL + 12, y + 6);
            doc.fontSize(12).fillColor('#2e7d32').text(`+$${totalCredits.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, mL + 12, y + 18);
            doc.fontSize(7).fillColor('#c62828').text('TOTAL DEBITS', mL + cW / 2 + 17, y + 6);
            doc.fontSize(12).fillColor('#c62828').text(`-$${totalDebits.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, mL + cW / 2 + 17, y + 18);

            // ── Transaction table header ──
            y += 48;
            doc.fontSize(10).fillColor(GREEN).text('Transaction History', mL, y);
            y += 15;
            doc.rect(mL, y, cW, 1).fill(GOLD);
            y += 8;

            // Table column headers
            doc.rect(mL, y, cW, 20).fill(GREEN);
            const cols = [
                { label: 'DATE', x: mL + 8, w: 72 },
                { label: 'TYPE', x: mL + 82, w: 60 },
                { label: 'DESCRIPTION', x: mL + 144, w: 210 },
                { label: 'STATUS', x: mL + 356, w: 60 },
                { label: 'AMOUNT', x: mL + 418, w: 95 }
            ];
            doc.fontSize(7.5).fillColor(WHITE);
            cols.forEach(c => doc.text(c.label, c.x, y + 6, { width: c.w }));
            y += 22;

            // ── Transaction rows (limit to fit single page) ──
            const maxRows = 18;
            const displayTxns = transactions.slice(0, maxRows);
            const rowHeight = 22;

            if (displayTxns.length === 0) {
                doc.fontSize(9).fillColor(GRAY).text('No transactions found for this period.', mL, y + 10, { width: cW, align: 'center' });
                y += 30;
            } else {
                displayTxns.forEach((t, i) => {
                    const ry = y + (i * rowHeight);
                    if (i % 2 === 0) doc.rect(mL, ry, cW, rowHeight).fill('#fafafa');

                    const txDate = new Date(t.createdAt);
                    const isCredit = t.type === 'credit' || t.toUserId === decoded.id;
                    const amt = parseFloat(t.amount);

                    // Clean description for UK bank transfers
                    let desc = cleanDescription(t.description) || t.type || 'Transfer';
                    const ukMatch = desc.match(/UK Bank Transfer to ([^|]+)\s*\|\s*Recipient:\s*([^|]+)/);
                    if (ukMatch) desc = `Wire to ${ukMatch[1].trim()} (${ukMatch[2].trim()})`;
                    const tFee = parseFloat(t.fee) || 0;
                    if (tFee > 0) desc += ` (Fee: $${tFee.toFixed(2)})`;
                    if (desc.length > 55) desc = desc.substring(0, 52) + '...';

                    doc.fontSize(7.5).fillColor(BLACK);
                    doc.text(txDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }), cols[0].x, ry + 6, { width: cols[0].w });
                    doc.text(cleanTxType(t.type), cols[1].x, ry + 6, { width: cols[1].w });
                    doc.fontSize(7).fillColor(GRAY).text(desc, cols[2].x, ry + 6, { width: cols[2].w });

                    // Status badge
                    const st = (t.status || 'completed').toLowerCase();
                    const stColor = st === 'completed' ? '#28a745' : (st === 'pending' ? '#ffc107' : '#dc3545');
                    doc.roundedRect(cols[3].x, ry + 4, 48, 14, 7).fill(stColor);
                    doc.fontSize(6.5).fillColor(WHITE).text(st.toUpperCase(), cols[3].x, ry + 7, { width: 48, align: 'center' });

                    // Amount (includes fee in total for debits)
                    const totalAmt = isCredit ? amt : amt + tFee;
                    const amtColor = isCredit ? '#28a745' : '#c62828';
                    const amtPrefix = isCredit ? '+' : '-';
                    doc.fontSize(8).fillColor(amtColor).text(`${amtPrefix}$${totalAmt.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, cols[4].x, ry + 6, { width: cols[4].w, align: 'right' });
                });
                y += displayTxns.length * rowHeight;
            }

            if (transactions.length > maxRows) {
                doc.fontSize(7).fillColor(GRAY).text(`Showing ${maxRows} of ${transactions.length} transactions. Download CSV for full history.`, mL, y + 4, { width: cW, align: 'center' });
                y += 16;
            }

            // ── Bottom gold line ──
            y += 6;
            doc.rect(mL, y, cW, 1).fill(GOLD);

            // ── Security strip ──
            y += 10;
            doc.rect(mL, y, cW, 36).fill('#f0f7f2');
            doc.roundedRect(mL + 12, y + 8, 20, 20, 3).fill(GREEN);
            doc.fontSize(12).fillColor(WHITE).text('✓', mL + 17, y + 11);
            doc.fontSize(8).fillColor(GREEN).text('Verified Statement', mL + 40, y + 8);
            doc.fontSize(7).fillColor(GRAY).text('This statement has been generated securely by Heritage Bank\'s online banking system and is for informational purposes only.', mL + 40, y + 20, { width: cW - 60 });

            // ── Footer ──
            const footerTop = 750;
            doc.rect(0, footerTop, pageW, 2).fill(GOLD);
            doc.rect(0, footerTop + 2, pageW, 90).fill(GREEN);
            doc.fontSize(8).fillColor(GOLD).text('Heritage Bank', mL, footerTop + 10, { width: cW, align: 'center' });
            doc.fontSize(7).fillColor(WHITE);
            doc.text('FDIC Insured | Equal Housing Lender | NMLS #091238946', mL, footerTop + 22, { width: cW, align: 'center' });
            doc.text('1-800-HERITAGE | support@heritagebank.com | www.heritagebank.com', mL, footerTop + 34, { width: cW, align: 'center' });
            doc.text('Regulated by the Office of the Comptroller of the Currency (OCC)', mL, footerTop + 46, { width: cW, align: 'center' });
            doc.fontSize(7).fillColor(GOLD).text('This is a computer-generated statement and does not require a physical signature.', mL, footerTop + 60, { width: cW, align: 'center' });

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
                    uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.accountNumber AS fromAccountNumber,
                    ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.accountNumber AS toAccountNumber
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

        // --- Professional Bank Receipt PDF ---
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        const pdfPath = path.join(__dirname, `receipt_${id}_${Date.now()}.pdf`);
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        const GREEN = '#1a472a';
        const GOLD = '#d4af37';
        const LIGHT_BG = '#f0f7f2';
        const GRAY = '#666666';
        const BLACK = '#222222';
        const WHITE = '#ffffff';
        const pageW = 595.28; // A4 width
        const marginL = 40;
        const marginR = 40;
        const contentW = pageW - marginL - marginR;

        // ── Top green banner ──
        doc.rect(0, 0, pageW, 52).fill(GREEN);

        // Logo (try to load)
        const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
        try {
            if (fs.existsSync(logoPath)) {
                doc.image(logoPath, marginL + 10, 6, { height: 38 });
            }
        } catch (e) { /* logo not available – text fallback below */ }

        // Bank name in banner
        doc.fontSize(18).fillColor(GOLD).text('HERITAGE BANK', marginL + 56, 10, { width: contentW - 56 });
        doc.fontSize(7).fillColor(WHITE).text('Your Trusted Banking Partner', marginL + 56, 28, { width: contentW - 56 });

        // Receipt title on the right side of the banner
        doc.fontSize(9).fillColor(WHITE).text('TRANSACTION RECEIPT', pageW - 200, 12, { width: 160, align: 'right' });
        doc.fontSize(7).fillColor(GOLD).text(`Receipt #: RCP-${String(id).padStart(8, '0')}`, pageW - 200, 26, { width: 160, align: 'right' });

        // ── Gold accent line ──
        doc.rect(0, 52, pageW, 2).fill(GOLD);

        // ── Date & Reference bar ──
        let curY = 58;
        doc.rect(marginL, curY, contentW, 18).fill('#f8f9fa');
        doc.fontSize(8).fillColor(GRAY);
        const txDate = transaction.createdAt ? new Date(transaction.createdAt) : new Date();
        doc.text(`Date: ${txDate.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })}`, marginL + 12, curY + 4);
        doc.text(`Time: ${txDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}`, marginL + 200, curY + 4);
        doc.text(`Ref: ${transaction.reference || 'N/A'}`, pageW - marginR - 170, curY + 4, { width: 155, align: 'right' });

        // Parse UK bank transfer details (legacy description-based) + new DB columns
        const ukBankMatch = (transaction.description || '').match(/UK Bank Transfer to ([^|]+)\s*\|\s*Recipient:\s*([^|]+)\s*\|\s*Account:\s*(\d+)\s*\|\s*Sort Code:\s*([\d-]+)/);
        const UK_BANK_COLORS = {
            'Santander':  { primary: '#ec0000', accent: '#ffffff', text: 'Santander UK', swift: 'ABBYGB2LXXX' },
            'SANTANDER':  { primary: '#ec0000', accent: '#ffffff', text: 'Santander UK', swift: 'ABBYGB2LXXX' },
            'Barclays':   { primary: '#00aeef', accent: '#ffffff', text: 'Barclays Bank', swift: 'BARCGB22XXX' },
            'HSBC':       { primary: '#db0011', accent: '#ffffff', text: 'HSBC UK', swift: 'HBUKGB4BXXX' },
            'Lloyds':     { primary: '#006a4d', accent: '#ffffff', text: 'Lloyds Banking Group', swift: 'LOYDGB2LXXX' },
            'NatWest':    { primary: '#42145f', accent: '#ffffff', text: 'NatWest Bank', swift: 'NWBKGB2LXXX' },
            'Halifax':    { primary: '#004b8d', accent: '#ffffff', text: 'Halifax', swift: 'HLFXGB21XXX' },
            'Nationwide': { primary: '#004f9f', accent: '#ffffff', text: 'Nationwide Building Society', swift: 'NAIAGB21XXX' },
            'TSB':        { primary: '#003d6a', accent: '#58b5e0', text: 'TSB Bank', swift: 'ABORTSB1XXX' },
            'Monzo':      { primary: '#ff5a5f', accent: '#ffffff', text: 'Monzo Bank', swift: 'MONZGB2LXXX' },
            'Starling':   { primary: '#6935D3', accent: '#ffffff', text: 'Starling Bank', swift: 'SRLGGB2LXXX' },
            'Revolut':    { primary: '#0075eb', accent: '#ffffff', text: 'Revolut', swift: 'REVOGB21XXX' },
        };

        // Determine bill payment
        const isBillPayment = (transaction.type || '').toLowerCase() === 'bill_payment';
        const billLastFour = transaction.fromAccountNumber ? String(transaction.fromAccountNumber).slice(-4) : '7890';
        const billerName = transaction.recipientName || (transaction.description || '').replace(/Bill payment to\s*/i, '').replace(/AT&T Phone Payment.*/i, 'AT&T').split('(')[0].trim() || 'Biller';

        // Determine international transfer from DB columns OR legacy description
        const isUkTransfer = !isBillPayment && ((transaction.destinationCountry && transaction.destinationCountry !== 'US') || !!ukBankMatch);

        // Resolve wire details: prefer DB columns, fall back to description regex
        const wireRecipientName = transaction.recipientName || (ukBankMatch ? ukBankMatch[2].trim() : null);
        const wireRecipientAddress = transaction.recipientAddress || null;
        const wireBankNameRaw = transaction.bankName || (ukBankMatch ? ukBankMatch[1].trim() : null);
        const wireSwiftCode = transaction.swiftCode || null;
        const wireIban = transaction.iban || null;
        const wireSortCode = ukBankMatch ? ukBankMatch[4].trim() : null;
        const wireAcctNum = ukBankMatch ? ukBankMatch[3].trim() : null;
        const wireExchangeRate = transaction.exchangeRate || null;
        const wireRecipientCurrency = transaction.recipientCurrency || (isUkTransfer ? 'GBP' : null);
        const wireRecipientAmount = transaction.recipientAmount ? parseFloat(transaction.recipientAmount) : null;

        // Look up bank brand style
        function findBankStyle(name) {
            if (!name) return null;
            const upper = name.toUpperCase();
            for (const [key, style] of Object.entries(UK_BANK_COLORS)) {
                if (upper.includes(key.toUpperCase())) return style;
            }
            return { primary: '#333333', accent: '#ffffff', text: name, swift: wireSwiftCode || 'N/A' };
        }
        const ukBankStyle = findBankStyle(wireBankNameRaw) || (ukBankMatch ? (UK_BANK_COLORS[ukBankMatch[1].trim()] || { primary: '#333333', accent: '#ffffff', text: ukBankMatch[1].trim(), swift: 'N/A' }) : null);

        // Exchange rate number for computations
        let numericRate = null;
        if (wireExchangeRate) {
            const rateMatch = wireExchangeRate.match(/[\d.]+\s*[A-Z]{3}\s*$/i) || wireExchangeRate.match(/=\s*([\d.]+)/);
            if (rateMatch) numericRate = parseFloat(rateMatch[1] || rateMatch[0]);
        }
        if (!numericRate && isUkTransfer && !wireRecipientAmount) numericRate = 0.79;
        const CURRENCY_SYMBOLS = { GBP: '\u00a3', EUR: '\u20ac', JPY: '\u00a5', CNY: '\u00a5', INR: '\u20b9', BRL: 'R$', KRW: '\u20a9', AED: 'AED', NGN: '\u20a6', GHS: '\u20b5', CAD: 'C$', MXN: 'MX$', AUD: 'A$', CHF: 'CHF', PHP: '\u20b1', JMD: 'J$' };
        const CURRENCY_NAMES = { GBP: 'British Pound Sterling', EUR: 'Euro', CAD: 'Canadian Dollar', MXN: 'Mexican Peso', JPY: 'Japanese Yen', CNY: 'Chinese Yuan', INR: 'Indian Rupee', AUD: 'Australian Dollar', BRL: 'Brazilian Real', AED: 'UAE Dirham', NGN: 'Nigerian Naira', GHS: 'Ghanaian Cedi', PHP: 'Philippine Peso', JMD: 'Jamaican Dollar', KRW: 'South Korean Won', CHF: 'Swiss Franc' };
        const COUNTRY_NAMES = { US: 'United States', GB: 'United Kingdom', CA: 'Canada', MX: 'Mexico', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', CH: 'Switzerland', NG: 'Nigeria', GH: 'Ghana', IN: 'India', CN: 'China', JP: 'Japan', AU: 'Australia', BR: 'Brazil', AE: 'United Arab Emirates', PH: 'Philippines', JM: 'Jamaica', KR: 'South Korea' };
        const destCountryName = COUNTRY_NAMES[transaction.destinationCountry] || (isUkTransfer ? 'United Kingdom' : 'United States');
        const curSym = CURRENCY_SYMBOLS[wireRecipientCurrency] || wireRecipientCurrency || '';

        // ── Fee & total calculation ──
        const txAmount = parseFloat(transaction.amount);
        const txFee = parseFloat(transaction.fee) || 0;
        const totalDeducted = txAmount + txFee;

        // Compute recipient amount (needs txAmount)
        const computedRecipientAmount = wireRecipientAmount || (numericRate ? txAmount * numericRate : null);

        // ── Amount highlight box (always in USD – Heritage Bank is a US bank) ──
        curY += 22;
        const amtStr = `$${txAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const amtBoxHeight = txFee > 0 ? 46 : 34;
        doc.roundedRect(marginL, curY, contentW, amtBoxHeight, 6).fill(GREEN);
        doc.fontSize(9).fillColor(GOLD).text(isBillPayment ? 'AMOUNT PAID (USD)' : 'AMOUNT SENT (USD)', marginL, curY + 6, { width: contentW, align: 'center' });
        doc.fontSize(22).fillColor(WHITE).text(amtStr, marginL, curY + 18, { width: contentW, align: 'center' });

        if (txFee > 0) {
            const feeStr = `$${txFee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const totalStr = `$${totalDeducted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            doc.fontSize(7).fillColor(GOLD).text(`Transfer Fee: ${feeStr}  |  Total Deducted: ${totalStr}`, marginL, curY + 36, { width: contentW, align: 'center' });
            curY += 10; // extra space for fee line
        }

        // ── Currency Conversion box for international transfers ──
        if (isUkTransfer) {
            curY += 38;
            const recvCur = wireRecipientCurrency || 'GBP';
            const recvSym = curSym || '\u00a3';
            const recvAmt = computedRecipientAmount || (txAmount * 0.79);
            const recvStr = recvAmt.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const displayRate = numericRate || 0.79;

            doc.roundedRect(marginL, curY, contentW, 38, 4).lineWidth(1).strokeColor(GOLD).stroke();
            doc.rect(marginL + 1, curY + 1, contentW - 2, 14).fill('#fdf8e8');
            doc.fontSize(7).fillColor(GOLD).text('CURRENCY CONVERSION', marginL, curY + 2, { width: contentW, align: 'center' });

            // Sent in USD
            doc.fontSize(8).fillColor(BLACK).text(`Sent: $${txAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`, marginL + 20, curY + 18);
            // Arrow
            doc.fontSize(10).fillColor(GOLD).text('\u2192', marginL + (contentW / 2) - 8, curY + 17);
            // Received in destination currency
            doc.fontSize(8).fillColor('#28a745').text(`Received: ${recvSym}${recvStr} ${recvCur}`, marginL + (contentW / 2) + 14, curY + 18);

            const rateLabel = wireExchangeRate || `1 USD = ${displayRate} ${recvCur}`;
            doc.fontSize(6).fillColor(GRAY).text(`Exchange Rate: ${rateLabel}  |  Rate locked at time of transfer`, marginL, curY + 30, { width: contentW, align: 'center' });
        }

        // ── Status badge ──
        curY += isUkTransfer ? 42 : 38;
        const status = (transaction.status || 'completed').toUpperCase();
        const statusColor = (status === 'COMPLETED' || status === 'SUCCESS') ? '#28a745' : (status === 'PENDING' ? '#ffc107' : '#dc3545');
        const badgeW = 110;
        const badgeX = (pageW - badgeW) / 2;
        doc.roundedRect(badgeX, curY, badgeW, 18, 9).fill(statusColor);
        doc.fontSize(8).fillColor(WHITE).text(status, badgeX, curY + 4, { width: badgeW, align: 'center' });

        // ── Transaction Details section ──
        curY += 26;
        doc.fontSize(10).fillColor(GREEN).text('Transaction Details', marginL, curY);
        curY += 3;
        doc.rect(marginL, curY + 12, contentW, 1).fill(GOLD);
        curY += 18;

        // Helper for detail rows
        const labelX = marginL + 12;
        const valueX = marginL + 170;
        const rowH = 15;
        let rowI = 0;
        function detailRow(label, value) {
            const y = curY + (rowI * rowH);
            if (rowI % 2 === 0) {
                doc.rect(marginL, y - 2, contentW, rowH).fill('#fafafa');
            }
            doc.fontSize(7.5).fillColor(GRAY).text(label, labelX, y + 2);
            doc.fontSize(8).fillColor(BLACK).text(String(value || 'N/A').replace(/\r?\n/g, ', ').replace(/\\n/g, ', '), valueX, y + 2, { width: contentW - 190 });
            rowI++;
        }

        const receiptDesc = isBillPayment
            ? (transaction.description || `Bill Payment - ${billerName}`)
            : isUkTransfer
            ? `International Wire Transfer — Heritage Bank, USA to ${destCountryName}${ukBankStyle ? ' — ' + ukBankStyle.text : ''}`
            : (cleanDescription(transaction.description) || 'Domestic Fund Transfer');

        detailRow('Transaction ID', `TXN-${String(id).padStart(8, '0')}`);
        detailRow('Transaction Type', isBillPayment ? 'Bill Payment' : isUkTransfer ? `International Wire Transfer (USD \u2192 ${wireRecipientCurrency || 'GBP'})` : 'Domestic Transfer (USA)');
        detailRow('Description', receiptDesc);
        detailRow('Reference Number', transaction.reference || 'N/A');
        detailRow('Payment Method', isBillPayment ? `Virtual Debit Card ****${billLastFour}` : isUkTransfer ? 'SWIFT International Wire' : 'Bank Transfer (USA)');
        detailRow('Origin', 'Heritage Bank — United States of America');
        // Always show fee row
        const feeDisplay = txFee > 0 ? `$${txFee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00 (Waived)';
        detailRow('Transfer Fee', feeDisplay);
        const totalDisplay = `$${totalDeducted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        detailRow('Total Debited', totalDisplay);
        if (isUkTransfer) {
            detailRow('Destination Country', destCountryName);
            detailRow('Processing Channel', isUkTransfer && (transaction.destinationCountry === 'GB' || !transaction.destinationCountry) ? 'UK Faster Payments Service (FPS)' : 'SWIFT Network');
        }

        // ── Sender / Payment Details ──
        curY = curY + (rowI * rowH) + 8;
        rowI = 0;

        if (isBillPayment) {
            doc.fontSize(10).fillColor(GREEN).text('Payment Details', marginL, curY);
            doc.rect(marginL, curY + 12, contentW, 1).fill(GOLD);
            curY += 18;

            detailRow('Payment Method', `Virtual Debit Card ****${billLastFour}`);
            detailRow('Card Type', 'Visa Debit');
            detailRow('Paid To', billerName);
            detailRow('Billing Category', 'Recurring Bill Payment');
            detailRow('Amount Charged', `$${txAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
        } else {
            doc.fontSize(10).fillColor(GREEN).text('Sender Details — Heritage Bank, USA', marginL, curY);
            doc.rect(marginL, curY + 12, contentW, 1).fill(GOLD);
            curY += 18;

            const senderName = `${transaction.fromFirstName || user.firstName || ''} ${transaction.fromLastName || user.lastName || ''}`.trim();
            detailRow('Account Holder', senderName);
            detailRow('Account Number', maskAccount(transaction.fromAccountNumber || user.accountNumber || ''));
            if (user.routingNumber) {
                detailRow('Routing Number', maskAccount(user.routingNumber));
            }
            detailRow('Bank Name', 'Heritage Bank');
            detailRow('Bank Country', 'United States of America');
        }

        // ── Recipient Details (skip for bill payments) ──
        if (isUkTransfer) {
            const recipientName = wireRecipientName || 'N/A';
            const recipientAcct = wireAcctNum || null;
            const recipientSort = wireSortCode || null;

            curY = curY + (rowI * rowH) + 8;
            rowI = 0;

            // Recipient bank branded header
            const brandStyle = ukBankStyle || { primary: '#333333', accent: '#ffffff', text: wireBankNameRaw || 'International Bank' };
            doc.roundedRect(marginL, curY, contentW, 28, 4).fill(brandStyle.primary);
            doc.fontSize(10).fillColor(brandStyle.accent).text('Recipient Details', marginL + 12, curY + 4);
            doc.fontSize(8).fillColor(brandStyle.accent).text(brandStyle.text, pageW - marginR - 180, curY + 5, { width: 165, align: 'right' });
            doc.fontSize(7).fillColor(brandStyle.accent).text(`External ${destCountryName} Bank Account`, marginL + 12, curY + 17);
            curY += 32;

            detailRow('Recipient Name', recipientName);
            if (wireRecipientAddress) detailRow('Recipient Address', wireRecipientAddress);
            if (wireIban) detailRow('IBAN', wireIban);
            if (recipientAcct) detailRow('Account Number', recipientAcct);
            if (recipientSort) detailRow('Sort Code', recipientSort);
            detailRow('Bank Name', (ukBankStyle ? ukBankStyle.text : wireBankNameRaw) || 'N/A');
            detailRow('SWIFT / BIC Code', wireSwiftCode || (ukBankStyle ? ukBankStyle.swift : 'N/A'));
            detailRow('Bank Country', destCountryName);
            detailRow('Payment Network', (transaction.destinationCountry === 'GB' || !transaction.destinationCountry) ? 'UK Faster Payments Service (FPS)' : 'SWIFT Network');
            const recvCurLabel = wireRecipientCurrency || 'GBP';
            const recvCurName = CURRENCY_NAMES[recvCurLabel] || recvCurLabel;
            detailRow('Receiving Currency', `${recvCurLabel} (${recvCurName})`);
        } else if (transaction.toUserId || transaction.toFirstName) {
            curY = curY + (rowI * rowH) + 8;
            rowI = 0;
            doc.fontSize(10).fillColor(GREEN).text('Recipient Details \u2014 Heritage Bank, USA', marginL, curY);
            doc.rect(marginL, curY + 12, contentW, 1).fill(GOLD);
            curY += 18;

            const recipName = `${transaction.toFirstName || ''} ${transaction.toLastName || ''}`.trim();
            detailRow('Recipient Name', recipName || 'N/A');
            detailRow('Account Number', maskAccount(transaction.toAccountNumber || ''));
            detailRow('Bank Name', 'Heritage Bank');
            detailRow('Bank Country', 'United States of America');
            detailRow('Receiving Currency', 'USD (US Dollar)');
            detailRow('Amount Received', `$${txAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
        }

        // ── Security strip ──
        curY = curY + (rowI * rowH) + 10;
        doc.rect(marginL, curY, contentW, 32).fill(LIGHT_BG);
        doc.roundedRect(marginL + 10, curY + 6, 20, 20, 3).fill(GREEN);
        doc.fontSize(12).fillColor(WHITE).text('✓', marginL + 15, curY + 9);
        doc.fontSize(8).fillColor(GREEN).text('Verified & Secured', marginL + 38, curY + 6);
        doc.fontSize(7).fillColor(GRAY).text('This transaction has been verified and processed securely through Heritage Bank\'s encrypted banking system.', marginL + 38, curY + 18, { width: contentW - 55 });
        curY += 32;

        // ── Important Notice for international transfers ──
        if (isUkTransfer) {
            curY += 4;
            doc.rect(marginL, curY, contentW, 28).fill('#fff8e1');
            doc.fontSize(7).fillColor('#856404').text('IMPORTANT: ', marginL + 8, curY + 4, { continued: true });
            doc.fillColor('#666666').text('International wire transfers are processed within 1-2 business days. Exchange rate was applied at the time of transfer.', { width: contentW - 20 });
            curY += 28;
        }

        // ── Footer ──
        curY += 8;
        const footerTop = curY;
        doc.rect(0, footerTop, pageW, 2).fill(GOLD);
        doc.rect(0, footerTop + 2, pageW, 65).fill(GREEN);

        doc.fontSize(7).fillColor(GOLD).text('Heritage Bank', marginL, footerTop + 8, { width: contentW, align: 'center' });
        doc.fontSize(6.5).fillColor(WHITE);
        doc.text('FDIC Insured | Equal Housing Lender | NMLS #091238946', marginL, footerTop + 18, { width: contentW, align: 'center' });
        doc.text('Member FDIC | Routing Number: 091238946', marginL, footerTop + 28, { width: contentW, align: 'center' });
        doc.text('1-800-HERITAGE | support@heritagebank.com | www.heritagebank.com', marginL, footerTop + 38, { width: contentW, align: 'center' });
        doc.text('Regulated by the Office of the Comptroller of the Currency (OCC) | SWIFT: HRTGUSBKXXX', marginL, footerTop + 48, { width: contentW, align: 'center' });
        doc.fontSize(6.5).fillColor(GOLD).text('This is a computer-generated receipt and does not require a physical signature.', marginL, footerTop + 56, { width: contentW, align: 'center' });

        doc.end();

        stream.on('finish', () => {
            res.download(pdfPath, `Heritage_Bank_Receipt_${transaction.reference || id}.pdf`, () => {
                try { fs.unlinkSync(pdfPath); } catch (e) {}
            });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Helper: mask account number for receipts (show last 4 digits)
function maskAccount(accNum) {
    if (!accNum) return 'N/A';
    const s = String(accNum);
    if (s.length <= 4) return s;
    return '****' + s.slice(-4);
}

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
                   uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.email AS fromEmail, uf.accountNumber AS fromAccountNumber,
                   ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.email AS toEmail, ut.accountNumber AS toAccountNumber
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
        if (!token) {
            return res.status(401).json({ success: false, message: 'Authorization required' });
        }
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        // Check card exists and belongs to user
        const [cards] = await pool.execute(
            'SELECT id, status FROM cards WHERE id = ? AND userId = ?',
            [id, decoded.id]
        );
        
        if (cards.length === 0) {
            return res.status(404).json({ success: false, message: 'Card not found' });
        }

        if (cards[0].status === 'blocked') {
            return res.status(400).json({ success: false, message: 'Cannot freeze a blocked card' });
        }

        if (cards[0].status === 'paused') {
            return res.status(400).json({ success: false, message: 'Card is paused by administrator. Contact support.' });
        }

        await pool.execute(
            'UPDATE cards SET status = ?, frozenAt = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?',
            ['frozen', id, decoded.id]
        );

        res.json({ success: true, message: 'Card frozen successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ADMIN CARD CONTROLS ====================

// Admin: List/search cards
app.get('/api/admin/cards', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = String(req.query.q || req.query.search || '').trim().toLowerCase();
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));

        let sql = `
            SELECT c.id, c.userId, c.cardType, c.cardNetwork, c.cardholderName, c.cardNumberMasked,
                   c.expirationDate, c.status, c.issuedAt, c.activatedAt, c.frozenAt, c.pausedAt,
                   c.deliveryEtaText, c.deliveryStatus,
                   u.firstName, u.lastName, u.email,
                   ba.accountNumber AS linkedAccount
            FROM cards c
            JOIN users u ON c.userId = u.id
            LEFT JOIN bank_accounts ba ON c.accountId = ba.id
        `;
        const params = [];

        if (q) {
            sql += ` WHERE (u.email LIKE ? OR u.firstName LIKE ? OR u.lastName LIKE ? OR ba.accountNumber LIKE ? OR c.cardNumberMasked LIKE ?) `;
            const like = `%${q}%`;
            params.push(like, like, like, like, like);
        }

        sql += ` ORDER BY c.issuedAt DESC LIMIT ?`;
        params.push(limit);

        const [cards] = await pool.execute(sql, params);
        res.json({ success: true, cards, count: cards.length });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

async function setCardStatusAsAdmin({ adminId, cardId, status, reason, req }) {
    const allowed = new Set(['active', 'frozen', 'paused', 'blocked', 'pending']);
    const next = String(status || '').trim().toLowerCase();
    if (!allowed.has(next)) {
        const err = new Error('Invalid status');
        err.statusCode = 400;
        throw err;
    }

    const [rows] = await pool.execute('SELECT * FROM cards WHERE id = ?', [cardId]);
    const card = rows?.[0];
    if (!card) {
        const err = new Error('Card not found');
        err.statusCode = 404;
        throw err;
    }

    const now = new Date();
    const frozenAt = next === 'frozen' ? now : null;
    const pausedAt = next === 'paused' ? now : null;

    await pool.execute(
        'UPDATE cards SET status = ?, frozenAt = ?, pausedAt = ? WHERE id = ?',
        [next, frozenAt, pausedAt, cardId]
    );

    // Notify the user
    try {
        const titleMap = {
            active: 'Card Reactivated',
            frozen: 'Card Frozen',
            paused: 'Card Paused',
            blocked: 'Card Blocked',
            pending: 'Card Status Updated'
        };
        const title = titleMap[next] || 'Card Status Updated';
        await createNotification(
            card.userId,
            'card',
            title,
            `Your card ${card.cardNumberMasked || ''} status is now: ${next.toUpperCase()}.${reason ? ` Reason: ${reason}` : ''}`.trim(),
            { cardId, status: next }
        );
    } catch (e) {}

    // Activity log
    try {
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
            [card.userId, 'CARD_STATUS_UPDATED', `Admin set card status to ${next.toUpperCase()}${reason ? ` — ${reason}` : ''}`, req?.ip]
        );
    } catch (e) {}

    // Admin audit
    try {
        await logAdminAction(adminId, 'card_status_update', card.userId, null, null,
            { cardId, from: card.status, to: next, reason },
            `Card ${cardId} status set to ${next}`, null, req
        );
    } catch (e) {}

    return { cardId, previousStatus: card.status, status: next };
}

app.put('/api/admin/cards/:id/freeze', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await setCardStatusAsAdmin({
            adminId: req.auth?.id,
            cardId: req.params.id,
            status: 'frozen',
            reason: req.body?.reason,
            req
        });
        res.json({ success: true, message: 'Card frozen', ...result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/cards/:id/unfreeze', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await setCardStatusAsAdmin({
            adminId: req.auth?.id,
            cardId: req.params.id,
            status: 'active',
            reason: req.body?.reason,
            req
        });
        res.json({ success: true, message: 'Card unfrozen', ...result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/cards/:id/pause', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await setCardStatusAsAdmin({
            adminId: req.auth?.id,
            cardId: req.params.id,
            status: 'paused',
            reason: req.body?.reason,
            req
        });
        res.json({ success: true, message: 'Card paused', ...result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/cards/:id/unpause', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await setCardStatusAsAdmin({
            adminId: req.auth?.id,
            cardId: req.params.id,
            status: 'active',
            reason: req.body?.reason,
            req
        });
        res.json({ success: true, message: 'Card unpaused', ...result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

app.put('/api/cards/:id/unfreeze', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { id } = req.params;

        // Only allow user to unfreeze cards they themselves froze.
        // If an admin paused a card, the user should not be able to reactivate it.
        const [result] = await pool.execute(
            'UPDATE cards SET status = ?, frozenAt = NULL WHERE id = ? AND userId = ? AND status = ?',
            ['active', id, decoded.id, 'frozen']
        );

        if (!result || result.affectedRows === 0) {
            return res.status(400).json({ success: false, message: 'Card cannot be unfrozen (it may be paused or not frozen)' });
        }

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
        const cols = await getTransactionsTableColumns();
        const colSet = new Set((cols || []).map(c => String(c).toLowerCase()));
        const hasCol = (name) => colSet.has(String(name).toLowerCase());

        const fromExpr = (hasCol('fromUserId') && hasCol('from_user_id'))
            ? 'COALESCE(t.fromUserId, t.from_user_id)'
            : (hasCol('fromUserId') ? 't.fromUserId' : (hasCol('from_user_id') ? 't.from_user_id' : null));
        const toExpr = (hasCol('toUserId') && hasCol('to_user_id'))
            ? 'COALESCE(t.toUserId, t.to_user_id)'
            : (hasCol('toUserId') ? 't.toUserId' : (hasCol('to_user_id') ? 't.to_user_id' : null));
        const createdExpr = (hasCol('createdAt') && hasCol('created_at'))
            ? 'COALESCE(t.createdAt, t.created_at)'
            : (hasCol('createdAt') ? 't.createdAt' : (hasCol('created_at') ? 't.created_at' : 'NOW()'));
        const refExpr = (hasCol('reference') && hasCol('reference_id'))
            ? 'COALESCE(t.reference, t.reference_id)'
            : (hasCol('reference') ? 't.reference' : (hasCol('reference_id') ? 't.reference_id' : 'NULL'));
        const descExpr = (hasCol('description') ? 't.description' : (hasCol('details') ? 't.details' : (hasCol('memo') ? 't.memo' : 't.description')));

        // Build joins only when the linking columns exist.
        const joinSender = fromExpr ? `LEFT JOIN users u1 ON ${fromExpr} = u1.id` : `LEFT JOIN users u1 ON 1=0`;
        const joinRecipient = toExpr ? `LEFT JOIN users u2 ON ${toExpr} = u2.id` : `LEFT JOIN users u2 ON 1=0`;

        const [rows] = await pool.execute(`
            SELECT t.*,
                   ${createdExpr} AS createdAt,
                   ${refExpr} AS reference,
                   ${descExpr} AS description,
                   u1.firstName as senderFirst, u1.lastName as senderLast,
                   u1.email as senderEmail, u1.accountNumber as senderAccountNumber,
                   u2.firstName as recipientFirst, u2.lastName as recipientLast,
                   u2.email as recipientEmail, u2.accountNumber as recipientAccountNumber
            FROM transactions t
            ${joinSender}
            ${joinRecipient}
            ORDER BY ${createdExpr} DESC
            LIMIT 100
        `);

        const transactions = (rows || []).map(normalizeTransactionRow);
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

        // Generate reset token (NEVER return it in API response)
        const resetToken = crypto.randomBytes(24).toString('hex');
        const resetExpiry = new Date(Date.now() + 3600000); // 1 hour
        
        await pool.execute(
            'UPDATE users SET resetToken = ?, resetTokenExpiry = ? WHERE email = ?',
            [resetToken, resetExpiry, email]
        );

        const appBaseUrl = process.env.APP_BASE_URL;
        if (!appBaseUrl) {
            return res.status(500).json({
                success: false,
                message: 'APP_BASE_URL is not configured (needed to send reset link)'
            });
        }

        const resetLink = `${String(appBaseUrl).replace(/\/$/, '')}/forgot-password.html?email=${encodeURIComponent(email)}&token=${encodeURIComponent(resetToken)}`;
        const emailText = `We received a request to reset your Heritage Bank password.\n\nReset your password using this link (valid for 1 hour):\n${resetLink}\n\nIf you did not request this, you can ignore this email.`;
        const emailHtml = `<p>We received a request to reset your Heritage Bank password.</p><p><a href="${resetLink}">Reset your password</a> (valid for 1 hour)</p><p>If you did not request this, you can ignore this email.</p>`;
        try {
            await sendTransactionalEmail({
                to: email,
                subject: 'Reset your Heritage Bank password',
                text: emailText,
                html: emailHtml
            });
        } catch (e) {
            // Don’t leak resetToken; just report config issue.
            if (e && e.code === 'EMAIL_NOT_CONFIGURED') {
                return res.status(500).json({ success: false, message: e.message });
            }
            throw e;
        }

        res.json({ success: true, message: 'Password reset instructions sent to email' });
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
        const cols = await getTransactionsTableColumns();
        const colSet = new Set((cols || []).map(c => String(c).toLowerCase()));
        const hasCol = (name) => colSet.has(String(name).toLowerCase());
        const createdExpr = (hasCol('createdAt') && hasCol('created_at'))
            ? 'COALESCE(createdAt, created_at)'
            : (hasCol('createdAt') ? 'createdAt' : (hasCol('created_at') ? 'created_at' : null));

        // Total users
        const [userCount] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE accountStatus != "deleted"');
        
        // Total deposits (sum of all balances)
        const [totalBalance] = await pool.execute('SELECT SUM(balance) as total FROM users WHERE accountStatus != "deleted"');
        
        // Today's transactions
        const [todayTxns] = createdExpr
            ? await pool.execute(`SELECT COUNT(*) as count FROM transactions WHERE DATE(${createdExpr}) = CURDATE()`)
            : [[{ count: 0 }]];
        
        // Pending loans
        const [pendingLoans] = await pool.execute(`
            SELECT COUNT(*) as count 
            FROM loan_applications 
            WHERE status = 'pending'
        `);
        
        // Total transactions this month
        const [monthlyTxns] = createdExpr
            ? await pool.execute(
                `SELECT COUNT(*) as count, SUM(amount) as volume
                 FROM transactions
                 WHERE MONTH(${createdExpr}) = MONTH(CURDATE()) AND YEAR(${createdExpr}) = YEAR(CURDATE())`
              )
            : [[{ count: 0, volume: 0 }]];
        
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

        const cols = await getTransactionsTableColumns();
        const colSet = new Set((cols || []).map(c => String(c).toLowerCase()));
        const hasCol = (name) => colSet.has(String(name).toLowerCase());

        const fromExpr = (hasCol('fromUserId') && hasCol('from_user_id'))
            ? 'COALESCE(t.fromUserId, t.from_user_id)'
            : (hasCol('fromUserId') ? 't.fromUserId' : (hasCol('from_user_id') ? 't.from_user_id' : null));
        const toExpr = (hasCol('toUserId') && hasCol('to_user_id'))
            ? 'COALESCE(t.toUserId, t.to_user_id)'
            : (hasCol('toUserId') ? 't.toUserId' : (hasCol('to_user_id') ? 't.to_user_id' : null));
        const createdExpr = (hasCol('createdAt') && hasCol('created_at'))
            ? 'COALESCE(t.createdAt, t.created_at)'
            : (hasCol('createdAt') ? 't.createdAt' : (hasCol('created_at') ? 't.created_at' : 'NOW()'));
        const refExpr = (hasCol('reference') && hasCol('reference_id'))
            ? 'COALESCE(t.reference, t.reference_id)'
            : (hasCol('reference') ? 't.reference' : (hasCol('reference_id') ? 't.reference_id' : 'NULL'));
        const descExpr = (hasCol('description') ? 't.description' : (hasCol('details') ? 't.details' : (hasCol('memo') ? 't.memo' : 't.description')));

        const joinSender = fromExpr ? `LEFT JOIN users sender ON ${fromExpr} = sender.id` : `LEFT JOIN users sender ON 1=0`;
        const joinRecipient = toExpr ? `LEFT JOIN users recipient ON ${toExpr} = recipient.id` : `LEFT JOIN users recipient ON 1=0`;
        
        let query = `
            SELECT t.*, 
                   ${createdExpr} AS createdAt,
                   ${refExpr} AS reference,
                   ${descExpr} AS description,
                   sender.firstName as senderFirst, sender.lastName as senderLast,
                   sender.email as senderEmail, sender.accountNumber as senderAccountNumber,
                   recipient.firstName as recipientFirst, recipient.lastName as recipientLast,
                   recipient.email as recipientEmail, recipient.accountNumber as recipientAccountNumber
            FROM transactions t
            ${joinSender}
            ${joinRecipient}
            WHERE 1=1
        `;
        const params = [];

        // Generic query search used by the admin UI (e.g. account number, email, reference, description)
        if (searchQuery) {
            const like = `%${String(searchQuery).trim()}%`;
            query += `
                AND (
                    ${refExpr} LIKE ? OR ${descExpr} LIKE ?
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
            query += ` AND DATE(${createdExpr}) >= ?`;
            params.push(startDate);
        }
        
        if (endDate) {
            query += ` AND DATE(${createdExpr}) <= ?`;
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

        query += ` ORDER BY ${createdExpr} DESC LIMIT 100`;

        const [rows] = await pool.execute(query, params);
        const transactions = (rows || []).map(normalizeTransactionRow);
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
        // Admin-triggered reset should not reveal passwords/tokens in API.
        // We create a reset token and email the user a reset link.

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = users[0];
        if (!user.email) {
            return res.status(400).json({ success: false, message: 'User has no email on file' });
        }

        const resetToken = crypto.randomBytes(24).toString('hex');
        const resetExpiry = new Date(Date.now() + 3600000); // 1 hour

        try {
            await pool.execute(
                'UPDATE users SET resetToken = ?, resetTokenExpiry = ?, forcePasswordChange = 1 WHERE id = ?',
                [resetToken, resetExpiry, userId]
            );
        } catch (e) {
            // In case the DB doesn't have forcePasswordChange yet.
            await pool.execute(
                'UPDATE users SET resetToken = ?, resetTokenExpiry = ? WHERE id = ?',
                [resetToken, resetExpiry, userId]
            );
        }

        // Log the action
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
            [userId, 'PASSWORD_RESET', 'Admin forced password reset', req.ip]
        );

        const appBaseUrl = process.env.APP_BASE_URL;
        if (!appBaseUrl) {
            return res.status(500).json({
                success: false,
                message: 'APP_BASE_URL is not configured (needed to send reset link)'
            });
        }

        const resetLink = `${String(appBaseUrl).replace(/\/$/, '')}/forgot-password.html?email=${encodeURIComponent(user.email)}&token=${encodeURIComponent(resetToken)}`;
        const emailText = `An administrator requested a password reset for your Heritage Bank account.\n\nReset your password using this link (valid for 1 hour):\n${resetLink}`;
        const emailHtml = `<p>An administrator requested a password reset for your Heritage Bank account.</p><p><a href="${resetLink}">Reset your password</a> (valid for 1 hour)</p>`;
        try {
            await sendTransactionalEmail({
                to: user.email,
                subject: 'Heritage Bank password reset',
                text: emailText,
                html: emailHtml
            });
        } catch (e) {
            if (e && e.code === 'EMAIL_NOT_CONFIGURED') {
                return res.status(500).json({ success: false, message: e.message });
            }
            throw e;
        }

        res.json({ success: true, message: 'Password reset email sent to user' });
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

let _loginHistoryColumnsCache = null;
let _loginHistoryColumnsCacheAt = 0;
async function getLoginHistoryTableColumns() {
    const now = Date.now();
    if (_loginHistoryColumnsCache && (now - _loginHistoryColumnsCacheAt) < 5 * 60 * 1000) {
        return _loginHistoryColumnsCache;
    }
    try {
        const [rows] = await pool.execute('SHOW COLUMNS FROM login_history');
        const cols = Array.isArray(rows) ? rows.map(r => String(r.Field || '')).filter(Boolean) : [];
        _loginHistoryColumnsCache = cols;
        _loginHistoryColumnsCacheAt = now;
        return cols;
    } catch (e) {
        return null;
    }
}

function computeSessionKey(ip, userAgent) {
    const raw = `${String(ip || '').trim()}|${String(userAgent || '').trim()}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

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

        const cols = await getLoginHistoryTableColumns();
        const colSet = new Set((cols || []).map(c => String(c).toLowerCase()));
        const hasCol = (name) => colSet.has(String(name).toLowerCase());

        const ipCol = hasCol('ipAddress') ? 'ipAddress' : (hasCol('ip_address') ? 'ip_address' : null);
        const uaCol = hasCol('userAgent') ? 'userAgent' : (hasCol('user_agent') ? 'user_agent' : null);
        const statusCol = hasCol('loginStatus') ? 'loginStatus' : (hasCol('login_status') ? 'login_status' : null);
        const timeCol = hasCol('loginAt') ? 'loginAt' : (hasCol('login_at') ? 'login_at' : (hasCol('createdAt') ? 'createdAt' : (hasCol('created_at') ? 'created_at' : null)));

        if (!ipCol || !uaCol || !timeCol) {
            // If schema is missing required fields, return empty list (no mock data).
            return res.json({ success: true, sessions: [] });
        }

        const timeExpr = timeCol ? `MAX(${timeCol})` : 'MAX(NOW())';
        const minTimeExpr = timeCol ? `MIN(${timeCol})` : 'MIN(NOW())';
        const statusFilter = statusCol ? `AND ${statusCol} = 'success'` : '';

        // Pull recent “session-like” groups from real login history.
        const [rows] = await pool.execute(`
            SELECT ${ipCol} AS ip,
                   ${uaCol} AS userAgent,
                   ${timeExpr} AS lastActivity,
                   ${minTimeExpr} AS firstSeen,
                   COUNT(*) AS loginCount
            FROM login_history
            WHERE userId = ?
            ${statusFilter}
            GROUP BY ${ipCol}, ${uaCol}
            ORDER BY lastActivity DESC
            LIMIT 10
        `, [decoded.id]);

        // Apply revocations
        let revokedAfter = null;
        try {
            const [globalRows] = await pool.execute(
                'SELECT revokedAfter FROM user_session_revocations WHERE userId = ? LIMIT 1',
                [decoded.id]
            );
            revokedAfter = globalRows?.[0]?.revokedAfter || null;
        } catch (e) {
            revokedAfter = null;
        }

        let revokedKeys = new Set();
        try {
            const [specRows] = await pool.execute(
                'SELECT sessionKey FROM user_session_revocations_specific WHERE userId = ?',
                [decoded.id]
            );
            revokedKeys = new Set((specRows || []).map(r => String(r.sessionKey || '')));
        } catch (e) {
            revokedKeys = new Set();
        }

        const sessions = (rows || [])
            .map(r => {
                const ip = r.ip || '';
                const ua = r.userAgent || '';
                const sessionKey = computeSessionKey(ip, ua);
                return {
                    id: sessionKey,
                    deviceName: ua ? String(ua).slice(0, 80) : 'Unknown Device',
                    browserName: ua ? String(ua).slice(0, 40) : 'Unknown',
                    location: ip || 'Unknown',
                    ipAddress: ip || null,
                    userAgent: ua || null,
                    firstSeen: r.firstSeen || null,
                    lastActivity: r.lastActivity || null,
                    loginCount: Number(r.loginCount || 0)
                };
            })
            .filter(s => {
                if (revokedKeys.has(s.id)) return false;
                if (revokedAfter && s.lastActivity) {
                    try {
                        return new Date(s.lastActivity).getTime() > new Date(revokedAfter).getTime();
                    } catch (e) {
                        return true;
                    }
                }
                return true;
            });

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

        const decoded = jwt.verify(token, JWT_SECRET);
        const { sessionId } = req.params;
        const sessionKey = String(sessionId || '').trim();
        if (!sessionKey || sessionKey.length < 16) {
            return res.status(400).json({ success: false, message: 'Invalid session id' });
        }

        // Best-effort: revoke the “session” in our UI list (JWT remains valid until expiry).
        await pool.execute(
            'INSERT INTO user_session_revocations_specific (userId, sessionKey, revokedAt) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE revokedAt = NOW()',
            [decoded.id, sessionKey]
        );

        res.json({ success: true, message: 'Session removed from active sessions list' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Logout all sessions
app.post('/api/user/security/logout-all', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);

        await pool.execute(
            'INSERT INTO user_session_revocations (userId, revokedAfter) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE revokedAfter = NOW()',
            [decoded.id]
        );
        // Also clear specific revocations (optional) so the global cutoff is authoritative.
        try {
            await pool.execute('DELETE FROM user_session_revocations_specific WHERE userId = ?', [decoded.id]);
        } catch (e) {}

        res.json({ success: true, message: 'All sessions removed from active sessions list' });
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

// Download statement (current month)
app.get('/api/user/statements/current', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'No token' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        const user = users[0];

        // Get transactions for current month
        const [transactions] = await pool.execute(`
            SELECT t.*, 
                   uf.firstName AS fromFirstName, uf.lastName AS fromLastName, uf.accountNumber AS fromAccountNumber,
                   ut.firstName AS toFirstName, ut.lastName AS toLastName, ut.accountNumber AS toAccountNumber
            FROM transactions t
            LEFT JOIN users uf ON t.fromUserId = uf.id
            LEFT JOIN users ut ON t.toUserId = ut.id
            WHERE (t.fromUserId = ? OR t.toUserId = ?) AND MONTH(t.createdAt) = MONTH(NOW()) AND YEAR(t.createdAt) = YEAR(NOW())
            ORDER BY t.createdAt DESC
        `, [decoded.id, decoded.id]);

        // Create PDF – Same professional design as main statement
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        const pdfPath = path.join(__dirname, `statement_${decoded.id}_${Date.now()}.pdf`);
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        const GREEN = '#1a472a', GOLD = '#d4af37', GRAY = '#666666', BLACK = '#222222', WHITE = '#ffffff';
        const pageW = 595.28, mL = 40, mR = 40, cW = pageW - mL - mR;

        // ── Banner ──
        doc.rect(0, 0, pageW, 80).fill(GREEN);
        const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
        try { if (fs.existsSync(logoPath)) doc.image(logoPath, mL + 10, 12, { height: 50 }); } catch (e) {}
        doc.fontSize(22).fillColor(GOLD).text('HERITAGE BANK', mL + 75, 18, { width: cW - 75 });
        doc.fontSize(8).fillColor(WHITE).text('Your Trusted Banking Partner', mL + 75, 44, { width: cW - 75 });
        const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        doc.fontSize(10).fillColor(WHITE).text('MONTHLY STATEMENT', pageW - 195, 25, { width: 155, align: 'right' });
        doc.fontSize(8).fillColor(GOLD).text(monthName, pageW - 195, 42, { width: 155, align: 'right' });
        doc.rect(0, 80, pageW, 3).fill(GOLD);

        // ── Account info box ──
        let y = 96;
        doc.roundedRect(mL, y, cW, 58, 6).lineWidth(1).strokeColor('#e0e0e0').stroke();
        doc.rect(mL + 1, y + 1, cW - 2, 18).fill('#f8f9fa');
        doc.fontSize(9).fillColor(GREEN).text('ACCOUNT INFORMATION', mL + 12, y + 5);
        const infoY = y + 24;
        doc.fontSize(8).fillColor(GRAY);
        doc.text('Account Holder', mL + 12, infoY);
        doc.text('Account Number', mL + 12, infoY + 14);
        doc.text('Current Balance', mL + cW / 2 + 10, infoY);
        doc.text('Statement Period', mL + cW / 2 + 10, infoY + 14);
        doc.fontSize(9).fillColor(BLACK);
        doc.text(`${user.firstName} ${user.lastName}`, mL + 102, infoY);
        doc.text(user.accountNumber || 'N/A', mL + 102, infoY + 14);
        doc.fillColor('#28a745').text(`$${parseFloat(user.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, mL + cW / 2 + 110, infoY);
        doc.fillColor(BLACK).text(monthName, mL + cW / 2 + 110, infoY + 14);

        // ── Transaction table ──
        y += 68;
        doc.fontSize(10).fillColor(GREEN).text('Transaction History', mL, y);
        y += 15;
        doc.rect(mL, y, cW, 1).fill(GOLD);
        y += 8;
        doc.rect(mL, y, cW, 20).fill(GREEN);
        const cols = [
            { label: 'DATE', x: mL + 8, w: 72 },
            { label: 'TYPE', x: mL + 82, w: 60 },
            { label: 'DESCRIPTION', x: mL + 144, w: 210 },
            { label: 'STATUS', x: mL + 356, w: 60 },
            { label: 'AMOUNT', x: mL + 418, w: 95 }
        ];
        doc.fontSize(7.5).fillColor(WHITE);
        cols.forEach(c => doc.text(c.label, c.x, y + 6, { width: c.w }));
        y += 22;

        const maxRows = 20;
        const displayTxns = transactions.slice(0, maxRows);
        if (displayTxns.length === 0) {
            doc.fontSize(9).fillColor(GRAY).text('No transactions this month.', mL, y + 10, { width: cW, align: 'center' });
        } else {
            displayTxns.forEach((t, i) => {
                const ry = y + (i * 22);
                if (i % 2 === 0) doc.rect(mL, ry, cW, 22).fill('#fafafa');
                const isCredit = t.type === 'credit' || t.toUserId === decoded.id;
                const amt = parseFloat(t.amount);
                const tFee = parseFloat(t.fee) || 0;
                let desc = cleanDescription(t.description) || t.type || 'Transfer';
                const ukMatch = desc.match(/UK Bank Transfer to ([^|]+)\s*\|\s*Recipient:\s*([^|]+)/);
                if (ukMatch) desc = `Wire to ${ukMatch[1].trim()} (${ukMatch[2].trim()})`;
                if (tFee > 0 && !isCredit) desc += ` (Fee: $${tFee.toFixed(2)})`;
                if (desc.length > 55) desc = desc.substring(0, 52) + '...';

                doc.fontSize(7.5).fillColor(BLACK);
                doc.text(new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }), cols[0].x, ry + 6, { width: cols[0].w });
                doc.text(cleanTxType(t.type), cols[1].x, ry + 6, { width: cols[1].w });
                doc.fontSize(7).fillColor(GRAY).text(desc, cols[2].x, ry + 6, { width: cols[2].w });
                const st = (t.status || 'completed').toLowerCase();
                const stColor = st === 'completed' ? '#28a745' : (st === 'pending' ? '#ffc107' : '#dc3545');
                doc.roundedRect(cols[3].x, ry + 4, 48, 14, 7).fill(stColor);
                doc.fontSize(6.5).fillColor(WHITE).text(st.toUpperCase(), cols[3].x, ry + 7, { width: 48, align: 'center' });
                const displayAmt = isCredit ? amt : amt + tFee;
                const amtColor = isCredit ? '#28a745' : '#c62828';
                doc.fontSize(8).fillColor(amtColor).text(`${isCredit ? '+' : '-'}$${displayAmt.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, cols[4].x, ry + 6, { width: cols[4].w, align: 'right' });
            });
        }

        // ── Footer ──
        const footerTop = 750;
        doc.rect(0, footerTop, pageW, 2).fill(GOLD);
        doc.rect(0, footerTop + 2, pageW, 90).fill(GREEN);
        doc.fontSize(8).fillColor(GOLD).text('Heritage Bank', mL, footerTop + 10, { width: cW, align: 'center' });
        doc.fontSize(7).fillColor(WHITE);
        doc.text('FDIC Insured | Equal Housing Lender | NMLS #091238946', mL, footerTop + 22, { width: cW, align: 'center' });
        doc.text('1-800-HERITAGE | support@heritagebank.com | www.heritagebank.com', mL, footerTop + 34, { width: cW, align: 'center' });
        doc.text('Regulated by the Office of the Comptroller of the Currency (OCC)', mL, footerTop + 46, { width: cW, align: 'center' });
        doc.fontSize(7).fillColor(GOLD).text('This is a computer-generated statement and does not require a physical signature.', mL, footerTop + 60, { width: cW, align: 'center' });

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
        const txType = adjustmentType === 'debit' ? 'debit' : 'credit';
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
            [req.auth.id]
        );

        // Get cards
        const [cards] = await pool.execute(
            `SELECT id, cardNumber, expirationDate, status, cardType, createdAt FROM cards WHERE userId = ?`,
            [req.auth.id]
        );

        // Get compliance flags
        const [flags] = await pool.execute(
            `SELECT * FROM compliance_flags WHERE userId = ? AND status = 'active'`,
            [req.auth.id]
        );

        // Get login history
        const [logins] = await pool.execute(
            `SELECT * FROM login_history WHERE userId = ? ORDER BY loginAt DESC LIMIT 10`,
            [req.auth.id]
        );

        res.json({
            success: true,
            isImpersonation: true,
            readOnly: true,
            impersonatedBy: req.auth.impersonatedBy,
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

// ==================== NEW FEATURE ENDPOINTS ====================

// ==================== 1. SESSION SECURITY & LOGIN HISTORY ====================

// Get login history
app.get('/api/user/login-history', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT id, ipAddress, userAgent, device, location, city, country, 
                   loginStatus, failureReason, isSuspicious, loginAt
            FROM login_history 
            WHERE userId = ?
            ORDER BY loginAt DESC
            LIMIT 50
        `, [req.auth.id]);
        res.json({ success: true, loginHistory: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get session settings (for auto-logout)
app.get('/api/user/session-settings', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT sessionTimeout, autoLogout FROM user_preferences WHERE userId = ?',
            [req.auth.id]
        );
        const settings = rows[0] || { sessionTimeout: 15, autoLogout: true };
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update session settings
app.put('/api/user/session-settings', requireAuth, async (req, res) => {
    try {
        const { sessionTimeout, autoLogout } = req.body;
        await pool.execute(`
            INSERT INTO user_preferences (userId, sessionTimeout, autoLogout)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE sessionTimeout = VALUES(sessionTimeout), autoLogout = VALUES(autoLogout)
        `, [req.auth.id, sessionTimeout || 15, autoLogout !== false]);
        res.json({ success: true, message: 'Session settings updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== 2. TRANSACTION PIN ====================

// Set/Update transaction PIN
app.post('/api/user/transaction-pin', requireAuth, async (req, res) => {
    try {
        const { pin, currentPin } = req.body;
        
        if (!pin || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });
        }

        // Check if user already has a PIN
        const [users] = await pool.execute('SELECT transactionPin FROM users WHERE id = ?', [req.auth.id]);
        const user = users[0];

        if (user.transactionPin) {
            // Verify current PIN
            if (!currentPin) {
                return res.status(400).json({ success: false, message: 'Current PIN required' });
            }
            const isValid = await bcrypt.compare(currentPin, user.transactionPin);
            if (!isValid) {
                return res.status(400).json({ success: false, message: 'Current PIN is incorrect' });
            }
        }

        const hashedPin = await bcrypt.hash(pin, 10);
        await pool.execute('UPDATE users SET transactionPin = ? WHERE id = ?', [hashedPin, req.auth.id]);
        
        res.json({ success: true, message: 'Transaction PIN updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Verify transaction PIN (for high-value transfers)
app.post('/api/user/verify-transaction-pin', requireAuth, async (req, res) => {
    try {
        const { pin } = req.body;
        
        const [users] = await pool.execute('SELECT transactionPin FROM users WHERE id = ?', [req.auth.id]);
        const user = users[0];

        if (!user.transactionPin) {
            return res.json({ success: true, message: 'No PIN set', pinRequired: false });
        }

        const isValid = await bcrypt.compare(pin, user.transactionPin);
        if (!isValid) {
            return res.status(400).json({ success: false, message: 'Invalid PIN' });
        }

        res.json({ success: true, message: 'PIN verified' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Check if user has transaction PIN set
app.get('/api/user/has-transaction-pin', requireAuth, async (req, res) => {
    try {
        const [users] = await pool.execute('SELECT transactionPin FROM users WHERE id = ?', [req.auth.id]);
        const hasPin = !!(users[0]?.transactionPin);
        res.json({ success: true, hasPin });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== 3. USER ACCOUNT FREEZE ====================

// User freezes their own account
app.post('/api/user/freeze-account', requireAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        
        await pool.execute(
            "UPDATE users SET accountStatus = 'frozen' WHERE id = ?",
            [req.auth.id]
        );

        // Log activity
        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [req.auth.id, 'ACCOUNT_SELF_FROZEN', reason || 'User froze their own account', req.ip]
            );
        } catch (e) {}

        res.json({ success: true, message: 'Your account has been frozen. Contact support to unfreeze.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== 4. DARK MODE & USER PREFERENCES ====================

// Get user preferences
app.get('/api/user/preferences', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM user_preferences WHERE userId = ?',
            [req.auth.id]
        );
        const preferences = rows[0] || {
            darkMode: false,
            language: 'en',
            currency: 'USD',
            sessionTimeout: 15,
            autoLogout: true
        };
        res.json({ success: true, preferences });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update user preferences
app.put('/api/user/preferences', requireAuth, async (req, res) => {
    try {
        const { darkMode, language, currency, sessionTimeout, autoLogout } = req.body;
        
        await pool.execute(`
            INSERT INTO user_preferences (userId, darkMode, language, currency, sessionTimeout, autoLogout)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                darkMode = VALUES(darkMode),
                language = VALUES(language),
                currency = VALUES(currency),
                sessionTimeout = VALUES(sessionTimeout),
                autoLogout = VALUES(autoLogout)
        `, [req.auth.id, darkMode || false, language || 'en', currency || 'USD', sessionTimeout || 15, autoLogout !== false]);
        
        res.json({ success: true, message: 'Preferences updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== 5. CURRENCY CONVERTER ====================

// Simple currency converter (using fixed rates - in production use an API)
const exchangeRates = {
    USD: 1,
    EUR: 0.92,
    GBP: 0.79,
    CAD: 1.36,
    AUD: 1.53,
    JPY: 149.50,
    CHF: 0.88,
    CNY: 7.24,
    INR: 83.12,
    MXN: 17.15,
    NGN: 1550.00,
    ZAR: 18.75
};

app.get('/api/currency/rates', async (req, res) => {
    res.json({ 
        success: true, 
        rates: exchangeRates,
        baseCurrency: 'USD',
        lastUpdated: new Date().toISOString()
    });
});

app.post('/api/currency/convert', async (req, res) => {
    try {
        const { amount, from, to } = req.body;
        
        if (!amount || !from || !to) {
            return res.status(400).json({ success: false, message: 'Amount, from, and to currencies required' });
        }

        const fromRate = exchangeRates[from.toUpperCase()];
        const toRate = exchangeRates[to.toUpperCase()];

        if (!fromRate || !toRate) {
            return res.status(400).json({ success: false, message: 'Invalid currency code' });
        }

        const usdAmount = amount / fromRate;
        const convertedAmount = usdAmount * toRate;

        res.json({
            success: true,
            originalAmount: amount,
            fromCurrency: from.toUpperCase(),
            toCurrency: to.toUpperCase(),
            convertedAmount: Math.round(convertedAmount * 100) / 100,
            rate: toRate / fromRate
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ACCOUNT VERIFICATION ====================

// User: Get verification status
app.get('/api/user/verification-status', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT isVerified, documentRequested, documentRequestMessage FROM users WHERE id = ?',
            [req.auth.id]
        );
        if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });
        const user = rows[0];
        // Get uploaded documents
        let documents = [];
        try {
            const [docs] = await pool.execute(
                'SELECT id, documentType, verified, createdAt as uploadedAt FROM user_documents WHERE userId = ? ORDER BY createdAt DESC',
                [req.auth.id]
            );
            documents = docs;
        } catch (e) { /* table may not exist */ }
        
        res.json({
            success: true,
            verification: {
                isVerified: !!user.isVerified,
                documentRequested: !!user.documentRequested,
                documentRequestMessage: user.documentRequestMessage,
                documents
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Set user verification status
app.put('/api/admin/verify-user/:userId', requireAuth, async (req, res) => {
    try {
        const [admin] = await pool.execute('SELECT isAdmin FROM users WHERE id = ?', [req.auth.id]);
        if (!admin.length || !admin[0].isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
        
        const { isVerified } = req.body;
        await pool.execute(
            'UPDATE users SET isVerified = ?, documentRequested = false, documentRequestMessage = NULL WHERE id = ?',
            [isVerified ? 1 : 0, req.params.userId]
        );

        // Create notification for user
        const statusText = isVerified ? 'verified' : 'unverified';
        const notifMsg = isVerified
            ? 'Your account has been verified. You now have full access to all banking features.'
            : 'Your account verification has been revoked. Some features may be restricted.';
        try {
            await pool.execute(
                'INSERT INTO notifications (userId, title, message, type) VALUES (?, ?, ?, ?)',
                [req.params.userId, `Account ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}`, notifMsg, 'account']
            );
        } catch (e) { /* notifications table may not exist */ }

        res.json({ success: true, message: `User ${statusText} successfully` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Request documents from user
app.post('/api/admin/request-documents/:userId', requireAuth, async (req, res) => {
    try {
        const [admin] = await pool.execute('SELECT isAdmin FROM users WHERE id = ?', [req.auth.id]);
        if (!admin.length || !admin[0].isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
        
        const { message } = req.body;
        const requestMsg = message || 'Please upload your identification documents (Government-issued ID and proof of address).';
        
        await pool.execute(
            'UPDATE users SET documentRequested = true, documentRequestMessage = ? WHERE id = ?',
            [requestMsg, req.params.userId]
        );

        // Create notification for user
        try {
            await pool.execute(
                'INSERT INTO notifications (userId, title, message, type) VALUES (?, ?, ?, ?)',
                [req.params.userId, 'Document Request', requestMsg, 'document']
            );
        } catch (e) { /* notifications table may not exist */ }

        res.json({ success: true, message: 'Document request sent to user' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== 6. SAVINGS GOALS ====================

// Get all savings goals
app.get('/api/user/savings-goals', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT * FROM savings_goals WHERE userId = ? ORDER BY createdAt DESC
        `, [req.auth.id]);
        res.json({ success: true, goals: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Create savings goal
app.post('/api/user/savings-goals', requireAuth, async (req, res) => {
    try {
        const { name, targetAmount, targetDate, category, icon, color } = req.body;
        
        if (!name || !targetAmount) {
            return res.status(400).json({ success: false, message: 'Name and target amount required' });
        }

        const [result] = await pool.execute(`
            INSERT INTO savings_goals (userId, name, targetAmount, targetDate, category, icon, color)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [req.auth.id, name, targetAmount, targetDate || null, category || 'general', icon || 'piggy-bank', color || '#1a472a']);

        res.json({ success: true, message: 'Savings goal created', goalId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update savings goal (add/withdraw funds)
app.put('/api/user/savings-goals/:goalId', requireAuth, async (req, res) => {
    try {
        const { goalId } = req.params;
        const { addAmount, withdrawAmount, name, targetAmount, targetDate, status } = req.body;

        // Verify ownership
        const [goals] = await pool.execute('SELECT * FROM savings_goals WHERE id = ? AND userId = ?', [goalId, req.auth.id]);
        if (goals.length === 0) {
            return res.status(404).json({ success: false, message: 'Goal not found' });
        }

        const goal = goals[0];
        let newCurrentAmount = parseFloat(goal.currentAmount);

        if (addAmount) {
            newCurrentAmount += parseFloat(addAmount);
        }
        if (withdrawAmount) {
            newCurrentAmount -= parseFloat(withdrawAmount);
            if (newCurrentAmount < 0) newCurrentAmount = 0;
        }

        const updates = ['currentAmount = ?'];
        const params = [newCurrentAmount];

        if (name) { updates.push('name = ?'); params.push(name); }
        if (targetAmount) { updates.push('targetAmount = ?'); params.push(targetAmount); }
        if (targetDate !== undefined) { updates.push('targetDate = ?'); params.push(targetDate || null); }
        if (status) { updates.push('status = ?'); params.push(status); }

        // Check if goal is completed
        if (newCurrentAmount >= parseFloat(goal.targetAmount)) {
            updates.push("status = 'completed'");
            updates.push('completedAt = NOW()');
        }

        params.push(goalId);
        await pool.execute(`UPDATE savings_goals SET ${updates.join(', ')} WHERE id = ?`, params);

        res.json({ success: true, message: 'Savings goal updated', newAmount: newCurrentAmount });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete savings goal
app.delete('/api/user/savings-goals/:goalId', requireAuth, async (req, res) => {
    try {
        const { goalId } = req.params;
        await pool.execute('DELETE FROM savings_goals WHERE id = ? AND userId = ?', [goalId, req.auth.id]);
        res.json({ success: true, message: 'Savings goal deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Alias routes for savings-goals (frontend uses /api/savings-goals)
app.get('/api/savings-goals', requireAuth, async (req, res) => { req.url = '/api/user/savings-goals'; app.handle(req, res); });
app.post('/api/savings-goals', requireAuth, async (req, res) => { req.url = '/api/user/savings-goals'; app.handle(req, res); });
app.put('/api/savings-goals/:goalId', requireAuth, async (req, res) => { req.url = `/api/user/savings-goals/${req.params.goalId}`; app.handle(req, res); });
app.delete('/api/savings-goals/:goalId', requireAuth, async (req, res) => { req.url = `/api/user/savings-goals/${req.params.goalId}`; app.handle(req, res); });

// ==================== 7. INTERNAL MESSAGING ====================

// Get inbox messages
app.get('/api/messages/inbox', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT m.*, 
                   u.firstName AS senderFirstName, u.lastName AS senderLastName, u.email AS senderEmail, u.isAdmin AS senderIsAdmin
            FROM internal_messages m
            LEFT JOIN users u ON m.fromUserId = u.id
            WHERE m.toUserId = ? AND m.isDeleted = FALSE
            ORDER BY m.createdAt DESC
            LIMIT 100
        `, [req.auth.id]);
        res.json({ success: true, messages: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get sent messages
app.get('/api/messages/sent', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT m.*, 
                   u.firstName AS recipientFirstName, u.lastName AS recipientLastName, u.email AS recipientEmail
            FROM internal_messages m
            LEFT JOIN users u ON m.toUserId = u.id
            WHERE m.fromUserId = ? AND m.isDeleted = FALSE
            ORDER BY m.createdAt DESC
            LIMIT 100
        `, [req.auth.id]);
        res.json({ success: true, messages: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get unread message count
app.get('/api/messages/unread-count', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT COUNT(*) as count FROM internal_messages WHERE toUserId = ? AND isRead = FALSE AND isDeleted = FALSE',
            [req.auth.id]
        );
        res.json({ success: true, count: rows[0].count });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Send message
app.post('/api/messages/send', requireAuth, async (req, res) => {
    try {
        const { toUserId, subject, message, parentMessageId } = req.body;
        
        if (!subject || !message) {
            return res.status(400).json({ success: false, message: 'Subject and message required' });
        }

        // If no toUserId specified, send to admin
        let recipientId = toUserId;
        if (!recipientId) {
            const [admins] = await pool.execute('SELECT id FROM users WHERE isAdmin = TRUE LIMIT 1');
            if (admins.length === 0) {
                return res.status(400).json({ success: false, message: 'No admin available' });
            }
            recipientId = admins[0].id;
        }

        const [result] = await pool.execute(`
            INSERT INTO internal_messages (fromUserId, toUserId, subject, message, parentMessageId)
            VALUES (?, ?, ?, ?, ?)
        `, [req.auth.id, recipientId, subject, message, parentMessageId || null]);

        res.json({ success: true, message: 'Message sent', messageId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark message as read
app.put('/api/messages/:messageId/read', requireAuth, async (req, res) => {
    try {
        const { messageId } = req.params;
        await pool.execute(
            'UPDATE internal_messages SET isRead = TRUE, readAt = NOW() WHERE id = ? AND toUserId = ?',
            [messageId, req.auth.id]
        );
        res.json({ success: true, message: 'Message marked as read' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete message
app.delete('/api/messages/:messageId', requireAuth, async (req, res) => {
    try {
        const { messageId } = req.params;
        await pool.execute(
            'UPDATE internal_messages SET isDeleted = TRUE WHERE id = ? AND (toUserId = ? OR fromUserId = ?)',
            [messageId, req.auth.id, req.auth.id]
        );
        res.json({ success: true, message: 'Message deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Get all messages (for admin panel)
app.get('/api/admin/messages', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT m.id, m.subject, m.message AS body, m.isRead, m.createdAt,
                   m.fromUserId, m.toUserId,
                   sender.email AS userEmail,
                   sender.firstName AS senderFirstName, sender.lastName AS senderLastName,
                   (SELECT COUNT(*) FROM internal_messages r WHERE r.parentMessageId = m.id AND r.fromUserId != m.fromUserId) > 0 AS adminReply
            FROM internal_messages m
            LEFT JOIN users sender ON m.fromUserId = sender.id
            WHERE m.isDeleted = FALSE 
            AND m.toUserId IN (SELECT id FROM users WHERE isAdmin = TRUE)
            ORDER BY m.createdAt DESC
            LIMIT 200
        `);
        res.json({ success: true, messages: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Send message to user
app.post('/api/admin/messages/send', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { toUserId, toEmail, subject, message } = req.body;
        
        if (!subject || !message) {
            return res.status(400).json({ success: false, message: 'Subject and message required' });
        }

        let recipientId = toUserId;
        if (!recipientId && toEmail) {
            const [users] = await pool.execute('SELECT id FROM users WHERE email = ?', [toEmail.toLowerCase()]);
            if (users.length === 0) {
                return res.status(404).json({ success: false, message: 'User not found' });
            }
            recipientId = users[0].id;
        }

        if (!recipientId) {
            return res.status(400).json({ success: false, message: 'Recipient required' });
        }

        const [result] = await pool.execute(`
            INSERT INTO internal_messages (fromUserId, toUserId, subject, message)
            VALUES (?, ?, ?, ?)
        `, [req.auth.id, recipientId, subject, message]);

        res.json({ success: true, message: 'Message sent', messageId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Reply to a message
app.put('/api/admin/messages/:id/reply', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { adminReply, reply, subject } = req.body;
        const replyText = adminReply || reply;

        if (!replyText) {
            return res.status(400).json({ success: false, message: 'Reply is required' });
        }

        // Get the original message to find the user
        const [messages] = await pool.execute(
            'SELECT * FROM internal_messages WHERE id = ?',
            [id]
        );

        if (messages.length === 0) {
            return res.status(404).json({ success: false, message: 'Message not found' });
        }

        const originalMessage = messages[0];
        const toUserId = originalMessage.fromUserId;

        // Create a reply message
        const [result] = await pool.execute(`
            INSERT INTO internal_messages (fromUserId, toUserId, subject, message, parentMessageId)
            VALUES (?, ?, ?, ?, ?)
        `, [req.auth.id, toUserId, subject || `Re: ${originalMessage.subject}`, replyText, id]);

        // Mark original as replied (you could add an adminReply column if needed)
        await pool.execute(
            'UPDATE internal_messages SET isRead = TRUE WHERE id = ?',
            [id]
        );

        res.json({ success: true, message: 'Reply sent', messageId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ADMIN SUPPORT TICKETS (ALTERNATE ROUTES) ====================

// Admin: Get support tickets (alternate route for admin panel)
app.get('/api/admin/support-tickets', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status, priority, limit = 50 } = req.query;
        
        let query = `SELECT st.id, st.ticketNumber, st.subject, st.description, st.category, 
                            st.priority, st.status, st.adminReply, st.createdAt, st.updatedAt,
                            u.firstName, u.lastName, u.email as userEmail
                     FROM support_tickets st
                     JOIN users u ON st.userId = u.id WHERE 1=1`;
        const params = [];
        
        if (status && status !== 'all') { 
            query += ' AND st.status = ?'; 
            params.push(status); 
        }
        if (priority) { 
            query += ' AND st.priority = ?'; 
            params.push(priority); 
        }
        query += ' ORDER BY st.createdAt DESC LIMIT ?';
        params.push(parseInt(limit));
        
        const [tickets] = await pool.execute(query, params);
        res.json({ success: true, tickets });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Update support ticket (reply/status)
app.put('/api/admin/support-tickets/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { adminReply, status } = req.body;

        // Check ticket exists
        const [tickets] = await pool.execute('SELECT * FROM support_tickets WHERE id = ?', [id]);
        if (tickets.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const ticket = tickets[0];
        let updateFields = [];
        let updateParams = [];

        if (adminReply) {
            updateFields.push('adminReply = ?');
            updateParams.push(adminReply);
        }

        if (status) {
            updateFields.push('status = ?');
            updateParams.push(status);
            
            if (status === 'resolved') {
                updateFields.push('resolvedBy = ?');
                updateFields.push('resolvedAt = NOW()');
                updateParams.push(req.auth.id);
            }
        }

        if (updateFields.length > 0) {
            updateFields.push('updatedAt = NOW()');
            updateParams.push(id);
            
            await pool.execute(
                `UPDATE support_tickets SET ${updateFields.join(', ')} WHERE id = ?`,
                updateParams
            );
        }

        // Send notification to user
        try {
            await pool.execute(
                `INSERT INTO notifications (userId, type, title, message, data) 
                 VALUES (?, 'system', 'Support Ticket Update', ?, ?)`,
                [ticket.userId, `Your support ticket has been updated.`, JSON.stringify({ ticketId: id })]
            );
        } catch (notifError) {
            // non-critical notification error
        }

        res.json({ success: true, message: 'Ticket updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== 8. TRANSACTION CATEGORIES ====================

// Get spending by category
app.get('/api/user/spending-analytics', requireAuth, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        
        let dateFilter = '';
        const params = [req.auth.id];
        
        if (startDate && endDate) {
            dateFilter = 'AND t.createdAt BETWEEN ? AND ?';
            params.push(startDate, endDate);
        } else {
            // Default to last 30 days
            dateFilter = 'AND t.createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
        }

        // Get spending by category
        const [categories] = await pool.execute(`
            SELECT 
                COALESCE(t.category, 'uncategorized') as category,
                COUNT(*) as transactionCount,
                SUM(t.amount) as totalAmount
            FROM transactions t
            WHERE t.fromUserId = ? ${dateFilter}
            GROUP BY COALESCE(t.category, 'uncategorized')
            ORDER BY totalAmount DESC
        `, params);

        // Get daily spending trend
        const [daily] = await pool.execute(`
            SELECT 
                DATE(t.createdAt) as date,
                SUM(t.amount) as totalAmount,
                COUNT(*) as transactionCount
            FROM transactions t
            WHERE t.fromUserId = ? ${dateFilter}
            GROUP BY DATE(t.createdAt)
            ORDER BY date ASC
        `, params);

        // Get total in/out
        const [totals] = await pool.execute(`
            SELECT 
                SUM(CASE WHEN fromUserId = ? THEN amount ELSE 0 END) as totalOut,
                SUM(CASE WHEN toUserId = ? THEN amount ELSE 0 END) as totalIn
            FROM transactions
            WHERE (fromUserId = ? OR toUserId = ?) ${dateFilter.replace(/t\./g, '')}
        `, [req.auth.id, req.auth.id, req.auth.id, req.auth.id, ...(startDate && endDate ? [startDate, endDate] : [])]);

        res.json({
            success: true,
            analytics: {
                byCategory: categories,
                dailyTrend: daily,
                totals: totals[0]
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Set transaction category
app.post('/api/transactions/:transactionId/category', requireAuth, async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { category, notes } = req.body;

        if (!category) {
            return res.status(400).json({ success: false, message: 'Category required' });
        }

        // Verify user owns this transaction
        const [txns] = await pool.execute(
            'SELECT * FROM transactions WHERE id = ? AND (fromUserId = ? OR toUserId = ?)',
            [transactionId, req.auth.id, req.auth.id]
        );

        if (txns.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        // Update transaction category
        await pool.execute(
            'UPDATE transactions SET category = ? WHERE id = ?',
            [category, transactionId]
        );

        // Also store in transaction_categories for more details
        await pool.execute(`
            INSERT INTO transaction_categories (userId, transactionId, category, notes)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE category = VALUES(category), notes = VALUES(notes)
        `, [req.auth.id, transactionId, category, notes || null]);

        res.json({ success: true, message: 'Category set' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get available categories
app.get('/api/transaction-categories', async (req, res) => {
    const categories = [
        { id: 'food', name: 'Food & Dining', icon: 'utensils', color: '#e74c3c' },
        { id: 'shopping', name: 'Shopping', icon: 'shopping-bag', color: '#9b59b6' },
        { id: 'transport', name: 'Transportation', icon: 'car', color: '#3498db' },
        { id: 'bills', name: 'Bills & Utilities', icon: 'file-invoice-dollar', color: '#f39c12' },
        { id: 'entertainment', name: 'Entertainment', icon: 'film', color: '#e91e63' },
        { id: 'health', name: 'Health & Fitness', icon: 'heartbeat', color: '#2ecc71' },
        { id: 'education', name: 'Education', icon: 'graduation-cap', color: '#00bcd4' },
        { id: 'travel', name: 'Travel', icon: 'plane', color: '#ff5722' },
        { id: 'income', name: 'Income', icon: 'dollar-sign', color: '#27ae60' },
        { id: 'savings', name: 'Savings', icon: 'piggy-bank', color: '#1a472a' },
        { id: 'investment', name: 'Investment', icon: 'chart-line', color: '#673ab7' },
        { id: 'other', name: 'Other', icon: 'ellipsis-h', color: '#95a5a6' }
    ];
    res.json({ success: true, categories });
});

// ==================== 9. SUPPORT TICKET ENHANCEMENTS ====================

// User: Create support ticket
app.post('/api/support/tickets', requireAuth, async (req, res) => {
    try {
        const { category, subject, description, priority } = req.body;
        
        if (!category || !subject || !description) {
            return res.status(400).json({ success: false, message: 'Category, subject, and description required' });
        }

        const ticketNumber = 'TKT' + Date.now().toString(36).toUpperCase();

        const [result] = await pool.execute(`
            INSERT INTO support_tickets (ticketNumber, userId, category, subject, description, priority)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [ticketNumber, req.auth.id, category, subject, description, priority || 'normal']);

        res.json({ success: true, message: 'Ticket created', ticketNumber, ticketId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// User: Get my tickets
app.get('/api/support/tickets', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT * FROM support_tickets WHERE userId = ? ORDER BY createdAt DESC
        `, [req.auth.id]);
        res.json({ success: true, tickets: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// User: Get ticket details with replies
app.get('/api/support/tickets/:ticketId', requireAuth, async (req, res) => {
    try {
        const { ticketId } = req.params;
        
        const [tickets] = await pool.execute(
            'SELECT * FROM support_tickets WHERE id = ? AND userId = ?',
            [ticketId, req.auth.id]
        );

        if (tickets.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        const [replies] = await pool.execute(`
            SELECT r.*, u.firstName, u.lastName, u.isAdmin
            FROM ticket_replies r
            LEFT JOIN users u ON r.userId = u.id
            WHERE r.ticketId = ?
            ORDER BY r.createdAt ASC
        `, [ticketId]);

        res.json({ success: true, ticket: tickets[0], replies });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// User: Reply to ticket
app.post('/api/support/tickets/:ticketId/reply', requireAuth, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, message: 'Message required' });
        }

        // Verify ticket ownership
        const [tickets] = await pool.execute(
            'SELECT * FROM support_tickets WHERE id = ? AND userId = ?',
            [ticketId, req.auth.id]
        );

        if (tickets.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        await pool.execute(`
            INSERT INTO ticket_replies (ticketId, userId, message, isStaff)
            VALUES (?, ?, ?, FALSE)
        `, [ticketId, req.auth.id, message]);

        // Update ticket status
        await pool.execute(
            "UPDATE support_tickets SET status = 'open', updatedAt = NOW() WHERE id = ?",
            [ticketId]
        );

        res.json({ success: true, message: 'Reply added' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Get all tickets
app.get('/api/admin/support/tickets', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        let query = `
            SELECT t.*, u.firstName, u.lastName, u.email
            FROM support_tickets t
            LEFT JOIN users u ON t.userId = u.id
        `;
        const params = [];

        if (status) {
            query += ' WHERE t.status = ?';
            params.push(status);
        }

        query += ' ORDER BY t.createdAt DESC';

        const [rows] = await pool.execute(query, params);
        res.json({ success: true, tickets: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Reply to ticket
app.post('/api/admin/support/tickets/:ticketId/reply', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { message, status } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, message: 'Message required' });
        }

        await pool.execute(`
            INSERT INTO ticket_replies (ticketId, userId, message, isStaff)
            VALUES (?, ?, ?, TRUE)
        `, [ticketId, req.auth.id, message]);

        // Update ticket status
        const newStatus = status || 'in_progress';
        await pool.execute(
            'UPDATE support_tickets SET status = ?, assignedTo = ?, updatedAt = NOW() WHERE id = ?',
            [newStatus, req.auth.id, ticketId]
        );

        res.json({ success: true, message: 'Reply added' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin: Update ticket status
app.put('/api/admin/support/tickets/:ticketId/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { status, resolution } = req.body;

        const updates = ['status = ?', 'updatedAt = NOW()'];
        const params = [status];

        if (status === 'resolved' || status === 'closed') {
            updates.push('resolvedBy = ?', 'resolvedAt = NOW()');
            params.push(req.auth.id);
            if (resolution) {
                updates.push('resolution = ?');
                params.push(resolution);
            }
        }
        if (status === 'closed') {
            updates.push('closedAt = NOW()');
        }

        params.push(ticketId);
        await pool.execute(`UPDATE support_tickets SET ${updates.join(', ')} WHERE id = ?`, params);

        res.json({ success: true, message: 'Ticket updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== LOAN APPLICATION ENDPOINTS ====================

// Create loan_applications table if not exists
async function ensureLoanTables() {
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS loan_applications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                loan_type VARCHAR(50) NOT NULL,
                loan_amount DECIMAL(15,2) NOT NULL,
                loan_duration_months INT NOT NULL,
                interest_rate DECIMAL(5,2) DEFAULT 6.99,
                monthly_payment DECIMAL(15,2),
                monthly_income DECIMAL(15,2),
                employment_status VARCHAR(50),
                employer_name VARCHAR(100),
                years_employed INT,
                purpose TEXT,
                first_name VARCHAR(50),
                last_name VARCHAR(50),
                email VARCHAR(100),
                phone VARCHAR(20),
                address VARCHAR(255),
                city VARCHAR(100),
                state VARCHAR(50),
                zip VARCHAR(20),
                status ENUM('pending', 'under_review', 'approved', 'rejected', 'disbursed') DEFAULT 'pending',
                admin_notes TEXT,
                reviewed_by INT,
                reviewed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

    } catch (e) {
        if (!e.message.includes('already exists')) {
            console.error('Error creating loan_applications table:', e.message);
        }
    }
}

// Create investments table if not exists
async function ensureInvestmentTables() {
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS investments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                product_name VARCHAR(100) NOT NULL,
                product_type ENUM('savings_bond', 'index_fund', 'fixed_deposit', 'growth_fund') NOT NULL,
                amount DECIMAL(15,2) NOT NULL,
                apy DECIMAL(5,2) NOT NULL,
                period_years INT NOT NULL,
                estimated_return DECIMAL(15,2),
                maturity_date DATE,
                status ENUM('active', 'matured', 'withdrawn', 'cancelled') DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

    } catch (e) {
        if (!e.message.includes('already exists')) {
            console.error('Error creating investments table:', e.message);
        }
    }
}

// Create chat_messages table for live chat
async function ensureChatTables() {
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                session_id VARCHAR(100) NOT NULL,
                message TEXT NOT NULL,
                sender_type ENUM('user', 'agent', 'system') NOT NULL,
                agent_id INT,
                is_read BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id),
                INDEX idx_session_id (session_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                session_id VARCHAR(100) UNIQUE NOT NULL,
                status ENUM('active', 'waiting', 'closed') DEFAULT 'waiting',
                agent_id INT,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME,
                INDEX idx_user_id (user_id),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

    } catch (e) {
        if (!e.message.includes('already exists')) {
            console.error('Error creating chat tables:', e.message);
        }
    }
}

// Initialize tables
setTimeout(async () => {
    await ensureLoanTables();
    await ensureInvestmentTables();
    await ensureChatTables();
}, 2000);

// Submit loan application
app.post('/api/loans/apply', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;
        const {
            loanType, amount, term, firstName, lastName, email, phone,
            address, city, state, zip, employment, employer, income,
            yearsEmployed, purpose
        } = req.body;

        // Validation
        if (!loanType || !amount || !term) {
            return res.status(400).json({ success: false, message: 'Loan type, amount, and term are required' });
        }

        const loanAmount = parseFloat(amount);
        const loanDuration = parseInt(term);
        
        if (loanAmount < 1000 || loanAmount > 500000) {
            return res.status(400).json({ success: false, message: 'Loan amount must be between $1,000 and $500,000' });
        }

        // Calculate interest rate based on loan type
        const rates = {
            personal: 6.99, home: 5.25, auto: 4.49,
            business: 7.50, education: 4.99, emergency: 9.99
        };
        const interestRate = rates[loanType] || 6.99;

        // Calculate monthly payment
        const monthlyRate = interestRate / 100 / 12;
        const monthlyPayment = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, loanDuration)) / 
                              (Math.pow(1 + monthlyRate, loanDuration) - 1);

        const [result] = await pool.execute(`
            INSERT INTO loan_applications (
                user_id, loan_type, loan_amount, loan_duration_months, interest_rate,
                monthly_payment, monthly_income, employment_status, employer_name,
                years_employed, purpose, first_name, last_name, email, phone,
                address, city, state, zip, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `, [
            userId, loanType, loanAmount, loanDuration, interestRate,
            monthlyPayment.toFixed(2), income || null, employment || null, employer || null,
            yearsEmployed || null, purpose || null, firstName || null, lastName || null,
            email || null, phone || null, address || null, city || null, state || null, zip || null
        ]);

        // Log activity
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details) VALUES (?, ?, ?)',
            [userId, 'LOAN_APPLICATION', `Applied for ${loanType} loan of $${loanAmount.toLocaleString()}`]
        ).catch(() => {});

        res.status(201).json({
            success: true,
            message: 'Loan application submitted successfully',
            applicationId: `LOAN-${result.insertId}`,
            estimatedMonthlyPayment: parseFloat(monthlyPayment.toFixed(2))
        });
    } catch (error) {
        console.error('Loan application error:', error);
        res.status(500).json({ success: false, message: 'Error submitting loan application' });
    }
});

// Get user's loan applications
app.get('/api/loans/my-applications', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;
        
        const [applications] = await pool.execute(`
            SELECT id, loan_type as loanType, loan_amount as amount, 
                   loan_duration_months as term, interest_rate as rate,
                   monthly_payment as monthlyPayment, status, 
                   created_at as createdAt, reviewed_at as reviewedAt,
                   admin_notes as adminNotes
            FROM loan_applications 
            WHERE user_id = ? 
            ORDER BY created_at DESC
        `, [userId]);

        res.json({ success: true, applications });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching applications' });
    }
});

// Get specific loan application
app.get('/api/loans/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.auth.id;
        
        const [applications] = await pool.execute(`
            SELECT * FROM loan_applications WHERE id = ? AND user_id = ?
        `, [id, userId]);

        if (applications.length === 0) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        res.json({ success: true, application: applications[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching application' });
    }
});

// Admin: Get all loan applications
app.get('/api/admin/loans', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT la.*, u.firstName, u.lastName, u.email as userEmail
            FROM loan_applications la
            LEFT JOIN users u ON la.user_id = u.id
        `;
        const params = [];

        if (status) {
            query += ' WHERE la.status = ?';
            params.push(status);
        }

        query += ' ORDER BY la.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [applications] = await pool.execute(query, params);

        // Get total count
        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM loan_applications' + (status ? ' WHERE status = ?' : ''),
            status ? [status] : []
        );

        res.json({
            success: true,
            applications,
            total: countResult[0].total,
            page: parseInt(page),
            totalPages: Math.ceil(countResult[0].total / limit)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching loan applications' });
    }
});

// Admin: Update loan status
app.put('/api/admin/loans/:id/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, adminNotes } = req.body;

        if (!['pending', 'under_review', 'approved', 'rejected', 'disbursed'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        await pool.execute(`
            UPDATE loan_applications 
            SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = NOW()
            WHERE id = ?
        `, [status, adminNotes || null, req.auth.id, id]);

        // If approved, notify user
        if (status === 'approved') {
            const [apps] = await pool.execute('SELECT user_id, loan_amount, loan_type FROM loan_applications WHERE id = ?', [id]);
            if (apps.length > 0) {
                await pool.execute(
                    'INSERT INTO notifications (userId, type, title, message) VALUES (?, ?, ?, ?)',
                    [apps[0].user_id, 'loan', 'Loan Approved!', 
                     `Your ${apps[0].loan_type} loan application for $${apps[0].loan_amount} has been approved.`]
                ).catch(() => {});
            }
        }

        res.json({ success: true, message: `Loan application ${status}` });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating loan status' });
    }
});

// ==================== INVESTMENT ENDPOINTS ====================

// Create/submit investment
app.post('/api/investments/invest', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;
        const { product, amount, period } = req.body;

        if (!product || !amount || !period) {
            return res.status(400).json({ success: false, message: 'Product, amount, and period are required' });
        }

        const investAmount = parseFloat(amount);
        const periodYears = parseInt(period);

        if (investAmount < 500) {
            return res.status(400).json({ success: false, message: 'Minimum investment is $500' });
        }

        // Get user balance
        const [users] = await pool.execute('SELECT balance FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userBalance = parseFloat(users[0].balance) || 0;
        if (userBalance < investAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }

        // Determine product type and APY
        const productTypes = {
            'Savings Bond': { type: 'savings_bond', apy: 3.5 },
            'Index Fund': { type: 'index_fund', apy: 7.2 },
            'Fixed Deposit': { type: 'fixed_deposit', apy: 4.8 },
            'Growth Fund': { type: 'growth_fund', apy: 9.5 }
        };

        // Extract product name from input
        const productName = Object.keys(productTypes).find(p => product.includes(p)) || 'Fixed Deposit';
        const productInfo = productTypes[productName];
        
        // Calculate estimated return using compound interest
        const estimatedReturn = investAmount * Math.pow(1 + productInfo.apy / 100, periodYears) - investAmount;
        const maturityDate = new Date();
        maturityDate.setFullYear(maturityDate.getFullYear() + periodYears);

        // Deduct from balance
        await pool.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [investAmount, userId]);

        // Create investment record
        const [result] = await pool.execute(`
            INSERT INTO investments (user_id, product_name, product_type, amount, apy, period_years, estimated_return, maturity_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [userId, productName, productInfo.type, investAmount, productInfo.apy, periodYears, estimatedReturn.toFixed(2), maturityDate.toISOString().split('T')[0]]);

        // Create transaction record
        await pool.execute(`
            INSERT INTO transactions (fromUserId, type, amount, description, status, reference)
            VALUES (?, 'investment', ?, ?, 'completed', ?)
        `, [userId, investAmount, `Investment in ${productName} for ${periodYears} years`, `INV-${result.insertId}`]);

        // Log activity
        await pool.execute(
            'INSERT INTO activity_logs (user_id, action_type, action_details) VALUES (?, ?, ?)',
            [userId, 'INVESTMENT', `Invested $${investAmount.toLocaleString()} in ${productName}`]
        ).catch(() => {});

        res.status(201).json({
            success: true,
            message: 'Investment created successfully',
            investment: {
                id: result.insertId,
                product: productName,
                amount: investAmount,
                apy: productInfo.apy,
                period: periodYears,
                estimatedReturn: parseFloat(estimatedReturn.toFixed(2)),
                maturityDate: maturityDate.toISOString().split('T')[0],
                newBalance: userBalance - investAmount
            }
        });
    } catch (error) {
        console.error('Investment error:', error);
        res.status(500).json({ success: false, message: 'Error creating investment' });
    }
});

// Get user's investments
app.get('/api/investments/my-investments', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;

        const [investments_list] = await pool.execute(`
            SELECT id, product_name as product, product_type as type, amount, 
                   apy, period_years as period, estimated_return as estimatedReturn,
                   maturity_date as maturityDate, status, created_at as investedAt
            FROM investments
            WHERE user_id = ?
            ORDER BY created_at DESC
        `, [userId]);

        // Calculate totals
        const totalInvested = investments_list.reduce((sum, inv) => sum + parseFloat(inv.amount), 0);
        const totalEstimatedReturn = investments_list.reduce((sum, inv) => sum + parseFloat(inv.estimatedReturn || 0), 0);

        res.json({
            success: true,
            totalInvested,
            totalEstimatedReturn,
            count: investments_list.length,
            investments: investments_list
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching investments' });
    }
});

// Get investment details
app.get('/api/investments/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.auth.id;

        const [investments_list] = await pool.execute(`
            SELECT * FROM investments WHERE id = ? AND user_id = ?
        `, [id, userId]);

        if (investments_list.length === 0) {
            return res.status(404).json({ success: false, message: 'Investment not found' });
        }

        res.json({ success: true, investment: investments_list[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching investment' });
    }
});

// ==================== LIVE CHAT ENDPOINTS ====================

// Start a chat session
app.post('/api/chat/start', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;
        const sessionId = `CHAT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Check for existing active session
        const [existing] = await pool.execute(
            'SELECT * FROM chat_sessions WHERE user_id = ? AND status IN ("active", "waiting")',
            [userId]
        );

        if (existing.length > 0) {
            return res.json({ success: true, sessionId: existing[0].session_id, resumed: true });
        }

        // Create new session
        await pool.execute(
            'INSERT INTO chat_sessions (user_id, session_id, status) VALUES (?, ?, "waiting")',
            [userId, sessionId]
        );

        // Add welcome message
        await pool.execute(
            'INSERT INTO chat_messages (user_id, session_id, message, sender_type) VALUES (?, ?, ?, "system")',
            [userId, sessionId, 'Welcome to Heritage Bank Live Chat! A support agent will be with you shortly. Average wait time is 2-3 minutes.']
        );

        res.json({ success: true, sessionId, resumed: false });
    } catch (error) {
        console.error('Chat start error:', error);
        res.status(500).json({ success: false, message: 'Error starting chat' });
    }
});

// Send chat message
app.post('/api/chat/message', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;
        const { sessionId, message } = req.body;

        if (!sessionId || !message) {
            return res.status(400).json({ success: false, message: 'Session ID and message required' });
        }

        // Verify session belongs to user
        const [sessions] = await pool.execute(
            'SELECT * FROM chat_sessions WHERE session_id = ? AND user_id = ?',
            [sessionId, userId]
        );

        if (sessions.length === 0) {
            return res.status(404).json({ success: false, message: 'Chat session not found' });
        }

        // Insert message
        const [result] = await pool.execute(
            'INSERT INTO chat_messages (user_id, session_id, message, sender_type) VALUES (?, ?, ?, "user")',
            [userId, sessionId, message]
        );

        // Auto-response (simulated agent for demo)
        const autoResponses = [
            'Thank you for your message. Let me look into that for you.',
            'I understand your concern. Let me check our records.',
            'I appreciate your patience. One moment please.',
            'That\'s a great question! Let me provide you with the information.'
        ];

        // Add simulated agent response after a short delay (for demo purposes)
        setTimeout(async () => {
            try {
                const randomResponse = autoResponses[Math.floor(Math.random() * autoResponses.length)];
                await pool.execute(
                    'INSERT INTO chat_messages (user_id, session_id, message, sender_type) VALUES (?, ?, ?, "agent")',
                    [userId, sessionId, randomResponse]
                );
            } catch (e) {}
        }, 2000);

        res.json({ success: true, messageId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error sending message' });
    }
});

// Get chat messages
app.get('/api/chat/messages/:sessionId', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;
        const { sessionId } = req.params;
        const { since } = req.query;

        // Verify session belongs to user
        const [sessions] = await pool.execute(
            'SELECT * FROM chat_sessions WHERE session_id = ? AND user_id = ?',
            [sessionId, userId]
        );

        if (sessions.length === 0) {
            return res.status(404).json({ success: false, message: 'Chat session not found' });
        }

        let query = 'SELECT id, message, sender_type as sender, created_at as timestamp FROM chat_messages WHERE session_id = ?';
        const params = [sessionId];

        if (since) {
            query += ' AND id > ?';
            params.push(parseInt(since));
        }

        query += ' ORDER BY created_at ASC';

        const [messages] = await pool.execute(query, params);

        res.json({ success: true, messages, sessionStatus: sessions[0].status });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching messages' });
    }
});

// End chat session
app.post('/api/chat/end', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.id;
        const { sessionId } = req.body;

        await pool.execute(
            'UPDATE chat_sessions SET status = "closed", ended_at = NOW() WHERE session_id = ? AND user_id = ?',
            [sessionId, userId]
        );

        // Add closing message
        await pool.execute(
            'INSERT INTO chat_messages (user_id, session_id, message, sender_type) VALUES (?, ?, ?, "system")',
            [userId, sessionId, 'Chat session ended. Thank you for contacting Heritage Bank!']
        );

        res.json({ success: true, message: 'Chat session ended' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error ending chat' });
    }
});

// Admin: Get all active chat sessions
app.get('/api/admin/chats', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [sessions] = await pool.execute(`
            SELECT cs.*, u.firstName, u.lastName, u.email,
                   (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.session_id) as messageCount
            FROM chat_sessions cs
            LEFT JOIN users u ON cs.user_id = u.id
            WHERE cs.status IN ('active', 'waiting')
            ORDER BY cs.started_at DESC
        `);

        res.json({ success: true, sessions });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching chat sessions' });
    }
});

// Admin: Send message to chat
app.post('/api/admin/chat/message', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { sessionId, message } = req.body;

        const [sessions] = await pool.execute('SELECT * FROM chat_sessions WHERE session_id = ?', [sessionId]);
        if (sessions.length === 0) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        // Update session status to active if it was waiting
        if (sessions[0].status === 'waiting') {
            await pool.execute(
                'UPDATE chat_sessions SET status = "active", agent_id = ? WHERE session_id = ?',
                [req.auth.id, sessionId]
            );
        }

        await pool.execute(
            'INSERT INTO chat_messages (user_id, session_id, message, sender_type, agent_id) VALUES (?, ?, ?, "agent", ?)',
            [sessions[0].user_id, sessionId, message, req.auth.id]
        );

        res.json({ success: true, message: 'Message sent' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error sending message' });
    }
});

// ==================== MOBILE CHECK DEPOSIT ====================

// User: Submit a check deposit
app.post('/api/check-deposit', requireAuth, async (req, res) => {
    try {
        const decoded = req.auth;
        const { amount, accountType, checkNumber, payer, memo, frontImage, backImage } = req.body;

        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid check amount' });
        }
        if (parseFloat(amount) > 50000) {
            return res.status(400).json({ success: false, message: 'Maximum single check deposit is $50,000' });
        }
        if (!frontImage || !backImage) {
            return res.status(400).json({ success: false, message: 'Both front and back check images are required' });
        }

        const reference = 'DEP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

        await pool.execute(
            `INSERT INTO check_deposits (userId, amount, accountType, checkNumber, payer, memo, frontImage, backImage, reference, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [decoded.id, parseFloat(amount), accountType || 'checking', checkNumber || null, payer || null, memo || null, frontImage, backImage, reference]
        );

        // Log activity
        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [decoded.id, 'CHECK_DEPOSIT_SUBMITTED', `Check deposit of $${parseFloat(amount).toLocaleString()} submitted (Ref: ${reference})`, req.ip || null]
            );
        } catch (e) {}

        res.json({ success: true, reference, message: 'Check deposit submitted for review' });
    } catch (error) {
        console.error('Check deposit error:', error);
        res.status(500).json({ success: false, message: 'Error submitting deposit' });
    }
});

// User: Get their check deposits
app.get('/api/check-deposits', requireAuth, async (req, res) => {
    try {
        const decoded = req.auth;
        const [deposits] = await pool.execute(
            'SELECT id, amount, accountType, checkNumber, payer, memo, reference, status, rejectionReason, createdAt, reviewedAt FROM check_deposits WHERE userId = ? ORDER BY createdAt DESC LIMIT 50',
            [decoded.id]
        );
        res.json({ success: true, deposits });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error loading deposits' });
    }
});

// Admin: Get all pending check deposits
app.get('/api/admin/check-deposits', requireAuth, requireAdmin, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const [deposits] = await pool.execute(
            `SELECT cd.*, u.firstName, u.lastName, u.email, u.accountNumber
             FROM check_deposits cd
             JOIN users u ON cd.userId = u.id
             WHERE cd.status = ?
             ORDER BY cd.createdAt DESC`,
            [status]
        );
        res.json({ success: true, deposits });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error loading check deposits' });
    }
});

// Admin: Approve a check deposit — credits the user's balance
app.post('/api/admin/approve-check-deposit/:depositId', requireAuth, requireAdmin, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { depositId } = req.params;
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT * FROM check_deposits WHERE id = ? AND status = ? FOR UPDATE',
            [depositId, 'pending']
        );
        const deposit = rows[0];
        if (!deposit) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'Pending deposit not found or already processed' });
        }

        const amountValue = parseFloat(deposit.amount);

        // Credit user's balance
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amountValue, deposit.userId]);

        // Update deposit status
        await connection.execute(
            'UPDATE check_deposits SET status = ?, reviewedAt = NOW(), reviewedBy = ? WHERE id = ?',
            ['approved', req.auth.id, depositId]
        );

        // Create a transaction record for the deposit
        const txRef = deposit.reference || 'DEP-' + Date.now().toString(36).toUpperCase();
        await connection.execute(
            `INSERT INTO transactions (fromUserId, toUserId, amount, type, description, status, reference, createdAt)
             VALUES (NULL, ?, ?, 'check_deposit', ?, 'completed', ?, NOW())`,
            [deposit.userId, amountValue, `Mobile Check Deposit${deposit.checkNumber ? ' #' + deposit.checkNumber : ''}${deposit.payer ? ' from ' + deposit.payer : ''}`, txRef]
        );

        // Log activity
        try {
            await connection.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [deposit.userId, 'CHECK_DEPOSIT_APPROVED', `Check deposit of $${amountValue.toLocaleString()} approved. Balance credited.`, req.ip || null]
            );
        } catch (e) {}

        await connection.commit();

        // Fetch updated user info for response
        const [users] = await pool.execute('SELECT firstName, lastName, balance FROM users WHERE id = ?', [deposit.userId]);
        const user = users[0];

        res.json({
            success: true,
            message: `Check deposit of $${amountValue.toLocaleString()} approved. ${user ? user.firstName + ' ' + user.lastName + "'s" : 'User'} balance credited. New balance: $${user ? parseFloat(user.balance).toLocaleString() : 'N/A'}`
        });
    } catch (error) {
        try { await connection.rollback(); } catch (e) {}
        console.error('Approve check deposit error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Admin: Reject a check deposit
app.post('/api/admin/reject-check-deposit/:depositId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { depositId } = req.params;
        const { reason } = req.body;

        const [rows] = await pool.execute('SELECT * FROM check_deposits WHERE id = ? AND status = ?', [depositId, 'pending']);
        if (!rows[0]) {
            return res.status(404).json({ success: false, message: 'Pending deposit not found or already processed' });
        }

        await pool.execute(
            'UPDATE check_deposits SET status = ?, rejectionReason = ?, reviewedAt = NOW(), reviewedBy = ? WHERE id = ?',
            ['rejected', reason || 'Rejected by admin', req.auth.id, depositId]
        );

        // Log activity
        try {
            await pool.execute(
                'INSERT INTO activity_logs (user_id, action_type, action_details, ip_address) VALUES (?, ?, ?, ?)',
                [rows[0].userId, 'CHECK_DEPOSIT_REJECTED', `Check deposit of $${parseFloat(rows[0].amount).toLocaleString()} rejected. Reason: ${reason || 'Rejected by admin'}`, req.ip || null]
            );
        } catch (e) {}

        res.json({ success: true, message: 'Check deposit rejected' });
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

// ==================== ROUTE ALIASES (frontend compatibility) ====================

// Support tickets: frontend uses /api/support-tickets, backend uses /api/support/tickets
app.get('/api/support-tickets', requireAuth, async (req, res) => { req.url = '/api/support/tickets'; app.handle(req, res); });
app.post('/api/support-tickets', requireAuth, async (req, res) => { req.url = '/api/support/tickets'; app.handle(req, res); });

// Messages: frontend uses /api/messages, backend uses /api/messages/inbox|sent|send
app.get('/api/messages', requireAuth, async (req, res) => {
    const type = req.query.type || 'inbox';
    req.url = `/api/messages/${type}`;
    app.handle(req, res);
});
app.post('/api/messages', requireAuth, async (req, res) => { req.url = '/api/messages/send'; app.handle(req, res); });

// Analytics: frontend uses /api/analytics, backend uses /api/user/spending-analytics
app.get('/api/analytics', requireAuth, async (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    req.url = '/api/user/spending-analytics' + qs;
    app.handle(req, res);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Heritage Bank running on port ${PORT}`);
});
