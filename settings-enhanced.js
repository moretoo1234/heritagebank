/**
 * Enhanced Settings Page JavaScript
 * Handles all banking profile features: account info, documents, beneficiaries,
 * security, 2FA, login history, sessions, data export, and account controls
 */

const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
    ? 'http://localhost:3001' 
    : '';
let userId = null;
let loginHistoryCache = [];
let activeSessionsCache = [];

// ============================================================================
// AUTHENTICATION & INITIALIZATION
// ============================================================================

async function checkAuth() {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = 'signin.html';
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/api/user/profile/complete`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!res.ok) {
            if (res.status === 401) {
                window.location.href = 'signin.html';
                return;
            }
            throw new Error('Failed to load profile');
        }
        
        const data = await res.json();
        
        if (data.success && data.user) {
            userId = data.user.id;
            await populateAllSections(data.user);
        } else {
            window.location.href = 'signin.html';
        }
    } catch (e) {
        console.error('Auth error:', e);
        showAlert('Error loading profile: ' + e.message, 'error');
    }
}

async function populateAllSections(user) {
    // Populate basic profile
    populateProfileForm(user);
    
    // Populate account information
    populateAccountInfo(user);
    
    // Populate transaction limits
    populateTransactionLimits(user);
    
    // Load login history
    await loadLoginHistory();
    
    // Load active sessions
    await loadActiveSessions();
    
    // Load beneficiaries
    await loadBeneficiaries();
    
    // Load document verification status
    await loadDocumentStatus(user);
    
    // Load account controls state
    populateAccountControls(user);
    
    // Load preferences
    await loadPreferences(user);
}

// ============================================================================
// PROFILE FORM - BASIC & ENHANCED
// ============================================================================

function populateProfileForm(user) {
    // Basic fields
    document.getElementById('firstName').value = user.firstName || '';
    document.getElementById('lastName').value = user.lastName || '';
    document.getElementById('email').value = user.email || '';
    document.getElementById('phone').value = user.phone || '';
    document.getElementById('address').value = user.address || '';
    document.getElementById('city').value = user.city || '';
    document.getElementById('country').value = user.country || 'United States';
    
    // Enhanced fields (if present)
    if (document.getElementById('dateOfBirth')) {
        document.getElementById('dateOfBirth').value = user.dateOfBirth || '';
    }
    if (document.getElementById('ssn')) {
        document.getElementById('ssn').value = maskSSN(user.ssn) || '';
    }
    if (document.getElementById('state')) {
        document.getElementById('state').value = user.state || '';
    }
    if (document.getElementById('zipCode')) {
        document.getElementById('zipCode').value = user.zipCode || '';
    }
    
    // Populate verification badges
    updateVerificationBadges(user);
}

function maskSSN(ssn) {
    if (!ssn) return '';
    const clean = ssn.replace(/\D/g, '');
    if (clean.length !== 9) return '';
    return `***-**-${clean.slice(-4)}`;
}

function updateVerificationBadges(user) {
    const emailBadge = document.getElementById('emailVerificationBadge');
    const phoneBadge = document.getElementById('phoneVerificationBadge');
    
    if (emailBadge) {
        if (user.emailVerified) {
            emailBadge.innerHTML = '<i class="fas fa-check-circle" style="color: #4caf50;"></i> Verified';
            emailBadge.style.color = '#4caf50';
        } else {
            emailBadge.innerHTML = '<i class="fas fa-exclamation-circle" style="color: #ff9800;"></i> Unverified';
            emailBadge.style.color = '#ff9800';
        }
    }
    
    if (phoneBadge) {
        if (user.phoneVerified) {
            phoneBadge.innerHTML = '<i class="fas fa-check-circle" style="color: #4caf50;"></i> Verified';
            phoneBadge.style.color = '#4caf50';
        } else {
            phoneBadge.innerHTML = '<i class="fas fa-exclamation-circle" style="color: #ff9800;"></i> Unverified';
            phoneBadge.style.color = '#ff9800';
        }
    }
}

// ============================================================================
// ACCOUNT INFORMATION DISPLAY
// ============================================================================

function populateAccountInfo(user) {
    const accountNumberEl = document.getElementById('accountNumber');
    const routingNumberEl = document.getElementById('routingNumber');
    const accountTypeEl = document.getElementById('accountType');
    const accountStatusEl = document.getElementById('accountStatus');
    const balanceEl = document.getElementById('balance');
    const memberSinceEl = document.getElementById('memberSince');
    
    if (accountNumberEl) {
        accountNumberEl.textContent = formatAccountNumber(user.accountNumber || '');
    }
    if (routingNumberEl) {
        routingNumberEl.textContent = user.routingNumber || 'N/A';
    }
    if (accountTypeEl) {
        accountTypeEl.textContent = formatAccountType(user.accountType || '');
    }
    if (accountStatusEl) {
        accountStatusEl.innerHTML = getStatusBadge(user.accountStatus || 'active');
    }
    if (balanceEl) {
        balanceEl.textContent = formatCurrency(user.balance || 0);
    }
    if (memberSinceEl && user.createdAt) {
        memberSinceEl.textContent = formatDate(user.createdAt);
    }
}

function formatAccountNumber(num) {
    const str = String(num).padStart(10, '0');
    return str.slice(0, 4) + '-' + str.slice(4);
}

function formatAccountType(type) {
    const types = {
        'checking': 'Checking Account',
        'savings': 'Savings Account',
        'money-market': 'Money Market Account',
        'cd': 'Certificate of Deposit'
    };
    return types[type] || type;
}

function getStatusBadge(status) {
    const badges = {
        'active': '<span class="badge" style="background: #4caf50;">Active</span>',
        'frozen': '<span class="badge" style="background: #ff9800;">Frozen</span>',
        'suspended': '<span class="badge" style="background: #f44336;">Suspended</span>',
        'pending': '<span class="badge" style="background: #2196f3;">Pending</span>'
    };
    return badges[status] || `<span class="badge">${status}</span>`;
}

function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(amount);
}

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ============================================================================
// TRANSACTION LIMITS
// ============================================================================

function populateTransactionLimits(user) {
    const daily = {
        limit: user.dailyTransferLimit || 10000,
        spent: user.dailyTransferSpent || 0
    };
    const weekly = {
        limit: user.weeklyTransferLimit || 50000,
        spent: user.weeklyTransferSpent || 0
    };
    const monthly = {
        limit: user.monthlyTransferLimit || 200000,
        spent: user.monthlyTransferSpent || 0
    };
    
    updateLimitDisplay('daily', daily);
    updateLimitDisplay('weekly', weekly);
    updateLimitDisplay('monthly', monthly);
    
    const singleEl = document.getElementById('singleTransactionLimit');
    if (singleEl) {
        singleEl.textContent = formatCurrency(user.singleTransactionLimit || 25000);
    }
}

function updateLimitDisplay(period, data) {
    const percentUsed = Math.round((data.spent / data.limit) * 100);
    const labelEl = document.getElementById(`${period}Limit`);
    const progressEl = document.getElementById(`${period}Progress`);
    const spentEl = document.getElementById(`${period}Spent`);
    
    if (labelEl) {
        labelEl.textContent = formatCurrency(data.limit);
    }
    if (spentEl) {
        spentEl.textContent = `${formatCurrency(data.spent)} of ${formatCurrency(data.limit)}`;
    }
    if (progressEl) {
        progressEl.style.width = percentUsed + '%';
        const color = percentUsed > 80 ? '#f44336' : percentUsed > 50 ? '#ff9800' : '#4caf50';
        progressEl.style.backgroundColor = color;
    }
}

// ============================================================================
// PROFILE UPDATE
// ============================================================================

async function updateProfile(e) {
    e?.preventDefault();
    const token = localStorage.getItem('token');
    
    const profileData = {
        firstName: document.getElementById('firstName').value,
        lastName: document.getElementById('lastName').value,
        phone: document.getElementById('phone').value,
        address: document.getElementById('address').value,
        city: document.getElementById('city').value,
        state: document.getElementById('state')?.value,
        zipCode: document.getElementById('zipCode')?.value,
        dateOfBirth: document.getElementById('dateOfBirth')?.value,
        country: document.getElementById('country').value
    };
    
    try {
        const res = await fetch(`${API_URL}/api/user/profile/complete`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(profileData)
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Profile updated successfully!', 'success');
        } else {
            showAlert(data.message || 'Update failed', 'error');
        }
    } catch (e) {
        showAlert('Error updating profile: ' + e.message, 'error');
    }
}

// ============================================================================
// LOGIN HISTORY & SESSIONS
// ============================================================================

async function loadLoginHistory() {
    const token = localStorage.getItem('token');
    const container = document.getElementById('loginHistoryContainer');
    if (!container) return;
    
    try {
        const res = await fetch(`${API_URL}/api/user/security/login-history`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success && data.logins) {
            loginHistoryCache = data.logins;
            displayLoginHistory(data.logins);
        } else {
            container.innerHTML = '<p style="color: #999; text-align: center;">No login history available</p>';
        }
    } catch (e) {
        console.error('Error loading login history:', e);
        container.innerHTML = '<p style="color: #999; text-align: center;">Error loading history</p>';
    }
}

function displayLoginHistory(logins) {
    const container = document.getElementById('loginHistoryContainer');
    if (!container) return;
    
    if (!logins || logins.length === 0) {
        container.innerHTML = '<p style="color: #999; text-align: center;">No login history</p>';
        return;
    }
    
    container.innerHTML = logins.slice(0, 10).map(login => `
        <div class="history-item" style="padding: 10px; border-bottom: 1px solid #eee;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong>${login.device || 'Unknown Device'}</strong>
                    <p style="margin: 5px 0 0 0; color: #666; font-size: 0.85rem;">
                        <i class="fas fa-map-marker-alt"></i> ${login.location || 'Unknown Location'}<br>
                        <i class="fas fa-globe"></i> IP: ${maskIP(login.ip || 'N/A')}
                    </p>
                </div>
                <div style="text-align: right; color: #999; font-size: 0.85rem;">
                    ${formatTimeAgo(login.timestamp || login.createdAt || new Date())}
                </div>
            </div>
        </div>
    `).join('');
}

function maskIP(ip) {
    if (!ip) return 'N/A';
    const parts = ip.split('.');
    if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.***.***.`;
    }
    return ip;
}

