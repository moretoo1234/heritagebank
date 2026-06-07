/**
 * Data Migration Script for Heritage Bank
 * Run this to migrate existing MySQL data to Firestore
 * 
 * Usage: node migrate.js
 * 
 * This script will:
 * 1. Connect to MySQL (using existing database config)
 * 2. Load all users, accounts, and transactions
 * 3. Import them into Firestore
 */

const path = require('path');
const mysql = require('mysql2/promise');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

// Load environment variables from backend folder
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

// ==================== MySQL Config Helper (same as server.js) ====================
function getMySqlEnv(key, fallback) {
  return process.env[key] || fallback;
}

const projectId = getMySqlEnv('GCLOUD_PROJECT') || 'btc-a87b4d93';

// Force use production Firebase (not emulator)
// This must be set BEFORE importing firebase-admin
process.env.FIRESTORE_EMULATOR_HOST = '';

// Initialize Firebase Admin - use production Firebase with explicit credentials
// Try to get credentials from environment or use default
const { auth } = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

let creds;
try {
  // Try to load from GOOGLE_APPLICATION_CREDENTIALS if set
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    const fs = require('fs');
    const serviceAccount = require(credPath);
    creds = serviceAccount;
  }
} catch {}

// Initialize with credentials if found, otherwise use default
if (creds) {
  admin.initializeApp({
    projectId: projectId,
    credential: admin.credential.cert(creds)
  });
} else {
  admin.initializeApp({
    projectId: projectId
  });
}
console.log(`🔗 Using Firebase Project: ${projectId}`);

const db = admin.firestore();

