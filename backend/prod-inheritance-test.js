/*
  Production (Render) end-to-end test:
    - Admin login
    - Create a unique test user
    - Login as that user
    - Admin transfers $1,000,000.00 to the user with description containing "Inheritance"
    - Verify user profile balance increases and the transaction appears in user transactions
    - Cleanup: debit back the same amount and close the test account

  Usage (PowerShell):
    node prod-inheritance-test.js

  Required env (set locally, never commit/paste):
    E2E_ADMIN_PASSWORD=...

  Optional env:
    E2E_BASE_URL=https://heritagebank-ku1y.onrender.com
    E2E_ADMIN_EMAIL=admin@heritagebank.com
    E2E_TRANSFER_AMOUNT=1000000
    E2E_TRANSFER_DESCRIPTION="Inheritance payment"
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
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

(async () => {
  if (!BASE.startsWith('https://')) {
    throw new Error(`Refusing to run against non-https base URL: ${BASE}`);
  }

  const stamp = Date.now();

  const adminEmail = process.env.E2E_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@heritagebank.com';
  const adminPassword = process.env.E2E_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error('Missing E2E_ADMIN_PASSWORD. Provide it as an environment variable (never commit it).');
  }

  const amount = Number(process.env.E2E_TRANSFER_AMOUNT || 1000000);
  assert(Number.isFinite(amount) && amount > 0, 'E2E_TRANSFER_AMOUNT must be a positive number');

  const description = String(process.env.E2E_TRANSFER_DESCRIPTION || 'Inheritance payment').trim();
  assert(description.length > 0, 'E2E_TRANSFER_DESCRIPTION must be non-empty');

  console.log('1) System status');
  const sys = await request('GET', '/api/system/status');
  console.log(sys.status, sys.data.success, sys.data.serverTime);
  assert(sys.status === 200 && sys.data.success === true, `system/status failed: ${JSON.stringify(sys.data)}`);

  console.log('\n2) Admin login');
  const adminLogin = await request('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  console.log(adminLogin.status, adminLogin.data.success, adminLogin.data.user?.email);
  assert(adminLogin.status === 200 && adminLogin.data.success === true, `admin login failed: ${JSON.stringify(adminLogin.data)}`);
  const adminToken = adminLogin.data.token;

  console.log('\n3) Create unique test user');
  const testEmail = `inherit_${stamp}@example.com`;
  const testPassword = 'InheritTest!234';
  const createUser = await request(
    'POST',
    '/api/admin/create-user',
    {
      firstName: 'Inheritance',
      lastName: 'Test',
      email: testEmail,
      password: testPassword,
      initialBalance: 0,
      accountType: 'checking'
    },
    adminToken
  );
  console.log(createUser.status, createUser.data.success, createUser.data.user?.id, createUser.data.user?.accountNumber);
  assert(createUser.status === 201 && createUser.data.success === true, `create-user failed: ${JSON.stringify(createUser.data)}`);
  const testUserId = createUser.data.user.id;

  console.log('\n4) User login (to get user token)');
  const userLogin = await request('POST', '/api/auth/login', { email: testEmail, password: testPassword });
  console.log(userLogin.status, userLogin.data.success, userLogin.data.user?.email);
  assert(userLogin.status === 200 && userLogin.data.success === true, `user login failed: ${JSON.stringify(userLogin.data)}`);
  const userToken = userLogin.data.token;

  console.log('\n5) Read user profile BEFORE transfer');
  const beforeProfile = await request('GET', '/api/user/profile', null, userToken);
  console.log(beforeProfile.status, beforeProfile.data.success, beforeProfile.data.user?.email);
  assert(beforeProfile.status === 200 && beforeProfile.data.success === true, `user profile failed: ${JSON.stringify(beforeProfile.data)}`);
  const beforeBal = Number(beforeProfile.data.user?.balance || 0);

  console.log(`\n6) Admin transfer $${money(amount)} to user with description: ${description}`);
  const transfer = await request(
    'POST',
    '/api/admin/transfer',
    {
      fromEmail: adminEmail,
      toEmail: testEmail,
      amount,
      description
    },
    adminToken
  );
  console.log(transfer.status, transfer.data.success, transfer.data.reference);
  assert(transfer.status === 200 && transfer.data.success === true, `admin transfer failed: ${JSON.stringify(transfer.data)}`);

  console.log('\n7) Read user profile AFTER transfer (balance should increase)');
  const afterProfile = await request('GET', '/api/user/profile', null, userToken);
  console.log(afterProfile.status, afterProfile.data.success);
  assert(afterProfile.status === 200 && afterProfile.data.success === true, `user profile after failed: ${JSON.stringify(afterProfile.data)}`);
  const afterBal = Number(afterProfile.data.user?.balance || 0);

  // Some systems may round/format; allow a tiny epsilon.
  const expectedMin = beforeBal + amount - 0.0001;
  assert(afterBal >= expectedMin, `Expected balance to increase by ${amount}. Before=${beforeBal} After=${afterBal}`);
  console.log(`   ✅ Balance increased. Before=$${money(beforeBal)} After=$${money(afterBal)}`);

  console.log('\n8) Verify the transaction appears on user transactions list');
  const txns = await request('GET', '/api/user/transactions', null, userToken);
  console.log(txns.status, txns.data.success, Array.isArray(txns.data.transactions) ? `count=${txns.data.transactions.length}` : '');
  assert(txns.status === 200 && txns.data.success === true, `user transactions failed: ${JSON.stringify(txns.data)}`);

  const list = Array.isArray(txns.data.transactions) ? txns.data.transactions : [];
  const match = list.find((t) => {
    const amt = Number(t.amount);
    const desc = String(t.description || '');
    return Math.abs(amt - amount) < 0.0001 && desc.toLowerCase().includes('inherit');
  });
  assert(!!match, `Could not find a user transaction with amount=${amount} and description containing "inherit". Latest txn: ${JSON.stringify(list[0] || {})}`);
  console.log(`   ✅ Found transaction id=${match.id} description="${match.description}"`);

  console.log('\n9) Cleanup: debit back the same amount (admin debit-account)');
  const debit = await request(
    'POST',
    '/api/admin/debit-account',
    { recipient: testEmail, amount, description: 'Cleanup: reverse inheritance test transfer' },
    adminToken
  );
  console.log(debit.status, debit.data.success, debit.data.message);
  assert(debit.status === 200 && debit.data.success === true, `cleanup debit failed: ${JSON.stringify(debit.data)}`);

  console.log('\n10) Cleanup: close the test user account');
  const close = await request(
    'PUT',
    `/api/admin/account-status/${testUserId}`,
    { status: 'closed', reason: 'Cleanup after inheritance test' },
    adminToken
  );
  console.log(close.status, close.data.success, close.data.message);
  assert(close.status === 200 && close.data.success === true, `account close failed: ${JSON.stringify(close.data)}`);

  console.log('\n✅ INHERITANCE TRANSFER DASHBOARD TEST PASSED');
})().catch((e) => {
  console.error('\n❌ INHERITANCE TRANSFER DASHBOARD TEST FAILED:', e.message);
  process.exit(1);
});
