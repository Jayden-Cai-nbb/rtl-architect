import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [browserPrefix, caseRoot, rtlarch, output] = process.argv.slice(2);
assert(browserPrefix && caseRoot && rtlarch && output,
  'Usage: node browser.mjs <Playwright prefix> <trial case root> <rtlarch entry> <new report.json>');
const requireBrowser = createRequire(join(resolve(browserPrefix), 'package.json'));
const { chromium } = requireBrowser('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const report = { chromium: browser.version(), playwright: requireBrowser('playwright/package.json').version, cases: [] };
const viewport = { width: 1440, height: 1000 };
const cli = (command, workspace) => JSON.parse(execFileSync(resolve(rtlarch), [command, '--workspace', workspace, '--json'],
  { cwd: workspace, encoding: 'utf8', timeout: 30000 }));
try {
  for (const name of ['16-1', 'fault-16-frame']) {
    const workspace = resolve(caseRoot, name);
    const measured = JSON.parse(await readFile(join(workspace, 'summary.json'), 'utf8'));
    const fault = name.startsWith('fault');
    const opened = cli('open', workspace);
    const page = await browser.newPage({ locale: 'zh-CN', viewport });
    const evidence = { workspace, viewport, buildId: opened.service.buildId, modelHash: measured.review.candidateHash, errors: [] };
    report.cases.push(evidence);
    page.on('pageerror', error => evidence.errors.push(String(error)));
    try {
      assert.equal(opened.service.buildId, measured.review.buildId);
      await page.goto(opened.reviewUrl);
      await page.getByRole('combobox', { name: '状态范围' }).selectOption('wr_ptr_commit_reg');
      await page.getByRole('button', { name: '查看状态范围', exact: true }).click();
      await page.locator('.canvas-shell[data-state-id="wr_ptr_commit_reg"]').waitFor();
      evidence.selected = await page.getByTestId('current-object').innerText();
      assert.match(evidence.selected, /wr_ptr_commit_reg/);
      const local = page.getByTestId('local-signal-detail');
      evidence.branch = await local.locator('[data-branch="publish"] strong').innerText();
      await local.getByText('驱动声明与来源', { exact: true }).click();
      await local.getByRole('button', { name: 'write_logic ↗' }).click();
      const source = page.getByRole('dialog', { name: '源码证据' });
      const hashMessage = fault ? '文件已变化' : '文件 SHA-256 与记录一致';
      const sourceStatus = source.getByText(hashMessage, { exact: !fault });
      await sourceStatus.waitFor();
      evidence.sourceStatus = await sourceStatus.innerText();
      await source.getByRole('button', { name: '关闭', exact: true }).click();

      await page.getByTestId('reading-projection').getByText('核验记录与语义缺口', { exact: true }).click();
      const history = page.getByTestId('reading-evidence');
      await history.getByText('全部状态与行为证据', { exact: true }).click();
      const run = history.getByText(`${measured.simulation.id} · ${measured.simulation.status} · 输入仍匹配`, { exact: true });
      await run.waitFor();
      evidence.verifyRun = await run.innerText();
      await page.getByTestId('tab-replay').click();
      const replay = page.getByTestId('transaction-replay').getByText(/尚无可读回放/);
      evidence.replayText = await replay.innerText();
      assert.match(evidence.replayText, /声明事务路径后/);
      assert.equal(await page.getByTestId('review-status').getAttribute('title'), evidence.modelHash);
      evidence.approval = await page.getByTestId('review-status').innerText();
      assert.equal(evidence.approval, '草稿');
      assert.deepEqual(evidence.errors, []);
      evidence.passed = true;
    } catch (error) {
      evidence.error = String(error);
      throw error;
    } finally {
      await page.close();
      cli('stop', workspace);
    }
  }
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag:'wx' });
}
