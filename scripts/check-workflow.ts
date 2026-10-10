import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {toolRoot,toolVersion} from '../src/workspace/environment';
import {modelSchema} from '../src/core/schema';
import {sourceBuildId} from '../src/workspace/build';
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-workflow-')),bin=join(toolRoot,'bin/rtlarch'),begin=performance.now();
const env={...process.env};delete env.RTLARCH_API_PORT;delete env.RTLARCH_WORKSPACE;
let cliCalls=0;const timings:Record<string,number>={};
async function cli(args:string[]){cliCalls++;const r=await exec(bin,[...args,'--workspace',root,'--json'],{env,timeout:210000,maxBuffer:16*1024*1024});const data=JSON.parse(r.stdout);assert.equal(data.ok,true);return data;}
let url='';
async function post(path:string,body:unknown){const response=await fetch(`${url}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
try{
 await cp(join(toolRoot,'examples/rtl-intake'),root,{recursive:true});
 const opened=await cli(['open','--init']);url=opened.service.apiUrl;assert.equal(opened.service.buildId,await sourceBuildId());
 const initial=await cli(['context']);assert.equal(initial.model.clocks.length,0);assert.equal(initial.model.modules[0].timing,'unknown');
 const yosys=await exec('yosys',['-Q','-T','-p','read_verilog -sv rtl/stage.sv rtl/stream_top.sv; hierarchy -top stream_top; proc; write_json netlist.json'],{cwd:root,env,timeout:30000,maxBuffer:4*1024*1024});
 await writeFile(join(root,'elaboration.log'),yosys.stdout+yosys.stderr);
 const imported=await cli(['import-yosys',join(root,'inputs.json'),join(root,'intake')]);
 const draft=await cli(['draft',imported.modelFile,join(root,'first-proposal.json'),'--open']);
 timings.firstCandidateMs=Math.round(performance.now()-begin);
 const registered=await (await fetch(`${url}/api/proposals/${draft.proposalId}`)).json();
 assert.equal(registered.preview.candidate.provenance.fidelity,'partial');
 const committed=await post('commit',{proposal:registered.proposal,candidateHash:registered.candidateHash}); // Simulated human save, isolated fixture only.
 let work=await cli(['workbench']);
 const model=modelSchema.parse(committed.model),module=model.modules.find(m=>m.parent===model.design.top)!;
 async function action(action:unknown){const f=join(root,'work-action.json');await writeFile(f,JSON.stringify({baseHash:work.workbenchHash,action}));work=await cli(['workbench',f]);return work;}
 await action({kind:'ask',title:'为什么分成两级？',text:'是否每一级都寄存，复位期间有效位如何清除？',target:{modelHash:committed.modelHash,moduleId:module.id,connectionIds:[]}});
 const threadId=work.workbench.threads[0].id,context=await cli(['context','--module',module.id]);
 assert.equal(context.collaboration.threads[0].id,threadId);
 const proposal={baseHash:committed.modelHash,reason:'依据源码说明第一级职责，保留时序缺口',commands:[{op:'rename_module',moduleId:module.id,name:'第一级：输入加一并寄存'}]};
 const file=join(root,'clarify.json');await writeFile(file,JSON.stringify(proposal));const candidate=await cli(['propose',file]);
 await action({kind:'reply',threadId,author:'agent',modelHash:committed.modelHash,text:'stage.sv 在上升沿寄存数据与 valid；低有效同步复位清零。两级的角色名称在候选中说明，完整周期合同仍待核对。',proposalId:candidate.id});
 await action({kind:'checkpoint',intent:'核对两级处理的时序与复位',nextStep:'阅读答复，检查候选，再核对原 RTL 仿真记录',target:{modelHash:candidate.candidateHash,moduleId:module.id,connectionIds:[],proposalId:candidate.id}});
 const restartStart=performance.now();await cli(['stop']);const reopened=await cli(['open']);url=reopened.service.apiUrl;
 assert.equal(new URL(reopened.reviewUrl).searchParams.get('proposal'),candidate.id);assert.equal(new URL(reopened.reviewUrl).searchParams.get('module'),module.id);assert.equal(reopened.resume.workbench.threads[0].messages.length,2);assert.equal(reopened.resume.workbench.checkpoint.intent,'核对两级处理的时序与复位');
 timings.resumeAfterRestartMs=Math.round(performance.now()-restartStart);
 const startRun=performance.now(),run=await cli(['verify',join(root,'verify.json')]);assert.equal(run.status,'passed');timings.simulationRunMs=Math.round(performance.now()-startRun);
 const original=await readFile(join(root,'rtl/stage.sv'),'utf8');await writeFile(join(root,'rtl/stage.sv'),original.replace('data_i + BIAS','data_i - BIAS'));
 const impact=await cli(['import-impact',imported.reportFile]),runs=await cli(['runs']);assert.equal(impact.affectedModuleIds.length,2);assert.equal(impact.unaffectedModuleIds.length,1);assert.equal(runs.runs[0].fresh,false);
 const review=await fetch(`${url}/api/review`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelHash:committed.modelHash,reviewer:'fixture'})});assert.equal(review.status,422);
 const report={toolVersion,sourceBuildId:opened.service.buildId,recordedAt:new Date().toISOString(),fixture:'examples/rtl-intake',scenario:'raw RTL → elaboration → candidate → human-save fixture → graph question → CLI context → candidate-linked reply → checkpoint → service restart → RTL simulation → source-change invalidation',timings,cliCalls,model:{modules:imported.modules,connections:imported.connections,fidelity:'partial'},restored:{threads:1,messages:2,checkpoint:true,candidate:true,module:true,manualContextReentry:0},sourceChange:{affectedModules:impact.affectedModuleIds.length,unaffectedModules:impact.unaffectedModuleIds.length,verificationFresh:false},verification:{status:run.status,checks:run.checks,toolVersion:run.steps[0].toolVersion},totalMs:Math.round(performance.now()-begin),note:'自动化临时工作区测量，非人类可读性或效率提升百分比；第一次构建是否需要会影响时间。仿真只验证此 RTL 样例，不证明导入模型完整。'};
 if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(report,null,2));
}finally{await cli(['stop']).catch(()=>undefined);await rm(root,{recursive:true,force:true});}
