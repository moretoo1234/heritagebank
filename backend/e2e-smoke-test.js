/*
  E2E smoke test for Heritage Bank backend.
  Runs a minimal admin+user flow against a locally running server.

  Usage (PowerShell):
    node e2e-smoke-test.js

  Requires backend server running on http://localhost:3001
*/

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001';

async function j(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
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

function maskedToken(t) {
  if (!t) return null;
  return `${t.slice(0, 16)}...${t.slice(-10)}`;
}

(async () => {
  const stamp = Date.now();

  const adminEmail = process.env.E2E_ADMIN_EMAIL || 'admin@heritagebank.com';
  const adminPassword = process.env.E2E_ADMIN_PASSWORD || 'AdminPass123456';

  console.log('1) Admin login');
  const adminLogin = await j('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  console.log(adminLogin.status, adminLogin.data.success, 'adminToken=', maskedToken(adminLogin.data.token));
  if (!adminLogin.data.success) throw new Error(`Admin login failed: ${JSON.stringify(adminLogin.data)}`);
  const adminToken = adminLogin.data.token;

  console.log('\n2) User register (user1)');
  const user1Email = `user1_${stamp}@example.com`;
  const user1Password = 'User1Pass!234';
  const reg1 = await j('POST', '/api/auth/register', {
    firstName: 'User',
    lastName: 'One',
    email: user1Email,
    password: user1Password,
    phone: '555-0101',
    initialDeposit: 1000
  });
  console.log(reg1.status, reg1.data.success, reg1.data.message);
  if (!reg1.data.success) throw new Error(`Register failed: ${JSON.stringify(reg1.data)}`);

  console.log('\n3) User login (user1)');
  const login1 = await j('POST', '/api/auth/login', { email: user1Email, password: user1Password });
  console.log(login1.status, login1.data.success, 'user1Token=', maskedToken(login1.data.token));
  if (!login1.data.success) throw new Error(`User1 login failed: ${JSON.stringify(login1.data)}`);
  const user1Id = login1.data.user?.id;
  const user1Token = login1.data.token;

  console.log('\n4) User change password (user1)');
  const user1NewPassword = 'User1NewPass!456';
  const ch1 = await j(
    'POST',
    '/api/auth/change-password',
    { currentPassword: user1Password, newPassword: user1NewPassword },
    user1Token
  );
  console.log(ch1.status, ch1.data);
  if (!ch1.data.success) throw new Error(`Change password failed: ${JSON.stringify(ch1.data)}`);

  console.log('\n5) User login with new password (user1)');
  const login1b = await j('POST', '/api/auth/login', { email: user1Email, password: user1NewPassword });
  console.log(login1b.status, login1b.data.success);
  if (!login1b.data.success) throw new Error(`User1 re-login failed: ${JSON.stringify(login1b.data)}`);
  const user1Token2 = login1b.data.token;

  console.log('\n6) Admin create user (user2)');
  const user2Email = `user2_${stamp}@example.com`;
  const user2Password = 'User2Pass!234';
  const create2 = await j(
    'POST',
    '/api/admin/create-user',
    {
      firstName: 'User',
      lastName: 'Two',
      email: user2Email,
      password: user2Password,
      initialBalance: 500,
      accountType: 'checking'
    },
    adminToken
  );
  console.log(create2.status, create2.data.success, create2.data.user?.id, create2.data.user?.accountNumber);
  if (!create2.data.success) throw new Error(`Admin create user failed: ${JSON.stringify(create2.data)}`);

  console.log('\n7) Admin transfer to user1 with description');
  const t1 = await j(
    'POST',
    '/api/admin/transfer',
    {
      fromEmail: adminEmail,
      toEmail: user1Email,
      amount: 250,
      description: 'Welcome bonus (admin transfer)'
    },
    adminToken
  );
  console.log(t1.status, t1.data.success, t1.data.reference);
  if (!t1.data.success) throw new Error(`Admin transfer failed: ${JSON.stringify(t1.data)}`);

  console.log('\n8) Freeze user1 account (hold)');
  const freeze = await j(
    'PUT',
    `/api/admin/account-status/${user1Id}`,
    { status: 'frozen', reason: 'Test hold to block transfers' },
    adminToken
  );
  console.log(freeze.status, freeze.data);
  if (!freeze.data.success) throw new Error(`Freeze failed: ${JSON.stringify(freeze.data)}`);

  console.log('\n9) Attempt user1 transfer while frozen (should fail with 403)');
  const xfer = await j(
    'POST',
    '/api/user/transfer',
    { toEmail: user2Email, amount: 10, description: 'Should be blocked because frozen' },
    user1Token2
  );
  console.log(xfer.status, xfer.data);
  if (xfer.status !== 403) {
    throw new Error(`Expected 403 when frozen, got ${xfer.status}: ${JSON.stringify(xfer.data)}`);
  }

  console.log('\n10) Admin password reset user1');
  const reset = await j(
    'POST',
    `/api/admin/force-password-reset/${user1Id}`,
    { temporaryPassword: 'TempUser1!999' },
    adminToken
  );
  console.log(reset.status, reset.data.success, reset.data.temporaryPassword ? 'returnedTemp=yes' : 'returnedTemp=no');
  if (!reset.data.success) throw new Error(`Admin reset failed: ${JSON.stringify(reset.data)}`);

  console.log('\n11) Unfreeze user1 so login is allowed');
  const unfreeze = await j(
    'PUT',
    `/api/admin/account-status/${user1Id}`,
    { status: 'active', reason: 'End test' },
    adminToken
  );
  console.log(unfreeze.status, unfreeze.data);
  if (!unfreeze.data.success) throw new Error(`Unfreeze failed: ${JSON.stringify(unfreeze.data)}`);

  console.log('\n12) Login user1 with admin-set temp password');
  const loginTemp = await j('POST', '/api/auth/login', { email: user1Email, password: 'TempUser1!999' });
  console.log(loginTemp.status, loginTemp.data.success);
  if (!loginTemp.data.success) throw new Error(`Temp login failed: ${JSON.stringify(loginTemp.data)}`);

  console.log('\n13) Verify admin route is blocked for non-admin token');
  const attempt = await j(
    'POST',
    '/api/admin/create-user',
    { firstName: 'X', lastName: 'Y', email: `hacker_${stamp}@example.com`, password: 'HackPass!234' },
    user1Token2
  );
  console.log(attempt.status, attempt.data);
  if (attempt.status !== 403) {
    throw new Error(`Expected 403 for non-admin, got ${attempt.status}: ${JSON.stringify(attempt.data)}`);
  }

  console.log('\n✅ E2E SMOKE TEST PASSED');
})().catch((e) => {
  console.error('\n❌ E2E SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
