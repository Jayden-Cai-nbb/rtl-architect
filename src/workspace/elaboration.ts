import { z } from 'zod';
import { inputFile, workspacePath } from './artifacts';
import { ToolError } from './environment';
import { inputManifestSchema } from './inventory';
import { verificationRun } from './verification';
import type { Model } from '../core/schema';
import { parameterValue } from '../core/parameters';

const name=z.string().trim().min(1);
export const elaborationReference={runId:z.string().regex(/^run_\d+_[a-f0-9]{32}$/),netlist:name,reuseElaboration:z.boolean().optional()};
type Configuration=z.infer<typeof inputManifestSchema>;
type Reference={runId:string;netlist:string;reuseElaboration?:boolean;top?:string};
type Producer=Awaited<ReturnType<typeof verificationRun>>;

export async function loadElaboration(workspace:string,hash:string,ref:Reference,producer?:Producer){
 const record=producer??await verificationRun(workspace,hash,ref.runId);
 const run=record.summary;
 if(!record.digest)throw new ToolError('ELABORATION_RUN','无法读取明确引用的展开运行。',{id:ref.runId,status:run.status});
 const file=await inputFile(await workspacePath(workspace,`evidence/runs/${ref.runId}`),ref.netlist,8*1024*1024);
 const declared=record.artifacts.some(a=>a.file===file.file&&a.sha256===file.sha256);
 const current=run.changedFiles?.length===0&&declared;
 let inventory:Awaited<ReturnType<typeof inputFile>>|undefined;
 let configuration:Configuration|undefined;
 if(ref.reuseElaboration&&record.elaborationInputs&&current&&run.stage==='elaboration'&&run.status==='passed'){
  inventory=await inputFile(workspace,record.elaborationInputs);
  if(record.inputs.some(input=>input.file===inventory!.file&&input.sha256===inventory!.sha256)){
   configuration=inputManifestSchema.parse(JSON.parse(inventory.bytes.toString()));
  }
 }
 const sourceOnly=!!configuration&&(!ref.top||ref.top===configuration.top);
 const inputsCurrent=!!current&&(run.fresh||sourceOnly);
 const trusted=inputsCurrent&&run.stage==='elaboration'&&run.status==='passed'&&run.inputClosure==='declared_complete'&&!!run.toolVersionsKnown;
 return {run,record,file,inventory,configuration,sourceOnly,inputsCurrent,trusted,reused:trusted&&sourceOnly&&run.modelHash!==hash};
}

export function configurationProblems(model:Model,configuration:Configuration){
 const module=model.modules.find(m=>m.id===model.design.top)!;
 const problems=module.rtlModule===configuration.top?[]:['顶层'];
 for(const [key,value] of Object.entries(configuration.parameters)){
  try{if(parameterValue(model,module,key)!==value)problems.push(key);}
  catch{problems.push(key);}
 }
 return problems;
}
