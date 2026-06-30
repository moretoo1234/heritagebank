/**
 * TiDB Database Module
 * Handles all database connections and queries for Heritage Bank
 */

const mysql = require('mysql2/promise');

let pool = null;
let passwordColumn = null;
let passwordColumnDetecting = false;

/**
 * Initialize database connection pool
 */
async function initializePool() {
  if (pool) return pool;

  const config = {
    host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 4000),
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || process.env.DATABASE || 'heritage_bank',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    connectionTimeout: 10000,
    enableTimestamps: true,
    timezone: '+00:00',
    ssl: process.env.DB_SSL === 'false' || process.env.MYSQL_SSL === 'false'
      ? undefined
      : { rejectUnauthorized: true }
  };

  try {
    console.log(`[DB] Connecting to database: ${config.host}:${config.port}/${config.database}`);
    console.log(`[DB] Database env: DB_HOST=${Boolean(process.env.DB_HOST)}, MYSQLHOST=${Boolean(process.env.MYSQLHOST)}, DB_NAME=${Boolean(process.env.DB_NAME)}, MYSQLDATABASE=${Boolean(process.env.MYSQLDATABASE)}`);
    pool = mysql.createPool(config);
    console.log('[DB] ✓ Connection pool created successfully');
    return pool;
  } catch (error) {
    console.error('[DB] ✗ Failed to create connection pool:', error);
    throw error;
  }
}

/**
 * Initialize database schema (create tables if they don't exist)
 */
