# Frontend Integration Examples - New Features

Quick implementation examples for integrating new features into your frontend.

---

## 1. Scheduled Transfers UI Example

```javascript
// Create scheduled transfer form
async function createScheduledTransfer() {
  const token = localStorage.getItem('token');
  
  const data = {
    recipientEmail: document.getElementById('recipientEmail').value,
    amount: parseFloat(document.getElementById('amount').value),
    frequency: document.getElementById('frequency').value, // weekly, monthly, etc
    startDate: document.getElementById('startDate').value,
    endDate: document.getElementById('endDate').value,
    description: document.getElementById('description').value
  };

  const res = await fetch(`${API_URL}/api/scheduled-transfers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(data)
  });

  const result = await res.json();
  if (result.success) {
    showAlert('Scheduled transfer created!', 'success');
    loadScheduledTransfers();
  } else {
    showAlert(result.message, 'error');
  }
}

// Load and display scheduled transfers
async function loadScheduledTransfers() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/scheduled-transfers`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    displayScheduledTransfers(result.transfers);
  }
}

function displayScheduledTransfers(transfers) {
  const html = transfers.map(t => `
    <div class="transfer-card">
      <h4>${t.description || 'Scheduled Transfer'}</h4>
      <p>To: ${t.recipientEmail}</p>
      <p>Amount: $${t.amount}</p>
      <p>Frequency: ${t.frequency}</p>
      <p>Next: ${t.nextRunDate}</p>
      <p>Status: <span class="status-${t.status}">${t.status}</span></p>
      <button onclick="editTransfer(${t.id})">Edit</button>
      <button onclick="deleteTransfer(${t.id})">Cancel</button>
    </div>
  `).join('');
  
  document.getElementById('transfersList').innerHTML = html;
}
```

---

## 2. Budget Management UI Example

```javascript
// Create budget
async function createBudget() {
  const token = localStorage.getItem('token');
  
  const data = {
    category: document.getElementById('category').value,
    limit: parseFloat(document.getElementById('limit').value),
    month: document.getElementById('month').value // optional
  };

  const res = await fetch(`${API_URL}/api/budgets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(data)
  });

  const result = await res.json();
  if (result.success) {
    showAlert('Budget created!', 'success');
    loadBudgets();
  }
}

