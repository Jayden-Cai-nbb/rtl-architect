import {mkdir,open,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname,basename} from 'node:path';
import {toolRoot,ToolError} from './environment';
export async function workspacePath(workspace:string,file:string){
 const root=await realpath(workspace),path=await realpath(resolve(root,file)),rel=relative(root,path);
 if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new ToolError('OUTSIDE_WORKSPACE',`文件不在当前工作区：${file}`);
 return path;
}
export async function inputFile(workspace:string,file:string,maxBytes=64*1024*1024){
 const path=await workspacePath(workspace,file);if(!(await stat(path)).isFile())throw new ToolError('INPUT_NOT_FILE',`输入不是普通文件：${file}`);
 const handle=await open(path,'r');try{
  const before=await handle.stat();if(!before.isFile()||before.size>maxBytes)throw new ToolError('INPUT_SIZE',`输入超过 ${maxBytes} 字节或不是普通文件：${file}`);
  const bytes=await handle.readFile(),after=await handle.stat();
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new ToolError('INPUT_CHANGED',`读取期间文件变化：${file}`);
  return {file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes};
 }finally{await handle.close();}
}
async function canonical(path:string):Promise<string>{try{return await realpath(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;return resolve(await canonical(dirname(path)),basename(path));}}
export async function newArtifactDirectory(workspace:string,destination:string){
 const output=await canonical(resolve(destination));
 for(const base of [await realpath(workspace),await realpath(toolRoot)]){const rel=relative(base,output);if(!rel||/^(architecture|generated|\.rtlarch)(\/|$)/.test(rel))throw new ToolError('OUTPUT_PROTECTED','输出必须使用正式模型目录之外的新目录');}
 await mkdir(dirname(output),{recursive:true});await mkdir(output);return output;
}
