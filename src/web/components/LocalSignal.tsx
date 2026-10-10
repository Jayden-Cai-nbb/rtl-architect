import {signalText} from '../../core/signals';
import type { Model } from '../../core/schema';
import { EvidenceLinks } from './Evidence';
export function LocalSignalDialog({model,id,close}:{model:Model;id:string;close:()=>void}) {
 const item=model.localSignals?.find(n=>n.id===id);if(!item)return null;
 return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-label="局部信号"><div className="section-title"><h2>{item.name} · 局部{item.driver.kind==='register'?'寄存':'组合'}驱动</h2><button onClick={close}>关闭</button></div><p>{item.description}</p><p className="hint">scope: {item.scope} · 位宽 {JSON.stringify(item.width)} · 这是作用域内部信号，不是额外 RTL 模块。</p><pre className="command-preview">{item.driver.kind==='comb'?signalText(item.driver.value):item.driver.sourceText}</pre><EvidenceLinks ids={item.evidenceIds}/></section></div>;
}