function formatTimeAgo(date) {
    const now = new Date();
    const time = new Date(date);
    const seconds = Math.floor((now - time) / 1000);
    
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    
    return time.toLocaleDateString();
}

async function loadActiveSessions() {
    const token = localStorage.getItem('token');
    const container = document.getElementById('activeSessionsContainer');
    if (!container) return;
    
    try {
        const res = await fetch(`${API_URL}/api/user/security/active-sessions`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success && data.sessions) {
            activeSessionsCache = data.sessions;
            displayActiveSessions(data.sessions);
        } else {
            container.innerHTML = '<p style="color: #999; text-align: center;">No active sessions</p>';
        }
    } catch (e) {
        console.error('Error loading active sessions:', e);
    }
}

function displayActiveSessions(sessions) {
    const container = document.getElementById('activeSessionsContainer');
    if (!container) return;
    
    if (!sessions || sessions.length === 0) {
        container.innerHTML = '<p style="color: #999; text-align: center;">No active sessions</p>';
        return;
    }
    
    container.innerHTML = sessions.map(session => `
        <div class="session-item" style="padding: 15px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <strong>${session.deviceName || 'Device'}</strong> 
                <span style="color: #999; font-size: 0.85rem;">${session.browserName || 'Browser'}</span>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 0.85rem;">
                    <i class="fas fa-map-marker-alt"></i> ${session.location || 'Unknown Location'}
                </p>
                <p style="margin: 5px 0 0 0; color: #999; font-size: 0.8rem;">
                    Last active: ${formatTimeAgo(session.lastActivity || new Date())}
                </p>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="logoutSession('${session.id || session._id}')">
                <i class="fas fa-sign-out-alt"></i> Logout
            </button>
        </div>
    `).join('');
}

