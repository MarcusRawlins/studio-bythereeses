import { db } from "@/db/client";
import { clients, projectParticipants, projectSources, projects } from "@/db/schema";
import { createProjectFromAgent } from "@/lib/crm";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";

type HoneyBookImportInput = {
  filePath: string;
  cutoffDate: string;
  apply?: boolean;
  now?: string;
};

type HoneyBookRow = Record<string, string>;

export type HoneyBookImportCandidate = {
  rowNumber: number;
  sourceId: string;
  projectName: string;
  clientName: string;
  clientEmail: string;
  eventDate: string;
  projectType: string;
  booked: boolean;
  totalProjectValueCents: number | null;
  totalPaidCents: number | null;
};

export type HoneyBookImportResult = {
  scannedRows: number;
  candidates: HoneyBookImportCandidate[];
  imported: Array<{ projectId: string; projectName: string; clientEmail: string; sourceId: string }>;
  importedCount: number;
  skippedCounts: {
    beforeCutoff: number;
    duplicateExportRow: number;
    existingProject: number;
    missingClientEmail: number;
    invalidEventDate: number;
  };
};

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += character;
  }

  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);

  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])));
}

function cleanText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() || null;
}

function cleanEmail(value: string | null | undefined) {
  return cleanText(value)?.toLowerCase() ?? null;
}

function emailFromText(value: string | null | undefined) {
  return cleanEmail(value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null);
}

function nameWithoutEmail(value: string | null | undefined) {
  const text = cleanText(value);
  if (!text) return null;
  const email = emailFromText(text);
  return cleanText(email ? text.replace(email, "") : text);
}

