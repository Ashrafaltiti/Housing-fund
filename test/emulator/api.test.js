'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, auth, resetEmulators, startServer, createUser, client, rid } = require('./helpers');

let srv;
test.before(async () => {
  await resetEmulators();
  srv = await startServer();
});
test.after(() => srv.close());
test.beforeEach(resetEmulators);

async function adminAndMember() {
  const admin = await createUser('admin@test.dev', { name: 'المسؤول' });
  const asAdmin = client(srv.base, admin.token);
  assert.equal((await asAdmin('POST', '/api/session')).status, 200);
  assert.equal((await asAdmin('POST', '/api/admin/members', { email: 'Sara@Test.dev' })).status, 201);
  const sara = await createUser('sara@test.dev', { name: 'سارة' });
  const asSara = client(srv.base, sara.token);
  return { admin, asAdmin, sara, asSara };
}

const fundDoc = async () => (await db.doc('fund/main').get()).data();

test('health and public config endpoints', async () => {
  const anon = client(srv.base);
  assert.deepEqual((await anon('GET', '/healthz')).body, { ok: true });
  const cfg = await anon('GET', '/api/config');
  assert.equal(cfg.body.firebase.projectId, 'demo-housing-fund');
});

test('API rejects missing or invalid tokens', async () => {
  assert.equal((await client(srv.base)('POST', '/api/session')).status, 401);
  assert.equal((await client(srv.base, 'garbage')('POST', '/api/session')).status, 401);
  assert.equal((await client(srv.base)('POST', '/api/transactions', { type: 'deposit', amount: '5', requestId: rid() })).status, 401);
});

test('membership: only invited + verified emails get access; ADMIN_EMAILS become admin', async () => {
  const admin = await createUser('admin@test.dev');
  const session = await client(srv.base, admin.token)('POST', '/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.member.role, 'admin');

  const stranger = await createUser('stranger@test.dev');
  const denied = await client(srv.base, stranger.token)('POST', '/api/session');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'not-invited');
  assert.equal((await client(srv.base, stranger.token)('POST', '/api/transactions', { type: 'deposit', amount: '5', requestId: rid() })).status, 403);

  await client(srv.base, admin.token)('POST', '/api/admin/members', { email: 'unverified@test.dev' });
  const unverified = await createUser('unverified@test.dev', { verified: false });
  const r = await client(srv.base, unverified.token)('POST', '/api/session');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'email-not-verified');
});

test('deposits and expenses update the shared balance atomically', async () => {
  const { asAdmin, asSara } = await adminAndMember();
  const dep = await asSara('POST', '/api/transactions', { type: 'deposit', amount: '100', requestId: rid() });
  assert.equal(dep.status, 201);
  assert.equal(dep.body.balanceCents, 10000);
  const exp = await asAdmin('POST', '/api/transactions', { type: 'expense', amount: '30.25', description: 'مواد تنظيف', requestId: rid() });
  assert.equal(exp.status, 201);
  assert.equal(exp.body.balanceCents, 6975);

  assert.deepEqual(
    (({ balanceCents, totalDepositsCents, totalExpensesCents, transactionCount }) => ({ balanceCents, totalDepositsCents, totalExpensesCents, transactionCount }))(await fundDoc()),
    { balanceCents: 6975, totalDepositsCents: 10000, totalExpensesCents: 3025, transactionCount: 2 },
  );
  const txs = await db.collection('transactions').get();
  assert.equal(txs.size, 2);
  const audit = await db.collection('auditLog').where('action', 'in', ['transaction.deposit', 'transaction.expense']).get();
  assert.equal(audit.size, 2);
  const expDoc = txs.docs.find((d) => d.data().type === 'expense').data();
  assert.equal(expDoc.memberName, 'المسؤول');
  assert.equal(expDoc.balanceAfterCents, 6975);
});

test('overspending is rejected and nothing is written', async () => {
  const { asSara } = await adminAndMember();
  await asSara('POST', '/api/transactions', { type: 'deposit', amount: '10', requestId: rid() });
  const r = await asSara('POST', '/api/transactions', { type: 'expense', amount: '10.01', description: 'كثير', requestId: rid() });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'insufficient-funds');
  assert.equal((await fundDoc()).balanceCents, 1000);
  assert.equal((await db.collection('transactions').get()).size, 1);
  // Spending exactly the balance is fine.
  assert.equal((await asSara('POST', '/api/transactions', { type: 'expense', amount: '10', description: 'كله', requestId: rid() })).status, 201);
  assert.equal((await fundDoc()).balanceCents, 0);
});

test('concurrent expenses can never overdraw the fund', async () => {
  const { asAdmin, asSara } = await adminAndMember();
  await asAdmin('POST', '/api/transactions', { type: 'deposit', amount: '50', requestId: rid() });
  // 12 concurrent 10 JOD expenses from two members against a 50 JOD balance: exactly 5 may succeed.
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? asAdmin : asSara)('POST', '/api/transactions', { type: 'expense', amount: '10', description: `مصروف ${i}`, requestId: rid() })),
  );
  assert.ok(results.every((r) => [201, 409, 503].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
  const ok = results.filter((r) => r.status === 201).length;
  const rejected = results.filter((r) => r.status === 409 && r.body.error.code === 'insufficient-funds').length;
  assert.equal(ok, 5, JSON.stringify(results.map((r) => r.status)));
  assert.equal(rejected + results.filter((r) => r.status === 503).length, 7);
  const f = await fundDoc();
  assert.equal(f.balanceCents, 0);
  assert.equal(f.totalExpensesCents, 5000);
  assert.equal((await db.collection('transactions').where('type', '==', 'expense').get()).size, 5);
});

