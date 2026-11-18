import {stateConeDiagram} from './stateConeDiagram';
import type {StateCone} from '../../core/nextStateCone';
self.onmessage=(event:MessageEvent<StateCone>)=>{try{self.postMessage({graph:stateConeDiagram(event.data)})}catch(e){self.postMessage({error:String(e)})}};