function parseDate(value: string | null | undefined) {
  const text = cleanText(value);
  if (!text) return null;
  const isoPrefix = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoPrefix) return isoPrefix;

  const parsed = new Date(`${text} 12:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function centsFromDollars(value: string | null | undefined) {
  const number = Number(cleanText(value)?.replace(/[^0-9.-]/g, "") ?? "");
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100);
}

function normalizedProjectName(value: string) {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\b(project|wedding)\b/g, "")
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(value: string) {
  const parts = value.split(" ").filter(Boolean);
  return {
    firstName: parts[0] ?? "Client",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

function rowClientName(row: HoneyBookRow) {
  return cleanText(row["Full Name"]) ?? nameWithoutEmail(row["Client Info"]) ?? "HoneyBook Client";
}

function rowClientEmail(row: HoneyBookRow) {
  return cleanEmail(row["Email Address"]) ?? emailFromText(row["Client Info"]);
}

function rowProjectName(row: HoneyBookRow) {
  return cleanText(row["Project Name"]);
}

function rowProjectType(row: HoneyBookRow) {
  return cleanText(row["Project Type"])?.toLowerCase() ?? "wedding";
}

async function projectExists(candidate: HoneyBookImportCandidate) {
  const source = await db.query.projectSources.findFirst({
    where: and(
      eq(projectSources.sourceType, "honeybook_project_report"),
      eq(projectSources.sourceId, candidate.sourceId),
    ),
  });
  if (source) return true;

  const rows = await db
    .select({ project: projects, client: clients })
    .from(projects)
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id));

  const candidateName = normalizedProjectName(candidate.projectName);
  for (const row of rows) {
    if (row.project.eventDate !== candidate.eventDate) continue;
    if (row.client?.email !== candidate.clientEmail) continue;
    const existingName = normalizedProjectName(row.project.name);
    if (existingName === candidateName || existingName.includes(candidateName) || candidateName.includes(existingName)) {
      return true;
    }
  }

  return false;
}

function candidateFromRow(row: HoneyBookRow, rowNumber: number) {
  const projectName = rowProjectName(row);
  const eventDate = parseDate(row["Project Date"]);
  const clientEmail = rowClientEmail(row);
  const clientName = rowClientName(row);
  if (!projectName || !eventDate || !clientEmail) return null;

  return {
    rowNumber,
    sourceId: `row-${rowNumber}`,
    projectName,
    clientName,
    clientEmail,
    eventDate,
    projectType: rowProjectType(row),
    booked: cleanText(row["Booked (yes/no)"])?.toLowerCase() === "yes",
    totalProjectValueCents: centsFromDollars(row["Total Project Value"]),
    totalPaidCents: centsFromDollars(row["Total Paid"]),
  } satisfies HoneyBookImportCandidate;
}

export async function importHoneyBookProjectsFromCsv(input: HoneyBookImportInput): Promise<HoneyBookImportResult> {
  const rows = parseCsv(fs.readFileSync(input.filePath, "utf8")) as HoneyBookRow[];
  const cutoffDate = parseDate(input.cutoffDate);
  if (!cutoffDate) throw new Error("A valid cutoffDate is required.");

  const result: HoneyBookImportResult = {
    scannedRows: rows.length,
    candidates: [],
    imported: [],
    importedCount: 0,
    skippedCounts: {
      beforeCutoff: 0,
      duplicateExportRow: 0,
      existingProject: 0,
      missingClientEmail: 0,
      invalidEventDate: 0,
    },
  };
  const seenKeys = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const eventDate = parseDate(row["Project Date"]);
    if (!eventDate) {
      result.skippedCounts.invalidEventDate += 1;
      continue;
    }
    if (eventDate < cutoffDate) {
      result.skippedCounts.beforeCutoff += 1;
      continue;
    }

    const clientEmail = rowClientEmail(row);
    if (!clientEmail) {
      result.skippedCounts.missingClientEmail += 1;
      continue;
    }

    const candidate = candidateFromRow(row, rowNumber);
    if (!candidate) continue;
    const duplicateKey = [
      normalizedProjectName(candidate.projectName),
      candidate.clientEmail,
      candidate.eventDate,
    ].join("|");
    if (seenKeys.has(duplicateKey)) {
      result.skippedCounts.duplicateExportRow += 1;
      continue;
    }
    seenKeys.add(duplicateKey);

    if (await projectExists(candidate)) {
      result.skippedCounts.existingProject += 1;
      continue;
    }

    result.candidates.push(candidate);
  }

  if (!input.apply) return result;

  for (const candidate of result.candidates) {
    const { firstName, lastName } = splitName(candidate.clientName);
    const created = await createProjectFromAgent({
      name: candidate.projectName,
      type: candidate.projectType,
      stage: candidate.booked ? "retainer_paid" : "inquiry",
      status: "active",
      eventDate: candidate.eventDate,
      budgetCents: candidate.totalProjectValueCents,
      primaryClient: {
        firstName,
        lastName,
        email: candidate.clientEmail,
        role: "primary",
      },
      intakeSource: {
        kind: "honeybook_import",
        title: "HoneyBook project export row",
        body: [
          `Project: ${candidate.projectName}`,
          `Client: ${candidate.clientName} <${candidate.clientEmail}>`,
          `Event date: ${candidate.eventDate}`,
          `Booked: ${candidate.booked ? "yes" : "no"}`,
        ].join("\n"),
        summary: "Imported from HoneyBook project report.",
        occurredAt: input.now,
        capturedBy: "The Reeses Studio Agent",
        sourceType: "honeybook_project_report",
        sourceId: candidate.sourceId,
        metadata: {
          rowNumber: candidate.rowNumber,
          leadSource: cleanText(rows[candidate.rowNumber - 1]["Lead Source"]),
          projectCreationDate: cleanText(rows[candidate.rowNumber - 1]["Project Creation Date"]),
          bookedDate: cleanText(rows[candidate.rowNumber - 1]["Booked Date"]),
          totalPaidCents: candidate.totalPaidCents,
        },
      },
    });
    result.imported.push({
      projectId: created.id,
      projectName: candidate.projectName,
      clientEmail: candidate.clientEmail,
      sourceId: candidate.sourceId,
    });
  }

  result.importedCount = result.imported.length;
  return result;
}
