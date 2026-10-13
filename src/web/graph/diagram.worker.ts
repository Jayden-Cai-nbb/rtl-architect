import {scopeDiagram,type DiagramOptions} from './scopeDiagram';
import {arrangeScope} from './readingLayout';
import type {Model} from '../../core/schema';
self.onmessage=async(event:MessageEvent<{id:number;model:Model;scope:string;hash:string;options:DiagramOptions;arrange:boolean}>)=>{
 const {id,model,scope,hash,options,arrange}=event.data;
 try{
  if(options.reading&&options.reading.modelHash!==hash)throw new Error('阅读布局对应旧模型，请核对后重新导入。');
  const positions=arrange?await arrangeScope(model,scope,hash,options.reading):options.positions;
  self.postMessage({id,graph:scopeDiagram(model,scope,{...options,positions}),positions});
 }catch(e){self.postMessage({id,error:e instanceof Error?e.message:String(e)})}
};
