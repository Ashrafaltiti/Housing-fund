import { initializeApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
  signOut,
} from 'firebase/auth';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  doc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
} from 'firebase/firestore';
import { formatMoney, formatDate, isValidAmount, normalizeDigits, newRequestId, auditLabel, authErrorMessage } from './format.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['loadingView', 'authView', 'verifyView', 'deniedView', 'appView'];

const state = {
  auth: null,
  db: null,
  member: null,
  txMode: 'expense',
  authMode: 'login',
  transactions: [],
  members: new Map(),
  unsubscribers: [],
  pendingRequestId: null,
};

// ---------- small UI helpers ----------
function show(view) {
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== view);
  $('userChip').classList.toggle('hidden', view === 'authView' || view === 'loadingView');
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function busy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
  }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c != null));
  return node;
}

// ---------- server API (all writes go through here) ----------
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'POST', body } = {}) {
  const user = state.auth.currentUser;
  if (!user) throw new ApiError(401, 'unauthenticated', 'لازم تسجل الدخول');
  const token = await user.getIdToken();
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'مشكلة بالاتصال، تأكد من الإنترنت وحاول مرة ثانية');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.code || 'error', data.error?.message || 'صار خطأ، حاول مرة ثانية');
  return data;
}

// ---------- auth ----------
function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('nameWrap').classList.toggle('hidden', !signup);
  $('authSubmit').textContent = signup ? 'إنشاء الحساب' : 'دخول';
  $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
  $('loginTab').className = signup ? 'secondary' : '';
  $('signupTab').className = signup ? '' : 'secondary';
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  const name = $('authName').value.trim();
  if (!email || password.length < 6 || (state.authMode === 'signup' && !name)) {
    toast(state.authMode === 'signup' ? 'عبّي الاسم والبريد وكلمة سر (6 أحرف على الأقل)' : 'عبّي البريد وكلمة السر', true);
    return;
  }
  await busy($('authSubmit'), async () => {
    try {
      if (state.authMode === 'signup') {
        const cred = await createUserWithEmailAndPassword(state.auth, email, password);
        await updateProfile(cred.user, { displayName: name });
        await sendEmailVerification(cred.user);
        await routeUser(cred.user);
      } else {
        await signInWithEmailAndPassword(state.auth, email, password);
      }
    } catch (err) {
      toast(authErrorMessage(err), true);
    }
  });
}

async function routeUser(user) {
  stopListeners();
  state.member = null;
  if (!user) {
    show('authView');
    return;
  }
  $('userName').textContent = user.displayName || user.email;
  const isPasswordUser = user.providerData.some((p) => p.providerId === 'password');
  if (isPasswordUser && !user.emailVerified) {
    $('verifyEmail').textContent = user.email;
    show('verifyView');
    return;
  }
  show('loadingView');
  try {
    // Token may predate verification; force refresh so the server sees email_verified=true.
    await user.getIdToken(true);
    const { member } = await api('/session');
    state.member = member;
    startApp();
  } catch (err) {
    // 403 = not invited / disabled; anything else (network, 5xx) can be retried from the same screen.
    $('deniedMsg').textContent = err.message;
    $('deniedEmail').textContent = user.email || '';
    show('deniedView');
  }
}

// ---------- real-time data ----------
function stopListeners() {
  for (const unsub of state.unsubscribers.splice(0)) unsub();
}

function listenError(err) {
  console.error(err);
  if (err.code === 'permission-denied') {
    toast('تم سحب صلاحيتك أو انتهت الجلسة', true);
    routeUser(state.auth.currentUser);
  }
}

function startApp() {
  const { db, member } = state;
  $('userName').textContent = member.name;
  $('asName').textContent = member.name;
  $('adminCard').classList.toggle('hidden', member.role !== 'admin');
  show('appView');

  state.unsubscribers.push(
    onSnapshot(doc(db, 'fund', 'main'), { includeMetadataChanges: true }, (snap) => {
      const f = snap.data() || {};
      const balance = f.balanceCents || 0;
      $('balance').textContent = formatMoney(balance);
      $('balance').classList.toggle('low', balance <= 0);
      $('income').textContent = formatMoney(f.totalDepositsCents || 0);
      $('spent').textContent = formatMoney(f.totalExpensesCents || 0);
      $('syncState').textContent = snap.metadata.fromCache ? 'آخر بيانات محفوظة — جاري المزامنة…' : 'متزامن مع جميع الأعضاء';
    }, listenError),
    onSnapshot(query(collection(db, 'transactions'), orderBy('createdAt', 'desc'), limit(200)), (snap) => {
      state.transactions = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
      renderHistory();
    }, listenError),
    onSnapshot(collection(db, 'members'), (snap) => {
      state.members = new Map(snap.docs.map((d) => [d.id, d.data()]));
      renderMembers();
    }, listenError),
  );

  if (member.role === 'admin') {
    state.unsubscribers.push(
      onSnapshot(collection(db, 'allowedEmails'), (snap) => renderAllowed(snap.docs), listenError),
      onSnapshot(query(collection(db, 'auditLog'), orderBy('at', 'desc'), limit(50)), (snap) => renderAudit(snap.docs), listenError),
    );
  }
}