test('retrying the same requestId is idempotent (no double charge)', async () => {
  const { asSara } = await adminAndMember();
  const id = rid();
  const body = { type: 'deposit', amount: '20', requestId: id };
  const [a, b] = await Promise.all([asSara('POST', '/api/transactions', body), asSara('POST', '/api/transactions', body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal((await fundDoc()).balanceCents, 2000);
  const conflict = await asSara('POST', '/api/transactions', { ...body, amount: '25' });
  assert.equal(conflict.status, 409);
});

test('input validation', async () => {
  const { asSara } = await adminAndMember();
  const bad = [
    { type: 'withdraw', amount: '5', requestId: rid() },
    { type: 'deposit', amount: '-5', requestId: rid() },
    { type: 'deposit', amount: '5.001', requestId: rid() },
    { type: 'expense', amount: '5', description: '   ', requestId: rid() },
    { type: 'expense', amount: '5', description: 'x'.repeat(121), requestId: rid() },
    { type: 'deposit', amount: '5', requestId: '../hack' },
    { type: 'deposit', amount: '5' },
  ];
  for (const body of bad) {
    const r = await asSara('POST', '/api/transactions', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const malformed = await fetch(`${srv.base}/api/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  assert.equal((await db.collection('transactions').get()).size, 0);
});

test('reversal: append-only history, permission checks, and balance protection', async () => {
  const { asAdmin, asSara } = await adminAndMember();
  const dep = await asAdmin('POST', '/api/transactions', { type: 'deposit', amount: '40', requestId: rid() });
  const exp = await asSara('POST', '/api/transactions', { type: 'expense', amount: '15', description: 'خبز', requestId: rid() });

  // A member can't reverse someone else's transaction.
  const forbidden = await asSara('POST', `/api/transactions/${dep.body.id}/reverse`, {});
  assert.equal(forbidden.status, 403);

  // The owner can reverse their own expense; money returns to the fund.
  const rev = await asSara('POST', `/api/transactions/${exp.body.id}/reverse`, { reason: 'غلط' });
  assert.equal(rev.status, 201);
  assert.equal(rev.body.balanceCents, 4000);
  const orig = (await db.doc(`transactions/${exp.body.id}`).get()).data();
  assert.equal(orig.reversed, true);
  const revDoc = (await db.doc(`transactions/${rev.body.id}`).get()).data();
  assert.equal(revDoc.type, 'reversal');
  assert.equal(revDoc.reversesId, exp.body.id);
  assert.equal((await fundDoc()).totalExpensesCents, 0);

  // Double reversal is rejected; reversal of a reversal is rejected.
  assert.equal((await asSara('POST', `/api/transactions/${exp.body.id}/reverse`, {})).status, 409);
  assert.equal((await asAdmin('POST', `/api/transactions/${rev.body.id}/reverse`, {})).status, 400);

  // Reversing a deposit that has already been spent is rejected.
  await asSara('POST', '/api/transactions', { type: 'expense', amount: '30', description: 'غاز', requestId: rid() });
  const blocked = await asAdmin('POST', `/api/transactions/${dep.body.id}/reverse`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'insufficient-funds');
  assert.equal((await fundDoc()).balanceCents, 1000);
  assert.equal((await asAdmin('POST', '/api/transactions/doesnotexist123/reverse', {})).status, 404);
});

test('admin endpoints: invite, remove (revokes access), protect self / ADMIN_EMAILS', async () => {
  const { admin, asAdmin, asSara } = await adminAndMember();
  assert.equal((await asSara('POST', '/api/session')).status, 200);
  assert.equal((await asSara('POST', '/api/admin/members', { email: 'x@test.dev' })).status, 403);
  assert.equal((await asAdmin('POST', '/api/admin/members', { email: 'bad' })).status, 400);
  assert.equal((await asAdmin('POST', '/api/admin/members', { email: 'y@test.dev', role: 'owner' })).status, 400);

  assert.equal((await asAdmin('DELETE', '/api/admin/members/sara%40test.dev')).status, 200);
  const after = await asSara('POST', '/api/transactions', { type: 'deposit', amount: '5', requestId: rid() });
  assert.equal(after.status, 403);
  assert.equal(after.body.error.code, 'member-disabled');

  // Re-inviting reactivates.
  await asAdmin('POST', '/api/admin/members', { email: 'sara@test.dev' });
  assert.equal((await asSara('POST', '/api/session')).status, 200);

  assert.equal((await asAdmin('DELETE', `/api/admin/members/${encodeURIComponent(admin.email)}`)).status, 400);
  const actions = (await db.collection('auditLog').get()).docs.map((d) => d.data().action);
  for (const a of ['member.joined', 'member.invited', 'member.removed']) assert.ok(actions.includes(a), a);
});

test('profile rename', async () => {
  const { asSara, sara } = await adminAndMember();
  assert.equal((await asSara('PATCH', '/api/me', { name: '' })).status, 400);
  const r = await asSara('PATCH', '/api/me', { name: '  سارة  أحمد ' });
  assert.equal(r.status, 200);
  assert.equal((await db.doc(`members/${sara.uid}`).get()).data().name, 'سارة أحمد');
});

test('revoked sessions are rejected', async () => {
  const { sara, asSara } = await adminAndMember();
  assert.equal((await asSara('POST', '/api/session')).status, 200);
  await new Promise((r) => setTimeout(r, 1100)); // revocation is second-granular
  await auth.revokeRefreshTokens(sara.uid);
  assert.equal((await asSara('POST', '/api/session')).status, 401);
});

test('security headers are set', async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal((await fetch(`${srv.base}/api/nope`)).status, 404);
});
