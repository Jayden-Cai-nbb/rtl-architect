import {z} from 'zod';
import {idSchema,hashSchema} from './schema';
import {candidateRefSchema} from './studies';
const text=z.string().trim().min(1).max(2000);
export const decisionInputSchema=z.strictObject({
 id:idSchema,title:text,threadIds:z.array(idSchema).min(1).max(50),
 options:z.array(z.strictObject({id:idSchema,label:text,candidate:candidateRefSchema,
  budget:z.strictObject({studyId:idSchema,optionId:idSchema}).optional(),
  assumptions:z.array(text).min(1).max(30),risks:z.array(text).max(30),
  experiments:z.array(z.strictObject({runId:idSchema,modelHash:hashSchema})).max(20)
 })).length(2)
}).refine(d=>new Set(d.options.map(o=>o.id)).size===2,'选项 ID 必须不同').refine(d=>new Set(d.threadIds).size===d.threadIds.length,'问题 ID 不能重复');
export const decisionSchema=decisionInputSchema.safeExtend({createdAt:z.iso.datetime(),choices:z.array(z.strictObject({optionId:idSchema,reason:text,author:z.literal('user'),createdAt:z.iso.datetime()}))});
export type Decision=z.infer<typeof decisionSchema>;
export type DecisionInput=z.infer<typeof decisionInputSchema>;
