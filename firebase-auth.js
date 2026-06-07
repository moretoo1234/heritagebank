/**
 * Firebase Authentication Integration for Heritage Bank
 * This module provides Firebase Auth as an alternative login method
 * alongside the existing JWT authentication
 */

import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup
} from 'firebase/auth';

// Firebase configuration - matches firebase-config.js
const firebaseConfig = {
  apiKey: "AIzaSyAmu2vBkk_UHy7BEzCyo2PCn5m6busyvqQ",
  authDomain: "btc-a87b4d93.firebaseapp.com",
  projectId: "btc-a87b4d93",
  storageBucket: "btc-a87b4d93.firebasestorage.app",
  messagingSenderId: "586730306637",
  appId: "1:586730306637:web:3b5758eb900f525f633004"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

/**
 * Sign in with Firebase using email and password
 * @param {string} email - User's email
 * @param {string} password - User's password
 * @returns {Promise} - Firebase user credential
 */
export async function signInWithEmail(email, password) {
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await credential.user.getIdToken();
    
    // Optionally sync with backend JWT
    await syncWithBackend(idToken, 'login');
    
    return { 
      success: true, 
      user: credential.user,
      idToken 
    };
  } catch (error) {
    console.error('Firebase sign in error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

/**
 * Register a new user with Firebase
 * @param {string} email - User's email
 * @param {string} password - User's password
 * @param {string} displayName - User's display name
 * @returns {Promise} - Firebase user credential
 */
export async function registerWithEmail(email, password, displayName) {
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    
    // Update profile with display name
    if (displayName) {
      await updateProfile(credential.user, { displayName });
    }
    
    const idToken = await credential.user.getIdToken();
    
    // Register with backend
    await syncWithBackend(idToken, 'register', { email, displayName });
    
    return { 
      success: true, 
      user: credential.user,
      idToken 
    };
  } catch (error) {
    console.error('Firebase register error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

/**
 * Sign in with Google
 * @returns {Promise} - Firebase user credential
 */
export async function signInWithGoogle() {
  try {
    const credential = await signInWithPopup(auth, googleProvider);
    const idToken = await credential.user.getIdToken();
    
    await syncWithBackend(idToken, 'login');
    
    return { 
      success: true, 
      user: credential.user,
      idToken 
    };
  } catch (error) {
    console.error('Google sign in error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

/**
 * Sign out from Firebase
 * @returns {Promise}
 */
export async function signOut() {
  try {
    await firebaseSignOut(auth);
    return { success: true };
  } catch (error) {
    console.error('Sign out error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send password reset email
 * @param {string} email - User's email
 * @returns {Promise}
 */
export async function resetPassword(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    return { success: true };
  } catch (error) {
    console.error('Password reset error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Listen to auth state changes
 * @param {function} callback - Called with user object or null
 * @returns {function} - Unsubscribe function
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      const idToken = await user.getIdToken();
      callback({ user, idToken });
    } else {
      callback(null);
    }
  });
}

/**
 * Sync Firebase auth with backend JWT system
 * @param {string} idToken - Firebase ID token
 * @param {string} action - 'login' or 'register'
 * @param {object} extraData - Additional user data
 */
async function syncWithBackend(idToken, action, extraData = {}) {
  try {
    // Send Firebase token to backend for JWT exchange
    const response = await fetch('/api/auth/firebase-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        action,
        ...extraData
      })
    });
    
    if (response.ok) {
      const data = response.json();
      // Store backend JWT if returned
      if (data.token) {
        localStorage.setItem('token', data.token);
      }
    }
  } catch (error) {
    console.error('Backend sync error:', error);
  }
}

/**
 * Get the current Firebase user
 * @returns {object|null}
 */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Check if user is authenticated with Firebase
 * @returns {boolean}
 */
export function isAuthenticated() {
  return !!auth.currentUser;
}

export default {
  signInWithEmail,
  registerWithEmail,
  signInWithGoogle,
  signOut,
  resetPassword,
  onAuthChange,
  getCurrentUser,
  isAuthenticated
};
