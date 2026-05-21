import { redirect } from "next/navigation";

export default async function EditQuestionnairePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/questionnaires/${id}`);
}
