import { z } from 'zod';
import { hashSchema, idSchema } from './schema';
import { studySchema } from './studies';
const text = z.string().trim().min(1).max(12000);
export const workTargetSchema = z.strictObject({modelHash:hashSchema,moduleId:idSchema.optional(),connectionIds:z.array(idSchema).max(100).default([]),proposalId:hashSchema.optional()});
const messageSchema=z.strictObject({id:idSchema,author:z.enum(['user','agent']),text,createdAt:z.iso.datetime(),modelHash:hashSchema,proposalId:hashSchema.optional()});
const threadSchema=z.strictObject({id:idSchema,target:workTargetSchema,title:z.string().trim().min(1).max(240),status:z.enum(['open','addressed','resolved']),messages:z.array(messageSchema).min(1),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()});
export const checkpointSchema=z.strictObject({intent:text,nextStep:text,target:workTargetSchema,updatedAt:z.iso.datetime()});
export const workbenchSchema=z.strictObject({schemaVersion:z.literal(1),threads:z.array(threadSchema),checkpoint:checkpointSchema.nullable(),studies:z.array(studySchema)});
export const workActionSchema=z.intersection(z.strictObject({baseHash:hashSchema,action:z.unknown()}),z.object({action:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('ask'),title:z.string().trim().min(1).max(240),text,target:workTargetSchema}),
 z.strictObject({kind:z.literal('reply'),threadId:idSchema,author:z.enum(['user','agent']),text,modelHash:hashSchema,proposalId:hashSchema.optional()}),
 z.strictObject({kind:z.literal('resolve'),threadId:idSchema,modelHash:hashSchema}),
 z.strictObject({kind:z.literal('reopen'),threadId:idSchema,modelHash:hashSchema}),
 z.strictObject({kind:z.literal('checkpoint'),intent:text,nextStep:text,target:workTargetSchema}),
 z.strictObject({kind:z.literal('study'),study:studySchema}),
])}));
export type Workbench=z.infer<typeof workbenchSchema>;
export type WorkTarget=z.infer<typeof workTargetSchema>;
export type WorkAction=z.infer<typeof workActionSchema>;
export type WorkbenchSnapshot={workbench:Workbench;workbenchHash:string;modelHash:string;threadStates:{id:string;versionChanged:boolean;missingTargets:string[];proposalState?:string}[]};
export const emptyWorkbench=():Workbench=>({schemaVersion:1,threads:[],checkpoint:null,studies:[]});
