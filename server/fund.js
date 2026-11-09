'use strict';

const { FieldValue } = require('firebase-admin/firestore');
const {
  ValidationError,
  parseAmountToCents,
  cleanText,
  normalizeEmail,
  validateRequestId,
  formatCents,
} = require('./validation');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

const ABORTED = 10; // gRPC status code for transaction contention
const ROLES = new Set(['admin', 'member']);
const EMPTY_FUND = { balanceCents: 0, totalDepositsCents: 0, totalExpensesCents: 0, transactionCount: 0 };

/**
 * All writes to money-related documents happen here, inside Firestore
 * transactions run with the Admin SDK. Clients are never allowed to write
 * these collections directly (see firestore.rules), so the balance can only
 * change atomically together with its transaction record and audit entry.
 */
class FundService {
  constructor(db, { adminEmails = [] } = {}) {
    this.db = db;
    this.adminEmails = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    this.fundRef = db.collection('fund').doc('main');
  }

  /**
   * Run a Firestore transaction, retrying on lock contention (gRPC ABORTED)
   * with jittered backoff. Firestore already retries internally; this covers
   * bursts of many members writing the shared balance at once.
   */
  async runTx(fn, attempts = 6) {
    for (let i = 1; ; i++) {
      try {
        return await this.db.runTransaction(fn, { maxAttempts: 5 });
      } catch (err) {
        if (err.code !== ABORTED) throw err;
        if (i >= attempts) throw new HttpError(503, 'busy', 'الصندوق مشغول حالياً، حاول مرة ثانية');
        await new Promise((r) => setTimeout(r, Math.random() * 100 * 2 ** i));
      }
    }
  }

  audit(tx, action, actor, details) {
    const ref = this.db.collection('auditLog').doc();
    tx.create(ref, {
      action,
      actorUid: actor.uid,
      actorEmail: actor.email || null,
      actorName: actor.name || null,
      details,
      at: FieldValue.serverTimestamp(),
    });
  }

  /**
   * Called after sign-in. Returns the member profile, creating it the first
   * time if the user's *verified* email is on the allowlist (or ADMIN_EMAILS).
   */
  async ensureMember(user) {
    const memberRef = this.db.collection('members').doc(user.uid);
    return this.runTx(async (tx) => {
      const snap = await tx.get(memberRef);
      if (snap.exists) {
        const member = snap.data();
        if (this.adminEmails.has(member.email) && (member.role !== 'admin' || !member.active)) {
          // ADMIN_EMAILS (server config) always wins, so the owner can't be locked out.
          tx.update(memberRef, { role: 'admin', active: true });
          this.audit(tx, 'member.promoted', { uid: user.uid, email: member.email, name: member.name }, { source: 'ADMIN_EMAILS' });
          return { uid: user.uid, ...member, role: 'admin', active: true };
        }
        if (!member.active) throw new HttpError(403, 'member-disabled', 'تم إيقاف عضويتك في الصندوق');
        return { uid: user.uid, ...member };
      }
      if (!user.email || !user.emailVerified) {
        throw new HttpError(403, 'email-not-verified', 'لازم تأكد بريدك الإلكتروني أولاً');
      }
      const email = user.email.toLowerCase();
      const allowRef = this.db.collection('allowedEmails').doc(email);
      const allowSnap = await tx.get(allowRef);
      let role;
      if (this.adminEmails.has(email)) role = 'admin';
      else if (allowSnap.exists && allowSnap.data().active !== false) role = allowSnap.data().role;
      else throw new HttpError(403, 'not-invited', 'بريدك غير مضاف للصندوق. اطلب من المسؤول إضافتك.');

      const name = cleanText(user.name || email.split('@')[0], { field: 'الاسم', max: 60 }) || email;
      const member = { email, name, role, active: true, joinedAt: FieldValue.serverTimestamp() };
      tx.create(memberRef, member);
      if (allowSnap.exists) tx.update(allowRef, { claimedBy: user.uid, claimedAt: FieldValue.serverTimestamp() });
      this.audit(tx, 'member.joined', { uid: user.uid, email, name }, { role });
      return { uid: user.uid, ...member, joinedAt: null };
    });
  }

