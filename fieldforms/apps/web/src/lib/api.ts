import { CSRF_HEADER } from '../offline/transport';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True when the request never reached the server (offline, DNS, connection reset). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof ApiError && err.status === 0);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? CSRF_HEADER : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Me {
  id: string;
  role: 'admin' | 'manager' | 'supervisor';
  displayName: string;
  siteIds: string[] | null;
  privacyNotice: { version: string; text: string };
  consentRequired: boolean;
}

export interface Bootstrap {
  generatedAt: string;
  settings: { shiftGraceMinutes: number };
  sites: {
    id: string;
    name: string;
    lat: number | null;
    lng: number | null;
    geofence_metres: number;
    region_id: string;
    region_name: string;
    company_id: string;
    company_name: string;
  }[];
  shifts: { id: string; site_id: string; name: string; kind: 'day' | 'night'; start_time: string; end_time: string }[];
  employees: { id: string; employee_no: string; first_name: string; last_name: string; title: string | null; site_id: string }[];
  pool: { id: string; employee_no: string; first_name: string; last_name: string; pool_region_id: string }[];
}
