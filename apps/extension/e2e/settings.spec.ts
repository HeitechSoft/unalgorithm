import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

/** Clicks the field the way a person would (by position) and types, so a field hidden by CSS fails the test. */
async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await expect(field).toBeVisible();
  const box = await field.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(150);
  if (!box) return;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
  await expect(field).toHaveValue(text);
}

test('AI setup: the API key and server fields can be clicked and typed into', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html#/ai`);

  await page.getByText('Your own API key', { exact: true }).click();
  await typeInto(page, page.getByLabel('API key', { exact: true }), `sk-ant-api03-${'x'.repeat(24)}`);
  await expect(page.getByText('Recognized as Anthropic (Claude).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test and save' })).toBeEnabled();

  await page.getByText('Local or self-hosted', { exact: true }).click();
  await typeInto(page, page.getByLabel('Address', { exact: true }), 'http://localhost:11434/v1');
});
