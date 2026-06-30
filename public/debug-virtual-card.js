/**
 * Frontend Debug Script for Virtual Card Creation
 * 
 * Add this to your browser console on cards.html to diagnose issues
 * Or add it temporarily to the page's <script> section
 */

(function() {
  console.log('%c🔍 Virtual Card Debug Mode Activated', 'color: #1a472a; font-size: 16px; font-weight: bold;');
  
  // Check 1: API URL Configuration
  console.log('\n📍 Step 1: API Configuration');
  const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
    ? 'http://localhost:3001' 
    : window.location.origin;
  console.log('API_URL:', API_URL);
  console.log('Current hostname:', window.location.hostname);
  console.log('Current origin:', window.location.origin);
  
  // Check 2: Authentication Token
  console.log('\n🔐 Step 2: Authentication');
  const token = localStorage.getItem('token');
  if (!token) {
    console.error('❌ No authentication token found!');
    console.log('👉 You need to login first');
  } else {
    console.log('✅ Token found:', token.substring(0, 20) + '...');
    
    // Try to decode JWT (without verification)
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        console.log('Token payload:', payload);
        
        // Check expiration
        if (payload.exp) {
          const expDate = new Date(payload.exp * 1000);
          const now = new Date();
          console.log('Token expires:', expDate.toLocaleString());
          if (expDate < now) {
            console.error('❌ Token is EXPIRED!');
            console.log('👉 Please logout and login again');
          } else {
            console.log('✅ Token is valid');
          }
        }
      }
    } catch (e) {
      console.log('Could not decode token:', e.message);
    }
  }
  
  // Check 3: Test the endpoint
  console.log('\n🧪 Step 3: Testing Virtual Card Endpoint');
  
  window.debugCreateVirtualCard = async function() {
    console.log('Attempting to create virtual card...');
    
    if (!token) {
      console.error('❌ Cannot test - no token available');
      return;
    }
    
    try {
      console.log('Making request to:', `${API_URL}/api/cards/apply`);
      
      const response = await fetch(`${API_URL}/api/cards/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ kind: 'virtual' })
      });
      
      console.log('Response status:', response.status);
      console.log('Response headers:', Object.fromEntries(response.headers));
      
      const data = await response.json();
      console.log('Response data:', data);
      
      if (data.success) {
        console.log('%c✅ SUCCESS! Virtual card created!', 'color: green; font-size: 14px; font-weight: bold;');
        console.log('Card details:', data.card);
      } else {
        console.error('%c❌ FAILED!', 'color: red; font-size: 14px; font-weight: bold;');
        console.error('Error message:', data.message);
      }
    } catch (error) {
      console.error('%c❌ REQUEST FAILED!', 'color: red; font-size: 14px; font-weight: bold;');
      console.error('Error:', error);
      console.error('Error type:', error.name);
      console.error('Error message:', error.message);
      
      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        console.log('👉 This might be a CORS or network connectivity issue');
      }
    }
  };
  
  // Check 4: Check existing cards
  console.log('\n📋 Step 4: Checking Existing Cards');
  
  window.debugGetCards = async function() {
    console.log('Fetching existing cards...');
    
    if (!token) {
      console.error('❌ Cannot test - no token available');
      return;
    }
    
    try {
      const response = await fetch(`${API_URL}/api/cards?ts=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      console.log('Response status:', response.status);
      const data = await response.json();
      console.log('Response data:', data);
      
      if (data.success) {
        console.log(`✅ Found ${data.cards.length} card(s)`);
        data.cards.forEach((card, i) => {
          console.log(`Card ${i + 1}:`, {
            type: card.cardType,
            masked: card.cardNumberMasked,
            status: card.status,
            issued: card.issuedAt
          });
        });
      } else {
        console.error('❌ Failed to get cards:', data.message);
      }
    } catch (error) {
      console.error('❌ Request failed:', error);
    }
  };
  
  // Check 5: Network connectivity
  console.log('\n🌐 Step 5: Network Connectivity');
  
  window.debugTestConnection = async function() {
    console.log('Testing connection to backend...');
    
    try {
      const response = await fetch(`${API_URL}/api/health`);
      const data = await response.json();
      
      if (data.status === 'ok') {
        console.log('✅ Backend is reachable');
        console.log('Backend info:', data);
      } else {
        console.error('❌ Backend responded but status is not OK');
      }
    } catch (error) {
      console.error('❌ Cannot reach backend!');
      console.error('Error:', error);
      console.log('👉 Make sure the backend server is running');
    }
  };
  
  // Check 6: CORS
  console.log('\n🔒 Step 6: CORS Check');
  console.log('If you see CORS errors in console, the backend needs to allow your origin');
  
  // Instructions
  console.log('\n📖 Available Debug Commands:');
  console.log('Run these commands in the console:');
  console.log('  debugTestConnection()  - Test if backend is reachable');
  console.log('  debugCreateVirtualCard()  - Try to create a virtual card');
  console.log('  debugGetCards()  - Fetch existing cards');
  
  console.log('\n' + '='.repeat(60));
  
  // Auto-run connection test
  setTimeout(() => {
    console.log('\n🚀 Auto-running connection test...');
    window.debugTestConnection();
  }, 1000);
  
})();
