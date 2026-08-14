import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function resolveJsonFile(filePath, label, candidates = []) {
  if (!filePath) {
    throw new Error(`${label} path is empty.`);
  }

  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} path does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);

  if (stat.isFile()) {
    return resolved;
  }

  for (const candidate of candidates) {
    const nested = path.join(resolved, candidate);

    if (
      fs.existsSync(nested) &&
      fs.statSync(nested).isFile()
    ) {
      return nested;
    }
  }

  throw new Error(
    `${label} path points to a directory instead of a JSON file: ${resolved}`,
  );
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const withoutBom = raw.replace(/^\uFEFF/, "");
  return JSON.parse(withoutBom);
}

function git(repositoryRoot, args) {
  return execFileSync(
    "git",
    ["-C", repositoryRoot, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    },
  ).trim();
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function prettyName(value) {
  return String(value ?? "")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getModuleName(filePath) {
  const file = normalizePath(filePath);

  const patterns = [
    /app\/\(modules\)\/[^/]+\/([^/]+)/i,
    /app\/modules\/[^/]+\/([^/]+)/i,
    /app\/src\/ui\/modules\/[^/]+\/([^/]+)/i,
    /src\/modules\/([^/]+)/i,
    /src\/services\/([^/]+)/i,
  ];

  for (const pattern of patterns) {
    const match = file.match(pattern);

    if (match?.[1]) {
      return prettyName(match[1]);
    }
  }

  const segments = file.split("/").filter(Boolean);

  if (segments.length >= 2) {
    return prettyName(segments[segments.length - 2]);
  }

  return prettyName(path.basename(file));
}

function classifyFile(filePath) {
  const file = normalizePath(filePath).toLowerCase();

  if (/\/add\/page\.(tsx|jsx)$/.test(file)) {
    return "Add page";
  }

  if (/\/edit\/.*\/page\.(tsx|jsx)$/.test(file)) {
    return "Edit page";
  }

  if (/\/view\/.*\/page\.(tsx|jsx)$/.test(file)) {
    return "View page";
  }

  if (/\/page\.(tsx|jsx)$/.test(file)) {
    return "page";
  }

  if (/\.spec\.(ts|tsx|js|jsx)$/.test(file)) {
    return "test";
  }

  if (file.includes("controller.")) {
    return "controller";
  }

  if (file.includes("service.")) {
    return "service";
  }

  if (
    file.includes("/dto/") ||
    file.includes(".dto.")
  ) {
    return "DTO";
  }

  if (
    file.includes("/types/") ||
    file.includes("types.")
  ) {
    return "types";
  }

  if (file.endsWith("schema.prisma")) {
    return "database schema";
  }

  return "file";
}

function shorten(value, maximum = 100) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maximum) {
    return normalized;
  }

  return `${normalized.slice(0, maximum - 3)}...`;
}

function usefulDiffLines(diff, prefix) {
  return diff
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith(prefix)) {
        return false;
      }

      if (
        line.startsWith("+++") ||
        line.startsWith("---")
      ) {
        return false;
      }

      const text = line.slice(1).trim();

      if (!text) {
        return false;
      }

      if (
        text.startsWith("import ") ||
        text === "{" ||
        text === "}" ||
        text === ");" ||
        text === "};"
      ) {
        return false;
      }

      return true;
    })
    .map((line) => line.slice(1).trim());
}

