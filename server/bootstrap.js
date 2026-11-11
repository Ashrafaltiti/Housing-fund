'use strict';

// Automatic Firebase setup done by the server on startup, using the service
// account. It saves manual steps: the web config is looked up instead of being
// copied by hand, the security rules are deployed, and the site's domain is
// added to Firebase Auth's authorized domains.

const fs = require('node:fs');
const path = require('node:path');
const { getSecurityRules } = require('firebase-admin/security-rules');

const RULES_FILE = path.join(__dirname, '..', 'firestore.rules');

async function googleApi(credential, method, url, body) {
  const { access_token: token } = await credential.getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Returns { apiKey, authDomain, projectId, appId } of the project's first web app, creating one if none exists. */
async function fetchWebConfig(credential, projectId) {
  const base = `https://firebase.googleapis.com/v1beta1/projects/${projectId}`;
  let { apps = [] } = await googleApi(credential, 'GET', `${base}/webApps`);
  apps = apps.filter((a) => a.state !== 'DELETED');
  if (!apps.length) {
    await googleApi(credential, 'POST', `${base}/webApps`, { displayName: 'Housing fund' });
    // Creation is asynchronous; wait for the app to appear.
    for (let i = 0; i < 10 && !apps.length; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      ({ apps = [] } = await googleApi(credential, 'GET', `${base}/webApps`));
    }
    if (!apps.length) throw new Error('web app was not created in time');
  }
  const cfg = await googleApi(credential, 'GET', `${base}/webApps/${apps[0].appId}/config`);
  return { apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId || projectId, appId: cfg.appId };
}

async function deployFirestoreRules(firebaseApp) {
  const source = fs.readFileSync(RULES_FILE, 'utf8');
  const rules = getSecurityRules(firebaseApp);
  const current = await rules.getFirestoreRuleset().catch(() => null);
  if (current?.source?.some((f) => f.content === source)) return false;
  await rules.releaseFirestoreRulesetFromSource(source);
  return true;
}

async function ensureAuthorizedDomain(credential, projectId, host) {
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config`;
  const { authorizedDomains = [] } = await googleApi(credential, 'GET', url);
  if (authorizedDomains.includes(host)) return false;
  await googleApi(credential, 'PATCH', `${url}?updateMask=authorizedDomains`, {
    authorizedDomains: [...authorizedDomains, host],
  });
  return true;
}

/** Best-effort background setup; failures are logged with what to do by hand. */
async function runStartupSetup({ firebaseApp, credential, projectId, publicHost }) {
  try {
    if (await deployFirestoreRules(firebaseApp)) console.log('Deployed firestore.rules');
  } catch (err) {
    console.warn(`Could not deploy firestore.rules automatically (deploy them with the Firebase CLI): ${err.message}`);
  }
  if (publicHost) {
    try {
      if (await ensureAuthorizedDomain(credential, projectId, publicHost)) console.log(`Added ${publicHost} to Firebase Auth authorized domains`);
    } catch (err) {
      console.warn(`Could not add ${publicHost} to Firebase Auth authorized domains (add it in the console): ${err.message}`);
    }
  }
}

module.exports = { fetchWebConfig, deployFirestoreRules, ensureAuthorizedDomain, runStartupSetup };
