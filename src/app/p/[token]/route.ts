import { authenticatePortalToken } from "@/lib/portal";
import { redirect } from "next/navigation";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await authenticatePortalToken(token);

  if (!result.ok) {
    redirect("/portal?error=invalid");
  }

  redirect("/portal");
}
