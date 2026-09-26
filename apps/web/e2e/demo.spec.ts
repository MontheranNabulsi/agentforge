import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function signInAsDemo(page: Page) {
  await page.goto('/login?demo=1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/o\//);
}

test('landing page and sign-in are accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI agents');
  const landing = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(landing.violations).toEqual([]);
  await page.goto('/login');
  const login = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(login.violations).toEqual([]);
});

test('a grounded answer streams in with citations and an execution timeline', async ({ page }) => {
  await signInAsDemo(page);
  await page.getByRole('link', { name: 'Support Knowledge Base' }).first().click();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox').fill('How fast must we respond to a Sev1 incident?');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/chat\/.+/);
  await expect(page.getByText('15 minutes').first()).toBeVisible();
  await expect(page.getByText('Sources')).toBeVisible();
  await expect(page.getByText('Retrieve knowledge')).toBeVisible();
});

test('an action that writes data waits for approval, then completes', async ({ page }) => {
  await signInAsDemo(page);
  await page.getByRole('link', { name: 'Support Knowledge Base' }).first().click();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox').fill(`Remember that the e2e check ran at ${Date.now()}`);
  await page.keyboard.press('Enter');
  await expect(page.getByText('waiting for approval')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/Saved the note/).first()).toBeVisible();
});

test('the run inspector and evaluations render', async ({ page }) => {
  await signInAsDemo(page);
  await page.getByRole('link', { name: 'Support Knowledge Base' }).first().click();
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await page.locator('a[href^="/runs/"]').first().click();
  await expect(page.getByText('Run inspector')).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'Evaluations', exact: true }).click();
  await expect(page.getByText('Core behaviours').first()).toBeVisible();
});
