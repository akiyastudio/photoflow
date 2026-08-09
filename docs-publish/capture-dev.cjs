const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9335');
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith('http://localhost:5173'));
  if (!page) throw new Error('未找到照片流开发版页面');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);
  console.log((await page.locator('body').innerText()).slice(0, 12000));
  await page.screenshot({ path: 'C:\\dev\\app1\\docs-publish\\captures\\current.png', fullPage: false });
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
