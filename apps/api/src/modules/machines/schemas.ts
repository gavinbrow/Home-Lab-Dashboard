import { z } from 'zod';

// Module-local request validators approved by the shared-contract owner.
const name = z.string().trim().min(1).max(120);
const tags = z.array(z.string().trim().min(1).max(48)).max(32);
export const MachineCreateSchema = z.object({ name, os: z.enum(['linux', 'windows', 'unknown']).default('unknown'), tags: tags.default([]), max_concurrent_operations: z.number().int().min(1).max(32).default(1) }).strict();
export const MachineUpdateSchema = z.object({ name: name.optional(), tags: tags.optional(), max_concurrent_operations: z.number().int().min(1).max(32).optional(), revision: z.number().int().positive() }).strict().refine(value => value.name !== undefined || value.tags !== undefined || value.max_concurrent_operations !== undefined);
export const MachineTestSchema = z.object({ capability: z.enum(['monitoring', 'ssh', 'sftp', 'desktop', 'runner', 'containers']), idempotency_key: z.string().min(1).max(200), runner: z.object({ workspace_id: z.uuid(), execution_identity_id: z.uuid(), grant_id: z.uuid() }).strict().optional(), container: z.object({ target_id: z.uuid(), grant_id: z.uuid() }).strict().optional() }).strict().refine(value => value.capability === 'runner' ? !!value.runner : !value.runner, { message: 'Runner test requires an explicitly selected workspace, execution identity and persisted grant.' }).refine(value => value.capability === 'containers' ? !!value.container : !value.container, { message: 'Container test requires an enrolled target and persisted status-action grant.' });
export const MetricsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
  resolution: z.enum(['raw', '5m', '1h']).default('raw'),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
}).strict().refine(value => Date.parse(value.to) >= Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86400000, { message: 'Time range must be ordered and at most 31 days.' });
