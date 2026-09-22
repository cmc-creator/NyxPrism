import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import 'dotenv/config';

if (!getApps().length) {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('⚠ Firebase Admin: missing env vars (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY). Auth routes will return 500.');
  } else {
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
  }
}

const admin = {
  auth: () => getAuth(),
};

export default admin;
