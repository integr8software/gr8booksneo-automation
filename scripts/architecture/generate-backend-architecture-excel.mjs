#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ExcelJS from "exceljs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function shortId(item) {
  if (item.id) return item.id;
  return crypto
    .createHash("sha1")
    .update(`${item.rule || ""}|${item.file || ""}|${item.line || ""}|${item.symbol || ""}`)
    .digest("hex")
    .slice(0, 12);
}

function setTitle(ws, title, subtitle, lastColumn) {
  ws.mergeCells(`A1:${lastColumn}1`);
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { bold: true, size: 18, color: { argb: "FFFFFFFF" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  ws.getCell("A1").alignment = { vertical: "middle" };
  ws.getRow(1).height = 28;

  ws.mergeCells(`A2:${lastColumn}2`);
  ws.getCell("A2").value = subtitle;
  ws.getCell("A2").font = { italic: true, color: { argb: "FF555555" } };
  ws.getCell("A2").alignment = { wrapText: true, vertical: "top" };
  ws.getRow(2).height = 32;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 26;
}

function applySeverityStyle(cell, severity) {
  if (severity === "BLOCKER") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4CCCC" } };
    cell.font = { bold: true, color: { argb: "FF9C0006" } };
  } else if (severity === "WARNING") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
    cell.font = { bold: true, color: { argb: "FF7F6000" } };
  } else {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2F0D9" } };
    cell.font = { bold: true, color: { argb: "FF375623" } };
  }
}

const args = parseArgs(process.argv);
const repositoryRoot = path.resolve(args["repository-root"] || process.cwd());
const inputPath = path.resolve(
  args.input ||
    path.join(repositoryRoot, "reports", "weekly-architecture", "backend-architecture-results.json"),
);
const outputPath = path.resolve(
  args.output ||
    path.join(repositoryRoot, "reports", "weekly-architecture", "Backend-Weekly-Architecture.xlsx"),
);

if (!fs.existsSync(inputPath)) {
  console.error(`Architecture JSON not found: ${inputPath}`);
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const findings = Array.isArray(report.findings) ? report.findings : [];

const workbook = new ExcelJS.Workbook();
workbook.creator = "Gr8BooksNeo QA Automation";
workbook.subject = "Backend Weekly Architecture Review";
workbook.title = "Backend Weekly Architecture";
workbook.created = new Date();

const readme = workbook.addWorksheet("Read Me", { views: [{ state: "frozen", ySplit: 2 }] });
setTitle(
  readme,
  "Backend Weekly Architecture Review",
  "Advisory architecture backlog for backend develop. BLOCKER means review/fix priority inside this report; the weekly workflow itself does not block a PR or merge.",
  "F",
);

const readmeRows = [
  ["Purpose", "Review the current backend develop architecture once per week and make architecture drift visible without turning historical/incomplete work into a merge failure."],
  ["How to use it", "Start with BLOCKER-class findings, verify context, then refactor only when the finding represents a real architecture problem."],
  ["Unfinished modules", "The analyzer evaluates files that currently exist. It does not fail a module because future controllers, DTOs, services, tests, or features do not exist yet."],
  ["Swagger", "Public endpoints and API-facing DTOs are expected to keep Swagger metadata consistent."],
  ["Jest", "Meaningful service business rules should have focused Jest coverage. Simple CRUD/wiring does not need artificial tests."],
  ["Controller architecture", "Controllers should stay thin and should not directly own Prisma/persistence behavior."],
  ["ERP focus", "Prioritize calculations, journal/debit-credit integrity, duplicate/partial transactions, tax/currency, permissions, reconciliation, audit integrity, and state transitions."],
  ["Auto-update", "A new workbook is generated from the latest develop snapshot on each scheduled workflow run. Manual edits to the downloaded workbook are not persisted."],
  ["Generated", report.generatedAt || ""],
  ["Files scanned", report.filesScanned ?? 0],
  ["Architecture findings", report.architectureFindingCount ?? findings.length],
];

readme.getRange = undefined;
let rowNo = 4;
for (const [label, value] of readmeRows) {
  readme.getCell(`A${rowNo}`).value = label;
  readme.getCell(`A${rowNo}`).font = { bold: true };
  readme.getCell(`B${rowNo}`).value = value;
  readme.mergeCells(`B${rowNo}:F${rowNo}`);
  readme.getCell(`B${rowNo}`).alignment = { wrapText: true, vertical: "top" };
  rowNo += 1;
}

rowNo += 1;
readme.getCell(`A${rowNo}`).value = "Severity";
readme.getCell(`B${rowNo}`).value = "Meaning";
styleHeader(readme.getRow(rowNo));
rowNo += 1;
for (const [severity, meaning] of [
  ["BLOCKER", "Highest review priority. Advisory weekly classification; verify before refactoring."],
  ["WARNING", "Architecture concern worth reviewing, but usually lower confidence/risk."],
  ["INFORMATION", "Context or low-priority observation."],
]) {
  readme.getCell(`A${rowNo}`).value = severity;
  applySeverityStyle(readme.getCell(`A${rowNo}`), severity);
  readme.getCell(`B${rowNo}`).value = meaning;
  readme.mergeCells(`B${rowNo}:F${rowNo}`);
  rowNo += 1;
}
readme.columns = [
  { width: 24 },
  { width: 34 },
  { width: 18 },
  { width: 18 },
  { width: 18 },
  { width: 18 },
];

const summary = workbook.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 2 }] });
setTitle(summary, "Backend Architecture Summary", "Current snapshot from the weekly full-tree advisory scan.", "F");

