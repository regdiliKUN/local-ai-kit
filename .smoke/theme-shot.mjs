import { chromium } from 'file:///C:/Users/xukunhang/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const base = process.argv[2] || 'http://127.0.0.1:7790/';
const browser = await chromium.launch();
// 系统浅色 + 手动深色：这正是「组件级媒体查询没跟手动主题走」会翻车的组合
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
await page.addInitScript(() => {
  try { localStorage.setItem('localai-tour-done', '1'); localStorage.setItem('localai-theme', 'dark'); } catch {}
});
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(2500);
await page.screenshot({ path: '.smoke/dark-dashboard.png' });
for (const t of ['fix', 'models']) {
  await page.locator(`#tabs li[data-tab="${t}"]`).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `.smoke/dark-${t}.png` });
}
await browser.close();