function getDbConfig() {
  // Support for various hosting providers
  const urlCfg = (() => {
    try {
      const databaseUrl = getMySqlEnv('DATABASE_URL');
      if (databaseUrl) {
        const parsed = new URL(databaseUrl);
        return {
          host: parsed.hostname,
          port: parsed.port,
          user: parsed.username,
          password: parsed.password,
          database: parsed.pathname.replace(/^\//, '')
        };
      }
    } catch {}
    return null;
  })();

  // Generic (Render/TiDB/etc): DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
  // Railway MySQL plugin: MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE
  // Clever Cloud: CLOUDSQL_HOST, CLOUDSQL_PORT, CLOUDSQL_USER, CLOUDSQL_PASSWORD, CLOUDSQL_DATABASE
  const host = (urlCfg?.host) || getMySqlEnv('DB_HOST', getMySqlEnv('MYSQLHOST'));
  const portRaw = (urlCfg?.port != null ? String(urlCfg.port) : null) || getMySqlEnv('DB_PORT', getMySqlEnv('MYSQLPORT', '3306'));
  const user = (urlCfg?.user) || getMySqlEnv('DB_USER', getMySqlEnv('MYSQLUSER'));
  const password = (urlCfg?.password) || getMySqlEnv('DB_PASSWORD', getMySqlEnv('MYSQLPASSWORD'));
  const database = (urlCfg?.database) || getMySqlEnv('DB_NAME', getMySqlEnv('MYSQLDATABASE'));

  return {
    host,
    port: parseInt(portRaw, 10) || 3306,
    user,
    password,
    database,
    ssl: {
      // Enable SSL for TiDB Cloud and other cloud providers
      rejectUnauthorized: true
    }
  };
}

// ==================== Test Connection ====================
async function testConnection() {
  const config = getDbConfig();
  console.log('📡 Testing database connection...');
  console.log(`   Host: ${config.host}:${config.port}`);
  console.log(`   Database: ${config.database}`);
  console.log(`   User: ${config.user}`);
  
  try {
    const connection = await mysql.createConnection(config);
    await connection.ping();
    console.log('✅ Database connection successful!\n');
    await connection.end();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

async function migrateUsers() {
  console.log('🔄 Migrating users...');
  
  const connection = await mysql.createConnection(getDbConfig());
  
  try {
    // Get all users from MySQL
    const [users] = await connection.execute(
      'SELECT * FROM users WHERE accountStatus != "closed"'
    );
    
    console.log(`Found ${users.length} users to migrate`);
    
    for (const user of users) {
      try {
        // Hash the password if not already hashed
        let passwordHash = user.password;
        if (!passwordHash.startsWith('$2')) {
          passwordHash = await bcrypt.hash(passwordHash, 12);
        }
        
        // Check if user already exists in Firestore
        const existingSnapshot = await db.collection('users')
          .where('email', '==', user.email)
          .limit(1)
          .get();
        
        if (!existingSnapshot.empty) {
          console.log(`  ⏭️  Skipping ${user.email} (already exists)`);
          continue;
        }
        
        // Create user in Firestore
        const userRef = await db.collection('users').add({
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          password: passwordHash,
          phone: user.phone || '',
          accountNumber: user.accountNumber,
          routingNumber: user.routingNumber || '091238946',
          balance: parseFloat(user.balance) || 0,
          accountType: user.accountType || 'checking',
          accountStatus: user.accountStatus || 'active',
          isAdmin: user.isAdmin || false,
          marketingConsent: user.marketingConsent || false,
          // Migration metadata
          migratedFrom: 'mysql',
          originalUserId: user.id,
          migratedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`  ✅ Migrated ${user.email} (Firestore ID: ${userRef.id})`);
        
      } catch (error) {
        console.error(`  ❌ Error migrating ${user.email}:`, error.message);
      }
    }
    
    console.log('✅ User migration complete!');
    
  } finally {
    await connection.end();
  }
}

async function migrationAccounts() {
  console.log('🔄 Migrating bank accounts...');
  
  const connection = await mysql.createConnection(getDbConfig());
  
  try {
    // Get all accounts from MySQL
    const [accounts] = await connection.execute(
      'SELECT ba.*, u.email as userEmail FROM bank_accounts ba JOIN users u ON ba.userId = u.id WHERE ba.status != "closed"'
    );
    
    console.log(`Found ${accounts.length} accounts to migrate`);
    
    for (const account of accounts) {
      try {
        // Find the user in Firestore by email
        const userSnapshot = await db.collection('users')
          .where('email', '==', account.userEmail)
          .limit(1)
          .get();
        
        if (userSnapshot.empty) {
          console.log(`  ⏭️  Skipping account ${account.accountNumber} (user not found)`);
          continue;
        }
        
        const firestoreUserId = userSnapshot.docs[0].id;
        
        // Check if account already exists
        const existingSnapshot = await db.collection('bankAccounts')
          .where('userId', '==', firestoreUserId)
          .where('accountNumber', '==', account.accountNumber)
          .limit(1)
          .get();
        
        if (!existingSnapshot.empty) {
          console.log(`  ⏭️  Skipping account ${account.accountNumber} (already exists)`);
          continue;
        }
        
        // Create account in Firestore
        await db.collection('bankAccounts').add({
          userId: firestoreUserId,
          accountNumber: account.accountNumber,
          accountType: account.accountType || 'checking',
          accountName: account.accountName || 'Primary Checking',
          balance: parseFloat(account.balance) || 0,
          status: account.status || 'active',
          isPrimary: account.isPrimary || false,
          // Migration metadata
          migratedFrom: 'mysql',
          originalAccountId: account.id,
          migratedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`  ✅ Migrated account ${account.accountNumber}`);
        
      } catch (error) {
        console.error(`  ❌ Error migrating account ${account.accountNumber}:`, error.message);
      }
    }
    
    console.log('✅ Account migration complete!');
    
  } finally {
    await connection.end();
  }
}

async function migrateTransactions() {
  console.log('🔄 Migrating transactions...');
  
  const connection = await mysql.createConnection(getDbConfig());
  
  try {
    // Get all transactions from MySQL
    const [transactions] = await connection.execute(
      'SELECT t.*, u.email as fromEmail FROM transactions t JOIN users u ON t.fromUserId = u.id'
    );
    
    console.log(`Found ${transactions.length} transactions to migrate`);
    
    for (const txn of transactions) {
      try {
        // Find the sender in Firestore
        const fromSnapshot = await db.collection('users')
          .where('email', '==', txn.fromEmail)
          .limit(1)
          .get();
        
        if (fromSnapshot.empty) {
          console.log(`  ⏭️  Skipping txn ${txn.reference} (sender not found)`);
          continue;
        }
        
        const fromUserId = fromSnapshot.docs[0].id;
        
        // Find the receiver if applicable
        let toUserId = null;
        if (txn.toEmail) {
          const toSnapshot = await db.collection('users')
            .where('email', '==', txn.toEmail)
            .limit(1)
            .get();
          
          if (!toSnapshot.empty) {
            toUserId = toSnapshot.docs[0].id;
          }
        }
        
        // Create transaction in Firestore
        await db.collection('transactions').add({
          fromUserId,
          toUserId,
          amount: parseFloat(txn.amount),
          type: txn.type || 'transfer',
          description: txn.description || '',
          status: txn.status || 'completed',
          reference: txn.reference,
          // Migration metadata
          migratedFrom: 'mysql',
          originalTransactionId: txn.id,
          migratedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`  ✅ Migrated txn ${txn.reference}`);
        
      } catch (error) {
        console.error(`  ❌ Error migrating txn ${txn.reference}:`, error.message);
      }
    }
    
    console.log('✅ Transaction migration complete!');
    
  } finally {
    await connection.end();
  }
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Heritage Bank Data Migration - MySQL to Firestore    ║
╚═══════════════════════════════════════════════════════════╝
  `);
  
  try {
    // First test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      console.error('❌ Cannot proceed without database connection');
      process.exit(1);
    }
    
    // Run migrations
    await migrateUsers();
    await migrationAccounts();
    await migrateTransactions();
    
    console.log(`
╔══════════════════════════════════════════════════════════╗
║           🎉 Migration Complete! 🎉                    ║
║                                                          ║
║  Users can now login with their existing credentials.    ║
╚══════════════════════════════════════════════════════════╝
    `);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

// Run if executed directly
main().catch(console.error);

module.exports = { migrateUsers, migrationAccounts, migrateTransactions };
