import type {Node} from '@xyflow/react';
export type PortGeometry={id:string;direction:'source'|'target';x:number;y:number;side:'WEST'|'EAST'|'NORTH'|'SOUTH';label?:string;interfaceIds?:string[];category?:string;labelX?:number;labelY?:number;textAnchor?:'start'|'middle'|'end'};
export type RtlNodeData={label:string;moduleId:string;kind:string;summary:string;boundary:boolean;geometry:{width:number;height:number;captionY?:number;ports:PortGeometry[]};ports:{id:string;width:number|undefined}[]}&Record<string,unknown>;
export type RtlNode=Node<RtlNodeData,'rtlModule'>;