  async updateProfile(member, body) {
    const name = cleanText(body?.name, { field: 'الاسم', max: 60, required: true });
    const memberRef = this.db.collection('members').doc(member.uid);
    await this.runTx(async (tx) => {
      tx.update(memberRef, { name });
      this.audit(tx, 'member.renamed', member, { from: member.name, to: name });
    });
    return { ...member, name };
  }

  /** Record a deposit or expense atomically. Expenses can never exceed the balance. */
  async addTransaction(member, body) {
    const type = body?.type;
    if (type !== 'deposit' && type !== 'expense') throw new ValidationError('نوع العملية غير صالح', 'invalid-type');
    const amountCents = parseAmountToCents(body.amount);
    const description = cleanText(body.description, {
      field: type === 'expense' ? 'وصف المصروف' : 'الملاحظة',
      max: 120,
      required: type === 'expense',
    }) || 'تعبئة الصندوق';
    const requestId = validateRequestId(body.requestId);
    const txRef = this.db.collection('transactions').doc(requestId);

    return this.runTx(async (tx) => {
      const [existing, fundSnap] = await Promise.all([tx.get(txRef), tx.get(this.fundRef)]);
      if (existing.exists) {
        const prev = existing.data();
        // Same request retried (e.g. flaky network): return the original result, don't double-charge.
        if (prev.memberUid === member.uid && prev.type === type && prev.amountCents === amountCents) {
          return { id: requestId, duplicate: true, balanceCents: prev.balanceAfterCents };
        }
        throw new HttpError(409, 'request-id-conflict', 'تعارض في معرّف الطلب، حاول مرة ثانية');
      }
      const fund = fundSnap.exists ? { ...EMPTY_FUND, ...fundSnap.data() } : { ...EMPTY_FUND };
      const delta = type === 'deposit' ? amountCents : -amountCents;
      const balanceAfterCents = fund.balanceCents + delta;
      if (balanceAfterCents < 0) {
        throw new HttpError(409, 'insufficient-funds', `الرصيد غير كافي. الرصيد الحالي ${formatCents(fund.balanceCents)} د.أ`);
      }
      const next = {
        balanceCents: balanceAfterCents,
        totalDepositsCents: fund.totalDepositsCents + (type === 'deposit' ? amountCents : 0),
        totalExpensesCents: fund.totalExpensesCents + (type === 'expense' ? amountCents : 0),
        transactionCount: fund.transactionCount + 1,
        updatedAt: FieldValue.serverTimestamp(),
      };
      tx.set(this.fundRef, next);
      tx.create(txRef, {
        type,
        amountCents,
        deltaCents: delta,
        description,
        memberUid: member.uid,
        memberName: member.name,
        balanceAfterCents,
        createdAt: FieldValue.serverTimestamp(),
        reversed: false,
      });
      this.audit(tx, `transaction.${type}`, member, { transactionId: requestId, amountCents, description, balanceAfterCents });
      return { id: requestId, duplicate: false, balanceCents: balanceAfterCents };
    });
  }

