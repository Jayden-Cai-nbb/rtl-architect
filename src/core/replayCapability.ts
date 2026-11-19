import type {Model,TransactionPath} from './schema';

const supported:Record<TransactionPath['semantics'],string>={
 ordered_lossless_single_slot_stages:'级联单槽',
 combinational_bypass:'组合旁路',
 registered_single_slot:'简单单槽',
 registered_skid:'双槽 skid',
};
const unsupported={
 addressed_fifo:'地址化 RAM FIFO',
 addressed_frame_fifo:'地址化 RAM 帧 FIFO',
};
export const replayCapabilities={
 supported:Object.entries(supported).map(([semantics,label])=>({semantics,label})),
 unsupported:Object.entries(unsupported).map(([semantics,label])=>({semantics,label})),
 independentVerification:{command:'verify <profile.json> --workspace . --json',history:'runs --workspace . --json',schema:'verification'},
};

export function replayAvailability(model:Model,moduleId:string,semantics?:string,pathId?:string){
 const module=model.modules.find(m=>m.id===moduleId);
 const paths=(module?.contract.transactionPaths??[]).filter(p=>!pathId||p.id===pathId);
 const gap=model.provenance?.unsupportedStructures.find(g=>g.kind==='ram_frame_replay'&&g.category==='unsupported'&&g.moduleIds.includes(moduleId));
 const requested=semantics??(!paths.length&&gap?'addressed_frame_fifo':undefined);
 const common={moduleId,semantics:requested,pathId,evidenceIds:gap?.evidenceIds??[]};
 if(!module)return {...common,status:'MODULE_NOT_FOUND' as const,message:'当前模型没有该模块。'};
 if(requested&&!Object.hasOwn(supported,requested)){
  const label=Object.hasOwn(unsupported,requested)?unsupported[requested as keyof typeof unsupported]:requested;
  return {...common,status:'UNSUPPORTED' as const,message:`当前事务回放不支持${label}。可用独立仿真检查并保留 verify 证据。`};
 }
 const matching=paths.filter(p=>!requested||p.semantics===requested);
 if(matching.length)return {...common,status:'DECLARED' as const,pathIds:matching.map(p=>p.id),message:'已有受支持的路径，可导入相应的仿真采样。'};
 if(paths.length&&pathId)return {...common,status:'SEMANTICS_MISMATCH' as const,message:`路径 ${pathId} 已声明为 ${paths[0].semantics}。`};
 return {...common,status:'NOT_DECLARED' as const,message:'当前范围尚未声明对应的事务路径。确认使用受支持的语义后，再通过提案添加路径。'};
}