const metrics = [
  ["Files Scanned", report.filesScanned ?? 0],
  ["Architecture Findings", report.architectureFindingCount ?? findings.length],
  ["Blockers", report.counts?.blocker ?? findings.filter((f) => f.severity === "BLOCKER").length],
  ["Warnings", report.counts?.warning ?? findings.filter((f) => f.severity === "WARNING").length],
  ["Information", report.counts?.information ?? findings.filter((f) => f.severity === "INFORMATION").length],
  ["Generated", report.generatedAt || ""],
];

summary.getCell("A4").value = "Metric";
summary.getCell("B4").value = "Value";
styleHeader(summary.getRow(4));
let sr = 5;
for (const [label, value] of metrics) {
  summary.getCell(`A${sr}`).value = label;
  summary.getCell(`B${sr}`).value = value;
  sr += 1;
}

function groupedCounts(key) {
  const map = new Map();
  for (const f of findings) {
    const value = f[key] || "(blank)";
    map.set(value, (map.get(value) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function writeGroup(startColumn, title, rows) {
  const c1 = startColumn;
  const c2 = startColumn + 1;
  const titleCell = summary.getCell(4, c1);
  titleCell.value = title;
  summary.getCell(4, c2).value = "Count";
  summary.getRow(4).getCell(c1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summary.getRow(4).getCell(c2).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summary.getRow(4).getCell(c1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
  summary.getRow(4).getCell(c2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
  let r = 5;
  for (const [name, count] of rows) {
    summary.getCell(r, c1).value = name;
    summary.getCell(r, c2).value = count;
    r += 1;
  }
}

writeGroup(4, "Findings by Module", groupedCounts("module"));
writeGroup(7, "Findings by Rule", groupedCounts("rule"));
summary.columns = [
  { width: 24 }, { width: 18 }, { width: 4 },
  { width: 28 }, { width: 12 }, { width: 4 },
  { width: 48 }, { width: 12 },
];

const sheet = workbook.addWorksheet("Architecture Findings", {
  views: [{ state: "frozen", ySplit: 4 }],
});
setTitle(
  sheet,
  "Backend Architecture Findings",
  "Review context before changing code. This weekly report is advisory and should not trigger mass refactors solely to reduce the count.",
  "L",
);

const headers = [
  "Severity",
  "Priority / Action",
  "Module",
  "Location",
  "Line",
  "Symbol / Item",
  "Rule",
  "Finding",
  "Why It Matters",
  "Recommended Fix",
  "Confidence",
  "Finding ID",
];
sheet.addRow([]);
const headerRow = sheet.addRow(headers);
styleHeader(headerRow);

for (const item of findings) {
  const location = item.line ? `${item.file}:${item.line}` : item.file;
  const row = sheet.addRow([
    item.severity || "INFORMATION",
    item.priority || "",
    item.module || "",
    location || "",
    item.line ?? "",
    item.symbol || "",
    item.rule || "",
    item.finding || item.message || "",
    item.whyItMatters || "",
    item.recommendation || "",
    item.confidence || "",
    shortId(item),
  ]);

  applySeverityStyle(row.getCell(1), item.severity || "INFORMATION");
  row.alignment = { vertical: "top", wrapText: true };
}

sheet.autoFilter = {
  from: { row: 4, column: 1 },
  to: { row: Math.max(4, sheet.rowCount), column: headers.length },
};

sheet.columns = [
  { width: 13 },
  { width: 19 },
  { width: 20 },
  { width: 52 },
  { width: 9 },
  { width: 24 },
  { width: 42 },
  { width: 58 },
  { width: 54 },
  { width: 58 },
  { width: 12 },
  { width: 16 },
];

for (const ws of workbook.worksheets) {
  for (const row of ws.eachRow ? [] : []) void row;
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.alignment = { ...row.alignment, vertical: "top", wrapText: true };
  });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
await workbook.xlsx.writeFile(outputPath);

console.log(`Backend architecture Excel generated.`);
console.log(`Findings: ${findings.length}`);
console.log(`Output: ${outputPath}`);
