'use strict';
const path = require('node:path');
const { chromium } = require('playwright');
const { log, stamp } = require('./log');

const REPORT_URL = 'https://ca-cluster1-2021-2.analytics.app.spscommerce.com/MicroStrategy/asp/Main.aspx'
  + '?evt=3067&src=Main.aspx.3067&Server=default&project=DICKS%20SPORTING%20GOODS'
  + '&reportID=96A1CBBA4B43CCD10A9F44A3B0307EAA&reportViewMode=1'
  + '&elementsPromptAnswers=2658181C443B8E5F7251838DFFE43896;2658181C443B8E5F7251838DFFE43896:6010';

// Recorded from the live login page on 2026-10-05. Opening the report while logged out redirects
// to https://analytics.spscommerce.com/Login, a different host from the report.
const LOGIN = {
  email: '#Email',
  password: '#Password',
  submit: '#btnSubmit',
};

const fileStamp = () => `${stamp().replace(/[: ]/g, '-')}-${String(Date.now() % 1000).padStart(3, '0')}`;

async function step(page, failuresDir, name, fn) {
  try {
    return await fn();
  } catch (err) {
    const shot = path.join(failuresDir, `${fileStamp()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    throw new Error(`${name} (${String(err.message).split('\n')[0]}; screenshot ${shot})`);
  }
}

async function onLoginPage(page) {
  await page.locator(`img[title="Add All"], ${LOGIN.email}`).filter({ visible: true }).first().waitFor();
  return page.locator(LOGIN.email).first().isVisible();
}

async function login(page, email, password) {
  await page.locator(LOGIN.email).fill(email);
  await page.locator(LOGIN.password).fill(password);
  await page.locator(LOGIN.submit).click();
  await page.waitForURL((url) => !url.pathname.toLowerCase().startsWith('/login'));
}

async function download({ email, password, rawDir, failuresDir }) {
  if (!email || !password) throw new Error('SPS_EMAIL and SPS_PASSWORD must be set');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    context.setDefaultTimeout(60_000);
    const page = await context.newPage();

    await step(page, failuresDir, 'open report', () => page.goto(REPORT_URL));
    if (await step(page, failuresDir, 'open report', () => onLoginPage(page))) {
      await step(page, failuresDir, 'login failed', async () => {
        await login(page, email, password);
        await page.goto(REPORT_URL);
        if (await onLoginPage(page)) throw new Error('the login page came back after signing in');
      });
      log('logged in');
    }

    await step(page, failuresDir, 'answer prompts', async () => {
      const addAll = page.locator('img[title="Add All"]').filter({ visible: true });
      await addAll.first().waitFor();
      await page.waitForLoadState('networkidle');
      const count = await addAll.count();
      for (let i = 0; i < count; i++) await addAll.nth(i).click();
      log(`answered ${count} prompts`);
    });

    // Export Options may open in a popup or in the same page; use whichever appears.
    const options = await step(page, failuresDir, 'open export options', async () => {
      const popup = page.waitForEvent('popup', { timeout: 10_000 }).catch(() => null);
      await page.locator('text="Export" >> visible=true').first().click();
      const target = (await popup) ?? page;
      await target.locator('input[name="exportFormatGrids"][value="csvIServer"]').waitFor();
      return target;
    });

    const file = await step(options, failuresDir, 'export', async () => {
      await options.locator('input[name="exportFormatGrids"][value="csvIServer"]').check();
      await options.locator('input[name="exportFilterDetails"][value="1"]').check();
      // MicroStrategy can send the export to a new window, so the file may arrive on another page.
      const pending = Promise.race([
        options.waitForEvent('download', { timeout: 120_000 }),
        context.waitForEvent('page', { timeout: 120_000 })
          .then((opened) => opened.waitForEvent('download', { timeout: 120_000 })),
      ]);
      await options.locator('input[name="3131"]').click();
      const dl = await pending;
      const target = path.join(rawDir, `download-${fileStamp()}.csv`);
      await dl.saveAs(target);
      return target;
    });
    log(`downloaded ${file}`);
    return file;
  } finally {
    await browser.close();
  }
}

module.exports = { download };
