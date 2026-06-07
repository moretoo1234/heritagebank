#!/usr/bin/env node
/**
 * Migration Script: MySQL to Firestore
 * Transfers all user, transaction, and loan data from MySQL to Firebase Firestore
 * 
 * Usage: npm run migrate
 * or: node functions/migrate.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });

const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

// Initialize Firebase Admin
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './functions/serviceAccountKey.json';
try {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (err) {
  console.error('❌ Firebase credentials not found. Set GOOGLE_APPLICATION_CREDENTIALS or ensure serviceAccountKey.json exists in functions/');
  process.exit(1);
}

const db = admin.firestore();

// MySQL Connection Config
const mysqlConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'heritage_bank',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {}  // Required for TiDB Cloud - enables SSL with default settings
};

const BATCH_SIZE = 500; // Process in batches to avoid memory issues

class MigrationManager {
  constructor() {
    this.stats = {
      users: { total: 0, migrated: 0, failed: 0 },
      transactions: { total: 0, migrated: 0, failed: 0 },
      loans: { total: 0, migrated: 0, failed: 0 },
      documents: { total: 0, migrated: 0, failed: 0 },
      startTime: new Date(),
      endTime: null
    };
  }

  async migrateUsers() {
    console.log('\n📦 Starting User Migration...');
    const pool = await mysql.createPool(mysqlConfig);
    let connection;

    try {
      connection = await pool.getConnection();
      
      // Get total count
      const [[{ count }]] = await connection.execute('SELECT COUNT(*) as count FROM users');
      this.stats.users.total = count;
      console.log(`   Found ${count} users to migrate`);

      // Fetch all users (LIMIT/OFFSET don't work with parameters, so fetch all and process in chunks)
      const [allUsers] = await connection.execute('SELECT * FROM users');

      // Process in batches
      for (let batchStart = 0; batchStart < allUsers.length; batchStart += BATCH_SIZE) {
        const batch = db.batch();
        const batchEnd = Math.min(batchStart + BATCH_SIZE, allUsers.length);
        const batchUsers = allUsers.slice(batchStart, batchEnd);

        for (const mysqlUser of batchUsers) {
          try {
            // Check if user already exists in Firebase Auth
            let firebaseUid = null;
            try {
              const existingUser = await admin.auth().getUserByEmail(mysqlUser.email);
              firebaseUid = existingUser.uid;
            } catch (err) {
              // User doesn't exist, create one
              const newUser = await admin.auth().createUser({
                email: mysqlUser.email,
                password: 'TempPassword123!', // Set temp password - user should reset on first login
                displayName: `${mysqlUser.firstName} ${mysqlUser.lastName}`
              });
              firebaseUid = newUser.uid;
            }

            // Prepare Firestore document
            const firestoreUser = {
              firstName: mysqlUser.firstName || '',
              lastName: mysqlUser.lastName || '',
              email: (mysqlUser.email || '').toLowerCase(),
              password: mysqlUser.password || '', // Keep hashed password for reference
              phone: mysqlUser.phone || '',
              accountNumber: mysqlUser.accountNumber || '',
              routingNumber: mysqlUser.routingNumber || '091238946',
              balance: parseFloat(mysqlUser.balance) || 0,
              accountType: mysqlUser.accountType || 'checking',
              accountStatus: mysqlUser.accountStatus || 'active',
              isAdmin: Boolean(mysqlUser.isAdmin),
              marketingConsent: Boolean(mysqlUser.marketingConsent),
              ssn: mysqlUser.ssn || '',
              dateOfBirth: mysqlUser.dateOfBirth || '',
              address: mysqlUser.address || '',
              city: mysqlUser.city || '',
              state: mysqlUser.state || '',
              zipCode: mysqlUser.zipCode || '',
              country: mysqlUser.country || 'United States',
              lastLogin: mysqlUser.lastLogin ? new Date(mysqlUser.lastLogin) : null,
              createdAt: mysqlUser.createdAt ? new Date(mysqlUser.createdAt) : new Date(),
              migratedAt: admin.firestore.FieldValue.serverTimestamp(),
              migratedFromMySQLId: mysqlUser.id
            };

            batch.set(db.collection('users').doc(firebaseUid), firestoreUser, { merge: true });
            this.stats.users.migrated++;

            process.stdout.write(`\r   Migrated ${this.stats.users.migrated}/${this.stats.users.total} users`);
          } catch (error) {
            this.stats.users.failed++;
            console.error(`   ❌ Failed to migrate user ${mysqlUser.email}:`, error.message);
          }
        }

        await batch.commit();
      }

      console.log(`\n   ✅ User migration complete: ${this.stats.users.migrated} success, ${this.stats.users.failed} failed`);
    } catch (error) {
      console.error('❌ User migration error:', error.message);
    } finally {
      if (connection) await connection.release();
      await pool.end();
    }
  }

  async migrateTransactions() {
    console.log('\n💳 Starting Transaction Migration...');
    const pool = await mysql.createPool(mysqlConfig);
    let connection;

    try {
      connection = await pool.getConnection();
      
      // Get total count
      const [[{ count }]] = await connection.execute('SELECT COUNT(*) as count FROM transactions');
      this.stats.transactions.total = count;
      console.log(`   Found ${count} transactions to migrate`);

      // Get user mapping (MySQL ID -> Firebase UID)
      const [usersResult] = await connection.execute('SELECT id, email FROM users');
      const userIdMap = {};
      for (const user of usersResult) {
        try {
          const firebaseUser = await admin.auth().getUserByEmail(user.email);
          userIdMap[user.id] = firebaseUser.uid;
        } catch (err) {
          console.warn(`   ⚠️  Could not find Firebase user for MySQL user ID ${user.id}`);
        }
      }

      // Fetch all transactions (LIMIT/OFFSET don't work with parameters, so fetch all and process in chunks)
      const [allTransactions] = await connection.execute('SELECT * FROM transactions');

      // Process in batches
      for (let batchStart = 0; batchStart < allTransactions.length; batchStart += BATCH_SIZE) {
        const batch = db.batch();
        const batchEnd = Math.min(batchStart + BATCH_SIZE, allTransactions.length);
        const batchTransactions = allTransactions.slice(batchStart, batchEnd);

        for (const txn of batchTransactions) {
          try {
            const firestoreTransaction = {
              fromUserId: userIdMap[txn.fromUserId] || txn.fromUserId,
              toUserId: userIdMap[txn.toUserId] || txn.toUserId,
              amount: parseFloat(txn.amount) || 0,
              type: txn.type || 'transfer',
              description: txn.description || '',
              status: txn.status || 'completed',
              createdAt: txn.createdAt ? new Date(txn.createdAt) : new Date(),
              migratedFromMySQLId: txn.id
            };

            batch.set(
              db.collection('transactions').doc(`migrated_${txn.id}`),
              firestoreTransaction,
              { merge: true }
            );
            this.stats.transactions.migrated++;

            process.stdout.write(`\r   Migrated ${this.stats.transactions.migrated}/${this.stats.transactions.total} transactions`);
          } catch (error) {
            this.stats.transactions.failed++;
            console.error(`   ❌ Failed to migrate transaction ${txn.id}:`, error.message);
          }
        }

        await batch.commit();
      }

      console.log(`\n   ✅ Transaction migration complete: ${this.stats.transactions.migrated} success, ${this.stats.transactions.failed} failed`);
    } catch (error) {
      console.error('❌ Transaction migration error:', error.message);
    } finally {
      if (connection) await connection.release();
      await pool.end();
    }
  }

  async migrateLoanApplications() {
    console.log('\n📋 Starting Loan Application Migration...');
    const pool = await mysql.createPool(mysqlConfig);
    let connection;

    try {
      connection = await pool.getConnection();
      
      // Check if table exists
      let tableExists = false;
      try {
        const [[{ count }]] = await connection.execute('SELECT COUNT(*) as count FROM loan_applications');
        tableExists = true;
        this.stats.loans.total = count;
        console.log(`   Found ${count} loan applications to migrate`);
      } catch (err) {
        console.log('   ℹ️  loan_applications table not found, skipping');
        return;
      }

      if (!tableExists || this.stats.loans.total === 0) return;

      // Get user mapping
      const [usersResult] = await connection.execute('SELECT id, email FROM users');
      const userIdMap = {};
      for (const user of usersResult) {
        try {
          const firebaseUser = await admin.auth().getUserByEmail(user.email);
          userIdMap[user.id] = firebaseUser.uid;
        } catch (err) {}
      }

      // Fetch all loans (LIMIT/OFFSET don't work with parameters, so fetch all and process in chunks)
      const [allLoans] = await connection.execute('SELECT * FROM loan_applications');

      // Process in batches
      for (let batchStart = 0; batchStart < allLoans.length; batchStart += BATCH_SIZE) {
        const batch = db.batch();
        const batchEnd = Math.min(batchStart + BATCH_SIZE, allLoans.length);
        const batchLoans = allLoans.slice(batchStart, batchEnd);

        for (const loan of batchLoans) {
          try {
            batch.set(
              db.collection('loanApplications').doc(`migrated_${loan.id}`),
              {
                userId: userIdMap[loan.user_id] || loan.user_id,
                loanType: loan.loan_type || '',
                loanAmount: parseFloat(loan.loan_amount) || 0,
                loanDurationMonths: loan.loan_duration_months || 0,
                monthlyIncome: parseFloat(loan.monthly_income) || 0,
                employmentStatus: loan.employment_status || '',
                purpose: loan.purpose || '',
                status: loan.status || 'pending',
                interestRate: parseFloat(loan.interest_rate) || 0,
                rejectionReason: loan.rejection_reason || '',
                createdAt: loan.created_at ? new Date(loan.created_at) : new Date(),
                migratedFromMySQLId: loan.id
              },
              { merge: true }
            );
            this.stats.loans.migrated++;

            process.stdout.write(`\r   Migrated ${this.stats.loans.migrated}/${this.stats.loans.total} loans`);
          } catch (error) {
            this.stats.loans.failed++;
            console.error(`   ❌ Failed to migrate loan ${loan.id}:`, error.message);
          }
        }

        await batch.commit();
      }

      console.log(`\n   ✅ Loan application migration complete: ${this.stats.loans.migrated} success, ${this.stats.loans.failed} failed`);
    } catch (error) {
      console.error('❌ Loan application migration error:', error.message);
    } finally {
      if (connection) await connection.release();
      await pool.end();
    }
  }

  async migrateDocuments() {
    console.log('\n📄 Starting Documents Migration...');
    const pool = await mysql.createPool(mysqlConfig);
    let connection;

    try {
      connection = await pool.getConnection();
      
      // Check if table exists
      let tableExists = false;
      try {
        const [[{ count }]] = await connection.execute('SELECT COUNT(*) as count FROM documents');
        tableExists = true;
        this.stats.documents.total = count;
        console.log(`   Found ${count} documents to migrate`);
      } catch (err) {
        console.log('   ℹ️  documents table not found, skipping');
        return;
      }

      if (!tableExists || this.stats.documents.total === 0) return;

      // Get user mapping
      const [usersResult] = await connection.execute('SELECT id, email FROM users');
      const userIdMap = {};
      for (const user of usersResult) {
        try {
          const firebaseUser = await admin.auth().getUserByEmail(user.email);
          userIdMap[user.id] = firebaseUser.uid;
        } catch (err) {}
      }

      // Fetch all documents (LIMIT/OFFSET don't work with parameters, so fetch all and process in chunks)
      const [allDocuments] = await connection.execute('SELECT * FROM documents');

      // Process in batches
      for (let batchStart = 0; batchStart < allDocuments.length; batchStart += BATCH_SIZE) {
        const batch = db.batch();
        const batchEnd = Math.min(batchStart + BATCH_SIZE, allDocuments.length);
        const batchDocuments = allDocuments.slice(batchStart, batchEnd);

        for (const doc of batchDocuments) {
          try {
            batch.set(
              db.collection('documents').doc(`migrated_${doc.id}`),
              {
                userId: userIdMap[doc.userId] || doc.userId,
                documentType: doc.documentType || '',
                fileName: doc.fileName || '',
                filePath: doc.filePath || '',
                status: doc.status || 'pending',
                rejectionReason: doc.rejectionReason || '',
                uploadedAt: doc.uploadedAt ? new Date(doc.uploadedAt) : new Date(),
                reviewedAt: doc.reviewedAt ? new Date(doc.reviewedAt) : null,
                migratedFromMySQLId: doc.id
              },
              { merge: true }
            );
            this.stats.documents.migrated++;

            process.stdout.write(`\r   Migrated ${this.stats.documents.migrated}/${this.stats.documents.total} documents`);
          } catch (error) {
            this.stats.documents.failed++;
            console.error(`   ❌ Failed to migrate document ${doc.id}:`, error.message);
          }
        }

        await batch.commit();
      }

      console.log(`\n   ✅ Documents migration complete: ${this.stats.documents.migrated} success, ${this.stats.documents.failed} failed`);
    } catch (error) {
      console.error('❌ Documents migration error:', error.message);
    } finally {
      if (connection) await connection.release();
      await pool.end();
    }
  }

  async run() {
    console.log('🚀 Starting Heritage Bank Migration: MySQL → Firestore');
    console.log(`📅 Started at: ${this.stats.startTime.toISOString()}`);
    console.log(`⚙️  Database: ${mysqlConfig.database}`);
    console.log(`🔧 MySQL Server: ${mysqlConfig.host}:${mysqlConfig.port}`);
    console.log('━'.repeat(60));

    try {
      await this.migrateUsers();
      await this.migrateTransactions();
      await this.migrateLoanApplications();
      await this.migrateDocuments();

      this.stats.endTime = new Date();
      const duration = (this.stats.endTime - this.stats.startTime) / 1000;

      console.log('\n━'.repeat(60));
      console.log('📊 MIGRATION SUMMARY:');
      console.log(`   Users:        ${this.stats.users.migrated}/${this.stats.users.total} (${this.stats.users.failed} failed)`);
      console.log(`   Transactions: ${this.stats.transactions.migrated}/${this.stats.transactions.total} (${this.stats.transactions.failed} failed)`);
      console.log(`   Loans:        ${this.stats.loans.migrated}/${this.stats.loans.total} (${this.stats.loans.failed} failed)`);
      console.log(`   Documents:    ${this.stats.documents.migrated}/${this.stats.documents.total} (${this.stats.documents.failed} failed)`);
      console.log(`⏱️  Duration: ${duration.toFixed(2)} seconds`);
      console.log(`✅ Completed at: ${this.stats.endTime.toISOString()}`);

      const totalSuccessful = this.stats.users.migrated + this.stats.transactions.migrated + 
                             this.stats.loans.migrated + this.stats.documents.migrated;
      const totalFailed = this.stats.users.failed + this.stats.transactions.failed + 
                         this.stats.loans.failed + this.stats.documents.failed;

      if (totalFailed === 0) {
        console.log('\n🎉 Migration completed successfully with no errors!');
      } else {
        console.log(`\n⚠️  Migration completed with ${totalFailed} errors. Please review the logs above.`);
      }

      process.exit(totalFailed === 0 ? 0 : 1);
    } catch (error) {
      console.error('\n❌ Migration failed:', error.message);
      process.exit(1);
    }
  }
}

// Run migration
const manager = new MigrationManager();
manager.run().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
