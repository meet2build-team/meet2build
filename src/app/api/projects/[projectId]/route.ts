import { requireUser } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store" };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns one project. RLS hides projects the user is not a member of,
// so a missing and an inaccessible project both return 404.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = await requireUser();

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: noStore },
    );
  }

  const { projectId } = await params;

  if (!uuidPattern.test(projectId)) {
    return Response.json(
      { error: "Invalid project ID" },
      { status: 400, headers: noStore },
    );
  }

  const { data, error } = await auth.supabase
    .from("projects")
    .select("id, name, created_by, created_at")
    .eq("id", projectId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load project", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  if (!data) {
    return Response.json(
      { error: "Project not found" },
      { status: 404, headers: noStore },
    );
  }

  return Response.json(data, { headers: noStore });
}
