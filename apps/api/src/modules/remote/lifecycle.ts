import type { ApiContext } from '../../core/context.js';
import { RemoteError } from './security.js';
export async function remoteAccessReady(context:Pick<ApiContext,'db'|'config'>):Promise<boolean> {
  if(context.config.restoreMode)return false;
  const row=(await context.db.query('SELECT restore_mode,maintenance_mode FROM runtime_control WHERE singleton=true')).rows[0];
  return Boolean(row&&!row.restore_mode&&!row.maintenance_mode);
}
export async function assertRemoteEnabled(context:Pick<ApiContext,'db'|'config'>):Promise<void> {
  if(!await remoteAccessReady(context))throw new RemoteError('REMOTE_MAINTENANCE_OR_RESTORE_MODE',503);
}
