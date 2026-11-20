// API responses contain user-specific data, so browsers and shared caches
// must never store them.
const noStore = { "Cache-Control": "private, no-store" };

export function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: noStore });
}

export function errorResponse(status: number, error: string) {
  return jsonResponse({ error }, status);
}

// Logs the cause on the server and returns a generic 500 to the client.
export function internalError(message: string, cause: unknown) {
  console.error(message, cause);
  return errorResponse(500, "Internal server error");
}
