// One-time script to update the $5,000 debit transaction from seeleyjonesxx@gmail.com
// to show Santander UK bank transfer details.
//
// Usage: node update-santander-txn.js <mysql-root-password>
//   e.g. node update-santander-txn.js MySecretPW
//
// If no argument is given, it reads DB_PASSWORD from backend/.env
require('dotenv').config();
const mysql = require('mysql2/promise');

const dbPassword = process.argv[2] ?? process.env.DB_PASSWORD ?? '';

(async () => {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '3306'),
        user: process.env.DB_USER || 'root',
        password: dbPassword,
        database: process.env.DB_NAME || 'heritage_bank'
    });

    try {
        // Find the transaction
        const [rows] = await pool.execute(
            `SELECT t.id, t.amount, t.type, t.status, t.description, t.reference, t.createdAt, u.email, u.firstName, u.lastName
             FROM transactions t
             JOIN users u ON t.fromUserId = u.id
             WHERE u.email = ? AND t.type = 'debit' AND t.amount = 5000
             ORDER BY t.createdAt DESC LIMIT 5`,
            ['seeleyjonesxx@gmail.com']
        );

        if (rows.length === 0) {
            console.log('No matching $5,000 debit transaction found for seeleyjonesxx@gmail.com');
            console.log('\nSearching for ALL transactions from this user...');
            const [allTxns] = await pool.execute(
                `SELECT t.id, t.amount, t.type, t.status, t.description, t.reference, t.createdAt
                 FROM transactions t
                 JOIN users u ON t.fromUserId = u.id
                 WHERE u.email = ?
                 ORDER BY t.createdAt DESC LIMIT 15`,
                ['seeleyjonesxx@gmail.com']
            );
            console.log('Found transactions:', JSON.stringify(allTxns, null, 2));
            await pool.end();
            return;
        }

        console.log('Found transaction(s):');
        console.log(JSON.stringify(rows, null, 2));

        // Update the first matching transaction with full Santander UK wire transfer details
        const txn = rows[0];
        const newDescription = 'UK Bank Transfer to Santander | Recipient: James A. Mitchell | Account: 72849163 | Sort Code: 09-01-28 | Ref: HERITAGE-SAN-' + txn.reference;

        const [result] = await pool.execute(
            `UPDATE transactions SET
                description = ?,
                destinationCountry = 'GB',
                recipientName = 'Santander Mortga',
                recipientAddress = 'Floor 1\n33 Princeway\nRedhill\nRH1 1SR',
                bankName = 'SANTANDER UK PLC',
                swiftCode = 'ABBYGB2LXXX',
                iban = 'GB10ABBY09009290004049',
                exchangeRate = '1 USD = 0.78610 GBP',
                recipientCurrency = 'GBP',
                recipientAmount = 3930.50
            WHERE id = ?`,
            [newDescription, txn.id]
        );

        console.log(`\n✅ Updated transaction ID ${txn.id} with full wire transfer details:`);
        console.log(`  Description: ${newDescription}`);
        console.log(`  Destination: GB (United Kingdom)`);
        console.log(`  Bank: SANTANDER UK PLC (ABBYGB2LXXX)`);
        console.log(`  IBAN: GB10ABBY09009290004049`);
        console.log(`  Exchange: 1 USD = 0.78610 GBP`);
        console.log(`  Recipient: £3,930.50 GBP`);
        console.log(`  Rows affected: ${result.affectedRows}`);
    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await pool.end();
    }
})();