function renderHistory() {
  const h = $('history');
  const filter = $('filter').value;
  const me = state.member?.uid;
  const items = state.transactions.filter((t) =>
    filter === 'all' ? true : filter === 'mine' ? t.memberUid === me : t.type === filter);
  h.replaceChildren();
  if (!items.length) {
    h.className = 'empty';
    h.textContent = 'ما في عمليات لحد الآن';
    return;
  }
  h.className = '';
  for (const t of items) {
    const sign = t.deltaCents > 0 ? '+' : '-';
    const cls = t.type === 'reversal' ? 'neutral' : t.deltaCents > 0 ? 'income' : 'expense';
    const meta = `${t.memberName} · ${formatDate(t.createdAt?.toDate?.())}${t.reversed ? ' · (ملغاة)' : ''}`;
    const side = el('div', { className: 'row' }, el('span', { className: `amount ${cls}`, textContent: sign + formatMoney(t.amountCents) }));
    const canReverse = t.type !== 'reversal' && !t.reversed && (state.member.role === 'admin' || t.memberUid === me);
    if (canReverse) {
      const btn = el('button', { type: 'button', className: 'delete', textContent: 'إلغاء' });
      btn.setAttribute('aria-label', `إلغاء العملية: ${t.description}`);
      btn.onclick = () => reverseTx(t, btn);
      side.append(btn);
    }
    h.append(el('div', { className: `entry${t.reversed ? ' reversed' : ''}` },
      el('div', {}, el('strong', { textContent: t.description }), el('small', { textContent: meta })),
      side));
  }
}

function renderMembers() {
  const box = $('members');
  box.replaceChildren();
  const list = [...state.members.entries()].filter(([, m]) => m.active).sort((a, b) => a[1].name.localeCompare(b[1].name, 'ar'));
  for (const [uid, m] of list) {
    box.append(el('div', { className: 'entry' },
      el('div', {}, el('strong', { textContent: m.name + (uid === state.member.uid ? ' (أنت)' : '') })),
      el('span', { className: 'badge', textContent: m.role === 'admin' ? 'مسؤول' : 'عضو' })));
  }
}

function renderAllowed(docs) {
  const box = $('allowed');
  box.replaceChildren();
  const sorted = [...docs].sort((a, b) => Number(b.data().active !== false) - Number(a.data().active !== false));
  for (const d of sorted) {
    const a = d.data();
    const active = a.active !== false;
    const right = el('div', { className: 'row' },
      el('span', { className: `badge${active ? '' : ' off'}`, textContent: !active ? 'محذوف' : a.role === 'admin' ? 'مسؤول' : 'عضو' }));
    if (active) {
      const btn = el('button', { type: 'button', className: 'delete', textContent: 'إزالة' });
      btn.onclick = () => removeMember(d.id, btn);
      right.append(btn);
    }
    box.append(el('div', { className: 'entry' },
      el('div', {}, el('strong', { textContent: d.id, dir: 'ltr' }), el('small', { textContent: a.claimedBy ? 'سجّل دخول' : 'بانتظار أول دخول' })),
      right));
  }
}

function renderAudit(docs) {
  const box = $('audit');
  box.replaceChildren();
  if (!docs.length) {
    box.append(el('div', { className: 'empty', textContent: 'السجل فاضي' }));
    return;
  }
  for (const d of docs) {
    const a = d.data({ serverTimestamps: 'estimate' });
    const det = a.details || {};
    const extra = det.amountCents != null ? ` ${formatMoney(det.amountCents)}` : det.email ? ` ${det.email}` : '';
    box.append(el('div', { className: 'entry' },
      el('div', {},
        el('strong', { textContent: `${a.actorName || a.actorEmail}: ${auditLabel(a.action)}${extra}` }),
        el('small', { textContent: `${formatDate(a.at?.toDate?.())}${det.description ? ' · ' + det.description : ''}${det.reason ? ' · ' + det.reason : ''}` }))));
  }
}

// ---------- actions ----------
function setTxMode(mode) {
  state.txMode = mode;
  const expense = mode === 'expense';
  $('itemWrap').classList.toggle('hidden', !expense);
  $('noteWrap').classList.toggle('hidden', expense);
  $('item').required = expense;
  $('txSubmit').textContent = expense ? 'تسجيل المصروف' : 'إضافة المبلغ';
  $('expenseTab').className = expense ? '' : 'secondary';
  $('incomeTab').className = expense ? 'secondary' : '';
  state.pendingRequestId = null;
}

