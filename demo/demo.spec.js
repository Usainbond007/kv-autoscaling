import {test, expect} from '@playwright/test';

test('fresh evidence and synchronized interaction', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173');
  await expect(page.getByRole('heading', {name: 'Compare scaling policies.'})).toBeVisible();
  await expect(page.locator('#results table tbody tr')).toHaveCount(2);
  await expect(page.locator('#results table tbody tr').first()).toContainText('800');
  await expect(page.locator('#results table tbody tr').last()).toContainText('666');
  await expect(page.locator('#results table')).not.toContainText('p99');
  await expect(page.locator('.charts svg:visible')).toHaveCount(4);
  await expect(page.getByText('KV-cache and queue diagnostics')).toBeVisible();
  await page.locator('#sample').fill('14');
  await expect(page.locator('output')).toHaveText('1:10');
  await expect(page.locator('.timestamps')).toContainText('10:06:56 UTC');
  await page.getByText('KV-cache and queue diagnostics').click();
  await expect(page.locator('.charts svg:visible')).toHaveCount(6);
  await expect(page.locator('.diagnostics')).toContainText('0.285 s for both policies');

  for (const link of await page.locator('a[href^="/evidence/fresh/"]').all()) {
    const response = await page.request.get(await link.getAttribute('href'));
    expect(response.ok()).toBeTruthy();
  }

  await page.screenshot({path: 'desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  for (const button of await page.locator('button').all()) {
    const box = await button.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({path: 'mobile.png', fullPage: true});
  expect(errors).toEqual([]);
});
