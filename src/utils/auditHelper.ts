import type { Request } from 'express';
import type { AuditStore, AuditLogInput } from '../services/AuditStore.js';
import type { AuthUser } from '../auth/AuthService.js';

export function getClientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim();
  }
  return req.socket.remoteAddress ?? undefined;
}

export function auditFromRequest(
  auditStore: AuditStore,
  req: Request,
  input: Omit<AuditLogInput, 'userId' | 'username' | 'ipAddress'>
): void {
  const user: AuthUser | undefined = req.authUser;
  auditStore.log({
    ...input,
    userId: user?.id ?? null,
    username: user?.username ?? null,
    ipAddress: getClientIp(req),
  });
}