async function onTxSubmit(e) {
  e.preventDefault();
  const type = state.txMode === 'expense' ? 'expense' : 'deposit';
  const amount = normalizeDigits($('amount').value).trim();
  const description = (type === 'expense' ? $('item').value : $('note').value).trim();
  if ((type === 'expense' && !description) || !isValidAmount(amount)) {
    toast('تأكد من البيانات والمبلغ', true);
    return;
  }
  // Reuse the same requestId on retry after a network failure so the server de-duplicates it.
  state.pendingRequestId ||= newRequestId();
  await busy($('txSubmit'), async () => {
    try {
      const result = await api('/transactions', { body: { type, amount, description, requestId: state.pendingRequestId } });
      state.pendingRequestId = null;
      $('txForm').reset();
      toast(`${type === 'expense' ? 'تم تسجيل المصروف' : 'تمت إضافة المبلغ'} — الرصيد ${formatMoney(result.balanceCents)}`);
    } catch (err) {
      if (err.code !== 'network') state.pendingRequestId = null;
      toast(err.message, true);
    }
  });
}

async function reverseTx(t, btn) {
  if (!confirm(`متأكد بدك تلغي "${t.description}" (${formatMoney(t.amountCents)})؟\nرح تنضاف عملية عكسية بالسجل.`)) return;
  const reason = prompt('سبب الإلغاء (اختياري):') ?? '';
  await busy(btn, async () => {
    try {
      await api(`/transactions/${encodeURIComponent(t.id)}/reverse`, { body: { reason } });
      toast('تم إلغاء العملية');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function onInvite(e) {
  e.preventDefault();
  const email = $('inviteEmail').value.trim();
  if (!email) return;
  const btn = e.submitter || $('inviteForm').querySelector('button');
  await busy(btn, async () => {
    try {
      await api('/admin/members', { body: { email, role: $('inviteRole').value } });
      $('inviteForm').reset();
      toast('تمت إضافة البريد. خلّي الشخص يسجل دخول بنفس البريد.');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function removeMember(email, btn) {
  if (!confirm(`إزالة ${email} من الصندوق؟`)) return;
  await busy(btn, async () => {
    try {
      await api(`/admin/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
      toast('تمت الإزالة');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function onRename() {
  const name = prompt('اسمك اللي رح يظهر للأعضاء:', state.member?.name || '');
  if (!name || !name.trim()) return;
  try {
    const { member } = await api('/me', { method: 'PATCH', body: { name } });
    state.member = member;
    $('userName').textContent = member.name;
    $('asName').textContent = member.name;
    toast('تم تعديل الاسم');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- boot ----------
async function boot() {
  const updateNet = () => $('netBanner').classList.toggle('hidden', navigator.onLine);
  addEventListener('online', updateNet);
  addEventListener('offline', updateNet);
  updateNet();

  let config;
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    $('loadingView').textContent = 'تعذر الاتصال بالخادم. حدّث الصفحة.';
    return;
  }
  const app = initializeApp(config.firebase);
  state.auth = getAuth(app);
  state.auth.languageCode = 'ar';
  let cache;
  try {
    cache = config.emulators ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() });
  } catch {
    cache = memoryLocalCache();
  }
  state.db = initializeFirestore(app, { localCache: cache });
  if (config.emulators) {
    connectAuthEmulator(state.auth, `http://${config.emulators.auth}`, { disableWarnings: true });
    const [host, port] = config.emulators.firestore.split(':');
    connectFirestoreEmulator(state.db, host, Number(port));
  }

  $('loginTab').onclick = () => setAuthMode('login');
  $('signupTab').onclick = () => setAuthMode('signup');
  $('authForm').onsubmit = onAuthSubmit;
  $('googleBtn').onclick = async () => {
    try {
      await signInWithPopup(state.auth, new GoogleAuthProvider());
    } catch (err) {
      toast(authErrorMessage(err), true);
    }
  };
  $('resetBtn').onclick = async () => {
    const email = $('authEmail').value.trim();
    if (!email) return toast('اكتب بريدك الإلكتروني أولاً', true);
    try {
      await sendPasswordResetEmail(state.auth, email);
      toast('إذا البريد مسجل، رح يوصلك رابط لتغيير كلمة السر');
    } catch (err) {
      toast(authErrorMessage(err), true);
    }
  };
  $('verifiedBtn').onclick = () => busy($('verifiedBtn'), async () => {
    await state.auth.currentUser?.reload();
    if (state.auth.currentUser?.emailVerified) await routeUser(state.auth.currentUser);
    else toast('لسا ما تأكد البريد. افتح الرابط اللي بعثناه.', true);
  });
  $('resendBtn').onclick = () => busy($('resendBtn'), async () => {
    try {
      await sendEmailVerification(state.auth.currentUser);
      toast('تم إرسال الرابط مرة ثانية');
    } catch (err) {
      toast(authErrorMessage(err), true);
    }
  });
  $('retryBtn').onclick = () => routeUser(state.auth.currentUser);
  $('logoutBtn').onclick = () => signOut(state.auth);
  $('renameBtn').onclick = onRename;
  $('expenseTab').onclick = () => setTxMode('expense');
  $('incomeTab').onclick = () => setTxMode('income');
  $('txForm').onsubmit = onTxSubmit;
  $('inviteForm').onsubmit = onInvite;
  $('filter').onchange = renderHistory;
  setAuthMode('login');
  setTxMode('expense');

  onAuthStateChanged(state.auth, (user) => routeUser(user));
}

boot();
