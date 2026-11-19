import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [browserPrefix, benchmarkDirectory, evidenceDirectory] = process.argv.slice(2);
assert(browserPrefix && benchmarkDirectory && evidenceDirectory,
  'Usage: node scripts/check-axis-replay-browser.mjs <temporary Playwright prefix> <benchmark directory> <new evidence directory>');
const browserRequire = createRequire(join(resolve(browserPrefix), 'package.json'));
const { chromium } = browserRequire('playwright');
const benchmark = resolve(benchmarkDirectory), evidence = resolve(evidenceDirectory);
const project = fileURLToPath(new URL('..', import.meta.url));
const read = async (...path) => JSON.parse(await readFile(join(...path), 'utf8'));
const summary = await read(benchmark, 'summary.json');
assert.equal(summary.passed, true);
await mkdir(evidence);
const cli = (command, workspace) => JSON.parse(execFileSync(join(project, 'bin/rtlarch'), [command, '--workspace', workspace, '--json'],
  { cwd: project, encoding: 'utf8' }));

const report = { build: summary.tools.frontendBuild, playwright: browserRequire('playwright/package.json').version,
  scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), cases: [] };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
report.chromium = browser.version();
try {
  for (const [id, width] of [['16-0', 1440], ['16-1', 1440], ['16-2', 1440], ['16-2', 1100], ['fault-skid-sideband', 1440]]) {
    const fault = id === 'fault-skid-sideband';
    const recordFile = fault ? summary.skidFault.record : summary.rows.find(r => r.id === id).nativeReplay.scenarios.find(s => s.tag === 'directed').record;
    const record = await read(benchmark, recordFile);
    const workspace = join(benchmark, fault ? id : `case-${id}`);
    const opened = cli('open', workspace);
    const viewport = { width, height: width === 1440 ? 1000 : 800 };
    const page = await browser.newPage({ locale: 'zh-CN', viewport });
    const errors = [];
    const entry = { id, viewport, buildId: opened.service.buildId, modelHash: record.modelHash, record: record.id, errors };
    report.cases.push(entry);
    page.on('pageerror', error => errors.push(String(error)));
    try {
      assert.equal(opened.service.buildId, report.build.sourceHash);
      await page.goto(opened.reviewUrl);
      await page.getByTestId('tab-replay').click();
      const replay = page.getByTestId('transaction-replay');
      await replay.getByRole('combobox', { name: '事务回放记录' }).selectOption(record.id);
      const detail = replay.getByTestId('replay-event-details');
      const slotCoverage = await replay.getByTestId('replay-slot-coverage').textContent();
      entry.topology = await replay.getByTestId('replay-topology').textContent();
      const findRow = edge => replay.getByRole('row').filter({ has: page.getByRole('button', { name: `E${edge}`, exact: true }) });
      const verifyState = async expected => {
        await page.locator(`.canvas-shell[data-state-id="${expected}"]`).waitFor();
        assert.equal(await page.getByRole('combobox', { name: '状态范围' }).inputValue(), expected);
        entry.locatedState = expected;
      };

      if (id === '16-0') {
        assert.match(slotCoverage, /峰值占用 0 槽.*复位期间同沿握手 1 次/);
        await replay.getByRole('button', { name: 'consume T0', exact: true }).click();
        assert.match(await detail.innerText(), /m_axis_tdata/);
        await detail.getByRole('button', { name: '在图中定位' }).click();
        assert.match(await page.getByTestId('current-object').innerText(), /m_axis_tdata/);
        await detail.getByRole('button', { name: '打开该对象的讨论' }).click();
        entry.discussionTarget = await page.getByTestId('discussion-target').innerText();
        assert.match(entry.discussionTarget, /m_axis_tdata/);
        await page.getByRole('textbox', { name: '你的问题' }).fill('旁路的输出何时与输入同沿消费？');
      } else if (id === '16-1') {
        assert.match(slotCoverage, /峰值占用 1 槽.*同沿接受与消费 0 次/);
        assert.match(await replay.getByTestId('replay-coverage').textContent(), /取消 1/);
        await replay.getByRole('button', { name: 'visible T0', exact: true }).click();
        await detail.getByRole('button', { name: '查看声明分支' }).click();
        await verifyState('m_axis_tdata_reg');
      } else if (fault) {
        assert.match(await replay.innerText(), /FAILED.*回放核对 FAILED/);
        const issue = findRow(35).getByText(/PAYLOAD_MISMATCH.*top\.m_axis_tdest_reg/);
        entry.issue = await issue.innerText();
        assert.match(entry.issue, /T7.*期望 182，观察 49/);
        await issue.getByRole('button', { name: '在图中定位' }).click();
        await verifyState('m_axis_tdest_reg');
      } else {
        assert.match(slotCoverage, /峰值占用 2 槽.*同沿消费 1 次/);
        assert.match(await replay.getByTestId('replay-coverage').textContent(), /取消 2/);
        await replay.getByRole('button', { name: 'store T7', exact: true }).click();
        await detail.getByRole('button', { name: '查看声明分支' }).click();
        await verifyState('temp_m_axis_tdata_reg');
        const transfer = findRow(35);
        await transfer.getByRole('button', { name: 'transfer T7', exact: true }).click();
        assert.equal(await transfer.getByRole('button', { name: 'consume T6', exact: true }).count(), 1);
        assert.match(await detail.innerText(), /dest\s+182/);
        await detail.getByRole('button', { name: '查看声明分支' }).click();
        await verifyState('m_axis_tdata_reg');
        await detail.getByRole('button', { name: '打开该对象的讨论' }).click();
        entry.discussionTarget = await page.getByTestId('discussion-target').innerText();
        assert.match(entry.discussionTarget, /m_axis_tdata_reg\/move_temp/);
      }
      assert.equal(await page.getByTestId('review-status').getAttribute('title'), record.modelHash);
      assert.match(await page.getByTestId('review-status').textContent(), /草稿/);
      assert.deepEqual(errors, []);
      entry.passed = true;
    } catch (error) {
      entry.error = String(error);
      await page.screenshot({ path: join(evidence, `${id}-${width}-failure.png`) });
      throw error;
    } finally {
      await page.close();
      cli('stop', workspace);
    }
  }
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'browser.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
