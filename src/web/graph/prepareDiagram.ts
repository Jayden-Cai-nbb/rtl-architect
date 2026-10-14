import type {Model,ScopeLayout} from '../../core/schema';
import {scopeDiagram,type DiagramOptions} from './scopeDiagram';
import {arrangeScope} from './readingLayout';

/** Same visibility and completeness rule for CLI and offline export, including local-only scopes. */
export async function prepareDiagram(model:Model,scope:string,hash:string,saved?:ScopeLayout,options:DiagramOptions={}){
 if(!model.modules.some(m=>m.id===scope))throw new Error(`层级不存在：${scope}`);
 if(saved?.reading&&saved.reading.modelHash!==hash)throw new Error('阅读布局对应旧模型；核对后重新生成。');
 const settings={...options,reading:saved?.reading};
 const required=scopeDiagram(model,scope,{...settings,measureOnly:true}).nodes.filter(n=>!n.data.boundary);
 const positions=saved&&required.every(n=>saved.positions[n.id])?saved.positions:await arrangeScope(model,scope,hash,saved?.reading,settings);
 return {graph:scopeDiagram(model,scope,{...settings,positions}),positions};
}
