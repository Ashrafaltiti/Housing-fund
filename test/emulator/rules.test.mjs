import test from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection } from 'firebase/firestore';

const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rules-test',
    firestore: { host, port: Number(port), rules: readFileSync('firestore.rules', 'utf8') },
  });
});
test.after(() => env.cleanup());
test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'members/alice'), { email: 'alice@x.dev', name: 'Alice', role: 'member', active: true });
    await setDoc(doc(db, 'members/boss'), { email: 'boss@x.dev', name: 'Boss', role: 'admin', active: true });
    await setDoc(doc(db, 'members/gone'), { email: 'gone@x.dev', name: 'Gone', role: 'admin', active: false });
    await setDoc(doc(db, 'fund/main'), { balanceCents: 1000 });
    await setDoc(doc(db, 'transactions/t1'), { type: 'deposit', amountCents: 1000, memberUid: 'alice' });
    await setDoc(doc(db, 'auditLog/a1'), { action: 'transaction.deposit' });
    await setDoc(doc(db, 'allowedEmails/alice@x.dev'), { role: 'member' });
  });
});

const as = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

test('unauthenticated users cannot read anything', async () => {
  const db = as(null);
  await assertFails(getDoc(doc(db, 'fund/main')));
  await assertFails(getDocs(collection(db, 'transactions')));
  await assertFails(getDocs(collection(db, 'members')));
});

test('signed-in non-members cannot read fund data', async () => {
  const db = as('stranger');
  await assertFails(getDoc(doc(db, 'fund/main')));
  await assertFails(getDocs(collection(db, 'transactions')));
  await assertFails(getDocs(collection(db, 'members')));
  await assertSucceeds(getDoc(doc(db, 'members/stranger'))); // own (missing) member doc
});

test('deactivated members lose access', async () => {
  const db = as('gone');
  await assertFails(getDoc(doc(db, 'fund/main')));
  await assertFails(getDocs(collection(db, 'auditLog')));
});

test('active members can read the shared fund, history and member list', async () => {
  const db = as('alice');
  await assertSucceeds(getDoc(doc(db, 'fund/main')));
  await assertSucceeds(getDocs(collection(db, 'transactions')));
  await assertSucceeds(getDocs(collection(db, 'members')));
});

test('only admins can read the audit log and allowlist', async () => {
  await assertFails(getDocs(collection(as('alice'), 'auditLog')));
  await assertFails(getDocs(collection(as('alice'), 'allowedEmails')));
  await assertSucceeds(getDocs(collection(as('boss'), 'auditLog')));
  await assertSucceeds(getDocs(collection(as('boss'), 'allowedEmails')));
});

test('nobody can write from the client — not even admins (writes go through the server)', async () => {
  for (const uid of ['alice', 'boss']) {
    const db = as(uid);
    await assertFails(setDoc(doc(db, 'fund/main'), { balanceCents: 999999 }));
    await assertFails(updateDoc(doc(db, 'fund/main'), { balanceCents: 999999 }));
    await assertFails(addDoc(collection(db, 'transactions'), { type: 'deposit', amountCents: 1 }));
    await assertFails(updateDoc(doc(db, 'transactions/t1'), { amountCents: 1 }));
    await assertFails(deleteDoc(doc(db, 'transactions/t1')));
    await assertFails(deleteDoc(doc(db, 'auditLog/a1')));
    await assertFails(addDoc(collection(db, 'auditLog'), { action: 'fake' }));
    await assertFails(updateDoc(doc(db, `members/${uid}`), { role: 'admin' }));
    await assertFails(setDoc(doc(db, 'members/newbie'), { role: 'admin', active: true }));
    await assertFails(setDoc(doc(db, 'allowedEmails/evil@x.dev'), { role: 'admin' }));
  }
});

test('unknown collections are denied', async () => {
  await assertFails(getDoc(doc(as('boss'), 'secrets/x')));
  await assertFails(setDoc(doc(as('boss'), 'secrets/x'), { a: 1 }));
});
