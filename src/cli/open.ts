import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,dirname} from 'node:path';
import {writeFile,mkdir} from 'node:fs/promises';
import {buildStatus} from '../workspace/build';
import {toolRoot,ToolError} from '../workspace/environment';
import {discoverService,ensureService,request,stopService,type ClientOptions} from './service-client';
import type {Repository} from '../workspace/repository';
export type Resume=Awaited<ReturnType<Repository['getResume']>>;
const exec=promisify(execFile);
export async function openWorkspace(workspace:string,options:ClientOptions&{restart?:boolean;json:boolean}){
 let build=await buildStatus(),rebuilt=false;
 const existing=await discoverService(workspace,{...options,allowOlderVersion:true});
 if(existing&&(!build.current||existing.buildId!==build.sourceHash)){
  if(!options.restart)throw new ToolError('RESTART_REQUIRED','该工作区仍运行旧构建；保存未发送的页面输入后，运行 rtlarch open --restart。只重启此工作区。',{service:existing,build});
  await stopService(workspace,options);
 }
 if(!build.current){
  await mkdir(join(workspace,'.rtlarch'),{recursive:true});
  try{
   const result=await exec('npm',['run','build'],{cwd:toolRoot,env:{...process.env,PATH:`${dirname(process.execPath)}:${process.env.PATH??''}`},timeout:180000,maxBuffer:4*1024*1024});
   await writeFile(join(workspace,'.rtlarch/build.log'),result.stdout+result.stderr);
  }catch(e){const error=e as Error&{stdout?:string;stderr?:string};await writeFile(join(workspace,'.rtlarch/build.log'),(error.stdout??'')+(error.stderr??'')+error.message);throw new ToolError('BUILD_FAILED','页面构建失败；详见工作区 .rtlarch/build.log。依赖不会自动安装。');}
  build=await buildStatus();if(!build.current)throw new ToolError('BUILD_CHANGED','构建期间源码发生变化，请再次运行 open。');rebuilt=true;
 }
 const service=await ensureService(workspace,options),resume=await request<Resume>(service,'resume');
 if(service.buildId!==build.sourceHash)throw new ToolError('SERVICE_BUILD_MISMATCH','服务构建与当前源码不同，请用 open --restart 重新打开。');
 const url=new URL(service.webUrl);url.searchParams.set('workspace',service.workspaceId);
 const checkpoint=resume.workbench.checkpoint,target=checkpoint?.target;
 const ready=target?.proposalId&&resume.proposals.find(p=>p.id===target.proposalId&&p.state==='READY');
 if(ready)url.searchParams.set('proposal',ready.id);
 const usable=!!target&&(target.modelHash===resume.modelHash||!!ready);
 if(usable&&target?.moduleId)url.searchParams.set('module',target.moduleId);
 if(usable&&target?.connectionIds.length)url.searchParams.set('connection',target.connectionIds[0]);
 if(resume.nextActions.length)url.searchParams.set('panel','work');
 const reviewUrl=url.toString(),browser=options.json?{opened:false,reason:'--json 返回链接，供调用方打开'}:await openBrowser(reviewUrl);
 return {service,reviewUrl,rebuilt,browser,resume,checkpointRestored:usable,note:'当前页面由此工作区服务提供。历史导出 HTML 不会自动更新；浏览器未打开时复制 reviewUrl。'};
}
async function openBrowser(url:string){
 const commands=process.platform==='darwin'?['open']:process.platform==='win32'?[]:['wslview','xdg-open'];
 for(const program of commands){try{await exec(program,[url],{timeout:5000,maxBuffer:1024*1024});return {opened:true,program};}catch{}}
 return {opened:false,reason:'未找到可用的浏览器打开程序，请复制 reviewUrl 到浏览器'};
}
