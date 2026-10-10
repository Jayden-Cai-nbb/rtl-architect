import { z } from 'zod';
export const idSchema = z.string().regex(/^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_]+$/);
const integer = z.number().finite().int().safe();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const widthSchema = z.union([integer.min(1).max(65536), z.strictObject({ param: idSchema }), z.strictObject({ expr: z.string().trim().min(1).max(2048) })]);
export const interfaceSchema = z.strictObject({ id: idSchema, role: z.enum(['producer', 'consumer']), protocol: z.enum(['rv', 'signal']), width: widthSchema, required: z.boolean(), group: idSchema.optional() });
export const contractSchema = z.strictObject({ responsibility: z.string(), latencyMinCycles: integer.nonnegative(), latencyCondition: z.string(), backpressure: z.string(), resetBehavior: z.string(), invariants: z.array(z.string()), verificationPlan: z.array(z.string()), openQuestions: z.array(z.string()) });
export const parameterSchema = z.union([integer, z.string(), z.boolean()]);
export const kindSchema = z.enum(['subsystem', 'module', 'memory', 'compute', 'controller', 'fifo', 'add_const']);
export const specificationSchema = z.strictObject({
  summary: z.string(),
  requirements: z.array(z.strictObject({ id: idSchema, text: z.string().trim().min(1), moduleIds: z.array(idSchema).min(1), acceptance: z.string() })),
  decisions: z.array(z.strictObject({ id: idSchema, text: z.string().trim().min(1), moduleIds: z.array(idSchema), rationale: z.string() })),
  openQuestions: z.array(z.string())
});
export const timingSchema = z.enum(['sequential', 'combinational', 'mixed', 'unknown']);
export const parameterBindingSchema = z.union([z.strictObject({ expression: z.string().trim().min(1).max(2048), scope: z.enum(['self','parent']) }),z.strictObject({reference:idSchema,scope:z.enum(['self','parent']),type:z.enum(['string','number','boolean'])})]);
export const instanceArraySchema = z.strictObject({ indexVariable: idSchema, from: integer.nonnegative(), to: integer.nonnegative(), sourcePath: z.string().min(1), overrides: z.record(z.string().regex(/^\d+$/), z.record(idSchema, parameterSchema)).optional() });
export const interfaceGroupSchema=z.strictObject({id:idSchema,label:z.string().trim().min(1),category:z.enum(['data','request','response','writeback','configuration','clock_reset','control','other']),description:z.string().trim().min(1)});
export const moduleSchema = z.strictObject({ id: idSchema, name: z.string().trim().min(1), parent: idSchema.nullable(), kind: kindSchema, rtlModule: idSchema, clock: idSchema.nullable(), reset: idSchema.nullable(), timing: timingSchema.optional(), parameters: z.record(idSchema, parameterSchema), parameterBindings: z.record(idSchema, parameterBindingSchema).optional(), instances: instanceArraySchema.optional(), resetControlInputs: z.array(idSchema).optional(), interfaces: z.array(interfaceSchema), interfaceGroups:z.array(interfaceGroupSchema).optional(), contract: contractSchema });
const text = z.string().trim().min(1);
export const evidenceTargetSchema = z.strictObject({ kind: z.enum(['module', 'interface', 'parameter', 'contract', 'connection', 'local']), moduleId: idSchema.optional(), itemId: idSchema.optional() });
const bitRange=z.strictObject({msb:integer.nonnegative(),lsb:integer.nonnegative()});
const causeRuleSchema=z.strictObject({issueCodes:z.array(idSchema).min(1),moduleId:idSchema,interfaceId:idSchema.optional(),scope:idSchema.optional(),indices:z.strictObject({from:integer.nonnegative(),to:integer.nonnegative()}).optional(),bits:bitRange.optional()});
const assessment=z.strictObject({status:z.enum(['complete','partial','unknown']),expected:integer.nonnegative().nullable(),detail:text,evidenceIds:z.array(idSchema)});
export const provenanceSchema = z.strictObject({
  origin: z.enum(['as_built', 'design']), fidelity: z.enum(['partial', 'exact']), scope: text,
  sourceDigest: hashSchema, configuration: text,
  coverage: z.strictObject({ elaboratedInstances: integer.positive().nullable(), representedInstances: integer.positive(), assessments:z.strictObject({portBits:assessment.optional(),localDrivers:assessment.optional(),parameterBindings:assessment.optional(),behavior:assessment.optional()}).optional() }),
  evidence: z.array(z.strictObject({ id: idSchema, file: text, fileHash: hashSchema, line: integer.positive().optional(), endLine: integer.positive().optional(), symbol: text.optional(), sourceKind: z.enum(['code', 'comment', 'test', 'measurement', 'report']), targets: z.array(evidenceTargetSchema).optional() })),
  findings: z.array(z.strictObject({ id: idSchema, classification: z.enum(['fact', 'inference', 'unknown', 'conflict']), moduleIds: z.array(idSchema), text, evidenceIds: z.array(idSchema) })),
  unsupportedStructures: z.array(z.strictObject({ id: idSchema, kind: text, moduleIds: z.array(idSchema), description: text, evidenceIds: z.array(idSchema), category:z.enum(['not_imported','unsupported','source_unknown','missing_asset']).optional(), causes:z.array(causeRuleSchema).optional(), targets: z.array(evidenceTargetSchema).optional() })),
  verification: z.array(z.strictObject({ stage: z.enum(['compile', 'elaboration', 'lint', 'simulation', 'synthesis', 'timing', 'formal']), status: z.enum(['passed', 'failed', 'not_run', 'blocked']), command: z.string(), detail: text, evidenceIds: z.array(idSchema), target: text.optional(), executedAt: z.iso.datetime().optional(), sourceDigest: hashSchema.optional(), tool: z.strictObject({ name: text, version: text }).optional(), batchId: text.optional() }))
});
export const endpointSchema = z.strictObject({ moduleId: idSchema, interfaceId: idSchema, index: z.union([integer.nonnegative(), z.literal('all')]).optional(), local: z.literal(true).optional(), slice: bitRange.optional(), sliceMapping:z.strictObject({arrayModuleId:idSchema,stride:integer,offset:integer,width:integer.min(1).max(65536)}).optional() });
export const linkSchema = z.strictObject({ id: idSchema, scope: idSchema, from: endpointSchema, to: endpointSchema });
export type SignalValue = { kind:'endpoint'; endpoint:z.infer<typeof endpointSchema> } | { kind:'constant'; width:number; value:string } | { kind:'concat'; parts:SignalValue[] } | { kind:'operator'; operator:'&'|'|'|'^'|'~'|'&&'|'||'|'!'|'+'|'-'|'mux'; operands:SignalValue[] };
export const signalValueSchema: z.ZodType<SignalValue> = z.lazy(()=>z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('endpoint'),endpoint:endpointSchema}),
 z.strictObject({kind:z.literal('constant'),width:integer.min(1).max(65536),value:z.string().regex(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)$/)}),
 z.strictObject({kind:z.literal('concat'),parts:z.array(signalValueSchema).min(1).max(4096)}),
 z.strictObject({kind:z.literal('operator'),operator:z.enum(['&','|','^','~','&&','||','!','+','-','mux']),operands:z.array(signalValueSchema).min(1).max(3)})
]));
export const localSignalSchema=z.strictObject({id:idSchema,scope:idSchema,name:z.string().trim().min(1),width:widthSchema,description:z.string().trim().min(1),driver:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('comb'),value:signalValueSchema}),
 z.strictObject({kind:z.literal('register'),inputs:z.array(endpointSchema),sourceText:z.string().trim().min(1)})
]),evidenceIds:z.array(idSchema)});
export const clockSchema = z.strictObject({ id: idSchema, edge: z.enum(['rising', 'falling']) });
export const resetSchema = z.strictObject({ id: idSchema, clock: idSchema.nullable(), activeLevel: z.enum(['low', 'high']), synchronous: z.boolean(), deassertion: z.enum(['synchronous', 'asynchronous', 'unknown']).optional() });
export const modelSchema = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]), specification: specificationSchema.optional(), provenance: provenanceSchema.optional(), design: z.strictObject({ id: idSchema, name: z.string().trim().min(1), top: idSchema }), clocks: z.array(clockSchema), resets: z.array(resetSchema), modules: z.array(moduleSchema), connections: z.array(linkSchema), localSignals: z.array(localSignalSchema).optional() });
export const commandSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set_parameter'), moduleId: idSchema, key: idSchema, value: parameterSchema }),
  z.strictObject({ op: z.literal('set_parameter_binding'), moduleId:idSchema, key:idSchema, binding:parameterBindingSchema.nullable() }),
  z.strictObject({ op: z.literal('update_instance_array'), moduleId:idSchema, instances:instanceArraySchema.nullable() }),
  z.strictObject({ op: z.literal('set_instance_parameter'), moduleId:idSchema, index:integer.nonnegative(), key:idSchema, value:parameterSchema }),
  z.strictObject({ op: z.literal('update_local_signals'), localSignals:z.array(localSignalSchema) }),
  z.strictObject({ op: z.literal('rename_module'), moduleId: idSchema, name: z.string().trim().min(1) }),
  z.strictObject({ op: z.literal('update_contract'), moduleId: idSchema, contract: contractSchema }),
  z.strictObject({ op: z.literal('create_module'), id: idSchema, parent: idSchema, template: kindSchema }),
  z.strictObject({ op: z.literal('define_module'), module: moduleSchema }),
  z.strictObject({op:z.literal('update_interface_groups'),moduleId:idSchema,groups:z.array(interfaceGroupSchema)}),
  z.strictObject({ op: z.literal('update_interfaces'), moduleId: idSchema, interfaces: z.array(interfaceSchema) }),
  z.strictObject({ op: z.literal('update_specification'), specification: specificationSchema }),
  z.strictObject({ op: z.literal('update_provenance'), provenance: provenanceSchema }),
  z.strictObject({ op: z.literal('update_domains'), clocks: z.array(clockSchema), resets: z.array(resetSchema) }),
  z.strictObject({ op: z.literal('update_module_timing'), moduleId: idSchema, clock: idSchema.nullable(), reset: idSchema.nullable(), timing: timingSchema }),
  z.strictObject({ op: z.literal('replace_architecture'), model: modelSchema }),
  z.strictObject({ op: z.literal('delete_module'), moduleId: idSchema }),
  z.strictObject({ op: z.literal('connect'), connection: linkSchema }),
  z.strictObject({ op: z.literal('disconnect'), connectionId: idSchema })
]);
export const proposalSchema = z.strictObject({ baseHash: hashSchema, reason: z.string().trim().min(1), commands: z.array(commandSchema).min(1) });
const position = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
export const readingLayoutSchema = z.strictObject({
  modelHash: hashSchema, reason: z.string().trim().min(1),
  mainPath: z.array(idSchema).min(1), control: z.array(idSchema),
  adjacent: z.array(z.strictObject({ node: idSchema, anchor: idSchema }))
});
export const scopeLayoutSchema = z.strictObject({ positions: z.record(z.string().min(1), position), reading: readingLayoutSchema.optional(), viewport: z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite().positive() }) });
export const layoutSchema = z.strictObject({ schemaVersion: z.literal(1), scopes: z.record(idSchema, scopeLayoutSchema) });
export const reviewSchema = z.strictObject({ modelHash: hashSchema, reviewer: z.string().trim().min(1), reviewedAt: z.iso.datetime(), scopeHash: hashSchema.optional(), scopeParts: z.record(z.string(), hashSchema).optional() });
export const moduleReviewsSchema = z.strictObject({ schemaVersion: z.literal(1), modules: z.record(idSchema, reviewSchema) });
export type ModuleReviews = z.infer<typeof moduleReviewsSchema>;
export type Specification = z.infer<typeof specificationSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Module = z.infer<typeof moduleSchema>;
export type Interface = z.infer<typeof interfaceSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type Link = z.infer<typeof linkSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Layout = z.infer<typeof layoutSchema>;
export type ScopeLayout = z.infer<typeof scopeLayoutSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ReviewStatus = 'DRAFT' | 'APPROVED' | 'STALE';
export type Issue = { location?:{scope?:string;moduleId:string;interfaceId?:string;index?:number;bits?:{lsb:number;msb:number}[]}; causeIds?:string[]; evidenceIds?:string[]; code: string; severity: 'error' | 'warning'; blocks: ('commit' | 'review')[]; target: string; message: string };
