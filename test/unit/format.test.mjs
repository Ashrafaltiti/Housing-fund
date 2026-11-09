import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, isValidAmount, normalizeDigits, newRequestId, authErrorMessage, auditLabel } from '../../src/client/format.js';

test('formatMoney', () => {
  assert.equal(formatMoney(0), '0.00 د.أ');
  assert.equal(formatMoney(123456), '1,234.56 د.أ');
  assert.equal(formatMoney(-5), '-0.05 د.أ');
  assert.equal(formatMoney(undefined), '0.00 د.أ');
});

test('isValidAmount mirrors server rules', () => {
  assert.ok(isValidAmount('5'));
  assert.ok(isValidAmount('5.25'));
  assert.ok(!isValidAmount('0'));
  assert.ok(!isValidAmount('5.255'));
  assert.ok(!isValidAmount('-1'));
  assert.ok(!isValidAmount('1000000.01'));
});

test('normalizeDigits converts Arabic-Indic digits and separators', () => {
  assert.equal(normalizeDigits('١٢٫٥'), '12.5');
  assert.equal(normalizeDigits('۳,۵'), '3.5');
});

test('newRequestId produces server-acceptable ids', () => {
  const id = newRequestId();
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(id, newRequestId());
});

test('labels', () => {
  assert.equal(authErrorMessage({ code: 'auth/invalid-credential' }), 'البريد أو كلمة السر غلط');
  assert.equal(authErrorMessage({}), 'صار خطأ، حاول مرة ثانية');
  assert.equal(auditLabel('transaction.expense'), 'مصروف');
  assert.equal(auditLabel('unknown'), 'unknown');
});