async function logoutSession(sessionId) {
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/security/logout-session/${sessionId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Session logged out', 'success');
            await loadActiveSessions();
        } else {
            showAlert('Failed to logout session', 'error');
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

async function logoutAllSessions() {
    if (!confirm('This will log you out of all devices. Continue?')) return;
    
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/security/logout-all`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            localStorage.removeItem('token');
            window.location.href = 'signin.html';
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

// ============================================================================
// PASSWORD CHANGE & PASSWORD STRENGTH
// ============================================================================

function togglePasswordForm() {
    const form = document.getElementById('passwordForm');
    if (form) {
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }
}

async function changePassword(e) {
    e?.preventDefault();
    const currentPass = document.getElementById('currentPassword')?.value;
    const newPass = document.getElementById('newPassword')?.value;
    const confirmPass = document.getElementById('confirmPassword')?.value;
    
    if (!currentPass || !newPass || !confirmPass) {
        showAlert('All password fields are required', 'error');
        return;
    }
    
    if (newPass !== confirmPass) {
        showAlert('New passwords do not match!', 'error');
        return;
    }
    
    const strength = checkPasswordStrength(newPass);
    if (strength.score < 3) {
        showAlert('New password is too weak. Use uppercase, lowercase, numbers, and symbols.', 'error');
        return;
    }
    
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/auth/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                currentPassword: currentPass,
                newPassword: newPass
            })
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Password changed successfully!', 'success');
            togglePasswordForm();
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
            updatePasswordStrengthMeter('');
        } else {
            showAlert(data.message || 'Password change failed', 'error');
        }
    } catch (e) {
        showAlert('Error changing password: ' + e.message, 'error');
    }
}

function checkPasswordStrength(password) {
    const strength = {
        score: 0,
        level: 'Very Weak',
        color: '#f44336'
    };
    
    if (!password) return strength;
    
    if (password.length >= 8) strength.score++;
    if (password.length >= 12) strength.score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength.score++;
    if (/\d/.test(password)) strength.score++;
    if (/[^a-zA-Z\d]/.test(password)) strength.score++;
    
    const levels = [
        { level: 'Very Weak', color: '#f44336' },
        { level: 'Weak', color: '#ff9800' },
        { level: 'Fair', color: '#ffc107' },
        { level: 'Strong', color: '#8bc34a' },
        { level: 'Very Strong', color: '#4caf50' }
    ];
    
    const levelIndex = Math.min(strength.score, 4);
    strength.level = levels[levelIndex].level;
    strength.color = levels[levelIndex].color;
    
    return strength;
}

function updatePasswordStrengthMeter(password) {
    const meter = document.getElementById('passwordStrengthMeter');
    const text = document.getElementById('passwordStrengthText');
    
    if (!meter || !text) return;
    
    const strength = checkPasswordStrength(password);
    const percentage = (strength.score / 5) * 100;
    
    meter.style.width = percentage + '%';
    meter.style.backgroundColor = strength.color;
    text.textContent = strength.level;
    text.style.color = strength.color;
}

// ============================================================================
// TWO-FACTOR AUTHENTICATION
// ============================================================================

function toggle2FAForm() {
    const form = document.getElementById('twoFactorSetupForm');
    if (form) {
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }
}

async function enable2FA(e) {
    e?.preventDefault();
    const method = document.getElementById('twoFactorMethod')?.value || 'sms';
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/2fa/enable`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ method })
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Two-Factor Authentication enabled!', 'success');
            toggle2FAForm();
            generateBackupCodes();
        } else {
            showAlert(data.message || 'Failed to enable 2FA', 'error');
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

async function disable2FA() {
    if (!confirm('Disable Two-Factor Authentication? This reduces your account security.')) return;
    
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/2fa/disable`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Two-Factor Authentication disabled', 'success');
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

async function generateBackupCodes() {
    const token = localStorage.getItem('token');
    const container = document.getElementById('backupCodesContainer');
    
    if (!container) return;
    
    try {
        const res = await fetch(`${API_URL}/api/user/2fa/backup-codes`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success && data.codes) {
            displayBackupCodes(data.codes);
        }
    } catch (e) {
        console.error('Error generating backup codes:', e);
    }
}

function displayBackupCodes(codes) {
    const container = document.getElementById('backupCodesContainer');
    if (!container) return;
    
    container.innerHTML = `
        <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; border-left: 4px solid #ff9800;">
            <h4><i class="fas fa-shield-alt"></i> Backup Codes</h4>
            <p style="color: #666; font-size: 0.9rem;">Save these codes in a safe place. Use them if you lose access to your 2FA device.</p>
            <div style="background: white; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 0.85rem; line-height: 1.8;">
                ${codes.map(code => `<div>${code}</div>`).join('')}
            </div>
            <button class="btn btn-secondary btn-sm" onclick="downloadBackupCodes()" style="margin-top: 10px;">
                <i class="fas fa-download"></i> Download
            </button>
        </div>
    `;
}

function downloadBackupCodes() {
    const codes = document.querySelectorAll('[style*="monospace"] div');
    const text = Array.from(codes).map(el => el.textContent).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backup-codes.txt';
    a.click();
}

// ============================================================================
// DOCUMENTS & VERIFICATION
// ============================================================================

async function loadDocumentStatus(user) {
    const token = localStorage.getItem('token');
    const container = document.getElementById('documentList');
    if (!container) return;
    
    try {
        const res = await fetch(`${API_URL}/api/user/documents`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success && data.documents) {
            displayDocuments(data.documents);
        } else {
            container.innerHTML = '<p style="color: #999; text-align: center;">No documents uploaded yet</p>';
        }
    } catch (e) {
        console.error('Error loading documents:', e);
    }
}

function displayDocuments(documents) {
    const container = document.getElementById('documentList');
    if (!container) return;
    
    if (!documents || documents.length === 0) {
        container.innerHTML = '<p style="color: #999; text-align: center;">No documents uploaded</p>';
        return;
    }
    
    container.innerHTML = documents.map(doc => `
        <div class="document-item" style="padding: 12px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <strong>${doc.documentType || 'Document'}</strong>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 0.85rem;">
                    Uploaded: ${formatDate(doc.uploadedAt || new Date())}<br>
                    Status: <span style="color: ${doc.verified ? '#4caf50' : '#ff9800'};">
                        ${doc.verified ? '<i class="fas fa-check-circle"></i> Verified' : '<i class="fas fa-clock"></i> Pending Review'}
                    </span>
                </p>
            </div>
            <div>
                <button class="btn btn-secondary btn-sm" onclick="downloadDocument('${doc.id || doc._id}')">
                    <i class="fas fa-download"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteDocument('${doc.id || doc._id}')" style="margin-left: 5px;">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

async function uploadDocument(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    if (file.size > 10 * 1024 * 1024) {
        showAlert('File size exceeds 10MB limit', 'error');
        return;
    }
    
    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('document', file);
    
    try {
        const res = await fetch(`${API_URL}/api/user/documents/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Document uploaded successfully!', 'success');
            await loadDocumentStatus({});
        } else {
            showAlert(data.message || 'Upload failed', 'error');
        }
    } catch (e) {
        showAlert('Error uploading document: ' + e.message, 'error');
    }
}

async function deleteDocument(docId) {
    if (!confirm('Delete this document?')) return;
    
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/documents/${docId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Document deleted', 'success');
            await loadDocumentStatus({});
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

// ============================================================================
// BENEFICIARIES MANAGEMENT
// ============================================================================

async function loadBeneficiaries() {
    const token = localStorage.getItem('token');
    const container = document.getElementById('beneficiariesList');
    if (!container) return;
    
    try {
        const res = await fetch(`${API_URL}/api/user/beneficiaries`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success && data.beneficiaries) {
            displayBeneficiaries(data.beneficiaries);
        } else {
            container.innerHTML = '<p style="text-align: center; color: #999;">No beneficiaries added yet</p>';
        }
    } catch (e) {
        console.error('Error loading beneficiaries:', e);
    }
}

function displayBeneficiaries(beneficiaries) {
    const container = document.getElementById('beneficiariesList');
    if (!container) return;
    
    if (!beneficiaries || beneficiaries.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #999;">No beneficiaries added yet</p>';
        return;
    }
    
    container.innerHTML = beneficiaries.map(ben => `
        <div class="beneficiary-item" style="padding: 15px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <strong>${ben.name}</strong>
                ${ben.nickname ? `<span style="color: #999; font-size: 0.9rem;"> (${ben.nickname})</span>` : ''}
                <p style="margin: 5px 0 0 0; color: #666; font-size: 0.85rem;">
                    Account: ${maskAccountNumber(ben.accountNumber)}<br>
                    Routing: ${ben.routingNumber} | Bank: ${ben.bankName || 'N/A'}<br>
                    Status: <span style="color: ${ben.verified ? '#4caf50' : '#ff9800'};">
                        ${ben.verified ? 'Verified' : 'Pending Verification'}
                    </span>
                </p>
            </div>
            <div>
                <button class="btn btn-secondary btn-sm" onclick="editBeneficiary('${ben.id || ben._id}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteBeneficiary('${ben.id || ben._id}')" style="margin-left: 5px;">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function maskAccountNumber(account) {
    if (!account) return 'N/A';
    return '*'.repeat(account.length - 4) + account.slice(-4);
}

function showAddBeneficiaryForm() {
    const form = document.getElementById('addBeneficiaryForm');
    if (form) {
        form.style.display = 'block';
    }
}

function hideAddBeneficiaryForm() {
    const form = document.getElementById('addBeneficiaryForm');
    if (form) {
        form.style.display = 'none';
        clearBeneficiaryForm();
    }
}

function clearBeneficiaryForm() {
    document.getElementById('beneficiaryName').value = '';
    document.getElementById('beneficiaryNickname').value = '';
    document.getElementById('beneficiaryAccount').value = '';
    document.getElementById('beneficiaryRouting').value = '';
    document.getElementById('beneficiaryBank').value = '';
}

async function addBeneficiary() {
    const name = document.getElementById('beneficiaryName')?.value;
    const nickname = document.getElementById('beneficiaryNickname')?.value;
    const account = document.getElementById('beneficiaryAccount')?.value;
    const routing = document.getElementById('beneficiaryRouting')?.value;
    const bank = document.getElementById('beneficiaryBank')?.value;
    
    if (!name || !account || !routing) {
        showAlert('Name, account, and routing number are required', 'error');
        return;
    }
    
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/beneficiaries`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                name, nickname, accountNumber: account, routingNumber: routing, bankName: bank
            })
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Beneficiary added successfully!', 'success');
            hideAddBeneficiaryForm();
            await loadBeneficiaries();
        } else {
            showAlert(data.message || 'Failed to add beneficiary', 'error');
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

async function deleteBeneficiary(benId) {
    if (!confirm('Delete this beneficiary?')) return;
    
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/beneficiaries/${benId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Beneficiary deleted', 'success');
            await loadBeneficiaries();
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

// ============================================================================
// ACCOUNT CONTROLS
// ============================================================================

function populateAccountControls(user) {
    const freezeToggle = document.getElementById('freezeAccountToggle');
    const intlToggle = document.getElementById('internationalToggle');
    
    if (freezeToggle) {
        freezeToggle.checked = user.accountFrozen || false;
    }
    if (intlToggle) {
        intlToggle.checked = user.internationalEnabled !== false;
    }
}

async function toggleAccountFreeze() {
    const toggle = document.getElementById('freezeAccountToggle');
    const token = localStorage.getItem('token');
    const action = toggle.checked ? 'freeze' : 'unfreeze';
    
    try {
        const res = await fetch(`${API_URL}/api/user/account/${action}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert(`Account ${action}d successfully`, 'success');
        } else {
            toggle.checked = !toggle.checked;
            showAlert('Failed to ' + action + ' account', 'error');
        }
    } catch (e) {
        toggle.checked = !toggle.checked;
        showAlert('Error: ' + e.message, 'error');
    }
}

async function toggleInternational() {
    const toggle = document.getElementById('internationalToggle');
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/account/international`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ enabled: toggle.checked })
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('International transactions ' + (toggle.checked ? 'enabled' : 'disabled'), 'success');
        } else {
            toggle.checked = !toggle.checked;
            showAlert('Failed to update setting', 'error');
        }
    } catch (e) {
        toggle.checked = !toggle.checked;
        showAlert('Error: ' + e.message, 'error');
    }
}

// ============================================================================
// PRIVACY & DATA MANAGEMENT
// ============================================================================

function loadPreferences(user) {
    // Load notification toggles
    const notificationToggles = document.querySelectorAll('[id^="notification"]');
    notificationToggles.forEach(toggle => {
        const prefKey = toggle.id;
        const pref = user.preferences?.[prefKey] ?? true;
        toggle.checked = pref;
    });
    
    // Load dark mode preference
    const darkModeToggle = document.getElementById('darkModeToggle');
    if (darkModeToggle) {
        const darkMode = localStorage.getItem('darkMode') === 'true';
        darkModeToggle.checked = darkMode;
        if (darkMode) {
            document.body.classList.add('dark-mode');
        }
    }
    
    // Load transaction PIN status
    const pinStatus = document.getElementById('pinStatus');
    if (pinStatus) {
        pinStatus.textContent = user.transactionPin ? 'Enabled' : 'Not Set';
        pinStatus.style.color = user.transactionPin ? '#28a745' : '#dc3545';
    }
}

// Dark Mode Toggle
function toggleDarkMode() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    const isDark = darkModeToggle?.checked;
    
    localStorage.setItem('darkMode', isDark);
    
    if (isDark) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    
    // Also save to server
    updatePreference('darkMode', isDark);
}

// Transaction PIN Management
function showPinSetup() {
    const modal = document.getElementById('pinModal');
    if (modal) modal.classList.add('active');
}

function hidePinModal() {
    const modal = document.getElementById('pinModal');
    if (modal) modal.classList.remove('active');
    // Clear inputs
    document.querySelectorAll('#pinModal input').forEach(input => input.value = '');
}

async function saveTransactionPin(e) {
    e.preventDefault();
    
    const currentPin = document.getElementById('currentPin')?.value || '';
    const newPin = document.getElementById('newPin').value;
    const confirmPin = document.getElementById('confirmPin').value;
    
    if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
        showAlert('PIN must be exactly 4 digits', 'error');
        return;
    }
    
    if (newPin !== confirmPin) {
        showAlert('PINs do not match', 'error');
        return;
    }
    
    const token = localStorage.getItem('token');
    try {
        const res = await fetch(`${API_URL}/api/user/transaction-pin`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ currentPin, newPin })
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Transaction PIN updated successfully', 'success');
            hidePinModal();
            const pinStatus = document.getElementById('pinStatus');
            if (pinStatus) {
                pinStatus.textContent = 'Enabled';
                pinStatus.style.color = '#28a745';
            }
        } else {
            showAlert(data.message || 'Failed to update PIN', 'error');
        }
    } catch (e) {
        showAlert('Error updating PIN', 'error');
    }
}

async function removeTransactionPin() {
    if (!confirm('Are you sure you want to remove your transaction PIN?')) return;
    
    const token = localStorage.getItem('token');
    try {
        const res = await fetch(`${API_URL}/api/user/transaction-pin`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Transaction PIN removed', 'success');
            const pinStatus = document.getElementById('pinStatus');
            if (pinStatus) {
                pinStatus.textContent = 'Not Set';
                pinStatus.style.color = '#dc3545';
            }
        } else {
            showAlert(data.message || 'Failed to remove PIN', 'error');
        }
    } catch (e) {
        showAlert('Error removing PIN', 'error');
    }
}

async function updatePreference(key, value) {
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/preferences`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ [key]: value })
        });
        
        const data = await res.json();
        if (!data.success) {
            showAlert('Failed to update preference', 'error');
        }
    } catch (e) {
        console.error('Error updating preference:', e);
    }
}

