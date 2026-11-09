'use strict';

const MAX_AMOUNT_CENTS = 100_000_000; // 1,000,000.00 JOD per operation
const AMOUNT_RE = /^(\d{1,9})(?:\.(\d{1,2}))?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

class ValidationError extends Error {
  constructor(message, code = 'invalid-input') {
    super(message);
    this.status = 400;
    this.code = code;
    this.expose = true;
  }
}

/** Parse a user-entered amount ("12", "12.5", 12.5) into integer cents without float drift. */
function parseAmountToCents(input) {
  const raw = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : String(input ?? '').trim();
  const m = AMOUNT_RE.exec(raw);
  if (!m) throw new ValidationError('المبلغ غير صالح', 'invalid-amount');
  const cents = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new ValidationError('المبلغ لازم يكون أكبر من صفر', 'invalid-amount');
  if (cents > MAX_AMOUNT_CENTS) throw new ValidationError('المبلغ أكبر من الحد المسموح', 'invalid-amount');
  return cents;
}

function cleanText(input, { field, max, required = false }) {
  if (input != null && typeof input !== 'string') throw new ValidationError(`${field} غير صالح`);
  const text = (input || '').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (required && !text) throw new ValidationError(`${field} مطلوب`);
  if ([...text].length > max) throw new ValidationError(`${field} طويل جداً (الحد ${max} حرف)`);
  return text;
}

function normalizeEmail(input) {
  const email = String(input ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new ValidationError('البريد الإلكتروني غير صالح', 'invalid-email');
  return email;
}

function validateRequestId(input) {
  if (typeof input !== 'string' || !REQUEST_ID_RE.test(input)) {
    throw new ValidationError('معرّف الطلب غير صالح', 'invalid-request-id');
  }
  return input;
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

module.exports = {
  MAX_AMOUNT_CENTS,
  ValidationError,
  parseAmountToCents,
  cleanText,
  normalizeEmail,
  validateRequestId,
  formatCents,
};
