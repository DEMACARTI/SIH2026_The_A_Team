import type { Command, PortSummary, Status } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new Error('backend unreachable');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface CommandResult {
  ok: true;
  id: number;
  delivered: { serial: boolean; wifiQueue: boolean; simulator: boolean };
}

export const sendCommand = (cmd: Command) =>
  request<CommandResult>('/api/commands', { method: 'POST', body: JSON.stringify(cmd) });

export const listPorts = () => request<{ ports: PortSummary[] }>('/api/ports').then((r) => r.ports);

export const connectSerial = (port: string, baudRate: number) =>
  request<{ ok: true; status: Status }>('/api/connect', { method: 'POST', body: JSON.stringify({ port, baudRate }) });

export const disconnectSerial = () => request<{ ok: true }>('/api/disconnect', { method: 'POST' });
