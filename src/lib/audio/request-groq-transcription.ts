import { setTimeout as wait } from "node:timers/promises";

const endpoint = "https://api.groq.com/openai/v1/audio/transcriptions";
const retryableStatuses = new Set([429, 500, 502, 503]);
const maxAttempts = 3;

function retryDelayMs(response: Response, attempt: number): number {
  const fallback = (attempt + 1) * 1_000;
  const retryAfter = response.headers.get("retry-after")?.trim();

  if (!retryAfter) return fallback;

  const requestedDelay = /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1_000
    : Date.parse(retryAfter) - Date.now();

  return Number.isNaN(requestedDelay)
    ? fallback
    : Math.max(fallback, requestedDelay);
}

export async function requestGroqTranscription(
  form: FormData,
  apiKey: string,
  signal: AbortSignal,
  deadline: number,
): Promise<Response | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    signal.throwIfAborted();

    if (Date.now() >= deadline) return null;

    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        cache: "no-store",
        redirect: "error",
        signal,
      });
    } catch {
      signal.throwIfAborted();
      return null;
    }

    signal.throwIfAborted();

    if (
      !retryableStatuses.has(response.status) ||
      attempt === maxAttempts - 1
    ) {
      return response;
    }

    const delayMs = retryDelayMs(response, attempt);

    if (delayMs >= deadline - Date.now()) {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    await wait(delayMs, undefined, { signal });
  }

  return null;
}