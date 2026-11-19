import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [prefix,trialDir,output]=process.argv.slice(2);
assert(prefix&&trialDir&&output,'Usage: node scripts/check-axis-fifo-browser.mjs <Playwright prefix> <FIFO results> <new report.json>');
const root=fileURLToPath(new URL('..',import.meta.url));
const requireBrowser=createRequire(join(resolve(prefix),'package.json'));
const {chromium}=requireBrowser('playwright');
const summary=JSON.parse(await readFile(join(trialDir,'summary.json'),'utf8'));
const tool=(command,workspace)=>JSON.parse(execFileSync(join(root,'bin/rtlarch'),[command,'--workspace',workspace,'--json'],{cwd:workspace,encoding:'utf8'}));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const report={chromium:browser.version(),playwright:requireBrowser('playwright/package.json').version,cases:[]};
try{
 for(const [test,viewport] of [[summary.cases[1],{width:1440,height:1000}],[summary.fault,{width:1100,height:800}]]){
  const opened=tool('open',test.root);
  const page=await browser.newPage({locale:'zh-CN',viewport});
  const row={workspace:test.root,viewport,buildId:opened.service.buildId,modelHash:test.candidateHash,errors:[]};
  report.cases.push(row);page.on('pageerror',error=>row.errors.push(String(error)));
  try{
   assert.equal(row.buildId,test.buildId);
   await page.goto(opened.reviewUrl);
   const reading=page.getByTestId('reading-task-evidence');
   await reading.getByText('阅读路径 · 有步骤需核对',{exact:true}).click();
   const task=reading.locator('section').filter({hasText:'从写地址沿帧边界到输出'});
   await task.getByRole('button',{name:'帧提交边界',exact:true}).click();
   row.selected=await page.getByTestId('current-object').innerText();
   assert.match(row.selected,/wr_ptr_commit_reg/);
   const ram=task.getByRole('listitem').filter({hasText:'RAM 读入'});
   row.ram=await ram.innerText();assert.match(row.ram,/表达缺口/);
   await ram.getByRole('button',{name:'read_logic ↗'}).click();
   const dialog=page.getByRole('dialog',{name:'源码证据'});
   await dialog.getByText('rtl/axis_fifo.v:372',{exact:true}).waitFor();
   await dialog.getByRole('button',{name:'关闭',exact:true}).click();
   await page.getByTestId('tab-replay').click();
   const replay=page.getByTestId('transaction-replay'),capability=replay.getByTestId('replay-capability');
   assert.match(await capability.innerText(),/UNSUPPORTED.*RAM 帧 FIFO/);
   await replay.getByRole('combobox',{name:'回放语义'}).selectOption('registered_skid');
   row.supported=await capability.innerText();assert.match(row.supported,/NOT_DECLARED/);
   await replay.getByRole('combobox',{name:'回放语义'}).selectOption('addressed_frame_fifo');
   row.unsupported=await capability.innerText();assert.match(row.unsupported,/UNSUPPORTED/);
   await replay.getByRole('button',{name:'查看独立仿真证据'}).click();
   const record=replay.getByTestId('replay-independent-verification').getByRole('listitem').filter({hasText:test.simId});
   row.run=await record.innerText();assert.match(row.run,new RegExp(test.simulation));
   assert.match(row.run,/模型与输入仍匹配/);
   assert.equal(await page.getByTestId('review-status').getAttribute('title'),row.modelHash);
   assert.match(await page.getByTestId('review-status').innerText(),/草稿/);
   assert.deepEqual(row.errors,[]);row.passed=true;
  }catch(error){row.error=String(error);throw error;}
  finally{await page.close();tool('stop',test.root);}
 }
}finally{
 await browser.close();report.finishedAt=new Date().toISOString();
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
}
