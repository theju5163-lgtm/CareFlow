export async function apiRequest<T = unknown>(path: string, token = '', options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const hospitalId = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('careflow-hospital-id') : null;
  const headers = { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(hospitalId ? { 'X-Hospital-Id': hospitalId } : {}), ...((options.headers || {}) as Record<string, string>) };
  const response = await fetch(`/api${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}
