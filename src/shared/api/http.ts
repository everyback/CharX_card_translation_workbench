export class ApiError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(message: string, status: number, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const hasJsonBody = Boolean(init?.body) && !(init?.body instanceof FormData);
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as Record<string, unknown>;
    throw new ApiError(String(body.error || `请求失败：${response.status}`), response.status, body);
  }
  return response.json() as Promise<T>;
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}
