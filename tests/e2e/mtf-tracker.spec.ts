import { test, expect } from '@playwright/test';

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
  await expect(row).toContainText('30 days'); await expect(row).toContainText('100.9200'); await expect(row).toContainText('908.00');
  await expect(row.locator('.up')).toHaveCount(2);
  await page.screenshot({ path: '/tmp/tradelens-manual-mtf.png', fullPage: true });
  await page.reload(); await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(row).toContainText('SYNTHETIC');
  await expect(page.getByRole('button', { name: 'Mark exited', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: /Exit date/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit SYNTHETIC', exact: true }).click();
  await page.getByLabel('Exit date (optional)', { exact: true }).fill(today);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByLabel('Exit date (optional)', { exact: true })).toHaveCount(0);
  await expect(row).toHaveClass(/mtf-closed/); await expect(row).toContainText('EXITED');
  await expect(page.getByText(/0 open positions/)).toBeVisible();
  await page.getByRole('button', { name: 'Edit SYNTHETIC', exact: true }).click();
  await page.getByLabel('Exit date (optional)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(row).not.toHaveClass(/mtf-closed/);
});

test('MTF refreshes quotes every 150 seconds without sending quantity or financial inputs', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/mtf/quotes', async route => {
    const payload = route.request().postDataJSON(); expect(payload).toEqual({ symbols: ['SYNTHETIC'] }); calls++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ quotes: [{ symbol: 'SYNTHETIC', priceInr: calls === 1 ? '110' : '90', marketAt: new Date().toISOString(), source: 'Synthetic E2E adapter', mode: 'DELAYED' }], unavailable: [] }) });
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('tradelens-manual-mtf-v1', JSON.stringify({ version: 1, positions: [{ id: 'synthetic', symbol: 'SYNTHETIC', boughtDate: '2026-01-01', quantity: 100, buyPriceInr: '100', interestPerDayInr: '0', otherChargesInr: '0', exitDate: null, manualPrice: null }] })));
  await page.reload(); await page.clock.install();
  await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(page.locator('.mtf-position-table tbody tr')).toContainText('1,000.00');
  await page.clock.runFor(150_100);
  await expect(page.locator('.mtf-position-table tbody tr .down')).toHaveCount(2);
  expect(calls).toBeGreaterThanOrEqual(2);
});

test('MTF corrupt saved work is not overwritten', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => localStorage.setItem('tradelens-manual-mtf-v1', '{broken'));
  await page.reload(); await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('has not been overwritten');
  await expect(page.getByRole('button', { name: 'Add position', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('tradelens-manual-mtf-v1'))).toBe('{broken');
});

test('manual MTF remains usable on mobile without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'MTF Tracker', exact: true }).click();
  await expect(page.getByLabel('Scrip symbol', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByText('Synthetic market data.', { exact: false })).not.toBeVisible();
});
