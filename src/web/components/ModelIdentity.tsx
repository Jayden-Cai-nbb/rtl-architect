import type {RegisteredProposal} from '../../core/api';
import type {Model} from '../../core/schema';
export function ModelIdentity({model,hash,serviceVersion,proposal,candidate,compare}:{model:Model;hash:string;serviceVersion?:string;proposal?:RegisteredProposal;candidate:boolean;compare:()=>void}){
 const matching=proposal?.candidateHash===hash;
 return <details className="model-identity" data-testid="model-identity"><summary>服务 {serviceVersion??'未知'} · {candidate?'候选未提交':'工作区已保存'} · 版本信息</summary><div><p>服务版本：{serviceVersion??'未知'}</p><p>候选创建版本：{matching?proposal.createdWith??'未知（旧记录未保存）':'未知（未登记或当前模型）'}</p><p className="hint">创建版本指生成并登记候选的工具版本。服务升级不会重写旧模型。</p><p>候选 ID：<code>{matching?proposal.id:'未关联'}</code></p><p>当前显示模型：<code>{hash}</code></p><p>候选基线：<code>{matching?proposal.proposal.baseHash:'见当前提案'}</code></p><p>源码输入摘要：<code>{model.provenance?.sourceDigest??'未记录'}</code></p><p>状态：{candidate?'尚未提交，人工确认也未完成':matching&&proposal.state==='APPLIED'?'候选已提交，批准状态单独检查':'显示工作区当前模型'}</p><button onClick={compare}>比较新旧候选</button></div></details>;
}
