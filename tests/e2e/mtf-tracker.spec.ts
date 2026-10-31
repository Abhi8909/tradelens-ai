import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  const result = await page.request.post('/api/mtf/workspace', { headers: { origin: 'http://127.0.0.1:5197' }, data: {} });
  expect(result.ok()).toBe(true);
  const user = (await result.json()).user;
  const accounts = await (await page.request.get('/api/mtf/accounts')).json();
  return { user, accountId: accounts.accounts[0].id };
}
test.beforeEach(async ({ page }, info) => { if (!info.title.includes('opens directly')) await login(page); });

test('manual MTF add, calculations, persistence, edit and greyed exit remove open totals', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(page.getByRole('button', { name: 'MTF Import', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Exit date (optional)', { exact: true })).toHaveCount(0);
  const today = await page.evaluate(() => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10));
  const bought = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Scrip symbol', { exact: true }).fill('SYNTHETIC');
  await page.getByLabel('Bought date', { exact: true }).fill(bought);
  await page.getByLabel('Quantity', { exact: true }).fill('100');
  await page.getByLabel('Buying price (₹ / share)', { exact: true }).fill('100');
  await page.getByLabel('Interest per day (₹)', { exact: true }).fill('2.40');
  await page.getByLabel('Other charges (₹)', { exact: true }).fill('20');
  await page.getByLabel('Current price (₹, optional manual)', { exact: true }).fill('110');
  await page.getByRole('button', { name: 'Add position', exact: true }).click();
  const row = page.locator('.mtf-position-table tbody tr');
  await expect(row).toContainText('30 days'); await expect(row).toContainText('₹100.92'); await expect(row).not.toContainText('100.9200'); await expect(row).toContainText('908.00');
  await expect(row.locator('.up')).toHaveCount(2);
  await page.screenshot({ path: '/tmp/tradelens-manual-mtf.png', fullPage: true });
  await page.reload(); await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(row).toContainText('SYNTHETIC');
  await expect(page.getByRole('button', { name: 'Mark exited', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: /Exit date/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit SYNTHETIC', exact: true }).click();
  await page.getByLabel('Exit date (optional)', { exact: true }).fill(today);
  await page.getByLabel('Change reason', { exact: true }).fill('Synthetic exit-date correction');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByLabel('Exit date (optional)', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Closed', exact: true }).click();
  await expect(row).toHaveClass(/mtf-closed/); await expect(row).toContainText('EXITED');
  await expect(page.getByText(/0 open positions/)).toBeVisible();
  await page.getByRole('button', { name: 'Edit SYNTHETIC', exact: true }).click();
  await page.getByLabel('Exit date (optional)', { exact: true }).fill('');
  await page.getByLabel('Change reason', { exact: true }).fill('Synthetic reopen correction');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('tab', { name: 'Open', exact: true }).click();
  await expect(row).not.toHaveClass(/mtf-closed/);
});

test('MTF refreshes every 150 seconds and shows an icon-only date tooltip', async ({ page }) => {
  const user = (await (await page.request.get('/api/mtf/session')).json()).user;
  const accountId = (await (await page.request.get('/api/mtf/accounts')).json()).accounts[0].id;
  await page.request.post('/api/mtf/positions', { headers: { origin: 'http://127.0.0.1:5197', 'x-mtf-csrf': user.csrf, 'idempotency-key': crypto.randomUUID() }, data: { accountId, position: { id: crypto.randomUUID(), symbol: 'SYNTHETIC', boughtDate: '2026-01-01', quantity: 100, buyPriceInr: '100', interestPerDayInr: '0', otherChargesInr: '0', exitDate: null, manualPrice: null } } });
  let calls = 0;
  await page.route('**/api/mtf/refresh', async route => { expect(route.request().postDataJSON()).toEqual({ accountId }); calls++; await route.fulfill({ contentType: 'application/json', body: '{}' }); });
  await page.route('**/api/mtf/summary?*', async route => {
    const result = await (await route.fetch()).json(); const value = calls >= 2 ? '90' : '110';
    for (const row of result.rows) {
      row.snapshot.quote = { marketAt: new Date().toISOString(), source: { reference: 'Synthetic E2E adapter' } };
      row.snapshot.quoteState = 'DELAYED';
      Object.assign(row.snapshot.metrics, { grossMarketValueInr: String(Number(value)*100), grossUnrealizedPnlInr: calls>=2?'-1000':'1000', costAdjustedUnrealizedPnlInr: calls>=2?'-1000':'1000' });
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto('/'); await page.clock.install(); await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(page.locator('.mtf-position-table tbody tr')).toContainText('1,000.00');
  const info = page.getByRole('button', { name: 'Quote timestamp: Market feed', exact: true });
  await expect(info).not.toHaveAttribute('title'); await expect(page.locator('.mtf-quote-meta').first()).toHaveText('Delayed');
  await info.hover(); const tooltip = page.getByRole('tooltip'); await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/^\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+(am|pm) IST$/);
  expect(await info.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer');
  await page.mouse.move(0,0); await expect(tooltip).not.toBeVisible(); await info.focus(); await expect(tooltip).toBeVisible(); await page.keyboard.press('Escape'); await expect(tooltip).not.toBeVisible();
  await page.clock.runFor(150_100); await expect(page.locator('.mtf-position-table tbody tr .down')).toHaveCount(2); expect(calls).toBeGreaterThanOrEqual(2);
});

test('MTF corrupt saved work is not overwritten', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => localStorage.setItem('tradelens-manual-mtf-v1', '{broken'));
  await page.reload(); await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('remain untouched');
  await expect(page.getByRole('button', { name: 'Add position', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('tradelens-manual-mtf-v1'))).toBe('{broken');
});

test('manual MTF remains usable on mobile without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(page.getByLabel('Scrip symbol', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText('Synthetic market data.', { exact: false })).not.toBeVisible();
});

test('MTF opens directly without auth screens and retains its workspace across reloads',async({page})=>{
  await page.goto('/#mtf');
  await expect(page.getByRole('heading',{name:'MTF portfolio',exact:true})).toBeVisible();
  await expect(page.getByLabel('Username',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Sign out',exact:true})).toHaveCount(0);
  const first=(await(await page.request.get('/api/mtf/session')).json()).user;
  expect(first).toBeTruthy();
  await page.reload();await expect(page.getByRole('heading',{name:'MTF portfolio',exact:true})).toBeVisible();
  expect((await(await page.request.get('/api/mtf/session')).json()).user.id).toBe(first.id);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('button',{name:'Change password',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Create portfolio account',exact:true})).toBeVisible();
});

test('position workspace reconciles interest, retains audit and records partial sale and conversion',async({page})=>{
  const user=(await(await page.request.get('/api/mtf/session')).json()).user;const accountId=(await(await page.request.get('/api/mtf/accounts')).json()).accounts[0].id;
  const today=new Date(Date.now()+19_800_000).toISOString().slice(0,10);const bought=new Date(Date.parse(`${today}T00:00:00Z`)-30*86400000).toISOString().slice(0,10);
  const response=await page.request.post('/api/mtf/positions',{headers:{origin:'http://127.0.0.1:5197','x-mtf-csrf':user.csrf,'idempotency-key':crypto.randomUUID()},data:{accountId,fundedInr:'6000',dailyFraction:'0.0004',position:{id:crypto.randomUUID(),symbol:'SYNTHETIC',boughtDate:bought,quantity:100,buyPriceInr:'100',interestPerDayInr:'2.40',otherChargesInr:'20',exitDate:null,manualPrice:{priceInr:'110',at:new Date().toISOString()}}}});expect(response.ok()).toBe(true);
  await page.goto('/#mtf');await page.getByRole('button',{name:'Details',exact:true}).click();const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Hold scenarios',exact:true}).click();await expect(dialog.getByText('Static-price hold scenarios', {exact:true})).toBeVisible();await expect(dialog.locator('tbody tr')).toHaveCount(5);
  await dialog.getByRole('button',{name:'Charges & reconciliation',exact:true}).click();await dialog.getByLabel('Service date',{exact:true}).fill(today);await dialog.getByLabel('Statement amount (₹, negative for refund)').fill('3');await dialog.getByLabel('Unique statement reference').fill('synthetic-e2e-charge');await dialog.getByLabel('I matched this amount to a broker statement.').check();await dialog.getByRole('button',{name:'Record statement charge',exact:true}).click();await expect(dialog.getByText('synthetic-e2e-charge',{exact:false})).toBeVisible();
  await dialog.getByRole('button',{name:'Transactions',exact:true}).click();await dialog.getByLabel('Effective date',{exact:true}).fill(today);await dialog.getByLabel('Transaction quantity').fill('40');await dialog.getByLabel('Sale fill price (₹)').fill('110');await dialog.getByLabel('Principal repaid (₹, optional)').fill('2400');await dialog.getByLabel('Transaction reason / reference').fill('Synthetic sale fill');await dialog.getByRole('button',{name:'Record transaction',exact:true}).click();await expect(dialog.getByText('Synthetic sale fill',{exact:false})).toBeVisible();
  await dialog.getByLabel('Transaction type').selectOption('CONVERT');await dialog.getByLabel('Effective date',{exact:true}).fill(today);await dialog.getByLabel('Transaction quantity').fill('60');await dialog.getByLabel('Principal repaid (₹, optional)').fill('3600');await dialog.getByLabel('Transaction reason / reference').fill('Synthetic delivery conversion');await dialog.getByRole('button',{name:'Record transaction',exact:true}).click();await expect(dialog.getByText('Synthetic delivery conversion',{exact:false})).toBeVisible();
  await dialog.getByRole('button',{name:'Audit history',exact:true}).click();await expect(dialog.getByText('Version 4',{exact:true})).toBeVisible();await dialog.getByRole('button',{name:'Close position details'}).click();await page.getByRole('tab',{name:'Converted',exact:true}).click();await expect(page.locator('.mtf-position-table tbody tr')).toHaveClass(/mtf-closed/);await expect(page.getByText(/0 open positions/)).toBeVisible();
});
