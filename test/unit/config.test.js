'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, readServiceAccount } = require('../../server/index');

test('loadConfig: production requires project id and api key', () => {
  assert.throws(() => loadConfig({}), /FIREBASE_PROJECT_ID/);
  assert.throws(() => loadConfig({ FIREBASE_PROJECT_ID: 'p' }), /FIREBASE_API_KEY/);
  const c = loadConfig({ FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'k', ADMIN_EMAILS: ' A@x.dev , b@x.dev ,', PORT: '8080' });
  assert.equal(c.port, 8080);
  assert.deepEqual(c.adminEmails, ['A@x.dev', 'b@x.dev']);
  assert.equal(c.clientConfig.firebase.authDomain, 'p.firebaseapp.com');
  assert.equal(c.clientConfig.emulators, null);
  assert.equal(c.useEmulators, false);
});

test('loadConfig: emulator mode works without real credentials', () => {
  const c = loadConfig({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' });
  assert.equal(c.projectId, 'demo-housing-fund');
  assert.deepEqual(c.clientConfig.emulators, { auth: '127.0.0.1:9099', firestore: '127.0.0.1:8080' });
});

test('readServiceAccount accepts raw JSON or base64', () => {
  const sa = { project_id: 'p', client_email: 'x@p.iam.gserviceaccount.com' };
  const prev = process.env.FIREBASE_SERVICE_ACCOUNT;
  try {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(sa);
    assert.deepEqual(readServiceAccount(), sa);
    process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(JSON.stringify(sa)).toString('base64');
    assert.deepEqual(readServiceAccount(), sa);
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    assert.equal(readServiceAccount(), null);
  } finally {
    if (prev === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
    else process.env.FIREBASE_SERVICE_ACCOUNT = prev;
  }
});

test('loadConfig: service account alone is enough (project id from it, web config looked up later)', () => {
  const c = loadConfig({ ADMIN_EMAILS: 'a@x.dev', RENDER_EXTERNAL_HOSTNAME: 'fund.onrender.com' }, { project_id: 'sa-proj' });
  assert.equal(c.projectId, 'sa-proj');
  assert.equal(c.clientConfig.firebase.projectId, 'sa-proj');
  assert.equal(c.clientConfig.firebase.apiKey, undefined);
  assert.equal(c.publicHost, 'fund.onrender.com');
  // Explicit env still wins.
  assert.equal(loadConfig({ FIREBASE_PROJECT_ID: 'env-proj', FIREBASE_API_KEY: 'k' }, { project_id: 'sa-proj' }).projectId, 'env-proj');
});
