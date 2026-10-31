import { test, expect } from "@playwright/test";
test("rollover dashboard opens directly, filters, sorts, exports and preserves method labels", async ({
  page,
}) => {
  await page.goto("/rollovers");
  await expect(
    page.getByRole("heading", { name: "Futures rollover", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("DEMO · SYNTHETIC DATA", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".roll-stock-table tbody tr")).toHaveCount(6);
  await expect(page.getByLabel("Rollover expiry month")).toHaveValue("2026-09");
  await page.getByLabel("Find rollover symbol").fill("ALPHA");
  await expect(page.locator(".roll-stock-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "All metrics", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: /Basis %/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: /Roll spread %/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Rollover % ↕", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  expect((await download).suggestedFilename()).toBe(
    "rollovers-DEMO-2026-09.csv",
  );
  await page.getByRole("button", { name: "DEMO-ALPHA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Exact contract inputs" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("img", { name: "Six-month next–near roll spread" }),
  ).toBeVisible();
  await expect(dialog.getByText(/rollover-v1/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close rollover details" }).click();
  await page.screenshot({
    path: "/tmp/tradelens-rollovers-desktop.png",
    fullPage: true,
  });
});
test("older months, incomplete rows, matrix gaps and source milestones remain visible", async ({
  page,
}) => {
  await page.goto("/rollovers");
  await expect(page.locator(".roll-stock-table tbody tr")).toHaveCount(6);
  await page.getByLabel("Rollover expiry month").selectOption("2026-10");
  await page.getByLabel("Data coverage").selectOption("only");
  await expect(page.locator(".roll-stock-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".roll-stock-table tbody tr")).toContainText(
    "Needs review",
  );
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.getByLabel("Rollover expiry month").selectOption("2026-06");
  await page
    .getByRole("tab", { name: "Six-month matrix", exact: true })
    .click();
  await expect(
    page.getByRole("columnheader", { name: "Mar 2026", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".roll-results tbody tr").first()).toContainText(
    "—",
  );
  await page.getByLabel("Matrix metric").selectOption("spread");
  await page.getByRole("tab", { name: "Sectors", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Financials", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Source status", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Fixture mode · real import and automation disabled",
    }),
  ).toBeVisible();
  await page.getByLabel("Rollover expiry month").selectOption("2026-11");
  await expect(page.locator(".roll-warning")).toContainText("MISSING");
});
test("rollover mobile view contains table scrolling and browser navigation works", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/rollovers");
  await expect(page.locator(".roll-stock-table tbody tr")).toHaveCount(6);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/tradelens-rollovers-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Market overview", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Futures rollover", exact: true }),
  ).toBeVisible();
});
test("rollover API errors are shown with a working retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/rollovers?*", async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic source unavailable" }),
      });
    else await route.continue();
  });
  await page.goto("/rollovers");
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic source unavailable",
  );
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".roll-stock-table tbody tr")).toHaveCount(6);
});
