// Firebase configuration - traditional script version
// Load Firebase SDK via CDN first, then initialize

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAmu2vBkk_UHy7BEzCyo2PCn5m6busyvqQ",
  authDomain: "btc-a87b4d93.firebaseapp.com",
  projectId: "btc-a87b4d93",
  storageBucket: "btc-a87b4d93.firebasestorage.app",
  messagingSenderId: "586730306637",
  appId: "1:586730306637:web:3b5758eb900f525f633004"
};

// Initialize Firebase - This will be executed after Firebase SDK loads
function initFirebase() {
  if (typeof firebase !== 'undefined' && firebase.apps) {
    // Initialize Firebase app if not already initialized
    if (firebase.apps.length === 0) {
      firebase.initializeApp(firebaseConfig);
      console.log('Firebase initialized successfully');
    }
    return firebase;
  } else {
    console.error('Firebase SDK not loaded');
    return null;
  }
}

// Auto-initialize when this script loads
if (typeof firebase !== 'undefined') {
  initFirebase();
} else {
  // Wait for Firebase to load from CDN
  window.addEventListener('load', initFirebase);
}
