// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import {  getAuth } from "firebase/auth";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "foodpoint-250d1.firebaseapp.com",
  projectId: "foodpoint-250d1",
  storageBucket: "foodpoint-250d1.firebasestorage.app",
  messagingSenderId: "791784705575",
  appId: "1:791784705575:web:9c933a7afe86a0c9618802",
  measurementId: "G-H5Q9MDT45R"
};


// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
export {app,auth} 
