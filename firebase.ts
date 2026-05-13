import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { initializeAuth } from 'firebase/auth';
import firebaseConfig from './firebase-applet-config.json';

const config = {
  ...firebaseConfig,
  apiKey: firebaseConfig.apiKey ? "PRESENT" : "MISSING",
  projectId: firebaseConfig.projectId
};
console.log("Firebase Config Loaded:", config);

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId || "(default)");
export const auth = initializeAuth(app);

export default app;