async function detectPasswordColumn() {
  if (passwordColumn) return passwordColumn;
  
  // Prevent multiple simultaneous detection attempts
  if (passwordColumnDetecting) {
    // Wait for detection to complete
    let attempts = 0;
    while (!passwordColumn && attempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    return passwordColumn || 'password';
  }
  
  passwordColumnDetecting = true;
  try {
    const pool = await initializePool();
    const [rows] = await pool.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME IN ('password', 'passwordHash')`,
      [process.env.DB_NAME || 'heritage_bank']
    );

    if (rows.some((column) => column.COLUMN_NAME === 'passwordHash')) {
      passwordColumn = 'passwordHash';
    } else if (rows.some((column) => column.COLUMN_NAME === 'password')) {
      passwordColumn = 'password';
    } else {
      passwordColumn = 'password';
    }
  } finally {
    passwordColumnDetecting = false;
  }

  return passwordColumn;
}

function normalizeUser(row) {
  if (!row) return null;
  if (!row.passwordHash && row.password) {
    row.passwordHash = row.password;
  }
  return row;
}

async function initializeSchema() {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    console.log('[DB] Initializing schema...');

    // Check if users table exists
    const [usersTables] = await connection.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
      [process.env.DB_NAME || process.env.MYSQLDATABASE || 'heritage_bank']
    );

    if (usersTables.length === 0) {
      // Only create tables if they don't exist (for dev/test environments)
      console.log('[DB] Creating users table...');
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT PRIMARY KEY AUTO_INCREMENT,
          email VARCHAR(255) UNIQUE NOT NULL,
          firstName VARCHAR(255) NOT NULL,
          lastName VARCHAR(255) NOT NULL,
          password VARCHAR(255) NOT NULL,
          accountNumber VARCHAR(64) DEFAULT NULL,
          routingNumber VARCHAR(32) DEFAULT NULL,
          swiftCode VARCHAR(64) DEFAULT NULL,
          balance DECIMAL(19, 2) DEFAULT 1000,
          accountStatus VARCHAR(50) DEFAULT 'active',
          transferRestricted BOOLEAN DEFAULT FALSE,
          isAdmin BOOLEAN DEFAULT FALSE,
          isLocked BOOLEAN DEFAULT FALSE,
          referralCode VARCHAR(16) UNIQUE,
          referredBy INT,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_email (email),
          INDEX idx_referralCode (referralCode),
          FOREIGN KEY (referredBy) REFERENCES users(id)
        )
      `);
      console.log('[DB] ✓ Users table created');

      console.log('[DB] Creating transactions table...');
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS transactions (
          id INT PRIMARY KEY AUTO_INCREMENT,
          fromUserId INT,
          toUserId INT,
          amount DECIMAL(19, 2) NOT NULL,
          type VARCHAR(50),
          description TEXT,
          status VARCHAR(50) DEFAULT 'completed',
          category VARCHAR(50),
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (fromUserId) REFERENCES users(id),
          FOREIGN KEY (toUserId) REFERENCES users(id),
          INDEX idx_fromUser (fromUserId),
          INDEX idx_toUser (toUserId),
          INDEX idx_createdAt (createdAt),
          INDEX idx_category (category)
        )
      `);
      console.log('[DB] ✓ Transactions table created');

      // New tables for features
      console.log('[DB] Creating scheduled_transfers table...');
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS scheduled_transfers (
          id INT PRIMARY KEY AUTO_INCREMENT,
          userId INT NOT NULL,
          recipientId INT,
          recipientEmail VARCHAR(255),
          amount DECIMAL(19, 2) NOT NULL,
          frequency VARCHAR(20) DEFAULT 'once',
          nextRunDate DATE NOT NULL,
          endDate DATE,
          description TEXT,
          status VARCHAR(20) DEFAULT 'active',
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id),
          INDEX idx_userId (userId),
          INDEX idx_nextRunDate (nextRunDate)
        )
      `);
      console.log('[DB] ✓ Scheduled transfers table created');

      console.log('[DB] Creating budgets table...');
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS budgets (
          id INT PRIMARY KEY AUTO_INCREMENT,
          userId INT NOT NULL,
          category VARCHAR(50) NOT NULL,
          limit DECIMAL(12, 2) NOT NULL,
          month VARCHAR(7) NOT NULL,
          spent DECIMAL(12, 2) DEFAULT 0,
          alertSent BOOLEAN DEFAULT FALSE,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id),
          INDEX idx_userId (userId),
          UNIQUE KEY unique_budget (userId, category, month)
        )
      `);
      console.log('[DB] ✓ Budgets table created');

      console.log('[DB] Creating disputes table...');
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS disputes (
          id INT PRIMARY KEY AUTO_INCREMENT,
          userId INT NOT NULL,
          transactionId INT,
          reason TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'open',
          adminNotes TEXT,
          resolution VARCHAR(50),
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id),
          INDEX idx_userId (userId),
          INDEX idx_status (status)
        )
      `);
      console.log('[DB] ✓ Disputes table created');

      console.log('[DB] Creating support_messages table...');
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS support_messages (
          id INT PRIMARY KEY AUTO_INCREMENT,
          userId INT NOT NULL,
          adminId INT,
          message TEXT NOT NULL,
          senderType VARCHAR(10) DEFAULT 'user',
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id),
          INDEX idx_userId (userId),
          INDEX idx_createdAt (createdAt)
        )
      `);
      console.log('[DB] ✓ Support messages table created');

      console.log('[DB] Creating referral_rewards table...');
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS referral_rewards (
          id INT PRIMARY KEY AUTO_INCREMENT,
          referrerId INT NOT NULL,
          referredUserId INT NOT NULL,
          rewardAmount DECIMAL(12, 2) DEFAULT 50,
          status VARCHAR(20) DEFAULT 'pending',
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (referrerId) REFERENCES users(id),
          FOREIGN KEY (referredUserId) REFERENCES users(id),
          INDEX idx_referrerId (referrerId)
        )
      `);
      console.log('[DB] ✓ Referral rewards table created');

    } else {
      // Tables already exist in production - just verify they have required columns
      console.log('[DB] ✓ Users table already exists (production schema)');
      console.log('[DB] ✓ Transactions table already exists (production schema)');
      // Backfill missing account identifiers for older rows that predate this schema
      try {
        console.log('[DB] Backfilling missing account numbers for users without accountNumber...');
        await connection.execute("UPDATE users SET accountNumber = CAST(1000000000 + id AS CHAR) WHERE accountNumber IS NULL");
        console.log('[DB] ✓ Backfilled accountNumber for existing users');
      } catch (backfillErr) {
        console.error('[DB] ✗ Backfill accountNumber failed:', backfillErr.message);
      }
      // Create new feature tables if missing
      try {
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS scheduled_transfers (
            id INT PRIMARY KEY AUTO_INCREMENT,
            userId INT NOT NULL,
            recipientId INT,
            recipientEmail VARCHAR(255),
            amount DECIMAL(19, 2) NOT NULL,
            frequency VARCHAR(20) DEFAULT 'once',
            nextRunDate DATE NOT NULL,
            endDate DATE,
            description TEXT,
            status VARCHAR(20) DEFAULT 'active',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id),
            INDEX idx_userId (userId),
            INDEX idx_nextRunDate (nextRunDate)
          )
        `);
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS budgets (
            id INT PRIMARY KEY AUTO_INCREMENT,
            userId INT NOT NULL,
            category VARCHAR(50) NOT NULL,
            limit DECIMAL(12, 2) NOT NULL,
            month VARCHAR(7) NOT NULL,
            spent DECIMAL(12, 2) DEFAULT 0,
            alertSent BOOLEAN DEFAULT FALSE,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id),
            INDEX idx_userId (userId),
            UNIQUE KEY unique_budget (userId, category, month)
          )
        `);
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS disputes (
            id INT PRIMARY KEY AUTO_INCREMENT,
            userId INT NOT NULL,
            transactionId INT,
            reason TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'open',
            adminNotes TEXT,
            resolution VARCHAR(50),
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id),
            INDEX idx_userId (userId),
            INDEX idx_status (status)
          )
        `);
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS support_messages (
            id INT PRIMARY KEY AUTO_INCREMENT,
            userId INT NOT NULL,
            adminId INT,
            message TEXT NOT NULL,
            senderType VARCHAR(10) DEFAULT 'user',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id),
            INDEX idx_userId (userId),
            INDEX idx_createdAt (createdAt)
          )
        `);
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS referral_rewards (
            id INT PRIMARY KEY AUTO_INCREMENT,
            referrerId INT NOT NULL,
            referredUserId INT NOT NULL,
            rewardAmount DECIMAL(12, 2) DEFAULT 50,
            status VARCHAR(20) DEFAULT 'pending',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (referrerId) REFERENCES users(id),
            FOREIGN KEY (referredUserId) REFERENCES users(id),
            INDEX idx_referrerId (referrerId)
          )
        `);
        console.log('[DB] ✓ New feature tables created/verified');
      } catch (tableErr) {
        console.error('[DB] ✗ New feature tables may not have been created:', tableErr.message);
      }
    }

  } catch (error) {
    console.error('[DB] ✗ Schema initialization error:', error);
    throw error;
  } finally {
    await connection.release();
  }
}

/**
 * Get user by email
 */
async function getUserByEmail(email) {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
    return normalizeUser(rows[0] || null);
  } finally {
    if (connection) {
      await connection.release();
    }
  }
}

/**
 * Get user by ID
 */
async function getUserById(id) {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute('SELECT * FROM users WHERE id = ?', [id]);
    return normalizeUser(rows[0] || null);
  } finally {
    if (connection) {
      await connection.release();
    }
  }
}

/**
 * Create user
 */
async function createUser(id, email, firstName, lastName, passwordHash, isAdmin = false, phone = null, gender = null) {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    const actualPasswordColumn = await detectPasswordColumn();
    console.log(`[DB] Creating user: ${email}, passwordColumn: ${actualPasswordColumn}, phone: ${phone}, gender: ${gender}`);
    const columns = ['email', 'firstName', 'lastName', actualPasswordColumn, 'balance', 'isAdmin'];
    const values = [email, firstName, lastName, passwordHash, 1000, isAdmin ? 1 : 0];

    if (phone) {
      columns.push('phone');
      values.push(phone);
    }
    if (gender) {
      columns.push('gender');
      values.push(gender);
    }
    if (id) {
      columns.unshift('id');
      values.unshift(id);
    }

    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO users (${columns.join(', ')}) VALUES (${placeholders})`;
    console.log(`[DB] SQL: ${sql}`);
    
    const [result] = await connection.execute(sql, values);
    console.log(`[DB] Insert successful, insertId: ${result.insertId}`);

    if (result.insertId) {
      // Ensure a stable accountNumber exists for the new user. Use a simple
      // deterministic scheme based on the auto-increment id so it's unique and
      // predictable in dev environments. In production, replace with proper
      // account number generation / formatting rules.
      try {
        const generatedAcct = String(1000000000 + result.insertId);
        await connection.execute('UPDATE users SET accountNumber = ? WHERE id = ? AND (accountNumber IS NULL OR accountNumber = "")', [generatedAcct, result.insertId]);
      } catch (acctErr) {
        console.error('[DB] Failed to set accountNumber for new user:', acctErr.message);
      }
      const user = await getUserById(result.insertId);
      console.log(`[DB] Fetched created user: ${user?.email}`);
      return user;
    }
    const user = await getUserByEmail(email);
    console.log(`[DB] Fetched created user by email: ${user?.email}`);
    return user;
  } catch (err) {
    console.error(`[DB] createUser failed for ${email}:`, err.message);
    console.error('[DB] Error stack:', err.stack);
    throw err;
  } finally {
    if (connection) {
      try {
        await connection.release();
      } catch (releaseErr) {
        console.error('[DB] Error releasing connection:', releaseErr.message);
      }
    }
  }
}

