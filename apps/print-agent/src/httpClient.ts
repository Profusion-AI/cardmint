import { agentConfig } from "./config.js";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(handle);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(handle);
        reject(err);
      });
  });
}

export async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const url = new URL(path, agentConfig.backendUrl);

  const response = await withTimeout(
    fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Print-Agent-Token": agentConfig.token,
      },
      body: JSON.stringify(body),
    }),
    agentConfig.requestTimeoutMs
  );

  const data = (await response.json()) as TResponse;
  if (!response.ok) {
    const msg = (data as any)?.error || (data as any)?.message || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

