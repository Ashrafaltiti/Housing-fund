'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmountToCents, cleanText, normalizeEmail, validateRequestId, formatCents, ValidationError } = require('../../server/validation');

test('parseAmountToCents handles valid input without float drift', () => {
  assert.equal(parseAmountToCents('12'), 1200);
  assert.equal(parseAmountToCents('12.5'), 1250);
  assert.equal(parseAmountToCents('0.01'), 1);
  assert.equal(parseAmountToCents(' 19.99 '), 1999);
  assert.equal(parseAmountToCents(0.1 + 0.2 === 0.3 ? 1 : '0.30'), 30);
  assert.equal(parseAmountToCents(4.35), 435);
  assert.equal(parseAmountToCents('1000000'), 100_000_000);
});

test('parseAmountToCents rejects invalid input', () => {
  for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '1,000', NaN, Infinity, null, undefined, {}, '1000000.01', '12.']) {
    assert.throws(() => parseAmountToCents(bad), ValidationError, `should reject ${String(bad)}`);
  }
});

test('cleanText trims, collapses whitespace, strips control/bidi chars and enforces limits', () => {
  assert.equal(cleanText('  مواد   تنظيف \n', { field: 'x', max: 20 }), 'مواد تنظيف');
  assert.equal(cleanText('a‮b\u0000c', { field: 'x', max: 20 }), 'abc');
  assert.equal(cleanText(undefined, { field: 'x', max: 5 }), '');
  assert.throws(() => cleanText('   ', { field: 'x', max: 5, required: true }), ValidationError);
  assert.throws(() => cleanText('abcdef', { field: 'x', max: 5 }), ValidationError);
  assert.throws(() => cleanText(42, { field: 'x', max: 5 }), ValidationError);
});

test('normalizeEmail lowercases and validates', () => {
  assert.equal(normalizeEmail(' Ahmad@Example.COM '), 'ahmad@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), ValidationError);
  assert.throws(() => normalizeEmail('a@b'), ValidationError);
});

test('validateRequestId only accepts safe document ids', () => {
  assert.equal(validateRequestId('abcdef0123456789'), 'abcdef0123456789');
  for (const bad of ['short', '../../etc', 'a/b/c/d/e/f/g/h', 'x'.repeat(65), 123, null]) {
    assert.throws(() => validateRequestId(bad), ValidationError);
  }
});

test('formatCents', () => {
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(1205), '12.05');
  assert.equal(formatCents(-50), '-0.50');
});
