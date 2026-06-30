/**
 * Heritage Bank - New Features Implementation
 * Scheduled Transfers, Budgeting, Disputes, Referrals, Support Messages
 */

module.exports = function(app, authenticateToken, requireAdmin, db) {
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';

  // ============ SCHEDULED TRANSFERS ============

  app.post('/api/scheduled-transfers', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      
      const { recipientEmail, amount, frequency, startDate, endDate, description } = req.body;
      if (!recipientEmail || !amount || !frequency) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }
      
      const recipient = await db.getUserByEmail(recipientEmail);
      if (!recipient) return res.status(404).json({ success: false, message: 'Recipient not found' });
      if (recipient.id === user.id) return res.status(400).json({ success: false, message: 'Cannot transfer to yourself' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [result] = await conn.execute(
          'INSERT INTO scheduled_transfers (userId, recipientId, amount, frequency, nextRunDate, endDate, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [user.id, recipient.id, amount, frequency, startDate || new Date().toISOString().split('T')[0], endDate || null, description || null]
        );
        res.json({ success: true, message: 'Scheduled transfer created', transferId: result.insertId });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[API] scheduled-transfers error', e);
      res.status(500).json({ success: false, message: 'Failed to create scheduled transfer' });
    }
  });

  app.get('/api/scheduled-transfers', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [transfers] = await conn.execute(
          'SELECT st.*, u.email as recipientEmail, u.firstName, u.lastName FROM scheduled_transfers st LEFT JOIN users u ON st.recipientId = u.id WHERE st.userId = ? ORDER BY st.nextRunDate ASC',
          [user.id]
        );
        res.json({ success: true, transfers });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[API] get scheduled-transfers error', e);
      res.status(500).json({ success: false, message: 'Failed to fetch scheduled transfers' });
    }
  });

  app.put('/api/scheduled-transfers/:id', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const { amount, frequency, endDate, description } = req.body;

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        await conn.execute(
          'UPDATE scheduled_transfers SET amount = ?, frequency = ?, endDate = ?, description = ? WHERE id = ? AND userId = ?',
          [amount, frequency, endDate || null, description || null, req.params.id, user.id]
        );
        res.json({ success: true, message: 'Scheduled transfer updated' });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[API] update scheduled-transfer error', e);
      res.status(500).json({ success: false, message: 'Failed to update scheduled transfer' });
    }
  });

  app.delete('/api/scheduled-transfers/:id', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        await conn.execute('DELETE FROM scheduled_transfers WHERE id = ? AND userId = ?', [req.params.id, user.id]);
        res.json({ success: true, message: 'Scheduled transfer deleted' });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to delete scheduled transfer' });
    }
  });

  // ============ BUDGETING ============

  app.post('/api/budgets', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const { category, limit, month } = req.body;
      if (!category || !limit) return res.status(400).json({ success: false, message: 'Category and limit required' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const currentMonth = month || new Date().toISOString().slice(0, 7);
        await conn.execute(
          'INSERT INTO budgets (userId, category, limit, month) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `limit` = VALUES(`limit`)',
          [user.id, category, limit, currentMonth]
        );
        res.json({ success: true, message: 'Budget created/updated' });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[API] budgets error', e);
      res.status(500).json({ success: false, message: 'Failed to create budget' });
    }
  });

  app.get('/api/budgets', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const month = req.query.month || new Date().toISOString().slice(0, 7);
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [budgets] = await conn.execute(
          'SELECT * FROM budgets WHERE userId = ? AND month = ? ORDER BY category ASC',
          [user.id, month]
        );
        res.json({ success: true, budgets });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch budgets' });
    }
  });

  app.delete('/api/budgets/:id', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        await conn.execute('DELETE FROM budgets WHERE id = ? AND userId = ?', [req.params.id, user.id]);
        res.json({ success: true, message: 'Budget deleted' });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to delete budget' });
    }
  });

  // ============ TRANSACTION CATEGORIZATION ============

  app.put('/api/transactions/:id/category', authenticateToken, async (req, res) => {
    try {
      const { category } = req.body;
      if (!category) return res.status(400).json({ success: false, message: 'Category required' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        await conn.execute('UPDATE transactions SET category = ? WHERE id = ?', [category, req.params.id]);
        res.json({ success: true, message: 'Transaction categorized' });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to update transaction' });
    }
  });

  app.get('/api/spending-analytics', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const period = req.query.period || 'monthly';
      
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [analytics] = await conn.execute(
          `SELECT category, COUNT(*) as count, SUM(amount) as total
           FROM transactions WHERE fromUserId = ? AND category IS NOT NULL
           GROUP BY category ORDER BY total DESC`,
          [user.id]
        );
        res.json({ success: true, analytics });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
    }
  });

  // ============ DISPUTES/CHARGEBACKS ============

  app.post('/api/disputes', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const { transactionId, reason } = req.body;
      if (!transactionId || !reason) return res.status(400).json({ success: false, message: 'Transaction and reason required' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [result] = await conn.execute(
          'INSERT INTO disputes (userId, transactionId, reason) VALUES (?, ?, ?)',
          [user.id, transactionId, reason]
        );
        res.json({ success: true, message: 'Dispute filed', disputeId: `DSP-${result.insertId}` });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[API] disputes error', e);
      res.status(500).json({ success: false, message: 'Failed to file dispute' });
    }
  });

  app.get('/api/disputes', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [disputes] = await conn.execute(
          'SELECT * FROM disputes WHERE userId = ? ORDER BY createdAt DESC',
          [user.id]
        );
        res.json({ success: true, disputes });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch disputes' });
    }
  });

  app.get('/api/admin/disputes', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const status = req.query.status || '';
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const where = status ? 'WHERE status = ?' : '';
        const [disputes] = await conn.execute(
          `SELECT d.*, u.email, u.firstName, u.lastName FROM disputes d LEFT JOIN users u ON d.userId = u.id ${where} ORDER BY d.createdAt DESC LIMIT 500`,
          status ? [status] : []
        );
        res.json({ success: true, disputes });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[ADMIN] disputes error', e);
      res.status(500).json({ success: false, message: 'Failed to fetch disputes' });
    }
  });

  app.put('/api/admin/disputes/:id/resolve', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { resolution, adminNotes } = req.body;
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [[dispute]] = await conn.execute('SELECT * FROM disputes WHERE id = ?', [req.params.id]);
        if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

        await conn.execute(
          'UPDATE disputes SET status = ?, resolution = ?, adminNotes = ? WHERE id = ?',
          [resolution === 'refund' ? 'resolved' : 'denied', resolution, adminNotes || null, req.params.id]
        );

        if (resolution === 'refund' && dispute.transactionId) {
          const [[txn]] = await conn.execute('SELECT * FROM transactions WHERE id = ?', [dispute.transactionId]);
          if (txn && txn.fromUserId) {
            await conn.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [txn.amount, txn.fromUserId]);
          }
        }
        res.json({ success: true, message: `Dispute ${resolution === 'refund' ? 'refunded' : 'denied'}` });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[ADMIN] resolve dispute error', e);
      res.status(500).json({ success: false, message: 'Failed to resolve dispute' });
    }
  });

  // ============ REFERRAL PROGRAM ============

  app.get('/api/referrals/code', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        if (!user.referralCode) {
          const code = db.generateReferralCode();
          await conn.execute('UPDATE users SET referralCode = ? WHERE id = ?', [code, user.id]);
          user.referralCode = code;
        }
        res.json({ success: true, referralCode: user.referralCode });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch referral code' });
    }
  });

  app.post('/api/referrals/apply', authenticateToken, async (req, res) => {
    try {
      const { referralCode } = req.body;
      if (!referralCode) return res.status(400).json({ success: false, message: 'Referral code required' });

      const user = await db.getUserByEmail(req.user.email);
      if (user.referredBy) return res.status(400).json({ success: false, message: 'You already have a referrer' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [[referrer]] = await conn.execute('SELECT id FROM users WHERE referralCode = ?', [referralCode]);
        if (!referrer) return res.status(404).json({ success: false, message: 'Invalid referral code' });

        await conn.execute('UPDATE users SET referredBy = ? WHERE id = ?', [referrer.id, user.id]);
        await conn.execute('INSERT INTO referral_rewards (referrerId, referredUserId, status) VALUES (?, ?, ?)', [referrer.id, user.id, 'pending']);

        res.json({ success: true, message: 'Referral applied successfully' });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to apply referral' });
    }
  });

  app.get('/api/referrals/rewards', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [rewards] = await conn.execute(
          'SELECT r.*, u.email, u.firstName, u.lastName FROM referral_rewards r LEFT JOIN users u ON r.referredUserId = u.id WHERE r.referrerId = ? ORDER BY r.createdAt DESC',
          [user.id]
        );
        const totalReward = rewards.reduce((sum, r) => sum + (r.status === 'pending' ? 0 : parseFloat(r.rewardAmount || 0)), 0);
        res.json({ success: true, rewards, totalReward });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch rewards' });
    }
  });

  app.post('/api/admin/referrals/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [[reward]] = await conn.execute('SELECT * FROM referral_rewards WHERE id = ?', [req.params.id]);
        if (!reward) return res.status(404).json({ success: false, message: 'Reward not found' });

        await conn.execute('UPDATE referral_rewards SET status = ? WHERE id = ?', ['completed', req.params.id]);
        await conn.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [reward.rewardAmount, reward.referrerId]);

        res.json({ success: true, message: 'Reward approved and credited' });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to approve reward' });
    }
  });

  // ============ INTERNAL SUPPORT MESSAGES ============

  app.post('/api/support/messages', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const { message } = req.body;
      if (!message) return res.status(400).json({ success: false, message: 'Message required' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [result] = await conn.execute(
          'INSERT INTO support_messages (userId, message, senderType) VALUES (?, ?, ?)',
          [user.id, message, 'user']
        );
        res.json({ success: true, message: 'Message sent', messageId: result.insertId });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[API] support message error', e);
      res.status(500).json({ success: false, message: 'Failed to send message' });
    }
  });

  app.get('/api/support/messages', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [messages] = await conn.execute(
          'SELECT * FROM support_messages WHERE userId = ? ORDER BY createdAt DESC LIMIT 50',
          [user.id]
        );
        res.json({ success: true, messages });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch messages' });
    }
  });

  app.get('/api/admin/support/messages', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [messages] = await conn.execute(
          `SELECT sm.*, u.email, u.firstName, u.lastName FROM support_messages sm
           LEFT JOIN users u ON sm.userId = u.id ORDER BY sm.createdAt DESC LIMIT 500`
        );
        res.json({ success: true, messages });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[ADMIN] support messages error', e);
      res.status(500).json({ success: false, message: 'Failed to fetch messages' });
    }
  });

  app.post('/api/admin/support/messages/:id/reply', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const { message } = req.body;
      if (!message) return res.status(400).json({ success: false, message: 'Reply message required' });

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [[originalMsg]] = await conn.execute('SELECT * FROM support_messages WHERE id = ?', [req.params.id]);
        if (!originalMsg) return res.status(404).json({ success: false, message: 'Message not found' });

        const [result] = await conn.execute(
          'INSERT INTO support_messages (userId, adminId, message, senderType) VALUES (?, ?, ?, ?)',
          [originalMsg.userId, user.id, message, 'admin']
        );
        res.json({ success: true, message: 'Reply sent', messageId: result.insertId });
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[ADMIN] reply message error', e);
      res.status(500).json({ success: false, message: 'Failed to send reply' });
    }
  });

  // ============ ACCOUNT STATEMENTS & EXPORT ============

  app.get('/api/statements/download', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const { startDate, endDate, format } = req.query;

      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const [transactions] = await conn.execute(
          `SELECT * FROM transactions WHERE (fromUserId = ? OR toUserId = ?) AND DATE(createdAt) BETWEEN ? AND ?
           ORDER BY createdAt DESC`,
          [user.id, user.id, startDate || '2020-01-01', endDate || new Date().toISOString().split('T')[0]]
        );

        if (format === 'csv') {
          let csv = 'Date,Type,Description,Amount,From,To,Status\n';
          transactions.forEach(t => {
            csv += `"${t.createdAt}","${t.type}","${(t.description || '').replace(/"/g, '""')}",${t.amount},"${t.fromUserId || 'N/A'}","${t.toUserId || 'N/A'}","${t.status}"\n`;
          });
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', 'attachment; filename=statement.csv');
          res.send(csv);
        } else if (format === 'pdf') {
          // Generate simple HTML that browsers can print to PDF
          let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Account Statement</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; }
    h1 { color: #1a472a; border-bottom: 3px solid #d4af37; padding-bottom: 10px; }
    .header { margin-bottom: 30px; }
    .info { margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th { background: #1a472a; color: white; padding: 10px; text-align: left; }
    td { padding: 8px; border-bottom: 1px solid #ddd; }
    tr:hover { background: #f5f5f5; }
    .credit { color: #28a745; font-weight: bold; }
    .debit { color: #dc3545; font-weight: bold; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #1a472a; text-align: center; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Heritage Bank - Account Statement</h1>
  <div class="header">
    <div class="info"><strong>Account Holder:</strong> ${user.firstName} ${user.lastName}</div>
    <div class="info"><strong>Account Number:</strong> ${user.accountNumber || 'N/A'}</div>
    <div class="info"><strong>Statement Period:</strong> ${startDate || '2020-01-01'} to ${endDate || new Date().toISOString().split('T')[0]}</div>
    <div class="info"><strong>Generated:</strong> ${new Date().toLocaleString()}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Description</th>
        <th>Type</th>
        <th>Amount</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
`;
          transactions.forEach(t => {
            const isCredit = t.toUserId === user.id;
            const amountClass = isCredit ? 'credit' : 'debit';
            const amountSign = isCredit ? '+' : '-';
            html += `      <tr>
        <td>${new Date(t.createdAt).toLocaleDateString()}</td>
        <td>${t.description || 'N/A'}</td>
        <td>${t.type || 'N/A'}</td>
        <td class="${amountClass}">${amountSign}$${parseFloat(t.amount).toFixed(2)}</td>
        <td>${t.status || 'N/A'}</td>
      </tr>
`;
          });
          html += `    </tbody>
  </table>
  <div class="footer">
    <p>Heritage Bank &bull; Member FDIC &bull; Equal Housing Lender</p>
    <p>This is an official statement. Please keep for your records.</p>
  </div>
</body>
</html>`;
          res.setHeader('Content-Type', 'text/html');
          res.send(html);
        } else {
          res.json({ success: true, transactions });
        }
      } finally { await conn.release(); }
    } catch (e) {
      console.error('[API] statement download error', e);
      res.status(500).json({ success: false, message: 'Failed to generate statement' });
    }
  });

  // ============ VELOCITY CHECKS (Fraud Detection) ============

  app.get('/api/velocity-check', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserByEmail(req.user.email);
      const pool = await db.initializePool();
      const conn = await pool.getConnection();
      try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [[dayStats]] = await conn.execute(
          'SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM transactions WHERE fromUserId = ? AND DATE(createdAt) = DATE(?)',
          [user.id, today]
        );

        const [[monthStats]] = await conn.execute(
          'SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM transactions WHERE fromUserId = ? AND DATE(createdAt) >= DATE(?)',
          [user.id, monthStart]
        );

        const limits = { daily: 10000, monthly: 100000 };
        const dayRemaining = Math.max(0, limits.daily - parseFloat(dayStats.total || 0));
        const monthRemaining = Math.max(0, limits.monthly - parseFloat(monthStats.total || 0));

        res.json({
          success: true,
          limits,
          today: { count: dayStats.count, total: parseFloat(dayStats.total || 0), remaining: dayRemaining },
          thisMonth: { count: monthStats.count, total: parseFloat(monthStats.total || 0), remaining: monthRemaining },
          canTransfer: dayRemaining > 0 && monthRemaining > 0
        });
      } finally { await conn.release(); }
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to check velocity' });
    }
  });

};
