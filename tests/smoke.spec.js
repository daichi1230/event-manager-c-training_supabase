import { test, expect } from '@playwright/test';

test('shows env warning when env is not configured in CI-like environment', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText('Supabase');
});
