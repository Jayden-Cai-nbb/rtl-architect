import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function selection(browserRequire, output) {
  const { chromium } = browserRequire('playwright');
  const out=resolve(output),temp=await mkdtemp(join(tmpdir(),'rtlarch-selection-browser-'));
  const cli=(...args)=>JSON.parse(execFileSync(join(root,'bin','rtlarch'),[...args,'--json'],{cwd:root,encoding:'utf8'}));
  const cases=[{width:1440,height:1000},{width:1100,height:800}];
  const report={cases:[]};
  const A='middle_tdata',B='boundary_m_axis_tdata';
  const edgeA='relation:stage0>stage1/payload/payload/payload/wire';
  const edgeB='relation:stage1>rack:top:producer/payload/payload/payload/wire';
  const stateId='stage0_valid_q',branchId='load';
  const urls=['checkpoint','module','panel','thread','connection'];
  const parameters=url=>Object.fromEntries([...new URL(url).searchParams].filter(([key])=>urls.includes(key)));
  let browser;

  async function request(service,path){
   const response=await fetch(new URL('/api/'+path,service.apiUrl),{headers:{'X-RTLArch-Workspace':service.workspaceId}});
   assert(response.ok,await response.clone().text());
   return response.json();
  }

  async function run(viewport){
   const workspace=join(temp,'workspace-'+viewport.width);
   await cp(join(root,'examples','external-axis'),workspace,{recursive:true});
   const modelFile=join(workspace,'architecture','model.json'),original=await readFile(modelFile);
   const errors=[];
   let open=cli('open','--workspace',workspace);
   const context=await browser.newContext({viewport,locale:'zh-CN'});
   let page=await context.newPage();
   const watch=p=>p.on('pageerror',error=>errors.push(error.message));
   watch(page);
   const work=()=>page.getByRole('region',{name:'讨论与继续',exact:true});
   const target=()=>page.getByTestId('discussion-target');
   const stateRange=()=>page.getByRole('combobox',{name:'状态范围',exact:true});
   const task=()=>page.getByRole('combobox',{name:'阅读任务',exact:true});
   const info=()=>page.getByTestId('selection-inspector');
   const question=()=>work().getByRole('textbox',{name:'你的问题',exact:true});
   const branch=()=>info().locator('[data-branch="load"][aria-current="true"]');
   const workPane=()=>page.locator('#work-dock');
   const wait=()=>page.waitForFunction(()=>document.querySelector('.react-flow__edge-path')&&!document.querySelector('.routing-status'));
   const snap=label=>page.screenshot({path:join(out,`${viewport.width}-${label}.png`),animations:'disabled'});
   const fit=async()=>{
    await page.locator('.react-flow__controls-fitview').click();
    // Fit can change the hint height and trigger a subsequent viewport resize.
    await page.waitForTimeout(220);
   };
   const geometry=()=>page.evaluate(()=>({
    nodes:[...document.querySelectorAll('.react-flow__node')].map(n=>[n.dataset.id,n.style.transform,n.offsetWidth,n.offsetHeight]),
    routes:[...document.querySelectorAll('.react-flow__edge-path')].map(e=>[e.id,e.getAttribute('d')]),
   }));
   async function clickEdge(id){
    const path=page.locator(`path.react-flow__edge-path[id=${JSON.stringify(id)}]`);
    const point=await path.evaluate(element=>{
     const length=element.getTotalLength(),matrix=element.getScreenCTM(),wrapper=element.closest('.react-flow__edge');
     for(let i=1;i<30;i++){
      const fraction=.5+((i%2?-1:1)*Math.floor(i/2))/30;
      const p=element.getPointAtLength(length*fraction).matrixTransform(matrix);
      if(document.elementFromPoint(p.x,p.y)?.closest('.react-flow__edge')===wrapper)return {x:p.x,y:p.y};
     }
    });
    assert(point,`edge ${id} is not under a usable pointer in the viewport`);
    await page.mouse.click(point.x,point.y);
    await page.waitForFunction(edge=>document.getElementById(edge)?.closest('.react-flow__edge')?.classList.contains('selected'),id);
   }
   async function chooseTask(value){
    await task().selectOption(value);
    await page.getByTestId('reading-projection').waitFor({state:value==='full'?'hidden':'visible'});
    await wait();
   }
   async function showsConnection(id){
    await page.getByTestId('signal-inspection').locator(`[data-connection-id="${id}"]`).waitFor();
    assert.equal(await page.getByTestId('current-object').innerText(),id);
   }
   async function title(value){
    await page.waitForFunction(v=>document.querySelector('[data-testid="discussion-target"]')?.textContent===v,value);
   }
   async function savedQuestion(text){
    await question().fill(text);
    await work().getByRole('button',{name:'保存问题',exact:true}).click();
    await work().locator('.thread-heading').getByText(text,{exact:true}).waitFor();
   }
   async function saveCheckpoint(intent,next){
    await work().getByRole('button',{name:'继续工作',exact:true}).click();
    await work().getByRole('textbox',{name:'工作目标',exact:true}).fill(intent);
    await work().getByRole('textbox',{name:'下一步',exact:true}).fill(next);
    await work().getByRole('button',{name:'保存继续位置',exact:true}).click();
    await work().getByText('下一步：'+next,{exact:true}).waitFor();
   }
   async function checkState(){
    await page.locator(`.canvas-shell[data-state-id="${stateId}"]`).waitFor();
    await wait();
    assert.equal(await task().inputValue(),'state');
    assert.equal(await stateRange().inputValue(),stateId);
   }
   const measurements=()=>page.evaluate(id=>{
    const area=document.querySelector('.canvas').getBoundingClientRect();
    const r=s=>document.querySelector(s)?.getBoundingClientRect();
    const hit=s=>{
     const e=document.querySelector(s),box=e?.getBoundingClientRect();
     return !!box?.height&&e.contains(document.elementFromPoint(box.x+box.width/2,box.y+Math.min(box.height/2,14)));
    };
    const body=[...document.querySelectorAll('.react-flow__node')].filter(n=>{
     const inner=n.querySelector('.main-module'),c=n.getBoundingClientRect(),x=c.x+c.width/2,y=c.y+c.height/2;
     return inner&&x>=area.left&&x<=area.right&&y>=area.top&&y<=area.bottom;
    }).map(n=>n.dataset.id);
    return {
     canvasHeight:area.height,dockHeight:r('#work-dock')?.height,
     questionHit:hit('[aria-label="你的问题"]'),discussionHit:hit('.thread-list .thread-heading strong'),
     branchHit:hit('[data-branch="load"][aria-current="true"] .state-rule-title strong'),
     selectedInView:body.includes('local:stage0:'+id),localNodesInView:body,overlay:!!document.querySelector('.modal-backdrop')
    };
   },stateId);

   try{
    const before=await request(open.service,'model');
    const home=new URL(open.reviewUrl);home.searchParams.set('panel','work');
    await page.goto(home.toString());await wait();await question().waitFor();
    await chooseTask('full');await fit();
    await clickEdge(edgeA);await showsConnection(A);await title('关于 '+A);
    await info().getByRole('button',{name:'对此提问',exact:true}).click();
    await savedQuestion('A 的独立讨论');
    await question().fill('A 的未发草稿');

    await chooseTask('overview');await fit();
    const projected=await geometry();
    await clickEdge(edgeB);await showsConnection(B);await title('关于 '+B);
    assert.deepEqual(await geometry(),projected);
    assert.equal(await question().inputValue(),'');
    assert.equal(await work().locator('.thread-list .thread-heading').getByText('A 的独立讨论',{exact:true}).count(),0);
    assert.equal(await info().getByText('模型连接',{exact:false}).count(),0);
    await info().getByText('连接来源与证据',{exact:true}).click();
    await info().getByText('模型连接',{exact:false}).waitFor();
    await info().getByText('连接来源与证据',{exact:true}).click();
    await info().getByRole('button',{name:'对此提问',exact:true}).click();
    await savedQuestion('B 的独立讨论');
    assert.deepEqual(await geometry(),projected);
    const asked=await request(open.service,'workbench');
    const savedB=asked.workbench.threads.find(t=>t.title==='B 的独立讨论');
    assert.deepEqual(savedB.target.selection,{modelHash:before.modelHash,scope:'top',instancePath:[{moduleId:'top'}],target:{kind:'relationship',members:[{kind:'connection',id:B}]}});
    assert.deepEqual(savedB.target.connectionIds,[B]);
    await clickEdge(edgeA);await title('关于 '+A);
    assert.equal(await question().inputValue(),'A 的未发草稿');
    await clickEdge(edgeB);await showsConnection(B);

    await info().getByRole('button',{name:'查看关联范围',exact:true}).click();
    await info().getByRole('button',{name:'再追一层',exact:true}).click();
    await info().getByText(/当前追踪 2 层/).waitFor();
    await title('关于 '+B);
    await info().getByRole('button',{name:'退出追踪',exact:true}).click();
    await page.getByTestId('reading-projection').waitFor();await wait();
    await title('关于 '+B);
    assert.deepEqual(await geometry(),projected);

    await info().getByRole('button',{name:'进入模块 · m_axis_tdata',exact:true}).click();
    await page.getByTestId('breadcrumb-stage1').waitFor();await showsConnection('stage1_data_q');
    await info().getByRole('button',{name:'到父层 · m_axis_tdata',exact:true}).click();
    await page.getByTestId('breadcrumb-stage1').waitFor({state:'hidden'});await showsConnection(B);await title('关于 '+B);
    await saveCheckpoint('核对 B 的跨层连线','恢复输出 B');
    const linkResume=cli('open','--workspace',workspace);
    assert(linkResume.checkpointRestored);
    assert.deepEqual(parameters(linkResume.reviewUrl),{checkpoint:'1',module:'top',connection:B,panel:'work'});
    await page.goto(linkResume.reviewUrl);await wait();await showsConnection(B);await title('关于 '+B);

    await page.getByTestId('tree-stage0').dblclick();await page.getByTestId('breadcrumb-stage0').waitFor();await wait();
    await stateRange().selectOption(stateId);
    await page.getByRole('button',{name:'查看状态范围',exact:true}).click();await checkState();
    await page.getByTestId('breadcrumb-top').click();await page.getByTestId('breadcrumb-stage0').waitFor({state:'hidden'});await wait();
    await page.getByTestId('tree-stage0').dblclick();await page.getByTestId('breadcrumb-stage0').waitFor();await checkState();
    await chooseTask('overview');await task().selectOption('state');await checkState();

    const stateGeometry=await geometry();
    await page.getByTestId('module-local:stage0:'+stateId).click();
    await info().getByRole('button',{name:'对此提问 update_branch '+branchId,exact:true}).click();
    await branch().waitFor();await title('关于 top/stage0 · '+stateId+'/'+branchId);
    await savedQuestion('有效位 load 的讨论');
    assert.deepEqual(await geometry(),stateGeometry);

    const slider=page.getByRole('separator',{name:'调整讨论面板高度',exact:true});
    const old=await workPane().evaluate(e=>e.getBoundingClientRect().height);
    const drag=await slider.boundingBox();assert(drag);
    await page.mouse.move(drag.x+drag.width/2,drag.y+drag.height/2);await page.mouse.down();
    await page.mouse.move(drag.x+drag.width/2,drag.y+drag.height/2+24,{steps:6});
    const sizeSaved=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/api/work-dock');
    await page.mouse.up();assert((await sizeSaved).ok());
    const remembered=await workPane().evaluate(e=>e.getBoundingClientRect().height);
    assert(Math.abs(old-remembered-24)<=1);
    await wait();
    assert.deepEqual(await geometry(),stateGeometry);

    await saveCheckpoint('核对有效位装载分支','在同一分支继续讨论');

    const firstBuild=open.service.buildId;
    await page.close();cli('stop','--workspace',workspace);
    open=cli('open','--workspace',workspace);
    const checkpoint=open.resume.workbench.checkpoint.target;
    assert(open.checkpointRestored);
    assert.deepEqual(parameters(open.reviewUrl),{checkpoint:'1',module:'stage0',panel:'work'});
    assert.deepEqual(checkpoint.selection,{modelHash:before.modelHash,scope:'stage0',instancePath:[{moduleId:'top'},{moduleId:'stage0'}],target:{kind:'local',id:stateId,branch:branchId}});
    assert.equal(checkpoint.object.id,branchId);
    assert.equal(open.service.buildId,firstBuild);
    page=await context.newPage();watch(page);
    await page.goto(open.reviewUrl);await branch().waitFor();await checkState();
    await title('关于 top/stage0 · '+stateId+'/'+branchId);
    const thread=work().locator('.work-thread').filter({has:page.getByText('有效位 load 的讨论',{exact:true})});
    await thread.waitFor();
    await page.waitForFunction(height=>Math.abs(document.getElementById('work-dock').getBoundingClientRect().height-height)<=1,remembered);
    await page.waitForFunction(()=>!document.querySelector('.routing-status')&&document.querySelector('.react-flow__node.selected'));
    const layout=await measurements();
    assert(layout.canvasHeight>=180,JSON.stringify(layout));
    assert(layout.questionHit&&layout.discussionHit&&layout.branchHit&&layout.selectedInView&&layout.localNodesInView.length>=2&&!layout.overlay,JSON.stringify(layout));
    await question().click();
    await page.keyboard.insertText('恢复后仍可同时看图、读分支和输入');
    assert.equal(await question().inputValue(),'恢复后仍可同时看图、读分支和输入');
    await snap('checkpoint');

    const threadUrl=await thread.getByRole('link',{name:'打开讨论',exact:true}).getAttribute('href');
    assert.equal(parameters(threadUrl).panel,'work');assert(parameters(threadUrl).thread);
    await page.goto(threadUrl);await branch().waitFor();await checkState();await title('关于 top/stage0 · '+stateId+'/'+branchId);
    await thread.waitFor();assert((await measurements()).questionHit);

    const after=await request(open.service,'model');
    assert.equal(after.modelHash,before.modelHash);assert.equal(after.reviewStatus,before.reviewStatus);
    assert.deepEqual(await readFile(modelFile),original);assert.deepEqual(errors,[]);
    return {viewport,buildId:open.service.buildId,modelHash:after.modelHash,reviewStatus:after.reviewStatus,
     completeConnection:A,overviewQuestion:savedB.target.selection,returnedState:stateId,checkpoint:checkpoint.selection,
     connectionCheckpointParams:parameters(linkResume.reviewUrl),checkpointParams:parameters(open.reviewUrl),threadParams:parameters(threadUrl),
     resized:{old,remembered},layout,errors};
   }catch(error){
    await snap('failure').catch(()=>{});
    await writeFile(join(out,`${viewport.width}-failure.json`),JSON.stringify({error:String(error),errors},null,2)+'\n');
    throw error;
   }finally{
    await context.close();
    cli('stop','--workspace',workspace);
   }
  }

  try{
   await mkdir(out);
   browser=await chromium.launch({headless:true,args:['--no-sandbox']});
   report.chromium=browser.version();
   for(const viewport of cases){
    report.cases.push(await run(viewport));
    await writeFile(join(out,'browser.json'),JSON.stringify(report,null,2)+'\n');
    console.log(`PASS ${viewport.width}×${viewport.height} · connections, exact state/branch, checkpoint and thread links, usable work dock`);
   }
  }finally{
   await browser?.close();
   await rm(temp,{recursive:true,force:true});
  }
}