// Load and display budgets with progress bars
async function loadBudgets() {
  const token = localStorage.getItem('token');
  const month = document.getElementById('monthFilter').value || new Date().toISOString().slice(0, 7);
  
  const res = await fetch(`${API_URL}/api/budgets?month=${month}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    displayBudgets(result.budgets);
  }
}

function displayBudgets(budgets) {
  const html = budgets.map(b => {
    const percentage = (b.spent / b.limit * 100).toFixed(0);
    const warningClass = percentage > 80 ? 'warning' : percentage > 100 ? 'danger' : '';
    
    return `
      <div class="budget-card ${warningClass}">
        <h4>${b.category}</h4>
        <div class="progress-bar">
          <div class="progress" style="width: ${Math.min(percentage, 100)}%"></div>
        </div>
        <p>Spent: $${b.spent} / $${b.limit} (${percentage}%)</p>
        ${percentage > 80 ? '<p class="alert">Approaching limit!</p>' : ''}
        <button onclick="deleteBudget(${b.id})">Delete</button>
      </div>
    `;
  }).join('');
  
  document.getElementById('budgetsList').innerHTML = html;
}

// View spending by category
async function viewSpendingAnalytics() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/spending-analytics?period=monthly`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    // Create pie chart or bar chart with result.analytics
    console.log('Analytics:', result.analytics);
  }
}
```

---

## 3. Dispute Filing UI Example

```javascript
// File dispute against transaction
async function fileDis(transactionId) {
  const token = localStorage.getItem('token');
  
  const reason = prompt('Why are you disputing this transaction?');
  if (!reason) return;

  const res = await fetch(`${API_URL}/api/disputes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ transactionId, reason })
  });

  const result = await res.json();
  if (result.success) {
    showAlert(`Dispute filed! ID: ${result.disputeId}`, 'success');
    loadDisputes();
  }
}

// View your disputes
async function loadDisputes() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/disputes`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    const html = result.disputes.map(d => `
      <div class="dispute-card">
        <h4>Dispute #DSP-${d.id}</h4>
        <p>Transaction: ${d.transactionId}</p>
        <p>Reason: ${d.reason}</p>
        <p>Status: <span class="status-${d.status}">${d.status}</span></p>
        ${d.status === 'resolved' ? `<p>Resolution: ${d.resolution}</p>` : ''}
        ${d.adminNotes ? `<p>Admin: ${d.adminNotes}</p>` : ''}
        <p>Filed: ${new Date(d.createdAt).toLocaleDateString()}</p>
      </div>
    `).join('');
    
    document.getElementById('disputesList').innerHTML = html;
  }
}
```

---

## 4. Referral Program UI Example

```javascript
// Display referral code with copy button
async function displayReferralCode() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/referrals/code`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    const code = result.referralCode;
    const referralLink = `${window.location.origin}/?ref=${code}`;
    
    document.getElementById('referralCode').textContent = code;
    document.getElementById('referralLink').value = referralLink;
  }
}

// Copy to clipboard
function copyReferralCode() {
  const code = document.getElementById('referralCode').textContent;
  navigator.clipboard.writeText(code);
  showAlert('Referral code copied!', 'success');
}

// Apply referral code (for new users during signup)
async function applyReferralCode(code) {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/referrals/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ referralCode: code })
  });

  const result = await res.json();
  if (result.success) {
    showAlert('Referral applied! You\'ll receive $50 when criteria are met.', 'success');
  }
}

// View referral rewards
async function loadReferralRewards() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/referrals/rewards`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    const html = result.rewards.map(r => `
      <div class="reward-card">
        <p>Referred: ${r.firstName} ${r.lastName}</p>
        <p>Email: ${r.email}</p>
        <p>Reward: $${r.rewardAmount}</p>
        <p>Status: <span class="badge-${r.status}">${r.status}</span></p>
      </div>
    `).join('');
    
    document.getElementById('rewardsList').innerHTML = html;
    document.getElementById('totalRewards').textContent = `$${result.totalReward.toFixed(2)}`;
  }
}
```

---

## 5. Support Messages UI Example

```javascript
// Send support message
async function sendSupportMessage() {
  const token = localStorage.getItem('token');
  const message = document.getElementById('messageInput').value;
  
  if (!message.trim()) return;

  const res = await fetch(`${API_URL}/api/support/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ message })
  });

  const result = await res.json();
  if (result.success) {
    document.getElementById('messageInput').value = '';
    loadSupportMessages();
  }
}

// Load and display support conversation
async function loadSupportMessages() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/support/messages`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    const html = result.messages.map(m => `
      <div class="message-container ${m.senderType}">
        <div class="message">
          <p class="sender">${m.senderType === 'admin' ? 'Support Team' : 'You'}</p>
          <p class="text">${m.message}</p>
          <p class="time">${new Date(m.createdAt).toLocaleString()}</p>
        </div>
      </div>
    `).join('');
    
    document.getElementById('messagesList').innerHTML = html;
    document.getElementById('messagesList').scrollTop = document.getElementById('messagesList').scrollHeight;
  }
}
```

---

## 6. Velocity Check UI Example

```javascript
// Check transfer limits before transfer
async function checkVelocityLimits() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/velocity-check`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  if (result.success) {
    const { today, thisMonth, limits } = result;
    
    document.getElementById('dailyLimit').innerHTML = `
      Daily: $${today.total.toFixed(2)} / $${limits.daily}
      (${today.remaining.toFixed(2)} remaining)
    `;
    
    document.getElementById('monthlyLimit').innerHTML = `
      Monthly: $${thisMonth.total.toFixed(2)} / $${limits.monthly}
      (${thisMonth.remaining.toFixed(2)} remaining)
    `;
    
    // Disable transfer button if limits exceeded
    if (!result.canTransfer) {
      document.getElementById('transferBtn').disabled = true;
      showAlert('You have reached your transfer limit', 'warning');
    }
  }
}

// Call before showing transfer form
document.getElementById('transferForm').addEventListener('focus', checkVelocityLimits);
```

---

## 7. Download Statement Example

```javascript
// Download statement as CSV
async function downloadStatement() {
  const token = localStorage.getItem('token');
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  
  const url = `${API_URL}/api/statements/download?startDate=${startDate}&endDate=${endDate}&format=csv`;
  
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (res.ok) {
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `statement-${startDate}-to-${endDate}.csv`;
    link.click();
    showAlert('Statement downloaded!', 'success');
  }
}
```

---

## 8. Categorize Transactions Example

```javascript
// Categorize a transaction
async function categorizeTransaction(transactionId) {
  const token = localStorage.getItem('token');
  const category = document.getElementById('categorySelect').value;
  
  const res = await fetch(`${API_URL}/api/transactions/${transactionId}/category`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ category })
  });

  const result = await res.json();
  if (result.success) {
    showAlert('Transaction categorized!', 'success');
  }
}

// Show category selector modal
function showCategorySelector(transactionId) {
  const categories = ['groceries', 'restaurants', 'utilities', 'gas', 'shopping', 'entertainment', 'healthcare', 'transportation', 'bills', 'other'];
  
  const options = categories.map(c => `<option value="${c}">${c}</option>`).join('');
  
  document.getElementById('categorySelect').innerHTML = options;
  document.getElementById('categoryBtn').onclick = () => categorizeTransaction(transactionId);
}
```

---

## 9. Push Notification Handler Example