  /**
   * History is append-only: instead of deleting, a transaction is reversed by
   * a compensating entry. Allowed for the admin or the member who created it.
   */
  async reverseTransaction(member, transactionId, body) {
    validateRequestId(transactionId);
    const reason = cleanText(body?.reason, { field: 'السبب', max: 120 });
    const origRef = this.db.collection('transactions').doc(transactionId);
    const reversalRef = this.db.collection('transactions').doc(`${transactionId}-rev`);

    return this.runTx(async (tx) => {
      const [origSnap, fundSnap] = await Promise.all([tx.get(origRef), tx.get(this.fundRef)]);
      if (!origSnap.exists) throw new HttpError(404, 'not-found', 'العملية غير موجودة');
      const orig = origSnap.data();
      if (orig.type === 'reversal') throw new HttpError(400, 'not-reversible', 'لا يمكن عكس عملية عكس');
      if (orig.reversed) throw new HttpError(409, 'already-reversed', 'العملية معكوسة مسبقاً');
      if (member.role !== 'admin' && orig.memberUid !== member.uid) {
        throw new HttpError(403, 'forbidden', 'فقط صاحب العملية أو المسؤول يقدر يعكسها');
      }
      const fund = fundSnap.exists ? { ...EMPTY_FUND, ...fundSnap.data() } : { ...EMPTY_FUND };
      const delta = -orig.deltaCents;
      const balanceAfterCents = fund.balanceCents + delta;
      if (balanceAfterCents < 0) {
        throw new HttpError(409, 'insufficient-funds', 'ما بنقدر نلغي الإيداع لأن الرصيد الحالي ما بكفي');
      }
      tx.set(this.fundRef, {
        balanceCents: balanceAfterCents,
        totalDepositsCents: fund.totalDepositsCents - (orig.type === 'deposit' ? orig.amountCents : 0),
        totalExpensesCents: fund.totalExpensesCents - (orig.type === 'expense' ? orig.amountCents : 0),
        transactionCount: fund.transactionCount + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(origRef, { reversed: true, reversedBy: member.uid, reversedAt: FieldValue.serverTimestamp(), reversalId: reversalRef.id });
      tx.create(reversalRef, {
        type: 'reversal',
        amountCents: orig.amountCents,
        deltaCents: delta,
        description: `عكس: ${orig.description}${reason ? ` (${reason})` : ''}`.slice(0, 200),
        memberUid: member.uid,
        memberName: member.name,
        balanceAfterCents,
        reversesId: transactionId,
        createdAt: FieldValue.serverTimestamp(),
        reversed: false,
      });
      this.audit(tx, 'transaction.reversed', member, { transactionId, reversalId: reversalRef.id, reason, balanceAfterCents });
      return { id: reversalRef.id, balanceCents: balanceAfterCents };
    });
  }

  async inviteMember(admin, body) {
    const email = normalizeEmail(body?.email);
    const role = body?.role ?? 'member';
    if (!ROLES.has(role)) throw new ValidationError('الصلاحية غير صالحة', 'invalid-role');
    const allowRef = this.db.collection('allowedEmails').doc(email);
    await this.runTx(async (tx) => {
      const existingMember = await tx.get(this.db.collection('members').where('email', '==', email).limit(1));
      tx.set(allowRef, { role, active: true, addedBy: admin.uid, addedAt: FieldValue.serverTimestamp() });
      // Re-inviting a previously removed member re-activates them with the requested role.
      existingMember.forEach((doc) => tx.update(doc.ref, { active: true, role }));
      this.audit(tx, 'member.invited', admin, { email, role });
    });
    return { email, role };
  }

  async removeMember(admin, rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (this.adminEmails.has(email)) throw new HttpError(400, 'protected', 'هذا المسؤول معرّف في إعدادات الخادم ولا يمكن حذفه من هنا');
    await this.runTx(async (tx) => {
      const members = await tx.get(this.db.collection('members').where('email', '==', email).limit(1));
      members.forEach((doc) => {
        if (doc.id === admin.uid) throw new HttpError(400, 'self-remove', 'ما بتقدر تحذف حسابك');
      });
      tx.set(this.db.collection('allowedEmails').doc(email), { active: false, removedBy: admin.uid, removedAt: FieldValue.serverTimestamp() }, { merge: true });
      members.forEach((doc) => tx.update(doc.ref, { active: false }));
      this.audit(tx, 'member.removed', admin, { email });
    });
    return { email };
  }
}

module.exports = { FundService, HttpError };
