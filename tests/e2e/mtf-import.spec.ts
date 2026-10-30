import { test, expect } from '@playwright/test';

test('MTF synthetic preview, correction, confirmation and audit download stay local', async ({ page }) => {
  const outgoing: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') outgoing.push(request.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'MTF Import', exact: true }).click();
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await expect(page.getByRole('heading', { name: 'Import preview: 9 candidate rows' })).toBeVisible();
  await expect(page.getByText(/3 rows with invalid chronology/)).toBeVisible();
  await page.screenshot({ path: '/tmp/tradelens-mtf-import-synthetic.png', fullPage: true });
  await page.getByRole('button', { name: 'Record 9: SYN-LOT-8', exact: true }).click();
  await page.getByLabel('Correction field').selectOption('exitDate');
  await page.getByLabel('Corrected value').fill('08/25/2025');
  await page.getByLabel('Correction reason').fill('Correct synthetic exit date');
  await page.getByRole('button', { name: 'Record correction', exact: true }).click();
  await expect(page.getByText(/2 rows with invalid chronology/)).toBeVisible();
  await expect(page.getByText(/Correct synthetic exit date/)).toBeVisible();
  await page.getByLabel('Selection for record 9').selectOption('REVIEW');
  await page.getByRole('button', { name: 'Confirm selected rows locally' }).click();
  await expect(page.getByRole('status')).toContainText('Confirmed 1 rows locally');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download private audit' }).click();
  expect((await download).suggestedFilename()).toBe('mtf-private-audit.json');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'MTF Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import preview: 9 candidate rows' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Confirmed 1 rows locally');
  expect(outgoing).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('SYN-LOT');
});

test('MTF browser CSV upload requires explicit metadata and handles missing prices', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'MTF Import', exact: true }).click();
  await page.getByLabel('Account label', { exact: true }).fill('Synthetic local account');
  await page.getByLabel('Broker label', { exact: true }).fill('Synthetic broker');
  await page.getByLabel('Snapshot date', { exact: true }).fill('2025-08-31');
  await page.getByLabel('Positions CSV (max 1 MiB)').setInputFiles({ name: 'misleading-old-date.csv', mimeType: 'text/csv', buffer: Buffer.from('Scrip,Buy Date,Buy Price,No of Shares,Current Price\nSYN-UPLOAD,08/01/2025,50,10,#N/A') });
  await page.getByRole('button', { name: 'Preview CSV', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import preview: 1 candidate rows' })).toBeVisible();
  await expect(page.getByText(/Snapshot 2025-08-31/)).toBeVisible();
  await page.getByLabel('Selection for record 2').selectOption('ACCEPT_UNVERIFIED');
  await page.getByRole('button', { name: 'Confirm selected rows locally' }).click();
  await expect(page.getByRole('status')).toContainText('No trades or portfolio totals were created');
  await page.getByRole('button', { name: 'Clear local data' }).click();
  await expect(page.getByRole('heading', { name: /Import preview:/ })).toHaveCount(0);
});

test('MTF malformed upload has a visible error and no partial preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'MTF Import', exact: true }).click();
  await page.getByLabel('Account label', { exact: true }).fill('Synthetic account');
  await page.getByLabel('Broker label', { exact: true }).fill('Synthetic broker');
  await page.getByLabel('Snapshot date', { exact: true }).fill('2025-08-31');
  await page.getByLabel('Positions CSV (max 1 MiB)').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('Scrip,"unterminated') });
  await page.getByRole('button', { name: 'Preview CSV', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('MALFORMED_CSV');
  await expect(page.getByRole('heading', { name: /Import preview:/ })).toHaveCount(0);
});

test('MTF preview is usable at mobile width without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'MTF Import', exact: true }).click();
  await page.getByRole('button', { name: 'Load synthetic example' }).click();
  await expect(page.getByRole('heading', { name: 'Import preview: 9 candidate rows' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Clear local data' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Local import data cleared');
});
