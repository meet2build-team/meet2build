import { requireUser } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store" };

// Lists the projects the user can see. RLS returns only projects
// where the user is a member.
export async function GET() {
  const auth = await requireUser();

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: noStore },
    );
  }

  const { data, error } = await auth.supabase
    .from("projects")
    .select("id, name, created_by, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to list projects", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  return Response.json({ projects: data }, { headers: noStore });
}

// Creates a project. The create_project database function inserts the
// project and makes the caller its owner in one transaction.
export async function POST(request: Request) {
  const auth = await requireUser();

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: noStore },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: noStore },
    );
  }

  const name =
    typeof body === "object" && body !== null && "name" in body
      ? body.name
      : undefined;

  if (typeof name !== "string" || name.trim() === "") {
    return Response.json(
      { error: "Project name must be a nonempty string" },
      { status: 400, headers: noStore },
    );
  }

  const { data, error } = await auth.supabase.rpc("create_project", {
    p_name: name.trim(),
  });

  if (error) {
    // 22023: the database rejected the name.
    if (error.code === "22023") {
      return Response.json(
        { error: "Project name must be a nonempty string" },
        { status: 400, headers: noStore },
      );
    }

    console.error("Failed to create project", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  return Response.json(data, { status: 201, headers: noStore });
}
