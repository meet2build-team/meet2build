import { authenticate } from "@/lib/api/auth";
import { jsonResponse } from "@/lib/api/response";

export async function GET() {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  return jsonResponse({ id: auth.user.id, email: auth.user.email ?? null });
}
