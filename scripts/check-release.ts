import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,rm,realpath,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {toolRoot} from '../src/workspace/environment';
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'rtlarch-release-')),copy=join(root,'tool'),workspace=join(root,'user project');
let opened=false;
const env={...process.env};delete env.RTLARCH_WORKSPACE;delete env.RTLARCH_API_PORT;
const command=async(program:string,args:string[],cwd=copy)=>exec(program,args,{cwd,env,timeout:240000,maxBuffer:6*1024*1024});
const cli=async(args:string[])=>JSON.parse((await command(join(copy,'bin/rtlarch'),[...args,'--workspace',workspace,'--json'],workspace)).stdout);
try{
 const pkg=JSON.parse(await readFile(join(toolRoot,'package.json'),'utf8')),lock=JSON.parse(await readFile(join(toolRoot,'package-lock.json'),'utf8'));
 assert.equal(pkg.version,lock.version);assert.equal(pkg.version,lock.packages[''].version);assert.equal(pkg.license,'MIT','Run this check in the public release checkout');
 assert((await readFile(join(toolRoot,'LICENSE'),'utf8')).includes('MIT License'));
 const gitCheckout=await access(join(toolRoot,'.git')).then(()=>true,()=>false);
 if(gitCheckout)await command('git',['ls-files','--error-unmatch','examples/external-axis/architecture/model.json','examples/typed-expressions/architecture/model.json','examples/typed-expressions/architecture/layout.json'],toolRoot);
 await mkdir(copy);await mkdir(workspace);
 for(const name of ['src','scripts','bin','.agents','examples','package.json','package-lock.json','vite.config.ts','tsconfig.json','index.html','env.sh','LICENSE','README.md'])await cp(join(toolRoot,name),join(copy,name),{recursive:true,filter:p=>!p.split('/').some(n=>['.rtlarch','node_modules','.runtime'].includes(n))});
 // Install from the lockfile in a separate directory; no inherited modules, runtime or dist.
 assert.equal((await command('node',['--version'])).stdout.trim(),'v'+pkg.engines.node);assert.equal((await command('npm',['--version'])).stdout.trim(),pkg.engines.npm);
 await command('npm',['ci','--no-audit','--no-fund']);assert((await realpath(join(copy,'node_modules'))).startsWith(copy));
 await command('npm',['run','build']);
 await cp(join(copy,'examples/external-axis/architecture'),join(workspace,'architecture'),{recursive:true});
 const before=await readFile(join(workspace,'architecture/model.json'),'utf8');
 const install=await cli(['install']);assert.equal(install.ok,true);
 const page=await cli(['open']);opened=true;assert.equal(page.ok,true);assert.equal(page.toolVersion,pkg.version);
 const health=await (await fetch(page.service.apiUrl+'/api/health')).json();assert.equal(health.toolVersion,pkg.version);assert.equal(health.buildId,page.service.buildId);
 const html=await (await fetch(page.reviewUrl)).text();assert(html.includes('/assets/'));
 assert.equal((await cli(['context','--offline'])).ok,true);assert.equal(await readFile(join(workspace,'architecture/model.json'),'utf8'),before);
 console.log(JSON.stringify({passed:true,version:pkg.version,publishedFixturesChecked:gitCheckout,lockfileInstall:true,inheritedNodeModules:false,inheritedRuntime:false,inheritedDist:false,workspaceWithSpaces:true,skillInstall:true,pageServed:true,modelUnchanged:true,platform:process.platform,remoteCI:'not_run'},null,2));
}finally{if(opened)await cli(['stop']).catch(()=>{});await rm(root,{recursive:true,force:true});}
