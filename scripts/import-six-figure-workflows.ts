import { upsertSixFigureWorkflowTemplates } from "@/lib/six-figure-workflows";

async function main() {
  const result = await upsertSixFigureWorkflowTemplates();
  console.log(`Upserted ${result.upserted} Studio workflow templates.`);
  for (const id of result.ids) {
    console.log(`- ${id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