async function axisRegister(browserRequire, benchmarkDirectory, evidenceDirectory) {
  const { chromium } = browserRequire('playwright');
  const benchmark = resolve(benchmarkDirectory), evidence = resolve(evidenceDirectory);
  const read = async (...path) => JSON.parse(await readFile(join(...path), 'utf8'));
  const summary = await read(benchmark, 'summary.json');
  assert.equal(summary.passed, true);
  await mkdir(evidence);
  const cli = (command, workspace) => JSON.parse(execFileSync(join(root, 'bin/rtlarch'), [command, '--workspace', workspace, '--json'],
    { cwd: root, encoding: 'utf8' }));

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
}

async function axisFifo(browserRequire, trialDir, output) {
  const { chromium } = browserRequire('playwright');
  const summary=JSON.parse(await readFile(join(trialDir,'summary.json'),'utf8'));
  const tool=(command,workspace)=>JSON.parse(execFileSync(join(root,'bin/rtlarch'),[command,'--workspace',workspace,'--json'],{cwd:workspace,encoding:'utf8'}));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const report={chromium:browser.version(),playwright:browserRequire('playwright/package.json').version,cases:[]};
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
}

const usage = [
  'npm run check:browser -- selection <Playwright prefix> <new evidence directory>',
  'npm run check:browser -- axis-register <Playwright prefix> <benchmark directory> <new evidence directory>',
  'npm run check:browser -- axis-fifo <Playwright prefix> <benchmark directory> <new report.json>',
].join('\n');
const [scenario, prefix, ...args] = process.argv.slice(2);
if (scenario === '--help') {
  console.log(usage);
} else {
  const scenarios = {
    selection: { run: selection, args: 1 },
    'axis-register': { run: axisRegister, args: 2 },
    'axis-fifo': { run: axisFifo, args: 2 },
  };
  assert(Object.hasOwn(scenarios, scenario) && prefix && args.length === scenarios[scenario].args, usage);
  const browserRequire = createRequire(join(resolve(prefix), 'package.json'));
  await scenarios[scenario].run(browserRequire, ...args);
}
