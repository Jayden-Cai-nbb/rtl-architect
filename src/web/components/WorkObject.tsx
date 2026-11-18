import {createContext,useContext} from 'react';
import type {ObjectRequest} from '../../core/workbench';
export const WorkObjectContext=createContext<(object:ObjectRequest)=>void>(()=>{});
export function AskObject({object}:{object:ObjectRequest}){const ask=useContext(WorkObjectContext);return <button className="text-button" aria-label={`对此提问 ${object.kind} ${object.id}`} onClick={()=>ask(object)}>对此提问</button>;}
