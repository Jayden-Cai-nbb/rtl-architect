import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,symlink,readFile,appendFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {toolRoot} from '../src/workspace/environment';
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-open-')),copy=join(root,'tool'),a=join(root,'a'),b=join(root,'b');
const env={...process.env};delete env.RTLARCH_API_PORT;delete env.RTLARCH_WORKSPACE;
async function cli(workspace:string,args:string[],fail=false){try{const r=await exec(join(copy,'bin/rtlarch'),[...args,'--workspace',workspace,'--json'],{cwd:workspace,env,timeout:210000,maxBuffer:4*1024*1024});assert.equal(fail,false,'expected rejection');return JSON.parse(r.stdout);}catch(e){if(!fail)throw e;return JSON.parse((e as {stdout:string}).stdout);}}
try{
 await mkdir(copy);for(const name of ['src','scripts','bin','dist','package.json','package-lock.json','vite.config.ts','tsconfig.json','index.html'])await cp(join(toolRoot,name),join(copy,name),{recursive:true});
 await symlink(join(toolRoot,'node_modules'),join(copy,'node_modules'));
 for(const dir of [a,b]){await mkdir(join(dir,'architecture'),{recursive:true});await cp(join(toolRoot,'examples/packet-pipeline/model.json'),join(dir,'architecture/model.json'));}
 const first=await cli(a,['open']),other=await cli(b,['open']);assert.equal(first.rebuilt,false);
 // Same package version, different production source. Existing services must not be silently reused.
 await appendFile(join(copy,'src/core/service.ts'),'\n// isolated source update fixture\n');
 const denied=await cli(a,['open'],true);assert.equal(denied.error.code,'RESTART_REQUIRED');assert.equal((await (await fetch(other.service.apiUrl+'/api/health')).json()).instanceId,other.service.instanceId);
 const resumed=await cli(a,['open','--restart']);assert.equal(resumed.rebuilt,true);assert.notEqual(resumed.service.buildId,first.service.buildId);assert.notEqual(resumed.service.instanceId,first.service.instanceId);
 assert.equal((await (await fetch(other.service.apiUrl+'/api/health')).json()).instanceId,other.service.instanceId);
 assert.equal((await cli(b,['context'],true)).error.code,'SERVICE_BUILD_MISMATCH');
 const html=await (await fetch(resumed.reviewUrl)).text();assert.ok(html.includes('/assets/'));
 await cli(a,['stop']);await rm(join(copy,'dist'),{recursive:true});
 const missing=await cli(a,['open']);assert.equal(missing.rebuilt,true);assert.equal(missing.browser.opened,false);
 console.log('PASS 1: same-version stale sources require explicit workspace restart; a second workspace is untouched');
 console.log('PASS 2: missing web build is rebuilt, identity is current and --json returns a usable URL without browser launch');
 // Invalid source never falls back to serving an old successful build.
 await cli(a,['stop']);await writeFile(join(copy,'src/web/broken.ts'),'this is invalid TypeScript !!!!\n');
 const bad=await cli(a,['open'],true);assert.equal(bad.error.code,'BUILD_FAILED');assert.ok((await readFile(join(a,'.rtlarch/build.log'),'utf8')).includes('error TS'));
 console.log('PASS 3: failed rebuild reports a saved build log, never a stale success link');
}finally{for(const workspace of [a,b]){try{const info=JSON.parse(await readFile(join(workspace,'.rtlarch/runtime.json'),'utf8'));await fetch(info.apiUrl+'/api/runtime/stop',{method:'POST',headers:{'Content-Type':'application/json','X-RTLArch-Workspace':info.workspaceId},body:'{}'});for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));try{await fetch(info.apiUrl+'/api/health',{signal:AbortSignal.timeout(500)});}catch{break;}}}catch{}}await rm(root,{recursive:true,force:true});}
console.log('完成 3 组统一打开与升级恢复检查。');
