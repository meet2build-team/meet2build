import { requireUser } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store" };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ projectId: string }> };

// Lists the meetings of a project. RLS hides projects the user is not a
// member of, so a missing and an inaccessible project both return 404.
export async function GET(_request: Request, { params }: Context) {
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

  const project = await auth.supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();

  if (project.error) {
    console.error("Failed to load project", project.error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  if (!project.data) {
    return Response.json(
      { error: "Project not found" },
      { status: 404, headers: noStore },
    );
  }

  const { data, error } = await auth.supabase
    .from("meetings")
    .select("id, project_id, title, created_by, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to list meetings", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  return Response.json({ meetings: data }, { headers: noStore });
}

// Creates a meeting. The create_meeting database function checks that the
// caller is a member of the project before inserting.
export async function POST(request: Request, { params }: Context) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: noStore },
    );
  }

  const title =
    typeof body === "object" && body !== null && "title" in body
      ? body.title
      : undefined;

  if (typeof title !== "string" || title.trim() === "") {
    return Response.json(
      { error: "Meeting title must be a nonempty string" },
      { status: 400, headers: noStore },
    );
  }

  const { data, error } = await auth.supabase.rpc("create_meeting", {
    p_project_id: projectId,
    p_title: title.trim(),
  });

  if (error) {
    // 42501: the project does not exist or the user is not a member.
    if (error.code === "42501") {
      return Response.json(
        { error: "Project not found" },
        { status: 404, headers: noStore },
      );
    }

    // 22023: the database rejected the title.
    if (error.code === "22023") {
      return Response.json(
        { error: "Meeting title must be a nonempty string" },
        { status: 400, headers: noStore },
      );
    }

    console.error("Failed to create meeting", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  return Response.json(data, { status: 201, headers: noStore });
}
