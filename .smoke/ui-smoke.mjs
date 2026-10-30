import { chromium } from 'file:///C:/Users/xukunhang/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';

const base = process.argv[2] || 'http://127.0.0.1:7790/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

// 首次打开会弹使用引导，遮罩会挡住所有点击；先在同一个源上打标记
await page.addInitScript(() => { try { localStorage.setItem('localai-tour-done', '1'); } catch {} });
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(2500);

const tabs = ['dashboard', 'models', 'play', 'compare', 'bench', 'context', 'health', 'fix', 'tools', 'services', 'settings', 'help'];
for (const t of tabs) {
  const li = page.locator(`#tabs li[data-tab="${t}"]`);
  if (!(await li.count())) { console.log(`跳过（无此页）: ${t}`); continue; }
  await li.click();
  await page.waitForTimeout(450);
}

// 回归：快捷键不能吃掉输入框里的字符
await page.locator('#tabs li[data-tab="models"]').click();
await page.waitForTimeout(300);
const search = page.locator('#modelSearch');
if (await search.count()) {
  await search.click();
  await search.type('1234r', { delay: 40 });
  const val = await search.inputValue();
  console.log(`输入框内容 = ${JSON.stringify(val)}（期望 "1234r"）`);
  if (val !== '1234r') console.log('!! 快捷键吃掉了输入');
}

await page.locator('#tabs li[data-tab="dashboard"]').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: '.smoke/dashboard.png', fullPage: false });
await page.locator('#tabs li[data-tab="models"]').click();
await page.waitForTimeout(800);
await page.screenshot({ path: '.smoke/models.png' });
await page.locator('#tabs li[data-tab="play"]').click();
await page.waitForTimeout(800);
await page.screenshot({ path: '.smoke/play.png' });

console.log('--- 页面错误 ---');
console.log(errors.length ? errors.join('\n') : '（无）');
await browser.close();
