import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ExcelJS from "exceljs";

const ARCHITECTURE_RULE_PREFIXES = [
  "structure.",
  "hooks.",
  "types.",
  "ui.",
  "fetching.",
];

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function isArchitectureFinding(finding) {
  const ruleId = String(finding?.ruleId ?? "");
  return ARCHITECTURE_RULE_PREFIXES.some((prefix) =>
    ruleId.startsWith(prefix),
  );
}

function toTitleCaseSegment(value) {
  return String(value ?? "")
    .split("-")
    .filter(Boolean)
    .map(
      (part) =>
        part.charAt(0).toUpperCase() +
        part.slice(1),
    )
    .join(" ");
}

function deriveModule(file) {
  const normalized = normalizePath(file);
  const parts = normalized.split("/").filter(Boolean);

  const modulesIndex = parts.indexOf("modules");
  if (
    modulesIndex >= 0 &&
    parts.length > modulesIndex + 2
  ) {
    const domain = toTitleCaseSegment(
      parts[modulesIndex + 1],
    );
    const feature = toTitleCaseSegment(
      parts[modulesIndex + 2],
    );

    return `${domain} / ${feature}`;
  }

  const srcIndex = parts.indexOf("src");
  if (srcIndex >= 0 && parts.length > srcIndex + 2) {
    const concern = parts[srcIndex + 1];
    const area = parts[srcIndex + 2];

    if (area && !area.includes(".")) {
      return `${toTitleCaseSegment(area)} (${toTitleCaseSegment(concern)})`;
    }
  }

  if (parts.length > 1) {
    return toTitleCaseSegment(parts.at(-2));
  }

  return "Uncategorized";
}

function extractSymbol(finding) {
  const message = String(finding?.message ?? "");

  const quoted = message.match(/"([^"]+)"/);
  if (quoted?.[1]) {
    return quoted[1];
  }

  const singleQuoted = message.match(/'([^']+)'/);
  if (singleQuoted?.[1]) {
    return singleQuoted[1];
  }

  return "";
}

