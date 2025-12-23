/*
  Final API edge-case check for Heritage Bank backend.

  Requires backend running on http://localhost:3001
  PowerShell:
    node e2e-final-check.js
*/

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

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
  const stamp = Date.now();

  const adminEmail = process.env.E2E_ADMIN_EMAIL || 'admin@heritagebank.com';
  const adminPassword = process.env.E2E_ADMIN_PASSWORD || 'AdminPass123456';

  console.log('A) system status');
  const sys = await request('GET', '/api/system/status');
  console.log(sys.status, sys.data.success);
  assert(sys.status === 200 && sys.data.success === true, 'system/status should return success');

  console.log('\nB) admin login');
  const adminLogin = await request('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  console.log(adminLogin.status, adminLogin.data.success);
  assert(adminLogin.data.success === true, 'admin login must succeed');
  const adminToken = adminLogin.data.token;

  console.log('\nC) admin users-with-balances requires auth');
  const noAuth = await request('GET', '/api/admin/users-with-balances');
  console.log(noAuth.status, noAuth.data);
  assert(noAuth.status === 401, 'admin/users-with-balances should be 401 without token');

  console.log('\nD) create a normal user');
  const userEmail = `final_${stamp}@example.com`;
  const userPass = 'FinalUser!234';
  const reg = await request('POST', '/api/auth/register', {
    firstName: 'Final',
    lastName: 'User',
    email: userEmail,
    password: userPass,
    phone: '555-0102',
    initialDeposit: 1000
  });
  console.log(reg.status, reg.data.success);
  assert(reg.status === 201 && reg.data.success === true, 'register should succeed');

  const userLogin = await request('POST', '/api/auth/login', { email: userEmail, password: userPass });
  console.log('user login:', userLogin.status, userLogin.data.success);
  assert(userLogin.data.success === true, 'user login must succeed');
  const userToken = userLogin.data.token;

  console.log('\nE) non-admin cannot call admin endpoint');
  const userAdminAttempt = await request(
    'POST',
    '/api/admin/create-user',
    { firstName: 'X', lastName: 'Y', email: `nope_${stamp}@example.com`, password: 'NopePass!234' },
    userToken
  );
  console.log(userAdminAttempt.status, userAdminAttempt.data);
  assert(userAdminAttempt.status === 403, 'non-admin must be blocked from admin routes');

  console.log('\nF) user transfer rejects invalid amount');
  const badAmt = await request('POST', '/api/user/transfer', { toEmail: adminEmail, amount: 0 }, userToken);
  console.log(badAmt.status, badAmt.data);
  assert(badAmt.status === 400, 'amount=0 should be rejected');

  console.log('\nG) admin transfer rejects same sender/recipient');
  // using sender and recipient as same email
  const same = await request(
    'POST',
    '/api/admin/transfer',
    { fromEmail: adminEmail, toEmail: adminEmail, amount: 10, description: 'Should fail' },
    adminToken
  );
  console.log(same.status, same.data);
  assert(same.status === 400, 'admin transfer to same account should fail');

  console.log('\n✅ FINAL EDGE-CASE CHECK PASSED');
})().catch((e) => {
  console.error('\n❌ FINAL EDGE-CASE CHECK FAILED:', e.message);
  process.exit(1);
});
