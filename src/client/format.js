// Pure helpers shared by the UI (and unit-tested in Node).
export const CURRENCY = 'د.أ';

export function formatMoney(cents) {
  const n = Number.isFinite(cents) ? cents : 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(n));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')} ${CURRENCY}`;
}

/** Client-side pre-check that mirrors the server rule (server is authoritative). */
export function isValidAmount(text) {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(text ?? '').trim());
  if (!m) return false;
  const cents = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return cents > 0 && cents <= 100_000_000;
}

/** Arabic-Indic digits typed on Arabic keyboards -> ASCII, and Arabic decimal separator -> '.' */
export function normalizeDigits(text) {
  return String(text ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.');
}

export function formatDate(date) {
  if (!date) return 'الآن';
  try {
    return date.toLocaleString('ar-JO', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
}

export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const AUDIT_LABELS = {
  'member.joined': 'انضم للصندوق',
  'member.invited': 'أضاف عضو',
  'member.removed': 'أزال عضو',
  'member.renamed': 'غيّر اسمه',
  'member.promoted': 'صار مسؤول',
  'transaction.deposit': 'إيداع',
  'transaction.expense': 'مصروف',
  'transaction.reversed': 'عكس عملية',
};

export function auditLabel(action) {
  return AUDIT_LABELS[action] || action;
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'البريد أو كلمة السر غلط',
  'auth/wrong-password': 'البريد أو كلمة السر غلط',
  'auth/user-not-found': 'البريد أو كلمة السر غلط',
  'auth/invalid-email': 'البريد الإلكتروني غير صالح',
  'auth/email-already-in-use': 'هذا البريد مسجل مسبقاً، جرّب تسجيل الدخول',
  'auth/weak-password': 'كلمة السر ضعيفة (6 أحرف على الأقل)',
  'auth/too-many-requests': 'محاولات كثيرة، حاول بعد شوي',
  'auth/popup-closed-by-user': 'تم إغلاق نافذة الدخول',
  'auth/network-request-failed': 'مشكلة بالاتصال بالإنترنت',
};

export function authErrorMessage(err) {
  return AUTH_ERRORS[err?.code] || 'صار خطأ، حاول مرة ثانية';
}
