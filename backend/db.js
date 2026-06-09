/**
 * TiDB Database Module
 * Handles all database connections and queries for Heritage Bank
 */

const mysql = require('mysql2/promise');

let pool = null;

/**
 * Initialize database connection pool
 */
async function initializePool() {
  if (pool) return pool;

  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'heritage_bank',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true
  };

  try {
    console.log(`[DB] Connecting to TiDB: ${config.host}:${config.port}/${config.database}`);
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
async function initializeSchema() {
  const pool = initializePool();
  const connection = await pool.getConnection();
  try {
    console.log('[DB] Initializing schema...');

    // Create users table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        firstName VARCHAR(255) NOT NULL,
        lastName VARCHAR(255) NOT NULL,
        passwordHash VARCHAR(255) NOT NULL,
        balance DECIMAL(19, 2) DEFAULT 1000,
        isAdmin BOOLEAN DEFAULT FALSE,
        isLocked BOOLEAN DEFAULT FALSE,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email)
      )
    `);
    console.log('[DB] ✓ Users table ready');

    // Create transactions table for audit trail
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(50) PRIMARY KEY,
        fromUserId VARCHAR(50),
        toUserId VARCHAR(50),
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
    console.log('[DB] ✓ Transactions table ready');

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
  const pool = initializePool();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0] || null;
  } finally {
    await connection.release();
  }
}

/**
 * Get user by ID
 */
async function getUserById(id) {
  const pool = initializePool();
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] || null;
  } finally {
    await connection.release();
  }
}

/**
 * Create user
 */
async function createUser(id, email, firstName, lastName, passwordHash, isAdmin = false) {
  const pool = initializePool();
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'INSERT INTO users (id, email, firstName, lastName, passwordHash, balance, isAdmin) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, email, firstName, lastName, passwordHash, 1000, isAdmin ? 1 : 0]
    );
    return getUserByEmail(email);
  } finally {
    await connection.release();
  }
}

/**
 * Update user balance
 */
async function updateUserBalance(email, newBalance) {
  const pool = initializePool();
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
  const pool = initializePool();
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
  const pool = initializePool();
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
async function recordTransaction(id, fromUserId, toUserId, amount, type, description) {
  const pool = initializePool();
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'INSERT INTO transactions (id, fromUserId, toUserId, amount, type, description) VALUES (?, ?, ?, ?, ?, ?)',
      [id, fromUserId, toUserId, amount, type, description]
    );
  } finally {
    await connection.release();
  }
}

/**
 * Get user transactions
 */
async function getUserTransactions(userId, limit = 50) {
  const pool = initializePool();
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
