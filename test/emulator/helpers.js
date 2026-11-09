'use strict';
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createApp } = require('../../server/app');
const { FundService } = require('../../server/fund');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-housing-fund';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!AUTH_HOST || !FS_HOST) throw new Error('Run via `npm test` so the Firebase emulators are started');

const adminApp = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
const db = getFirestore(adminApp);
const auth = getAuth(adminApp);

async function resetEmulators() {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' });
}

async function startServer({ adminEmails = ['admin@test.dev'], rateLimitPerMinute = 10_000 } = {}) {
  const fund = new FundService(db, { adminEmails });
  const clientConfig = {
    firebase: { apiKey: 'demo-api-key', authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID },
    emulators: { auth: AUTH_HOST, firestore: FS_HOST },
  };
  const app = createApp({ fund, auth, clientConfig, rateLimitPerMinute });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, fund, close: () => new Promise((r) => server.close(r)) };
}

const idt = (path) => `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/${path}?key=demo-api-key`;

/** Create an email/password user in the Auth emulator and return a fresh ID token. */
async function createUser(email, { verified = true, name } = {}) {
  const res = await fetch(idt('accounts:signUp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  await auth.updateUser(data.localId, { emailVerified: verified, ...(name ? { displayName: name } : {}) });
  return { uid: data.localId, email, token: await signIn(email) };
}

async function signIn(email) {
  const res = await fetch(idt('accounts:signInWithPassword'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.idToken;
}

function client(base, token) {
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

let counter = 0;
const rid = () => `req${Date.now().toString(36)}${(counter++).toString(36).padStart(6, '0')}`;

module.exports = { PROJECT_ID, AUTH_HOST, FS_HOST, db, auth, resetEmulators, startServer, createUser, signIn, client, rid };
