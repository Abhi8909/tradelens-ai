import { test, expect } from '@playwright/test';

test('research workflow shows grounded citations and contrary evidence', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Research assistant', exact: true }).click();
  await page.getByLabel('Hypothesis', { exact: true }).fill('Synthetic prices may rise; examine contrary observations.');
  await page.getByRole('button', { name: 'Research thesis' }).click();
  await expect(page.getByText(/Evidence for DEMO-ALPHA/)).toBeVisible();
  await expect(page.getByText('Synthetic data; not real market evidence.')).toBeVisible();
  await expect(page.getByText(/Citation: .*:trend/)).toBeVisible();
  await expect(page.getByText(/Input data version/)).toBeVisible();
  await page.getByLabel('Research action').selectOption('argue-against');
  await page.getByRole('button', { name: 'Research thesis' }).click();
  await expect(page.getByText(/Evidence for DEMO-ALPHA/)).toBeVisible();
  await expect(page.getByText(/Descriptive calculations only/)).toBeVisible();
});

test('research failure is visible and clears the earlier report', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Research assistant', exact: true }).click();
  await page.getByLabel('Hypothesis', { exact: true }).fill('Review this hypothesis');
  await page.getByRole('button', { name: 'Research thesis' }).click();
  await expect(page.getByText(/Evidence for DEMO-ALPHA/)).toBeVisible();
  await page.route('**/api/research', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Research unavailable' }) }));
  await page.getByRole('button', { name: 'Research thesis' }).click();
  await expect(page.getByRole('alert')).toHaveText('Research unavailable');
  await expect(page.getByText(/Evidence for DEMO-ALPHA/)).toHaveCount(0);
});