function quotedValue(line) {
  const match = String(line).match(/["'`](.*?)["'`]/);
  return match?.[1] || null;
}

function getDiff(repositoryRoot, baseSha, headSha, file) {
  try {
    return git(repositoryRoot, [
      "diff",
      "--unified=2",
      baseSha,
      headSha,
      "--",
      file,
    ]);
  } catch {
    return "";
  }
}

function diffText(diff) {
  return usefulDiffLines(diff, "+")
    .concat(usefulDiffLines(diff, "-"))
    .join("\n");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function fileSubject(filePath) {
  return prettyName(
    path.basename(normalizePath(filePath)).replace(/\.[^.]+$/, ""),
  );
}

function extractIdentifiers(lines) {
  const names = [];

  for (const line of lines) {
    const patterns = [
      /\b(?:interface|type|class|enum|function)\s+([A-Za-z_$][\w$]*)/,
      /\bconst\s*\[\s*([A-Za-z_$][\w$]*)/,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*[^=]/,
      /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);

      if (match?.[1]) {
        names.push(match[1]);
        break;
      }
    }
  }

  return unique(names);
}

function changedContext(added, removed) {
  const changed = added.concat(removed).join("\n").toLowerCase();

  if (
    /preview|visible|visibility|show|hide|readonly|template/.test(changed)
  ) {
    return "preview visibility and display behavior";
  }

  if (
    /selection|additive|currentx|currenty|startx|starty|rect/.test(changed)
  ) {
    return "selection state and drag behavior";
  }

  if (
    /\bwidth\b|\bheight\b|landscape|paperformat|pageformat/.test(changed)
  ) {
    return "page dimension handling";
  }

  if (
    /fetch\(|axios|usequery|usemutation|response|endpoint|api\//.test(changed)
  ) {
    return "request and response handling";
  }

  if (
    /usestate|useeffect|usememo|usecallback|useref|usecontext/.test(changed)
  ) {
    return "state and lifecycle behavior";
  }

  if (
    /class-validator|@is|@min|@max|@validate|schema|validation/.test(changed)
  ) {
    return "validation behavior";
  }

  if (
    /\$transaction|prisma\.|\.create\(|\.update\(|\.delete\(|\.upsert\(/.test(changed)
  ) {
    return "persistence and transaction behavior";
  }

  if (
    /total|subtotal|amount|balance|tax|vat|discount|rate|currency|round|quantity|debit|credit/.test(changed)
  ) {
    return "calculation behavior";
  }

  if (
    /permission|authorize|authorise|guard|role|forbidden|unauthorized|companyid|branchid/.test(changed)
  ) {
    return "access-control behavior";
  }

  if (
    /status|approved|rejected|cancelled|canceled|posted|draft|transition/.test(changed)
  ) {
    return "workflow-state behavior";
  }

  if (
    /onclick|onchange|onsubmit|disabled|aria-|button|dialog|drawer|modal|tooltip/.test(changed)
  ) {
    return "interaction and control-state behavior";
  }

  return "updated behavior and compatibility";
}

function summarizeChangedLine(line) {
  return shorten(
    String(line)
      .replace(/\s+/g, " ")
      .replace(/[{};]/g, "")
      .trim(),
    72,
  );
}

function formatNames(names, maximum = 2) {
  const selected = names.slice(0, maximum);

  if (selected.length === 0) {
    return "";
  }

  if (selected.length === 1) {
    return `\`${selected[0]}\``;
  }

  return `\`${selected[0]}\` and \`${selected[1]}\``;
}

function buildFileConcern({
  file,
  diff,
}) {
  const subject = fileSubject(file);
  const added = usefulDiffLines(diff, "+");
  const removed = usefulDiffLines(diff, "-");

  const addedNames = extractIdentifiers(added);
  const removedNames = extractIdentifiers(removed);
  const context = changedContext(added, removed);

  // A clear rename/replacement is the most specific concern we can produce.
  if (
    removedNames.length === 1 &&
    addedNames.length === 1 &&
    removedNames[0] !== addedNames[0]
  ) {
    return (
      `${subject} — \`${removedNames[0]}\` replaced by ` +
      `\`${addedNames[0]}\`; check ${context}.`
    );
  }

  // Prefer the exact symbols introduced by this file's diff.
  if (addedNames.length > 0) {
    const names = formatNames(addedNames);

    if (removedNames.length > 0) {
      return `${subject} — ${names} updated; check ${context}.`;
    }

    return `${subject} — added ${names}; check ${context}.`;
  }

  // If the change only removes symbols, say exactly what was removed.
  if (removedNames.length > 0) {
    return (
      `${subject} — removed ${formatNames(removedNames)}; ` +
      `check ${context}.`
    );
  }

  // Preserve useful literal-only edits, such as labels or configuration values.
  if (removed.length === 1 && added.length === 1) {
    const oldQuoted = quotedValue(removed[0]);
    const newQuoted = quotedValue(added[0]);

    if (
      oldQuoted &&
      newQuoted &&
      oldQuoted !== newQuoted
    ) {
      return (
        `${subject} — "${shorten(oldQuoted, 32)}" changed to ` +
        `"${shorten(newQuoted, 32)}"; check dependent behavior.`
      );
    }
  }

  // Final fallback still uses this file's actual diff rather than a shared
  // category, so unrelated files do not collapse into identical concerns.
  const representative = added[0] || removed[0];

  if (representative) {
    return (
      `${subject} — ${summarizeChangedLine(representative)}; ` +
      `check ${context}.`
    );
  }

  return `${subject} — changed file; check updated behavior and compatibility.`;
}
function normalizeFindingLabel(detail, result) {
  const severity = String(detail.severity ?? "").toUpperCase();

  if (
    result.blocking === true ||
    ["CRITICAL", "HIGH"].includes(severity)
  ) {
    return "QA Blocker";
  }

  return "QA Warning";
}

function buildFindingConcern(detail, result) {
  const label = normalizeFindingLabel(detail, result);
  const message = shorten(
    detail.message || result.summary || "Quality Gate finding",
    160,
  );

  return `${label} - ${message}`;
}

function loadAnalyzerResults(resultsSource) {
  if (!resultsSource || !fs.existsSync(resultsSource)) {
    return [];
  }

  const stat = fs.statSync(resultsSource);

  if (stat.isDirectory()) {
    const files = [
      "semgrep-result.json",
      "knip-result.json",
      "madge-result.json",
    ];

    const results = [];

    for (const fileName of files) {
      const filePath = path.join(resultsSource, fileName);

      if (!fs.existsSync(filePath)) {
        continue;
      }

      results.push(readJson(filePath));
    }

    return results;
  }

  const report = readJson(resultsSource);

  // Frontend reports may keep findings at the top level or under detector/rule
  // sections. Collect all finding-like arrays and deduplicate them.
  const collected = [];

  function visit(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "findings" || key === "details") &&
        Array.isArray(child)
      ) {
        for (const finding of child) {
          if (finding && typeof finding === "object") {
            collected.push(finding);
          }
        }
      } else {
        visit(child);
      }
    }
  }

  visit(report);

  const seen = new Set();
  const findings = collected.filter((finding) => {
    const signature = JSON.stringify([
      finding.severity || finding.level || "",
      finding.message || finding.title || finding.description || "",
      finding.file || finding.filePath || finding.path || "",
      finding.line ?? finding.lineNumber ?? null,
      finding.ruleId || finding.rule || finding.id || "",
    ]);

    if (seen.has(signature)) {
      return false;
    }

    seen.add(signature);
    return true;
  });

  return [{
    tool: report.tool || "Frontend QA",
    category: "FRONTEND_QUALITY",
    blocking: false,
    summary:
      report.decision?.label ||
      report.summary ||
      "Frontend QA finding",
    details: findings.map((finding) => ({
      severity: finding.severity || finding.level || "",
      message:
        finding.message ||
        finding.title ||
        finding.description ||
        "Frontend QA finding",
      file:
        finding.file ||
        finding.filePath ||
        finding.path ||
        "",
      line:
        finding.line ??
        finding.lineNumber ??
        null,
      ruleId:
        finding.ruleId ||
        finding.rule ||
        finding.id ||
        "",
    })),
  }];
}

const [
  repositoryRoot,
  changedFilesPath,
  resultsSource,
  outputPath,
  baseSha,
  headSha,
  repositoryName = "",
  branchName = "",
] = process.argv.slice(2);

if (
  !repositoryRoot ||
  !changedFilesPath ||
  !resultsSource ||
  !outputPath ||
  !baseSha ||
  !headSha
) {
  console.error(`
Usage:

node generate-crm-tickets.mjs ^
  <repositoryRoot> ^
  <changedFilesPath> ^
  <resultsSource> ^
  <outputPath> ^
  <baseSha> ^
  <headSha> ^
  <repositoryName> ^
  <branchName>
`);

  process.exit(1);
}

console.log("CRM generator inputs:");
console.log(`  repositoryRoot   : ${repositoryRoot}`);
console.log(`  changedFilesPath : ${changedFilesPath}`);
console.log(`  resultsSource    : ${resultsSource}`);
console.log(`  outputPath       : ${outputPath}`);
console.log(`  baseSha          : ${baseSha}`);
console.log(`  headSha          : ${headSha}`);

const resolvedChangedFilesPath = resolveJsonFile(
  changedFilesPath,
  "Changed-files",
  [
    "changed-files.json",
    path.join("raw", "changed-files.json"),
  ],
);

let resolvedResultsSource = resultsSource;

if (
  resultsSource &&
  fs.existsSync(resultsSource) &&
  fs.statSync(resultsSource).isDirectory()
) {
  // Backend intentionally supplies the results directory.
  resolvedResultsSource = resultsSource;
} else {
  resolvedResultsSource = resolveJsonFile(
    resultsSource,
    "QA results",
    [
      "frontend-quality-results.json",
      "quality-results.json",
      "QA-Report.json",
    ],
  );
}

const changedFilesDocument = readJson(
  resolvedChangedFilesPath,
);

const changedFiles = Array.isArray(changedFilesDocument)
  ? changedFilesDocument
  : Array.isArray(changedFilesDocument.files)
    ? changedFilesDocument.files
    : [];

const analyzerResults = loadAnalyzerResults(
  resolvedResultsSource,
);

const tickets = [];

// ---------------------------------------------------------
// One QA Checked ticket per changed file/card
// ---------------------------------------------------------

for (const fileValue of changedFiles) {
  const file = normalizePath(fileValue);

  const diff = getDiff(
    repositoryRoot,
    baseSha,
    headSha,
    file,
  );

  tickets.push({
    kind: "file-change",
    module: getModuleName(file),
    concern: buildFileConcern({
      file,
      diff,
    }),
    file,
  });
}

// ---------------------------------------------------------
// Additional ticket per analyzer finding
// ---------------------------------------------------------

for (const result of analyzerResults) {
  const details = Array.isArray(result.details)
    ? result.details
    : [];

  for (const detail of details) {
    const file = normalizePath(detail.file ?? "");

    tickets.push({
      kind: "finding",
      tool: result.tool,
      severity: detail.severity ?? "",
      module: file
        ? getModuleName(file)
        : prettyName(result.category),
      concern: buildFindingConcern(detail, result),
      file,
      line: detail.line ?? null,
      ruleId: detail.ruleId ?? "",
    });
  }
}

const fileTicketCount = tickets.filter(
  (ticket) => ticket.kind === "file-change",
).length;

const findingTicketCount = tickets.filter(
  (ticket) => ticket.kind === "finding",
).length;

const payload = {
  generatedAt: new Date().toISOString(),

  source: {
    repository: repositoryName,
    branch: branchName,
    baseSha,
    headSha,
  },

  summary: {
    changedFiles: changedFiles.length,
    fileTickets: fileTicketCount,
    findingTickets: findingTicketCount,
    totalTickets: tickets.length,
  },

  tickets,
};

fs.mkdirSync(
  path.dirname(outputPath),
  {
    recursive: true,
  },
);

fs.writeFileSync(
  outputPath,
  `${JSON.stringify(payload, null, 2)}\n`,
  "utf8",
);

console.log("");
console.log("========================================");
console.log("CRM QA Ticket Generator");
console.log("========================================");
console.log(`Changed files  : ${changedFiles.length}`);
console.log(`QA Checked     : ${fileTicketCount}`);
console.log(`QA findings    : ${findingTicketCount}`);
console.log(`Total tickets  : ${tickets.length}`);
console.log(`Output         : ${outputPath}`);
console.log("========================================");