'use strict';

const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createApp } = require('./app');
const { FundService } = require('./fund');

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json);
}

function loadConfig(env = process.env) {
  const useEmulators = Boolean(env.FIRESTORE_EMULATOR_HOST && env.FIREBASE_AUTH_EMULATOR_HOST);
  const projectId = env.FIREBASE_PROJECT_ID || (useEmulators ? 'demo-housing-fund' : undefined);
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required');
  const firebase = {
    apiKey: env.FIREBASE_API_KEY || (useEmulators ? 'demo-api-key' : undefined),
    authDomain: env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
    appId: env.FIREBASE_APP_ID || undefined,
  };
  if (!firebase.apiKey) throw new Error('FIREBASE_API_KEY is required');
  return {
    projectId,
    port: Number(env.PORT) || 3000,
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean),
    clientConfig: {
      firebase,
      emulators: useEmulators ? { auth: env.FIREBASE_AUTH_EMULATOR_HOST, firestore: env.FIRESTORE_EMULATOR_HOST } : null,
    },
    useEmulators,
  };
}

function main() {
  const config = loadConfig();
  const serviceAccount = config.useEmulators ? null : readServiceAccount();
  if (!config.useEmulators && !serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Set FIREBASE_SERVICE_ACCOUNT (service-account JSON or base64) or GOOGLE_APPLICATION_CREDENTIALS');
  }
  if (!config.adminEmails.length) console.warn('ADMIN_EMAILS is empty: nobody can sign in until an admin email is configured.');
  const firebaseApp = initializeApp({
    projectId: config.projectId,
    ...(config.useEmulators ? {} : { credential: serviceAccount ? cert(serviceAccount) : applicationDefault() }),
  });
  const db = getFirestore(firebaseApp);
  const fund = new FundService(db, { adminEmails: config.adminEmails });
  const app = createApp({ fund, auth: getAuth(firebaseApp), clientConfig: config.clientConfig });
  const server = app.listen(config.port, () => {
    console.log(`Housing fund listening on :${config.port}${config.useEmulators ? ' (Firebase emulators)' : ''}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { loadConfig, readServiceAccount };
