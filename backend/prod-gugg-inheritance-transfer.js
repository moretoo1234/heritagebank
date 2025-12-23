/*
  Production (Render) action script: create user "Gugg" and send an inheritance transfer.

  What it does:
    - Admin login
    - Fetch admin profile balance BEFORE
    - Create a unique user with firstName = "Gugg"
    - Admin transfer $864,000.00 to that user with description "Florida State Inheritance Fund"
    - Fetch admin profile balance AFTER (must decrease)
    - Fetch user profile balance AFTER (must increase)
    - Verify the transaction appears in user transactions and description matches

  SAFETY:
    This script performs a large real transfer. To prevent mistakes, it will refuse to run unless:
      CONFIRM_LIVE_TRANSFER=YES

  Usage (PowerShell):
    $env:E2E_ADMIN_PASSWORD = "<your admin password>"
    $env:CONFIRM_LIVE_TRANSFER = "YES"
    node prod-gugg-inheritance-transfer.js

  Optional env:
    E2E_BASE_URL=https://heritagebank-ku1y.onrender.com
    E2E_ADMIN_EMAIL=admin@heritagebank.com
    GUGG_EMAIL=gugg@example.com   # if you want a fixed email (must be unique in DB)
    GUGG_PASSWORD=GuggTest!234    # default below
*/

const BASE = process.env.E2E_BASE_URL || 'https://heritagebank-ku1y.onrender.com';

