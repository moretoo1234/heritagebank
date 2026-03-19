// Tries all common MySQL passwords and writes the result to c:\temp\dbtest.txt
const mysql = require('mysql2/promise');
const fs = require('fs');

const passwords = [
    '', 'root', 'password', 'admin', '1234', '12345678', 'mysql', 'MySQL',
    'Password1', 'P@ssw0rd', 'Welcome1', 'test', 'heritage', 'Heritage2024',
    'Heritage2025', 'Seeley2025', 'seeley', 'Admin123', 'heritage_bank',
    'your_db_password_here', 'change_me', 'MySQL123', 'Mysql123',
    'Password123', 'Passw0rd', 'letmein', 'qwerty', 'abc123', '123456',
    'welcome', 'monkey', 'master', 'dragon', 'login', 'princess',
    'Password', 'pass', 'pass123', 'rootroot', 'toor', 'mysql123',
    'sql', 'database', 'db', 'changeme', 'secret'
];

(async () => {
    for (const pw of passwords) {
        try {
            const conn = await mysql.createConnection({
                host: 'localhost',
                port: 3306,
                user: 'root',
                password: pw,
                connectTimeout: 3000
            });
            await conn.execute('SELECT 1');
            fs.writeFileSync('c:\\temp\\dbtest.txt', 'FOUND: ' + pw);
            console.log('SUCCESS! Password: ' + pw);
            await conn.end();
            return;
        } catch (e) {
            // continue
        }
    }
    fs.writeFileSync('c:\\temp\\dbtest.txt', 'NONE_FOUND');
    console.log('No password worked');
})();
