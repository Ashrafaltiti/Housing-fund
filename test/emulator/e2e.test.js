'use strict';
// Browser end-to-end test. Uses Playwright if it is installed (globally or locally); skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resetEmulators, startServer, createUser, client } = require('./helpers');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}
const SHOTS = process.env.E2E_SCREENSHOTS; // optional directory for screenshots

test('two members see each other\'s changes in real time', { skip: !chromium && 'playwright not installed', timeout: 120_000 }, async () => {
  await resetEmulators();
  const srv = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const admin = await createUser('admin@test.dev', { name: 'أبو أحمد' });
    await client(srv.base, admin.token)('POST', '/api/admin/members', { email: 'sara@test.dev' });
    await createUser('sara@test.dev', { name: 'سارة' });
    await createUser('stranger@test.dev', { name: 'غريب' });

    async function login(email, viewport) {
      const ctx = await browser.newContext({ viewport, locale: 'ar-JO' });
      const page = await ctx.newPage();
      page.on('console', (m) => m.type() === 'error' && errors.push(`${email}: ${m.text()}`));
      page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
      page.on('dialog', (d) => d.accept());
      await page.goto(srv.base);
      await page.fill('#authEmail', email);
      await page.fill('#authPassword', 'secret123');
      await page.click('#authSubmit');
      return page;
    }

    const a = await login('admin@test.dev', { width: 1280, height: 860 });
    await a.waitForSelector('#appView:not(.hidden)');
    await a.waitForSelector('#adminCard:not(.hidden)');

    // Admin deposits 100
    await a.click('#incomeTab');
    await a.fill('#amount', '100');
    await a.click('#txSubmit');
    await a.waitForFunction(() => document.getElementById('balance').textContent.startsWith('100.00'));

    // Sara (mobile) sees it in real time, then spends 30.50 using Arabic digits
    const s = await login('sara@test.dev', { width: 375, height: 760 });
    await s.waitForSelector('#appView:not(.hidden)');
    await s.waitForFunction(() => document.getElementById('balance').textContent.startsWith('100.00'));
    assert.ok(await s.isHidden('#adminCard'), 'non-admins do not see admin tools');
    await s.fill('#item', 'مواد تنظيف');
    await s.fill('#amount', '٣٠٫٥');
    await s.click('#txSubmit');
    await a.waitForFunction(() => document.getElementById('balance').textContent.startsWith('69.50'));
    await a.waitForFunction(() => document.getElementById('history').textContent.includes('مواد تنظيف'));
    assert.match(await a.textContent('#spent'), /30\.50/);

    // Overspend is blocked by the server and the user sees the reason
    await s.fill('#item', 'تلفزيون');
    await s.fill('#amount', '500');
    await s.click('#txSubmit');
    await s.waitForSelector('#toast.error:not(.hidden)');
    assert.match(await s.textContent('#toast'), /الرصيد غير كافي/);
    assert.match(await s.textContent('#balance'), /69\.50/);

    // Sara cancels her own expense -> both see the balance restored
    await s.click('#history .entry:not(.reversed) .delete');
    await a.waitForFunction(() => document.getElementById('balance').textContent.startsWith('100.00'));
    await a.waitForFunction(() => document.getElementById('audit').textContent.includes('عكس عملية'));

    // Mobile layout: nothing overflows horizontally
    const overflow = await s.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `mobile horizontal overflow: ${overflow}px`);
    assert.equal(await s.getAttribute('html', 'dir'), 'rtl');

    if (SHOTS) {
      await a.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });
      await s.screenshot({ path: path.join(SHOTS, 'mobile.png'), fullPage: true });
    }

    // A signed-in user who was never invited is denied
    const x = await login('stranger@test.dev', { width: 375, height: 760 });
    await x.waitForSelector('#deniedView:not(.hidden)');
    assert.match(await x.textContent('#deniedMsg'), /غير مضاف/);
    assert.ok(await x.isHidden('#appView'));
    if (SHOTS) await x.screenshot({ path: path.join(SHOTS, 'denied.png') });

    // Sign out returns to the login screen
    await s.click('#logoutBtn');
    await s.waitForSelector('#authView:not(.hidden)');
    if (SHOTS) await s.screenshot({ path: path.join(SHOTS, 'login.png') });

    // Expected: 403 for the uninvited user, 409 for the blocked overspend. Anything else (e.g. CSP) fails.
    const unexpected = errors.filter((e) => !/status of (403|409)/.test(e)); // denied user + blocked overspend
    assert.deepEqual(unexpected, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
