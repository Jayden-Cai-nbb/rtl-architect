import type {Model,ScopeLayout} from '../../core/schema';
import {scopeDiagram,type DiagramOptions} from './scopeDiagram';
import {arrangeScope} from './readingLayout';

/** Same visibility and completeness rule for CLI and offline export, including local-only scopes. */
export async function prepareDiagram(model:Model,scope:string,hash:string,saved?:ScopeLayout,options:DiagramOptions={},arrange=false){
 if(!model.modules.some(m=>m.id===scope))throw new Error(`层级不存在：${scope}`);
 if(saved?.reading&&saved.reading.modelHash!==hash)throw new Error('阅读布局对应旧模型；核对后重新生成。');
 const reading=Object.hasOwn(options,'reading')?options.reading:saved?.reading;
 if(reading&&reading.modelHash!==hash)throw new Error('阅读布局对应旧模型；核对后重新生成。');
 const settings={...options,reading};
 const required=scopeDiagram(model,scope,{...settings,measureOnly:true}).nodes.filter(n=>!n.data.boundary);
 // Session positions take precedence. A reading-task projection never consumes saved full-view
 // positions, even when its current members happen to have the same IDs.
 const supplied=options.positions??(options.task?undefined:saved?.positions);
 const retained=!arrange&&supplied&&required.every(n=>supplied[n.id]);
 const positions=retained?supplied:await arrangeScope(model,scope,hash,reading,settings);
 return {graph:scopeDiagram(model,scope,{...settings,positions}),positions,
  layoutSource:retained?(options.positions?'session_positions':'saved_positions'):'automatic',
  readingSource:reading?'explicit':'none'};
}