/**
 * Update user balance
 */
async function updateUserBalance(email, newBalance) {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    await connection.execute('UPDATE users SET balance = ? WHERE email = ?', [newBalance, email]);
    return getUserByEmail(email);
  } finally {
    await connection.release();
  }
}

/**
 * Lock/unlock user
 */
async function setUserLocked(email, locked) {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    await connection.execute('UPDATE users SET isLocked = ? WHERE email = ?', [locked ? 1 : 0, email]);
    return getUserByEmail(email);
  } finally {
    await connection.release();
  }
}

/**
 * Get all users (admin only)
 */
async function getAllUsers() {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    // Select columns that exist across different production schemas.
    // Some deployments use `isLocked` while others do not; select a safe subset.
    const [rows] = await connection.execute(`SELECT id, email, firstName, lastName, balance, isAdmin,
      accountNumber, accountStatus, transferRestricted, createdAt
      FROM users ORDER BY createdAt DESC`);
    return rows;
  } finally {
    await connection.release();
  }
}

/**
 * Record transaction
 */
async function recordTransaction(fromUserId, toUserId, amount, type, description) {
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'INSERT INTO transactions (fromUserId, toUserId, amount, type, description) VALUES (?, ?, ?, ?, ?)',
      [fromUserId, toUserId, amount, type, description]
    );
  } finally {
    await connection.release();
  }
}

/**
 * Get user transactions
 */
async function getUserTransactions(userId, limit = 50) {
  const safeLimit = Number(limit);
  const normalizedLimit = Number.isFinite(safeLimit) && safeLimit > 0 ? Math.floor(safeLimit) : 50;
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(
      `SELECT * FROM transactions WHERE fromUserId = ? OR toUserId = ? ORDER BY createdAt DESC LIMIT ${normalizedLimit}`,
      [userId, userId]
    );
    return rows;
  } finally {
    await connection.release();
  }
}

function generateReferralCode() {
  return 'REF' + Math.random().toString(36).substr(2, 10).toUpperCase();
}

module.exports = {
  initializePool,
  initializeSchema,
  getUserByEmail,
  getUserById,
  createUser,
  updateUserBalance,
  setUserLocked,
  getAllUsers,
  recordTransaction,
  getUserTransactions,
  generateReferralCode
};
