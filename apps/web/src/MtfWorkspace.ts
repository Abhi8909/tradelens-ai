import type { PortfolioDocument } from '../../../packages/core/src/mtf/dashboard.ts';
import type { MtfSnapshot } from '../../../packages/core/src/mtf/types.ts';
export type MtfUser = { id: string; username: string; csrf: string };
export type DashboardRow = { document: PortfolioDocument; snapshot: MtfSnapshot };
export async function mtfRequest(path: string, user?: MtfUser | null, input?: unknown, method = input === undefined ? 'GET' : 'POST', key?: string) {
  const response = await fetch(`/api/mtf/${path}`, { method, credentials: 'same-origin', headers: input === undefined ? {} : { 'content-type': 'application/json', ...(user ? { 'x-mtf-csrf': user.csrf } : {}), ...(method === 'GET' ? {} : { 'idempotency-key': key ?? crypto.randomUUID() }) }, body: input === undefined ? undefined : JSON.stringify(input) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Could not complete request'); return data;
}
export function downloadPrivate(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Share initialization across React StrictMode mounts; keep the identity in HttpOnly cookies.
let openingWorkspace: Promise<{ user: MtfUser }> | null = null;
export function openMtfWorkspace(): Promise<{ user: MtfUser }> {
  if (!openingWorkspace) openingWorkspace = mtfRequest('workspace', null, {}).finally(() => { openingWorkspace = null; });
  return openingWorkspace;
}
