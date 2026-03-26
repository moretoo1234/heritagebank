const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
    ? 'http://localhost:3001' 
    : window.location.origin;

// Redirect authenticated users to dashboard
(function() {
    const token = localStorage.getItem('token');
    if (token) {
        fetch(`${API_URL}/api/auth/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        }).then(r => r.json()).then(data => {
            if (data.success && data.user) {
                window.location.href = data.user.isAdmin ? 'admin.html' : 'dashboard.html';
            }
        }).catch(() => {});
    }
})();

let currentStep = 1;
const formData = {};

// Step navigation
function nextStep() {
    if (!validateCurrentStep()) return;
    
    saveStepData();
    
    if (currentStep < 4) {
        document.querySelector(`.form-step[data-step="${currentStep}"]`).classList.remove('active');
        document.querySelector(`.progress-step[data-step="${currentStep}"]`).classList.remove('active');
        document.querySelector(`.progress-step[data-step="${currentStep}"]`).classList.add('completed');
        
        currentStep++;
        
        document.querySelector(`.form-step[data-step="${currentStep}"]`).classList.add('active');
        document.querySelector(`.progress-step[data-step="${currentStep}"]`).classList.add('active');
        
        if (currentStep === 4) {
            showReviewSummary();
        }
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function prevStep() {
    if (currentStep > 1) {
        document.querySelector(`.form-step[data-step="${currentStep}"]`).classList.remove('active');
        document.querySelector(`.progress-step[data-step="${currentStep}"]`).classList.remove('active');
        
        currentStep--;
        
        document.querySelector(`.form-step[data-step="${currentStep}"]`).classList.add('active');
        document.querySelector(`.progress-step[data-step="${currentStep}"]`).classList.add('active');
        document.querySelector(`.progress-step[data-step="${currentStep}"]`).classList.remove('completed');
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// Validate current step
function validateCurrentStep() {
    const step = currentStep;
    
    if (step === 1) {
        const firstName = document.getElementById('firstName').value.trim();
        const lastName = document.getElementById('lastName').value.trim();
        const dob = document.getElementById('dateOfBirth').value;
        
        if (!firstName || !lastName) {
            showAlert('Please fill in all required fields', 'danger');
            return false;
        }
        
        if (dob) {
            const age = calculateAge(new Date(dob));
            if (age < 18) {
                showAlert('You must be at least 18 years old to open an account', 'danger');
                return false;
            }
        }
    }
    
    if (step === 2) {
        const email = document.getElementById('email').value.trim();
        const phone = document.getElementById('phone').value.trim();
        const address = document.getElementById('address').value.trim();
        const city = document.getElementById('city').value.trim();
        const state = document.getElementById('state').value;
        const zipCode = document.getElementById('zipCode').value.trim();
        
        if (!email || !phone || !address || !city || !state || !zipCode) {
            showAlert('Please fill in all required contact information', 'danger');
            return false;
        }
        
        if (!isValidEmail(email)) {
            showAlert('Please enter a valid email address', 'danger');
            return false;
        }
        
        if (zipCode.length !== 5 || !/^\d+$/.test(zipCode)) {
            showAlert('Please enter a valid 5-digit ZIP code', 'danger');
            return false;
        }
    }
    
    if (step === 3) {
        const accountType = document.querySelector('input[name="accountType"]:checked');
        const initialDeposit = parseFloat(document.getElementById('initialDeposit').value);
        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        
        if (!accountType) {
            showAlert('Please select an account type', 'danger');
            return false;
        }
        
        if (!initialDeposit || initialDeposit < 50) {
            showAlert('Minimum initial deposit is $50.00', 'danger');
            return false;
        }
        
        if (password.length < 8) {
            showAlert('Password must be at least 8 characters', 'danger');
            return false;
        }
        
        const passwordStrength = checkPasswordStrength(password);
        if (passwordStrength < 3) {
            showAlert('Password is too weak. Please use a stronger password with uppercase, lowercase, numbers, and symbols', 'danger');
            return false;
        }
        
        if (password !== confirmPassword) {
            showAlert('Passwords do not match', 'danger');
            return false;
        }
    }
    
    if (step === 4) {
        const agreeTerms = document.getElementById('agreeTerms').checked;
        const agreePrivacy = document.getElementById('agreePrivacy').checked;
        const ageConfirm = document.getElementById('ageConfirm').checked;
        
        if (!agreeTerms || !agreePrivacy || !ageConfirm) {
            showAlert('You must agree to all required terms and conditions', 'danger');
            return false;
        }
    }
    
    return true;
}

// Save step data
function saveStepData() {
    if (currentStep === 1) {
        formData.firstName = document.getElementById('firstName').value.trim();
        formData.lastName = document.getElementById('lastName').value.trim();
        formData.dateOfBirth = document.getElementById('dateOfBirth').value;
        formData.ssn = document.getElementById('ssn').value.trim();
    }
    
    if (currentStep === 2) {
        formData.email = document.getElementById('email').value.trim();
        formData.phone = document.getElementById('phone').value.trim();
        formData.address = document.getElementById('address').value.trim();
        formData.city = document.getElementById('city').value.trim();
        formData.state = document.getElementById('state').value;
        formData.zipCode = document.getElementById('zipCode').value.trim();
        formData.country = document.getElementById('country').value.trim();
    }
    
    if (currentStep === 3) {
        formData.accountType = document.querySelector('input[name="accountType"]:checked').value;
        formData.initialDeposit = parseFloat(document.getElementById('initialDeposit').value);
        formData.password = document.getElementById('password').value;
        formData.referralCode = document.getElementById('referralCode').value.trim();
    }
}

// Show review summary
function showReviewSummary() {
    const summary = `
        <h3 style="color: #1a472a; margin-bottom: 15px;">Account Summary</h3>
        <div style="display: grid; grid-template-columns: 150px 1fr; gap: 10px; line-height: 1.8;">
            <strong>Name:</strong><span>${formData.firstName} ${formData.lastName}</span>
            <strong>Date of Birth:</strong><span>${new Date(formData.dateOfBirth).toLocaleDateString()}</span>
            <strong>Email:</strong><span>${formData.email}</span>
            <strong>Phone:</strong><span>${formData.phone}</span>
            <strong>Address:</strong><span>${formData.address}, ${formData.city}, ${formData.state} ${formData.zipCode}</span>
            <strong>Account Type:</strong><span style="text-transform: capitalize;">${formData.accountType}</span>
            <strong>Initial Deposit:</strong><span>$${formData.initialDeposit.toFixed(2)}</span>
            ${formData.referralCode ? `<strong>Referral Code:</strong><span>${formData.referralCode}</span>` : ''}
        </div>
    `;
    document.getElementById('reviewSummary').innerHTML = summary;
}

// Account type selection
function selectAccountType(type, el) {
    document.querySelectorAll('.account-type-card').forEach(card => card.classList.remove('selected'));
    if (el) el.closest('.account-type-card').classList.add('selected');
    document.getElementById(`type${type.charAt(0).toUpperCase() + type.slice(1)}`).checked = true;
}

// Toggle password visibility
function togglePassword(inputId, icon) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
}

// Password strength checker
document.getElementById('password')?.addEventListener('input', function() {
    const strength = checkPasswordStrength(this.value);
    const strengthBar = document.getElementById('passwordStrength');
    const strengthText = document.getElementById('passwordStrengthText');
    
    const colors = ['#dc3545', '#ffc107', '#17a2b8', '#28a745', '#155724'];
    const texts = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'];
    const widths = ['20%', '40%', '60%', '80%', '100%'];
    
    strengthBar.style.width = widths[strength];
    strengthBar.style.backgroundColor = colors[strength];
    strengthText.textContent = texts[strength];
    strengthText.style.color = colors[strength];
});

function checkPasswordStrength(password) {
    let strength = 0;
    
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password)) strength++;
    if (/[^a-zA-Z\d]/.test(password)) strength++;
    
    return Math.min(strength, 4);
}

// Helpers
function calculateAge(birthday) {
    const ageDifMs = Date.now() - birthday.getTime();
    const ageDate = new Date(ageDifMs);
    return Math.abs(ageDate.getUTCFullYear() - 1970);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showAlert(message, type) {
    const alertBox = document.getElementById('alertBox');
    alertBox.innerHTML = `<div class="alert alert-${type}"><i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-triangle'}"></i> ${message}</div>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    if (type === 'success') {
        setTimeout(() => alertBox.innerHTML = '', 5000);
    }
}

// Form submission
document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!validateCurrentStep()) return;
    
    saveStepData();
    
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating Account...';
    
    try {
        const response = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...formData,
                marketingConsent: document.getElementById('marketingConsent').checked
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            localStorage.setItem('token', data.token);
            // Only store non-sensitive user fields
            const safeUser = { id: data.user.id, firstName: data.user.firstName, lastName: data.user.lastName, email: data.user.email, accountNumber: data.user.accountNumber, accountType: data.user.accountType };
            localStorage.setItem('user', JSON.stringify(safeUser));
            
            showAlert(`Account created successfully! Account Number: ${data.user.accountNumber}`, 'success');
            
            setTimeout(() => {
                window.location.href = 'dashboard.html';
            }, 2000);
        } else {
            showAlert(data.message || 'Registration failed. Please try again.', 'danger');
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-check-circle"></i> Create Account';
        }
    } catch (error) {
        showAlert('Connection error. Please check your internet and try again.', 'danger');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-check-circle"></i> Create Account';
    }
});

// SSN formatting
document.getElementById('ssn')?.addEventListener('input', function(e) {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length > 3) value = value.slice(0, 3) + '-' + value.slice(3);
    if (value.length > 6) value = value.slice(0, 6) + '-' + value.slice(6, 10);
    e.target.value = value;
});

// Phone formatting
document.getElementById('phone')?.addEventListener('input', function(e) {
    let digits = e.target.value.replace(/\D/g, '');
    if (digits.length > 11) digits = digits.slice(0, 11);
    // Remove leading 1 if present
    if (digits.startsWith('1') && digits.length > 10) digits = digits.slice(1);
    let formatted = '';
    if (digits.length > 0) formatted = '+1 (' + digits.slice(0, 3);
    if (digits.length >= 3) formatted += ') ';
    if (digits.length > 3) formatted += digits.slice(3, 6);
    if (digits.length > 6) formatted += '-' + digits.slice(6, 10);
    e.target.value = formatted;
});
