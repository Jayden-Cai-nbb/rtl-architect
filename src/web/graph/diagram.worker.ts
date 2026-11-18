import {diagramQuality} from './quality';
import {type DiagramOptions} from './scopeDiagram';
import {prepareDiagram} from './prepareDiagram';
import type {Model} from '../../core/schema';
self.onmessage=async(event:MessageEvent<{id:number;model:Model;scope:string;hash:string;options:DiagramOptions;arrange:boolean}>)=>{
 const {id,model,scope,hash,options,arrange}=event.data;
 try{
  const result=await prepareDiagram(model,scope,hash,undefined,options,arrange);
  self.postMessage({id,...result,quality:diagramQuality(result.graph)});
 }catch(e){self.postMessage({id,error:e instanceof Error?e.message:String(e)})}
};