async function downloadStatement() {
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/statements/current`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `statement-${new Date().toISOString().split('T')[0]}.pdf`;
        a.click();
        
        showAlert('Statement downloaded', 'success');
    } catch (e) {
        showAlert('Error downloading statement: ' + e.message, 'error');
    }
}

async function exportData() {
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/privacy/export-data`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success && data.data) {
            const json = JSON.stringify(data.data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `mydata-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            
            showAlert('Your data has been exported', 'success');
        }
    } catch (e) {
        showAlert('Error exporting data: ' + e.message, 'error');
    }
}

async function requestAccountDeletion() {
    if (!confirm('Request account deletion? You will have 30 days to cancel this request.')) return;
    
    const token = localStorage.getItem('token');
    
    try {
        const res = await fetch(`${API_URL}/api/user/privacy/delete-request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await res.json();
        if (data.success) {
            showAlert('Account deletion request submitted. You have 30 days to cancel.', 'success');
        } else {
            showAlert(data.message || 'Failed to request deletion', 'error');
        }
    } catch (e) {
        showAlert('Error: ' + e.message, 'error');
    }
}

function confirmCloseAccount() {
    if (confirm('Are you sure you want to close your account? This action cannot be undone.')) {
        if (confirm('All your funds will need to be withdrawn. Type "CLOSE" to confirm.')) {
            showAlert('Please contact customer support to close your account.', 'error');
        }
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function showAlert(message, type) {
    const alert = document.getElementById('alertBox');
    if (!alert) {
        console.log(message, type);
        return;
    }
    
    alert.textContent = message;
    alert.className = `alert alert-${type}`;
    alert.style.display = 'block';
    setTimeout(() => alert.style.display = 'none', 5000);
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = 'signin.html';
}

// ============================================================================
// EVENT LISTENERS & INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    // Setup password strength meter listener
    const newPassInput = document.getElementById('newPassword');
    if (newPassInput) {
        newPassInput.addEventListener('input', (e) => updatePasswordStrengthMeter(e.target.value));
    }
    
    // Setup preference toggles
    document.querySelectorAll('[id^="notification"]').forEach(toggle => {
        toggle.addEventListener('change', (e) => updatePreference(e.target.id, e.target.checked));
    });
    
    // Setup profile form submission
    const profileForm = document.getElementById('profileForm');
    if (profileForm) {
        profileForm.addEventListener('submit', updateProfile);
    }
    
    // Setup password change form submission
    const passwordForm = document.getElementById('passwordChangeForm');
    if (passwordForm) {
        passwordForm.addEventListener('submit', changePassword);
    }
    
    // Setup 2FA form submission
    const twoFactorForm = document.getElementById('twoFactorSetupForm');
    if (twoFactorForm) {
        twoFactorForm.addEventListener('submit', enable2FA);
    }
    
    // Check auth and load profile
    checkAuth();
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        checkPasswordStrength,
        formatCurrency,
        maskSSN,
        maskIP,
        formatDate
    };
}
