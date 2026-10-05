'use strict';
const path = require('node:path');
const { chromium } = require('playwright');
const { log, stamp } = require('./log');

const MSTR = 'https://ca-cluster1-2021-2.analytics.app.spscommerce.com/MicroStrategy/asp/Main.aspx';
const VENDOR_ANSWER = '2658181C443B8E5F7251838DFFE43896;2658181C443B8E5F7251838DFFE43896:6010';
const REPORT_URL = `${MSTR}?evt=3067&src=Main.aspx.3067&Server=default&project=DICKS%20SPORTING%20GOODS`
  + `&reportID=96A1CBBA4B43CCD10A9F44A3B0307EAA&reportViewMode=1&elementsPromptAnswers=${VENDOR_ANSWER}`;
// The Sales Trends dashboard, whose "Weekly Unit Sales Trend" tab has units per style per week.
const TREND_URL = `${MSTR}?evt=3140&src=Main.aspx.3140&Server=default&project=DICKS%20SPORTING%20GOODS`
  + `&documentID=56276AB646DCA4FF0112518C91E9B4ED&elementsPromptAnswers=${VENDOR_ANSWER}`;

// Recorded from the live portal on 2026-10-05. Opening the report while logged out redirects
// to https://analytics.spscommerce.com/Login. Signing in lands on /Home, which is a different host
// from the report: only the retailer link on /Home carries the session over to the report host.
const LOGIN = {
  email: '#Email',
  password: '#Password',
  submit: '#btnSubmit',
  retailerLink: 'DICKS SPORTING GOODS',
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
  // A wrong password stays on /Login, so this times out.
  await page.waitForURL((url) => url.pathname.toLowerCase() === '/home');
  await page.locator('a', { hasText: LOGIN.retailerLink }).filter({ visible: true }).first().click();
  await page.waitForLoadState('networkidle');
}

// Opens url (a prompt page), signing in first when the portal sends the browser to /Login.
async function openSignedIn(page, url, { email, password, failuresDir }) {
  if (!email || !password) throw new Error('SPS_EMAIL and SPS_PASSWORD must be set');
  await step(page, failuresDir, 'open report', () => page.goto(url));
  if (await step(page, failuresDir, 'open report', () => onLoginPage(page))) {
    await step(page, failuresDir, 'login failed', async () => {
      await login(page, email, password);
      await page.goto(url);
      if (await onLoginPage(page)) throw new Error('the login page came back after signing in');
    });
    log('logged in');
  }
}

async function withBrowser(work) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    context.setDefaultTimeout(60_000);
    return await work(context, await context.newPage());
  } finally {
    await browser.close();
  }
}

// MicroStrategy may deliver an export to a new window, so the file may arrive on another page.
function nextDownload(context, page, timeout) {
  return Promise.race([
    page.waitForEvent('download', { timeout }),
    context.waitForEvent('page', { timeout }).then((opened) => opened.waitForEvent('download', { timeout })),
  ]);
}

async function download({ email, password, rawDir, failuresDir }) {
  return withBrowser(async (context, page) => {
    await openSignedIn(page, REPORT_URL, { email, password, failuresDir });

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
      // The page title also reads "Export"; only the button under the prompts submits them.
      await page.getByRole('button', { name: 'Export', exact: true }).filter({ visible: true }).first().click();
      const target = (await popup) ?? page;
      await target.locator('input[name="exportFormatGrids"][value="csvIServer"]').waitFor();
      return target;
    });

    const file = await step(options, failuresDir, 'export', async () => {
      await options.locator('input[name="exportFormatGrids"][value="csvIServer"]').check();
      await options.locator('input[name="exportFilterDetails"][value="1"]').check();
      const pending = nextDownload(context, options, 120_000);
      await options.locator('input[name="3131"]').click();
      const dl = await pending;
      const target = path.join(rawDir, `download-${fileStamp()}.csv`);
      await dl.saveAs(target);
      return target;
    });
    log(`downloaded ${file}`);
    return file;
  });
}

async function waitWhileProcessing(page) {
  await page.waitForFunction(() => !/Processing Request/.test(document.body.innerText), null,
    { timeout: 600_000, polling: 3000 });
}

// from is M/D/YYYY. The dashboard's end date defaults to the last complete week.
async function downloadTrend({ email, password, from, rawDir, failuresDir }) {
  return withBrowser(async (context, page) => {
    await openSignedIn(page, TREND_URL, { email, password, failuresDir });

    await step(page, failuresDir, 'answer prompts', async () => {
      const addAll = page.locator('img[title="Add All"]').filter({ visible: true });
      await addAll.first().waitFor();
      await page.waitForLoadState('networkidle');
      // The first prompt takes one choice and already holds "Date Range"; fill the others.
      const count = await addAll.count();
      for (let i = count - 1; i >= 1; i--) await addAll.nth(i).click();
      await page.locator('input[value="Run Dashboard"]').filter({ visible: true }).first().click();
    });

    await step(page, failuresDir, 'enter start date', async () => {
      const start = page.locator('input[id^="id_mstr"][id$="_txt"]').filter({ visible: true }).first();
      await start.waitFor();
      await start.click();
      await start.pressSequentially(from, { delay: 50 });
      await start.press('Tab');
      await page.locator('input[value="Run Dashboard"]').filter({ visible: true }).first().click();
      await page.waitForLoadState('networkidle');
      await waitWhileProcessing(page);
    });

    await step(page, failuresDir, 'open weekly units tab', async () => {
      await page.getByText('Weekly Unit Sales Trend', { exact: true }).filter({ visible: true }).last().click();
      await waitWhileProcessing(page);
      await page.getByText('Weekly Unit Sales by Style', { exact: true }).filter({ visible: true }).first().waitFor();
    });

    const file = await step(page, failuresDir, 'export weekly units', async () => {
      await page.getByText('Weekly Unit Sales by Style', { exact: true }).filter({ visible: true }).first().hover();
      await page.locator('.hover-menu-btn.visible').first().click();
      await page.getByText('Export', { exact: true }).filter({ visible: true }).last().hover();
      const pending = nextDownload(context, page, 300_000);
      await page.getByText('Data', { exact: true }).filter({ visible: true }).last().click();
      const dl = await pending;
      const target = path.join(rawDir, `sales-trends-${fileStamp()}.csv`);
      await dl.saveAs(target);
      return target;
    });
    log(`downloaded ${file}`);
    return file;
  });
}

module.exports = { download, downloadTrend };
