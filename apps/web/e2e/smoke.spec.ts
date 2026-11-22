import { prisma } from '@app/db';
import { expect, test } from '@playwright/test';
import { createSeedSession, deleteE2eSessions, SESSION_COOKIE } from './session';

test.beforeEach(async ({ context, baseURL }) => {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required (run with dotenv -e ../../.env)');
  const { cookieValue } = await createSeedSession(secret);
  await context.addCookies([
    { name: SESSION_COOKIE, value: cookieValue, url: baseURL!, httpOnly: true, sameSite: 'Lax' },
  ]);
});

test.afterAll(async () => {
  await deleteE2eSessions();
  await prisma.$disconnect();
});

test('signed-out users are sent to sign-in', async ({ browser, baseURL }) => {
  const page = await (await browser.newContext({ baseURL })).newPage();
  await page.goto('/repos');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});

test('login (mocked) → repo → PR → completed review renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Repositories' })
    .click();
  await page.getByRole('link', { name: 'acme/web', exact: true }).click();
  await expect(page).toHaveURL(/\/repos\/seed_repo_web\/pulls$/);

  await page.getByRole('link', { name: /feat\(auth\): refresh sessions/ }).click();
  await expect(page.getByRole('heading', { name: 'feat(auth): refresh sessions' })).toBeVisible();

  // The seed has one review per status; pick the completed one from the history.
  const history = page.getByRole('complementary', { name: 'Review history' });
  await history.getByRole('button', { name: /Completed/ }).click();

  await expect(page.getByText('Review completed')).toBeVisible();
  await expect(page.getByLabel('Risk score')).toHaveText('64');
  await expect(page.getByText('High risk')).toBeVisible();
  await expect(page.getByText('Stale review.')).toBeVisible();
  await expect(page.getByText('SQL built from user input')).toBeVisible();

  // Clicking an issue jumps to the Changed Files tab at that line.
  await page.getByRole('link', { name: /SQL built from user input/ }).click();
  await expect(page).toHaveURL(/tab=files/);
  const row = page.locator('#diff-src_auth_session_ts-R31');
  await expect(row).toHaveAttribute('data-has-issue', 'true');
  await expect(page.getByRole('list', { name: 'Issues on line 31' })).toBeVisible();
});

test('every review state renders from seed data', async ({ page }) => {
  await page.goto('/repos/seed_repo_web/pulls/42');
  const history = page.getByRole('complementary', { name: 'Review history' });
  const cases: [RegExp, string | RegExp][] = [
    [/Queued/, 'Waiting to start'],
    [/Running/, /Reviewed 5 of 12 files/],
    [/Waiting for Action/, 'Waiting for your GitHub Action'],
    [/Completed/, 'Review completed'],
    [/Failed/, "Your GitHub Action didn't send a result."],
  ];
  for (const [chip, text] of cases) {
    await history.getByRole('button', { name: chip }).click();
    await expect(page.getByText(text).first()).toBeVisible();
  }
});

test('Branches link → branch tree of the seed repo renders; PR links back into it', async ({
  page,
}) => {
  await page.goto('/repos');
  await page.getByRole('link', { name: 'Branches of acme/web' }).click();
  await expect(page).toHaveURL(/\/repos\/seed_repo_web\/tree$/);
  await expect(page.getByRole('link', { name: 'Branches', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: 'Repository tree' })).toBeVisible();
  for (const branch of ['main', 'dev', 'feature/login'])
    await expect(page.locator(`[data-branch="${branch}"]`)).toBeVisible();

  // A search in the URL shows only the matches and their compare-with ancestors.
  await page.goto('/repos/seed_repo_web/pulls/42');
  await page.getByRole('link', { name: 'Show in branch tree' }).click();
  await expect(page).toHaveURL(/\/repos\/seed_repo_web\/tree\?q=/);
  await expect(page.getByRole('heading', { name: 'Repository tree' })).toBeVisible();
});

test('settings, setup and connections pages render', async ({ page }) => {
  await page.goto('/repos/seed_repo_web/settings');
  await expect(page.getByRole('form', { name: 'Review settings' })).toBeVisible();
  await expect(page.getByLabel('Provider')).toHaveValue('platform');

  await page.goto('/repos/seed_repo_web/setup');
  await expect(page.getByRole('heading', { name: 'Choose the AI reviewer' })).toBeVisible();

  await page.goto('/settings/connections');
  await expect(page.getByRole('link', { name: 'Sign in with ChatGPT' })).toBeVisible();
});
