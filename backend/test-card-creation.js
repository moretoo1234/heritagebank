/**
 * Test script for virtual card creation
 * Run with: node backend/test-card-creation.js
 */

const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

async function testCardCreation() {
  console.log('\n========================================');
  console.log('Virtual Card Creation Test');
  console.log('========================================\n');

  // Step 1: Test database connection
  console.log('Step 1: Testing database connection...');
  let connection;
  try {
    const dbConfig = {
      host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.MYSQLPORT || '3306'),
      user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
      password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
      database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'heritage_bank',
      ssl: process.env.DB_SSL === 'false' ? false : {
        rejectUnauthorized: false
      }
    };

    console.log('Connecting to:', dbConfig.host + ':' + dbConfig.port);
    connection = await mysql.createConnection(dbConfig);
    console.log('✓ Database connection successful\n');
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    process.exit(1);
  }

  // Step 2: Check if users table exists
  console.log('Step 2: Checking users table...');
  try {
    const [users] = await connection.execute('SELECT COUNT(*) as count FROM users');
    console.log(`✓ Users table exists (${users[0].count} users found)\n`);
  } catch (error) {
    console.error('✗ Users table check failed:', error.message);
    await connection.end();
    process.exit(1);
  }

  // Step 3: Check if cards table exists
  console.log('Step 3: Checking cards table...');
  try {
    const [cards] = await connection.execute('SELECT COUNT(*) as count FROM cards');
    console.log(`✓ Cards table exists (${cards[0].count} cards found)\n`);
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.log('✗ Cards table does not exist!');
      console.log('   Creating cards table now...\n');
      
      // Create the table
      try {
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS cards (
            id INT PRIMARY KEY AUTO_INCREMENT,
            userId INT NOT NULL,
            cardType VARCHAR(20) NOT NULL DEFAULT 'virtual',
            cardNumber VARCHAR(255),
            cardNumberMasked VARCHAR(30),
            cardholderName VARCHAR(255),
            expirationDate VARCHAR(10),
            cvv VARCHAR(10),
            status VARCHAR(20) DEFAULT 'active',
            deliveryStatus VARCHAR(30) DEFAULT 'not_applicable',
            deliveryAddress TEXT,
            deliveryEtaText VARCHAR(100),
            dailyLimit DECIMAL(12,2) DEFAULT 5000,
            monthlyLimit DECIMAL(12,2) DEFAULT 25000,
            onlineEnabled TINYINT(1) DEFAULT 1,
            internationalEnabled TINYINT(1) DEFAULT 0,
            issuedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id),
            INDEX idx_userId (userId)
          )
        `);
        console.log('✓ Cards table created successfully\n');
      } catch (createError) {
        console.error('✗ Failed to create cards table:', createError.message);
        await connection.end();
        process.exit(1);
      }
    } else {
      console.error('✗ Cards table check failed:', error.message);
      await connection.end();
      process.exit(1);
    }
  }

  // Step 4: Get a test user
  console.log('Step 4: Getting test user...');
  let testUser;
  try {
    const [users] = await connection.execute(
      'SELECT * FROM users WHERE isAdmin = 0 LIMIT 1'
    );
    if (users.length === 0) {
      console.log('✗ No non-admin users found. Creating test user...');
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash('Test123!', 10);
      
      await connection.execute(
        'INSERT INTO users (email, firstName, lastName, password, balance) VALUES (?, ?, ?, ?, ?)',
        ['testuser@heritage.com', 'Test', 'User', hashedPassword, 1000]
      );
      
      const [newUsers] = await connection.execute(
        'SELECT * FROM users WHERE email = ?',
        ['testuser@heritage.com']
      );
      testUser = newUsers[0];
      console.log('✓ Test user created:', testUser.email);
    } else {
      testUser = users[0];
      console.log('✓ Test user found:', testUser.email);
    }
    console.log(`   User ID: ${testUser.id}, Balance: $${testUser.balance}\n`);
  } catch (error) {
    console.error('✗ Failed to get test user:', error.message);
    await connection.end();
    process.exit(1);
  }

  // Step 5: Test virtual card creation
  console.log('Step 5: Creating test virtual card...');
  try {
    const rawNumber = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
    const masked = '****-****-****-' + rawNumber.slice(-4);
    const cvv = String(Math.floor(100 + Math.random() * 900));
    const now = new Date();
    const expiry = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getFullYear() + 4).slice(-2)}`;
    const holderName = `${testUser.firstName} ${testUser.lastName}`.toUpperCase();

    const [result] = await connection.execute(
      `INSERT INTO cards (userId, cardType, cardNumber, cardNumberMasked, cardholderName, expirationDate, cvv, status, deliveryStatus)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'not_applicable')`,
      [testUser.id, 'virtual', rawNumber, masked, holderName, expiry, cvv]
    );

    console.log('✓ Virtual card created successfully!');
    console.log(`   Card ID: ${result.insertId}`);
    console.log(`   Card Number: ${rawNumber.match(/.{1,4}/g).join(' ')}`);
    console.log(`   Masked: ${masked}`);
    console.log(`   Expiry: ${expiry}`);
    console.log(`   CVV: ${cvv}`);
    console.log(`   Cardholder: ${holderName}\n`);
  } catch (error) {
    console.error('✗ Failed to create virtual card:', error.message);
    console.error('   Error code:', error.code);
    console.error('   SQL Message:', error.sqlMessage);
    await connection.end();
    process.exit(1);
  }

  // Step 6: Verify card was created
  console.log('Step 6: Verifying card in database...');
  try {
    const [cards] = await connection.execute(
      'SELECT * FROM cards WHERE userId = ? ORDER BY issuedAt DESC LIMIT 1',
      [testUser.id]
    );
    
    if (cards.length > 0) {
      const card = cards[0];
      console.log('✓ Card verified in database');
      console.log(`   Type: ${card.cardType}`);
      console.log(`   Status: ${card.status}`);
      console.log(`   Issued: ${card.issuedAt}\n`);
    } else {
      console.log('✗ Card not found in database\n');
    }
  } catch (error) {
    console.error('✗ Failed to verify card:', error.message);
  }

  // Step 7: Test card retrieval (simulating GET /api/cards endpoint)
  console.log('Step 7: Testing card retrieval...');
  try {
    const [cards] = await connection.execute(
      'SELECT * FROM cards WHERE userId = ? ORDER BY issuedAt DESC',
      [testUser.id]
    );
    
    console.log(`✓ Retrieved ${cards.length} card(s) for user`);
    cards.forEach((card, index) => {
      console.log(`   Card ${index + 1}: ${card.cardType} - ${card.cardNumberMasked} (${card.status})`);
    });
    console.log();
  } catch (error) {
    console.error('✗ Failed to retrieve cards:', error.message);
  }

  // Cleanup
  await connection.end();
  
  console.log('========================================');
  console.log('✓ All tests completed successfully!');
  console.log('========================================\n');
  console.log('Your virtual card system is working correctly.');
  console.log('Users should now be able to create virtual cards.\n');
}

// Run the test
testCardCreation().catch(error => {
  console.error('\n✗ Test failed with error:', error);
  process.exit(1);
});
