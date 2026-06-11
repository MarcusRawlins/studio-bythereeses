import { importHoneyBookProjectsFromCsv } from "@/lib/honeybook-import";

const defaultFilePath = "/Volumes/reeseai-memory/businesses/photography/clients/honeybook-data/January-2020-February-2026-Project-report-(HoneyBook).csv";

function optionValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const filePath = optionValue("file") ?? defaultFilePath;
  const cutoffDate = optionValue("cutoff") ?? new Date().toISOString().slice(0, 10);
  const apply = process.argv.includes("--apply");
  const json = process.argv.includes("--json");

  const result = await importHoneyBookProjectsFromCsv({
    filePath,
    cutoffDate,
    apply,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${apply ? "Imported" : "Dry run"} HoneyBook projects from ${filePath}`);
  console.log(`Cutoff date: ${cutoffDate}`);
  console.log(`Scanned rows: ${result.scannedRows}`);
  console.log(`Candidates: ${result.candidates.length}`);
  console.log(`Imported: ${result.importedCount}`);
  console.log(`Skipped: ${JSON.stringify(result.skippedCounts)}`);

  for (const candidate of result.candidates.slice(0, 25)) {
    console.log(`- ${candidate.eventDate} | ${candidate.projectName} | ${candidate.clientName} <${candidate.clientEmail}> | ${candidate.booked ? "booked" : "inquiry"}`);
  }
  if (result.candidates.length > 25) {
    console.log(`...and ${result.candidates.length - 25} more candidates. Re-run with --json for the full list.`);
  }

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write canonical projects, clients, participants, source notes, and activity logs.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
