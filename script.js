// Heritage Bank - Main JavaScript

const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
    ? 'http://localhost:3001' 
    : '';

// Mobile Menu Toggle
document.addEventListener('DOMContentLoaded', function() {
    const hamburger = document.getElementById('hamburger');
    const navLinks = document.getElementById('navLinks');
    
    if (hamburger) {
        hamburger.addEventListener('click', function() {
            navLinks.classList.toggle('active');
            hamburger.classList.toggle('active');
        });
    }

    // Contact Form
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const data = Object.fromEntries(formData);
            
            try {
                const response = await fetch(`${API_URL}/api/contact`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('Thank you! Your message has been sent.');
                    this.reset();
                } else {
                    alert('Failed to send message. Please try again.');
                }
            } catch (error) {
                console.error('Error:', error);
                alert('Connection error. Please try again.');
            }
        });
    }

    // Newsletter Form
    const newsletterForm = document.querySelector('.newsletter-signup');
    if (newsletterForm) {
        const btn = newsletterForm.querySelector('button');
        const input = newsletterForm.querySelector('input');
        
        btn.addEventListener('click', async function(e) {
            e.preventDefault();
            const email = input.value;
            
            if (!email) {
                alert('Please enter your email');
                return;
            }
            
            try {
                const response = await fetch(`${API_URL}/api/newsletter`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('Thank you for subscribing!');
                    input.value = '';
                } else {
                    alert(result.message || 'Subscription failed');
                }
            } catch (error) {
                console.error('Error:', error);
                alert('Connection error. Please try again.');
            }
        });
    }
});

// Smooth Scrolling
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Check Login Status
function checkLogin() {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please sign in to access this feature');
        window.location.href = 'signin.html';
        return false;
    }
    return true;
}

// Logout Function
function logout() {
    localStorage.clear();
    window.location.href = 'signin.html';
}

// Format Currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(amount);
}

// Get User from Storage
function getUser() {
    const userStr = localStorage.getItem('user');
    return userStr ? JSON.parse(userStr) : null;
}

// API Helper
async function apiRequest(endpoint, options = {}) {
    const token = localStorage.getItem('token');
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    try {
        const response = await fetch(`${API_URL}${endpoint}`, {
            ...options,
            headers
        });
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        return { success: false, message: 'Connection error' };
    }
}