function getSeverityRank(value) {
  switch (String(value ?? "").toLowerCase()) {
    case "blocker":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
    default:
      return 3;
  }
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const severityDifference =
      getSeverityRank(left.severity) -
      getSeverityRank(right.severity);

    if (severityDifference !== 0) {
      return severityDifference;
    }

    const moduleDifference = deriveModule(
      left.file,
    ).localeCompare(deriveModule(right.file));

    if (moduleDifference !== 0) {
      return moduleDifference;
    }

    const fileDifference = normalizePath(
      left.file,
    ).localeCompare(normalizePath(right.file));

    if (fileDifference !== 0) {
      return fileDifference;
    }

    return (
      Number(left.line ?? Number.MAX_SAFE_INTEGER) -
      Number(right.line ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function addTableStyle(worksheet) {
  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1,
    },
  ];

  worksheet.autoFilter = {
    from: "A1",
    to: "J1",
  };

  const headerRow = worksheet.getRow(1);
  headerRow.font = {
    bold: true,
  };
  headerRow.alignment = {
    vertical: "middle",
  };

  worksheet.eachRow((row, rowNumber) => {
    row.alignment = {
      vertical: "top",
      wrapText: true,
    };

    if (rowNumber > 1) {
      const severity = String(
        row.getCell(1).value ?? "",
      ).toLowerCase();

      if (severity === "blocker") {
        row.getCell(1).font = {
          bold: true,
        };
      }
    }
  });
}

function addSummarySection(
  worksheet,
  startRow,
  title,
  rows,
) {
  worksheet.getCell(startRow, 1).value = title;
  worksheet.getCell(startRow, 1).font = {
    bold: true,
    size: 13,
  };

  const headerRow = worksheet.getRow(startRow + 1);
  headerRow.values = ["Item", "Count"];
  headerRow.font = {
    bold: true,
  };

  rows.forEach(([label, count], index) => {
    const row = worksheet.getRow(
      startRow + 2 + index,
    );
    row.values = [label, count];
  });

  return startRow + rows.length + 3;
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!inputPath || !outputPath) {
    throw new Error(
      "Usage: node generate-frontend-architecture-excel.mjs <input-json> <output-xlsx>",
    );
  }

  const absoluteInputPath = path.resolve(
    inputPath,
  );
  const absoluteOutputPath = path.resolve(
    outputPath,
  );

  if (
    !fs.existsSync(absoluteInputPath) ||
    !fs.statSync(absoluteInputPath).isFile()
  ) {
    throw new Error(
      `Architecture JSON report was not found: ${absoluteInputPath}`,
    );
  }

  const report = JSON.parse(
    fs.readFileSync(
      absoluteInputPath,
      "utf8",
    ),
  );

  const architectureFindings = sortFindings(
    (Array.isArray(report.findings)
      ? report.findings
      : []
    ).filter(isArchitectureFinding),
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator =
    "Gr8BooksNeo QA Automation";
  workbook.company =
    "Integr8 Software Solutions Inc.";
  workbook.created = new Date();
  workbook.modified = new Date();

  const findingsSheet =
    workbook.addWorksheet(
      "Architecture Findings",
    );

  findingsSheet.columns = [
    {
      header: "Severity",
      key: "severity",
      width: 14,
    },
    {
      header: "Rule",
      key: "rule",
      width: 32,
    },
    {
      header: "Module",
      key: "module",
      width: 38,
    },
    {
      header: "File",
      key: "file",
      width: 70,
    },
    {
      header: "Line",
      key: "line",
      width: 10,
    },
    {
      header: "Symbol / Item",
      key: "symbol",
      width: 38,
    },
    {
      header: "Finding",
      key: "finding",
      width: 85,
    },
    {
      header: "Recommendation",
      key: "recommendation",
      width: 85,
    },
    {
      header: "Confidence",
      key: "confidence",
      width: 14,
    },
    {
      header: "Detector",
      key: "detector",
      width: 18,
    },
  ];

  for (const finding of architectureFindings) {
    findingsSheet.addRow({
      severity: String(
        finding.severity ?? "",
      ).toUpperCase(),
      rule: String(finding.ruleId ?? ""),
      module: deriveModule(finding.file),
      file: normalizePath(finding.file),
      line:
        Number.isInteger(finding.line)
          ? finding.line
          : "",
      symbol: extractSymbol(finding),
      finding: String(
        finding.message ?? "",
      ),
      recommendation: String(
        finding.recommendation ?? "",
      ),
      confidence: String(
        finding.confidence ?? "",
      ),
      detector: String(
        finding.detector ??
          finding.category ??
          "",
      ),
    });
  }

  addTableStyle(findingsSheet);

  const summarySheet =
    workbook.addWorksheet("Summary");

  summarySheet.columns = [
    {
      key: "label",
      width: 55,
    },
    {
      key: "count",
      width: 16,
    },
  ];

  summarySheet.getCell("A1").value =
    "Gr8BooksNeo Weekly Frontend Architecture Review";
  summarySheet.getCell("A1").font = {
    bold: true,
    size: 16,
  };

  summarySheet.getCell("A2").value =
    `Generated: ${new Date().toISOString()}`;
  summarySheet.getCell("A3").value =
    `Repository: ${report?.repository?.name ?? ""}`;
  summarySheet.getCell("A4").value =
    `Branch: ${report?.repository?.branch ?? "develop"}`;
  summarySheet.getCell("A5").value =
    `Commit: ${report?.repository?.commitShort ?? report?.repository?.commit ?? ""}`;

  const blockerCount =
    architectureFindings.filter(
      (finding) =>
        String(finding.severity).toLowerCase() ===
        "blocker",
    ).length;

  const warningCount =
    architectureFindings.filter(
      (finding) =>
        String(finding.severity).toLowerCase() ===
        "warning",
    ).length;

  const infoCount =
    architectureFindings.filter(
      (finding) =>
        String(finding.severity).toLowerCase() ===
        "info",
    ).length;

  let nextRow = 7;

  nextRow = addSummarySection(
    summarySheet,
    nextRow,
    "Architecture Summary",
    [
      [
        "Files scanned",
        Number(
          report?.analysis?.changedFileCount ?? 0,
        ),
      ],
      [
        "Architecture findings",
        architectureFindings.length,
      ],
      ["Blocker-class findings", blockerCount],
      ["Warnings", warningCount],
      ["Information", infoCount],
      [
        "Full detector findings",
        Number(report?.summary?.total ?? 0),
      ],
    ],
  );

  const byModule = new Map();
  for (const finding of architectureFindings) {
    const moduleName = deriveModule(
      finding.file,
    );

    byModule.set(
      moduleName,
      (byModule.get(moduleName) ?? 0) + 1,
    );
  }

  nextRow = addSummarySection(
    summarySheet,
    nextRow,
    "Findings By Module",
    [...byModule.entries()].sort(
      (left, right) =>
        right[1] - left[1] ||
        left[0].localeCompare(right[0]),
    ),
  );

  const byRule = new Map();
  for (const finding of architectureFindings) {
    const ruleId = String(
      finding.ruleId ?? "unknown",
    );

    byRule.set(
      ruleId,
      (byRule.get(ruleId) ?? 0) + 1,
    );
  }

  addSummarySection(
    summarySheet,
    nextRow,
    "Findings By Rule",
    [...byRule.entries()].sort(
      (left, right) =>
        right[1] - left[1] ||
        left[0].localeCompare(right[0]),
    ),
  );

  summarySheet.eachRow((row) => {
    row.alignment = {
      vertical: "top",
      wrapText: true,
    };
  });

  fs.mkdirSync(
    path.dirname(absoluteOutputPath),
    {
      recursive: true,
    },
  );

  await workbook.xlsx.writeFile(
    absoluteOutputPath,
  );

  console.log(
    `Frontend architecture Excel report generated: ${absoluteOutputPath}`,
  );
  console.log(
    `Architecture findings written: ${architectureFindings.length}`,
  );
}

main().catch((error) => {
  console.error(
    "Failed to generate frontend architecture Excel report.",
  );
  console.error(error.message);
  process.exitCode = 1;
});