import type {Issue,Model} from './schema';
export function issueLocation(issue:Issue):NonNullable<Issue['location']>{
 if(issue.location)return issue.location;
 const parts=issue.target.split('/'),[moduleId,interfaceId]=issue.target.split('.');
 if(parts.length>=3){const match=/^(.*?)(?:\[(\d+)\])?$/.exec(parts[2])!;return {scope:parts[0],moduleId:parts[1],interfaceId:match[1],...(match[2]?{index:Number(match[2])}:{})};}
 return {moduleId,interfaceId};
}
export function issueModule(model:Model,issue:Issue){
 const location=issueLocation(issue);
 return model.modules.some(m=>m.id===location.moduleId)?location.moduleId:model.connections.find(l=>l.id===issue.target)?.from.moduleId??model.design.top;
}
export function indexRanges(indices:number[]):string{
 const sorted=[...new Set(indices)].sort((a,b)=>a-b),parts:string[]=[];let start=sorted[0],last=start;
 for(const index of sorted.slice(1)){if(index===last+1){last=index;continue;}parts.push(start===last?String(start):`${start}–${last}`);start=last=index;}
 if(start!==undefined)parts.push(start===last?String(start):`${start}–${last}`);return parts.join(', ');
}
export function diagnosticGroups(model:Model,issues:Issue[]){
 const groups=new Map<string,{key:string;label:string;code:string;count:number;items:Map<string,{key:string;moduleId:string;interfaceId?:string;scope?:string;indices:number[];issues:Issue[]}>}>();
 for(const issue of issues){
  const key=issue.causeIds?.length?`cause:${issue.causeIds.join(',')}`:issue.code;
  const cause=model.provenance?.unsupportedStructures.find(u=>issue.causeIds?.includes(u.id));
  const group=groups.get(key)??{key,label:cause?.description??issue.message,code:issue.code,count:0,items:new Map()};
  const location=issueLocation(issue),moduleId=issueModule(model,issue),itemKey=`${location.scope??''}/${moduleId}/${location.interfaceId??''}`;
  const item=group.items.get(itemKey)??{key:itemKey,moduleId,interfaceId:location.interfaceId,scope:location.scope,indices:[],issues:[]};
  item.issues.push(issue);if(location.index!==undefined)item.indices.push(location.index);group.items.set(itemKey,item);group.count++;groups.set(key,group);
 }
 return [...groups.values()].map(g=>({...g,items:[...g.items.values()].map(item=>({...item,indexLabel:indexRanges(item.indices)}))}));
}
