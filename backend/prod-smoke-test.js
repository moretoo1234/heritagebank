/*
  Production (Render) authenticated smoke test.

  What it does:
    - Admin login
    - Call a couple admin endpoints (read-only)
    - Create a unique test user (small footprint)
    - Perform a tiny admin transfer WITH description
    - Close the test user account (best-effort cleanup)

  Usage (PowerShell):
    node prod-smoke-test.js

  Env overrides:
    E2E_BASE_URL=https://heritagebank-ku1y.onrender.com
    E2E_ADMIN_EMAIL=...
    E2E_ADMIN_PASSWORD=...
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

  console.log('1) Ping system status');
  const sys = await request('GET', '/api/system/status');
  console.log(sys.status, sys.data.success, sys.data.serverTime);
  assert(sys.status === 200 && sys.data.success === true, 'system/status should be reachable');

  console.log('\n2) Admin login');
  const login = await request('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  console.log(login.status, login.data.success, login.data.user?.email);
  assert(login.status === 200 && login.data.success === true, `admin login failed: ${JSON.stringify(login.data)}`);
  const adminToken = login.data.token;

  console.log('\n3) Admin dashboard stats (auth check)');
  const stats = await request('GET', '/api/admin/dashboard-stats', null, adminToken);
  console.log(stats.status, stats.data.success);
  assert(stats.status === 200 && stats.data.success === true, `dashboard-stats failed: ${JSON.stringify(stats.data)}`);

  console.log('\n4) Admin users-with-balances (auth check)');
  const users = await request('GET', '/api/admin/users-with-balances', null, adminToken);
  console.log(users.status, users.data.success, Array.isArray(users.data.users) ? `users=${users.data.users.length}` : '');
  assert(users.status === 200 && users.data.success === true, `users-with-balances failed: ${JSON.stringify(users.data)}`);

  console.log('\n5) Create a unique test user (prod)');
  const testEmail = `prod_test_${stamp}@example.com`;
  const testPassword = 'ProdTest!234';
  const createUser = await request(
    'POST',
    '/api/admin/create-user',
    {
      firstName: 'Prod',
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

  console.log('\n6) Admin transfer $1 to test user with description');
  const transfer = await request(
    'POST',
    '/api/admin/transfer',
    {
      fromEmail: adminEmail,
      toEmail: testEmail,
      amount: 1,
      description: 'PROD SMOKE TEST: admin transfer with description'
    },
    adminToken
  );
  console.log(transfer.status, transfer.data.success, transfer.data.reference);
  assert(transfer.status === 200 && transfer.data.success === true, `admin transfer failed: ${JSON.stringify(transfer.data)}`);

  console.log('\n7) Close the test user account (cleanup)');
  const close = await request(
    'PUT',
    `/api/admin/account-status/${testUserId}`,
    { status: 'closed', reason: 'Cleanup after prod smoke test' },
    adminToken
  );
  console.log(close.status, close.data.success, close.data.message);
  assert(close.status === 200 && close.data.success === true, `account close failed: ${JSON.stringify(close.data)}`);

  console.log('\n✅ PRODUCTION AUTH SMOKE TEST PASSED');
})().catch((e) => {
  console.error('\n❌ PRODUCTION AUTH SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
