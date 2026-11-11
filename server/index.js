'use strict';

const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createApp } = require('./app');
const { FundService } = require('./fund');
const { fetchWebConfig, runStartupSetup } = require('./bootstrap');

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json);
}

/**
 * @param {object} env
 * @param {object|null} serviceAccount  when given, the project id comes from it and the
 *   web config (API key, app id) is looked up at startup if not set in env.
 */
function loadConfig(env = process.env, serviceAccount = null) {
  const useEmulators = Boolean(env.FIRESTORE_EMULATOR_HOST && env.FIREBASE_AUTH_EMULATOR_HOST);
  const projectId =
    env.FIREBASE_PROJECT_ID || serviceAccount?.project_id || (useEmulators ? 'demo-housing-fund' : undefined);
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required');
  const firebase = {
    apiKey: env.FIREBASE_API_KEY || (useEmulators ? 'demo-api-key' : undefined),
    authDomain: env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
    appId: env.FIREBASE_APP_ID || undefined,
  };
  if (!firebase.apiKey && !serviceAccount) throw new Error('FIREBASE_API_KEY is required');
  return {
    projectId,
    port: Number(env.PORT) || 3000,
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean),
    clientConfig: {
      firebase,
      emulators: useEmulators ? { auth: env.FIREBASE_AUTH_EMULATOR_HOST, firestore: env.FIRESTORE_EMULATOR_HOST } : null,
    },
    useEmulators,
    // Render sets RENDER_EXTERNAL_HOSTNAME (e.g. housing-fund.onrender.com).
    publicHost: env.PUBLIC_HOST || env.RENDER_EXTERNAL_HOSTNAME || null,
  };
}

async function main() {
  const useEmulators = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
  const serviceAccount = useEmulators ? null : readServiceAccount();
  if (!useEmulators && !serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Set FIREBASE_SERVICE_ACCOUNT (service-account JSON or base64) or GOOGLE_APPLICATION_CREDENTIALS');
  }
  const config = loadConfig(process.env, serviceAccount);
  if (!config.adminEmails.length) console.warn('ADMIN_EMAILS is empty: nobody can sign in until an admin email is configured.');
  const credential = config.useEmulators ? null : serviceAccount ? cert(serviceAccount) : applicationDefault();
  const firebaseApp = initializeApp({ projectId: config.projectId, ...(credential ? { credential } : {}) });

  if (!config.clientConfig.firebase.apiKey) {
    const web = await fetchWebConfig(credential, config.projectId);
    config.clientConfig.firebase = { ...web, ...pickDefined(config.clientConfig.firebase) };
    if (!process.env.FIREBASE_AUTH_DOMAIN) config.clientConfig.firebase.authDomain = web.authDomain;
    console.log(`Loaded Firebase web config for ${config.projectId}`);
  }

  const db = getFirestore(firebaseApp);
  const fund = new FundService(db, { adminEmails: config.adminEmails });
  const app = createApp({ fund, auth: getAuth(firebaseApp), clientConfig: config.clientConfig });
  const server = app.listen(config.port, () => {
    console.log(`Housing fund listening on :${config.port}${config.useEmulators ? ' (Firebase emulators)' : ''}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  if (credential) runStartupSetup({ firebaseApp, credential, projectId: config.projectId, publicHost: config.publicHost });
}

function pickDefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { loadConfig, readServiceAccount };
