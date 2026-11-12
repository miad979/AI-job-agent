import { HttpError } from "../shared/core.ts";
import { createLocalBackend } from "../shared/localBackend.ts";

/**
 * Where the Orbit API lives:
 *  - default: the Express server on this origin (`npm run dev:full`, `npm start`)
 *  - VITE_API_URL=https://…: an Express server hosted somewhere else
 *  - VITE_BACKEND=local (the GitHub Pages build): no server at all; the same rules run in this browser over localStorage
 */
export const LOCAL_MODE = import.meta.env.VITE_BACKEND === "local";
const API_BASE = String(import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
const local = LOCAL_MODE ? createLocalBackend(window.localStorage) : null;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

let unauthorizedHandler: (() => void) | undefined;
/** Called when a request made with a token comes back 401, i.e. the session expired. */
export const setUnauthorizedHandler = (handler?: () => void) => { unauthorizedHandler = handler; };

export async function request<T>(path: string, method = "GET", body?: unknown, token = ""): Promise<T> {
  if (local) {
    try { return (await local.handle(method, path, body)) as T; }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 401 && token) unauthorizedHandler?.();
      throw new ApiError(error.status, error.message);
    }
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError(0, "Cannot reach the Orbit API. Start it with `npm run dev:full`."); }
  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const payload: unknown = isJson ? await res.json().catch(() => ({})) : await res.text();
  if (res.status === 401 && token) unauthorizedHandler?.();
  if (!res.ok) throw new ApiError(res.status, (isJson && (payload as { error?: string }).error) || `Request failed (${res.status})`);
  return payload as T;
}
