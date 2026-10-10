import { z } from 'zod';
import { hashSchema } from './schema';

export const protocolVersion = 1;
export const serviceInfoSchema = z.object({
  product: z.literal('rtl-architect'), protocolVersion: z.literal(protocolVersion), toolVersion: z.string(),
  workspaceId: hashSchema, workspaceRoot: z.string(), instanceId: z.string(), pid: z.number().int().positive(),
  apiUrl: z.string().url(), webUrl: z.string().url(),
});
export type ServiceInfo = z.infer<typeof serviceInfoSchema>;
