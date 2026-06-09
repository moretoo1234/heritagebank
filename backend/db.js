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
          balance DECIMAL(19, 2) DEFAULT 1000,
          isAdmin BOOLEAN DEFAULT FALSE,
          isLocked BOOLEAN DEFAULT FALSE,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_email (email)
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
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (fromUserId) REFERENCES users(id),
          FOREIGN KEY (toUserId) REFERENCES users(id),
          INDEX idx_fromUser (fromUserId),
          INDEX idx_toUser (toUserId),
          INDEX idx_createdAt (createdAt)
        )
      `);
      console.log('[DB] ✓ Transactions table created');
    } else {
      // Tables already exist in production - just verify they have required columns
      console.log('[DB] ✓ Users table already exists (production schema)');
      console.log('[DB] ✓ Transactions table already exists (production schema)');
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
    await connection.release();
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
    await connection.release();
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

    if (result.insertId) {
      return getUserById(result.insertId);
    }
    return getUserByEmail(email);
  } catch (err) {
    console.error(`[DB] createUser failed for ${email}:`, err.message);
    throw err;
  } finally {
    await connection.release();
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
    const [rows] = await connection.execute('SELECT id, email, firstName, lastName, balance, isAdmin, isLocked, createdAt FROM users ORDER BY createdAt DESC');
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
  const pool = await initializePool();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT * FROM transactions WHERE fromUserId = ? OR toUserId = ? ORDER BY createdAt DESC LIMIT ?',
      [userId, userId, limit]
    );
    return rows;
  } finally {
    await connection.release();
  }
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
  getUserTransactions
};