// Allow local env via backend/.env without committing secrets.
try {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {}

async function request(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function money(n) {
  const num = Number(n);
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

(async () => {
  if (!BASE.startsWith('https://')) {
    throw new Error(`Refusing to run against non-https base URL: ${BASE}`);
  }

  if (String(process.env.CONFIRM_LIVE_TRANSFER || '').trim().toUpperCase() !== 'YES') {
    throw new Error('Refusing to run: set CONFIRM_LIVE_TRANSFER=YES to perform the $864,000 live transfer.');
  }

  const stamp = Date.now();

  const adminEmail = process.env.E2E_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@heritagebank.com';
  const adminPassword = process.env.E2E_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error('Missing E2E_ADMIN_PASSWORD. Provide it as an environment variable (never commit it).');
  }

  const amount = 864000;
  const description = 'Florida State Inheritance Fund';

  console.log('1) System status');
  const sys = await request('GET', '/api/system/status');
  console.log(sys.status, sys.data.success, sys.data.serverTime);
  assert(sys.status === 200 && sys.data.success === true, `system/status failed: ${JSON.stringify(sys.data)}`);

  console.log('\n2) Admin login');
  const adminLogin = await request('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  console.log(adminLogin.status, adminLogin.data.success, adminLogin.data.user?.email);
  assert(adminLogin.status === 200 && adminLogin.data.success === true, `admin login failed: ${JSON.stringify(adminLogin.data)}`);
  const adminToken = adminLogin.data.token;

  console.log('\n3) Admin profile BEFORE (balance)');
  const adminBefore = await request('GET', '/api/user/profile', null, adminToken);
  assert(adminBefore.status === 200 && adminBefore.data.success === true, `admin profile failed: ${JSON.stringify(adminBefore.data)}`);
  const adminBeforeBal = Number(adminBefore.data.user?.balance || 0);
  console.log(`   Admin balance before: $${money(adminBeforeBal)}`);

  console.log('\n4) Create user "Gugg"');
  const guggEmail = (process.env.GUGG_EMAIL || `gugg_${stamp}@example.com`).trim();
  const guggPassword = (process.env.GUGG_PASSWORD || 'GuggTest!234').trim();

  const createUser = await request(
    'POST',
    '/api/admin/create-user',
    {
      firstName: 'Gugg',
      lastName: 'Inheritance',
      email: guggEmail,
      password: guggPassword,
      initialBalance: 0,
      accountType: 'checking'
    },
    adminToken
  );
  console.log(createUser.status, createUser.data.success, createUser.data.user?.id, createUser.data.user?.accountNumber);
  assert(createUser.status === 201 && createUser.data.success === true, `create-user failed: ${JSON.stringify(createUser.data)}`);
  const guggUserId = createUser.data.user.id;

  console.log(`   ✅ Created user: email=${guggEmail} password=${guggPassword} userId=${guggUserId}`);

  console.log('\n5) Login as Gugg (to verify dashboard data via APIs)');
  const guggLogin = await request('POST', '/api/auth/login', { email: guggEmail, password: guggPassword });
  console.log(guggLogin.status, guggLogin.data.success, guggLogin.data.user?.email);
  assert(guggLogin.status === 200 && guggLogin.data.success === true, `gugg login failed: ${JSON.stringify(guggLogin.data)}`);
  const guggToken = guggLogin.data.token;

  console.log('\n6) Gugg profile BEFORE');
  const guggBefore = await request('GET', '/api/user/profile', null, guggToken);
  assert(guggBefore.status === 200 && guggBefore.data.success === true, `gugg profile failed: ${JSON.stringify(guggBefore.data)}`);
  const guggBeforeBal = Number(guggBefore.data.user?.balance || 0);
  console.log(`   Gugg balance before: $${money(guggBeforeBal)}`);

  console.log(`\n7) Admin transfer $${money(amount)} to Gugg: "${description}"`);
  const transfer = await request(
    'POST',
    '/api/admin/transfer',
    {
      fromEmail: adminEmail,
      toEmail: guggEmail,
      amount,
      description
    },
    adminToken
  );
  console.log(transfer.status, transfer.data.success, transfer.data.reference);
  assert(transfer.status === 200 && transfer.data.success === true, `admin transfer failed: ${JSON.stringify(transfer.data)}`);

  console.log('\n8) Admin profile AFTER (balance should decrease)');
  const adminAfter = await request('GET', '/api/user/profile', null, adminToken);
  assert(adminAfter.status === 200 && adminAfter.data.success === true, `admin profile after failed: ${JSON.stringify(adminAfter.data)}`);
  const adminAfterBal = Number(adminAfter.data.user?.balance || 0);
  console.log(`   Admin balance after:  $${money(adminAfterBal)}`);
  assert(adminAfterBal <= adminBeforeBal - amount + 0.0001, `Expected admin balance to decrease by ${amount}. Before=${adminBeforeBal} After=${adminAfterBal}`);

  console.log('\n9) Gugg profile AFTER (balance should increase)');
  const guggAfter = await request('GET', '/api/user/profile', null, guggToken);
  assert(guggAfter.status === 200 && guggAfter.data.success === true, `gugg profile after failed: ${JSON.stringify(guggAfter.data)}`);
  const guggAfterBal = Number(guggAfter.data.user?.balance || 0);
  console.log(`   Gugg balance after:  $${money(guggAfterBal)}`);
  assert(guggAfterBal >= guggBeforeBal + amount - 0.0001, `Expected gugg balance to increase by ${amount}. Before=${guggBeforeBal} After=${guggAfterBal}`);

  console.log('\n10) Verify transaction appears in Gugg transactions (description must match)');
  const txns = await request('GET', '/api/user/transactions', null, guggToken);
  console.log(txns.status, txns.data.success, Array.isArray(txns.data.transactions) ? `count=${txns.data.transactions.length}` : '');
  assert(txns.status === 200 && txns.data.success === true, `gugg transactions failed: ${JSON.stringify(txns.data)}`);

  const list = Array.isArray(txns.data.transactions) ? txns.data.transactions : [];
  const match = list.find((t) => {
    const amt = Number(t.amount);
    const desc = String(t.description || '');
    return Math.abs(amt - amount) < 0.0001 && desc === description;
  });
  assert(!!match, `Could not find matching transaction amount=${amount} description="${description}". Latest txn: ${JSON.stringify(list[0] || {})}`);
  console.log(`   ✅ Found transaction id=${match.id} description="${match.description}"`);

  console.log('\n✅ GUGG INHERITANCE TRANSFER COMPLETED AND VERIFIED');
  console.log(`Login for Gugg: ${guggEmail}`);
  console.log(`Password for Gugg: ${guggPassword}`);
})().catch((e) => {
  console.error('\n❌ GUGG INHERITANCE TRANSFER FAILED:', e.message);
  process.exit(1);
});
