import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {toolRoot,toolVersion,exists,ToolError} from './environment';
// Hash inputs, not timestamps: checkout/copy/rebuild on another machine remains deterministic.
export async function sourceBuildId(root=toolRoot){
 const files:string[]=[];
 async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())files.push(p);}}
 await walk(join(root,'src'));
 for(const name of ['package.json','package-lock.json','vite.config.ts','tsconfig.json','index.html'])files.push(join(root,name));
 const hash=createHash('sha256');
 for(const file of files.sort()){hash.update(relative(root,file));hash.update('\0');hash.update(await readFile(file));hash.update('\0');}
 return hash.digest('hex');
}
export async function buildStatus(){
 const sourceHash=await sourceBuildId();let recorded:{sourceHash?:string;toolVersion?:string}|undefined;
 try{recorded=JSON.parse(await readFile(join(toolRoot,'dist/build-info.json'),'utf8'));}catch{}
 const current=!!recorded&&recorded.sourceHash===sourceHash&&recorded.toolVersion===toolVersion&&await exists(join(toolRoot,'dist/index.html'));
 return {current,sourceHash,recorded:recorded??null};
}
export async function assertCurrentBuild(){const status=await buildStatus();if(!status.current)throw new ToolError('BUILD_REQUIRED','页面缺失或与源码不一致；运行 rtlarch open 自动构建，或在工具目录运行 npm run build。',status);return status.sourceHash;}