```javascript
// Request notification permission
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    console.log('Notification permission:', permission);
  }
}

// Send notification when event occurs
function sendNotification(title, options = {}) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, {
      icon: '/assets/logo.png',
      badge: '/assets/badge.png',
      ...options
    });
  }
}

// Examples:
// Scheduled transfer completed
sendNotification('Scheduled Transfer Complete', {
  body: 'Your $500 transfer to john@bank.com has been processed'
});

// Dispute resolved
sendNotification('Dispute Resolved', {
  body: 'Your dispute has been approved and $500 has been refunded'
});

// Referral reward approved
sendNotification('Reward Credited', {
  body: 'Your referral reward of $50 has been approved and credited'
});

// Budget limit warning
sendNotification('Budget Alert', {
  body: 'You\'ve spent 85% of your groceries budget'
});
```

---

## 10. Admin Panel Examples

```javascript
// Admin: View and resolve disputes
async function loadAdminDisputes() {
  const token = localStorage.getItem('token');
  const status = document.getElementById('statusFilter').value;
  
  const res = await fetch(`${API_URL}/api/admin/disputes?status=${status}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  const html = result.disputes.map(d => `
    <tr>
      <td>#DSP-${d.id}</td>
      <td>${d.email}</td>
      <td>${d.reason}</td>
      <td>${d.status}</td>
      <td>
        <select onchange="resolveDispute(${d.id}, this.value)">
          <option>Action</option>
          <option value="refund">Approve Refund</option>
          <option value="deny">Deny</option>
        </select>
      </td>
    </tr>
  `).join('');
  
  document.getElementById('disputesTable').innerHTML = html;
}

async function resolveDispute(disputeId, resolution) {
  const token = localStorage.getItem('token');
  const adminNotes = prompt('Add notes (optional):');
  
  const res = await fetch(`${API_URL}/api/admin/disputes/${disputeId}/resolve`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ resolution, adminNotes })
  });

  const result = await res.json();
  if (result.success) {
    showAlert(`Dispute ${resolution}!`, 'success');
    loadAdminDisputes();
  }
}

// Admin: View support messages
async function loadAdminMessages() {
  const token = localStorage.getItem('token');
  
  const res = await fetch(`${API_URL}/api/admin/support/messages`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const result = await res.json();
  const grouped = groupMessagesByUser(result.messages);
  
  const html = Object.entries(grouped).map(([userId, messages]) => `
    <div class="message-thread" onclick="openThread(${userId})">
      <p class="user">${messages[0].firstName} ${messages[0].lastName}</p>
      <p class="preview">${messages[messages.length - 1].message.substring(0, 50)}...</p>
    </div>
  `).join('');
  
  document.getElementById('messageThreads').innerHTML = html;
}

function groupMessagesByUser(messages) {
  return messages.reduce((acc, msg) => {
    if (!acc[msg.userId]) acc[msg.userId] = [];
    acc[msg.userId].push(msg);
    return acc;
  }, {});
}
```

---

## CSS Styling Suggestions

```css
/* Scheduled transfers */
.transfer-card {
  border: 1px solid #e0e0e0;
  padding: 15px;
  border-radius: 8px;
  margin-bottom: 15px;
}

/* Budgets with progress */
.budget-card {
  background: #f9f9f9;
  padding: 15px;
  border-radius: 8px;
  margin-bottom: 15px;
}

.budget-card.warning {
  background: #fff3cd;
  border-left: 4px solid #ffc107;
}

.budget-card.danger {
  background: #f8d7da;
  border-left: 4px solid #dc3545;
}

.progress-bar {
  background: #e9ecef;
  height: 20px;
  border-radius: 4px;
  overflow: hidden;
  margin: 10px 0;
}

.progress-bar .progress {
  background: linear-gradient(90deg, #28a745, #20c997);
  height: 100%;
  transition: width 0.3s;
}

/* Messages */
.message-container {
  display: flex;
  margin-bottom: 15px;
}

.message-container.user {
  justify-content: flex-end;
}

.message-container.admin {
  justify-content: flex-start;
}

.message {
  background: #e9ecef;
  padding: 12px;
  border-radius: 8px;
  max-width: 70%;
}

.message-container.user .message {
  background: #007bff;
  color: white;
}

/* Status badges */
.status-active { color: #28a745; }
.status-pending { color: #ffc107; }
.status-completed { color: #28a745; }
.status-denied { color: #dc3545; }
.status-open { color: #ffc107; }
.status-resolved { color: #28a745; }
```

---

## Quick Implementation Checklist

- [ ] Create HTML templates for each feature
- [ ] Add JavaScript event listeners
- [ ] Style components with CSS
- [ ] Test with real API calls
- [ ] Add loading indicators
- [ ] Add error handling
- [ ] Add success notifications
- [ ] Test on mobile devices
- [ ] Add accessibility attributes
- [ ] Deploy and test in production

All endpoints are production-ready and tested!
