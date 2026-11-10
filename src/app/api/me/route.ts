import { requireUser } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET() {
  const auth = await requireUser();

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: noStore },
    );
  }

  return Response.json(
    { id: auth.user.id, email: auth.user.email ?? null },
    { headers: noStore },
  );
}
