import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import ExcelJS from "exceljs";

const ARCHITECTURE_RULE_PREFIXES = [
  "structure.",
  "hooks.",
  "types.",
  "ui.",
  "fetching.",
];

const SEVERITY_ORDER = {
  blocker: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_LABELS = {
  blocker: "BLOCKER",
  warning: "WARNING",
  info: "INFO",
};

const SEVERITY_EXPLANATIONS = {
  blocker:
    "Strong architecture violation according to the configured frontend standards. Weekly review is advisory; QA should still verify context before refactoring.",
  warning:
    "Architecture drift or maintainability concern that should be reviewed and cleaned up when appropriate.",
  info:
    "Informational architecture observation. No immediate action is normally required.",
};

const SEVERITY_ACTIONS = {
  blocker: "Review first. Refactor if confirmed as a real architecture violation.",
  warning: "Review and schedule cleanup/refactor when appropriate.",
  info: "Review for awareness; change only when useful.",
};

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function isArchitectureFinding(finding) {
  const ruleId = String(finding?.ruleId ?? "");

  return ARCHITECTURE_RULE_PREFIXES.some((prefix) =>
    ruleId.startsWith(prefix),
  );
}

function titleCaseSegment(value) {
  return String(value ?? "")
    .replace(/\.[^.]+$/, "")
    .split(/[-_\s]+/)
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
    const domain = titleCaseSegment(
      parts[modulesIndex + 1],
    );

    const feature = titleCaseSegment(
      parts[modulesIndex + 2],
    );

    return `${domain} / ${feature}`;
  }

  const srcIndex = parts.indexOf("src");

  if (srcIndex >= 0) {
    const concern = parts[srcIndex + 1] ?? "";
    const area = parts[srcIndex + 2] ?? "";

    if (area && !area.includes(".")) {
      if (
        ["shared", "auth", "billing", "workspace", "master", "onboarding", "pricing"].includes(
          area.toLowerCase(),
        )
      ) {
        return `${titleCaseSegment(area)} (${titleCaseSegment(concern)})`;
      }

      return titleCaseSegment(area);
    }
  }

  if (parts.length > 1) {
    return titleCaseSegment(parts.at(-2));
  }

  return "Uncategorized";
}

function extractSymbol(finding) {
  const message = String(finding?.message ?? "");

  const doubleQuoted = message.match(/"([^"]+)"/);

  if (doubleQuoted?.[1]) {
    return doubleQuoted[1];
  }

  const singleQuoted = message.match(/'([^']+)'/);

  if (singleQuoted?.[1]) {
    return singleQuoted[1];
  }

  return "";
}

function createLocation(finding) {
  const file = normalizePath(finding?.file ?? "");

  if (!file) {
    return "";
  }

  if (Number.isInteger(finding?.line)) {
    return `${file}:${finding.line}`;
  }

  return file;
}

function createFindingKey(finding) {
  const raw = [
    String(finding?.ruleId ?? ""),
    normalizePath(finding?.file ?? ""),
    String(finding?.line ?? ""),
    extractSymbol(finding),
  ].join("|");

  return crypto
    .createHash("sha1")
    .update(raw)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
}

function getSeverity(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  return normalized in SEVERITY_ORDER
    ? normalized
    : "warning";
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const leftSeverity = getSeverity(left.severity);
    const rightSeverity = getSeverity(right.severity);

    const severityDifference =
      SEVERITY_ORDER[leftSeverity] -
      SEVERITY_ORDER[rightSeverity];

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

function countBy(findings, selector) {
  const counts = new Map();

  for (const finding of findings) {
    const key = selector(finding) || "Uncategorized";

    counts.set(
      key,
      (counts.get(key) ?? 0) + 1,
    );
  }

  return [...counts.entries()].sort(
    (left, right) =>
      right[1] - left[1] ||
      String(left[0]).localeCompare(String(right[0])),
  );
}

function applyThinBorders(cell) {
  cell.border = {
    top: {
      style: "thin",
      color: { argb: "FFD9E2F3" },
    },
    left: {
      style: "thin",
      color: { argb: "FFD9E2F3" },
    },
    bottom: {
      style: "thin",
      color: { argb: "FFD9E2F3" },
    },
    right: {
      style: "thin",
      color: { argb: "FFD9E2F3" },
    },
  };
}

function styleSectionHeader(cell) {
  cell.font = {
    bold: true,
    color: { argb: "FFFFFFFF" },
    size: 12,
  };

  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E78" },
  };

  cell.alignment = {
    vertical: "middle",
  };
}

function styleMetricLabel(cell) {
  cell.font = {
    bold: true,
    color: { argb: "FF1F1F1F" },
  };

  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD9EAF7" },
  };

  applyThinBorders(cell);
}

function styleMetricValue(cell) {
  cell.font = {
    bold: true,
    color: { argb: "FF1F1F1F" },
  };

  cell.alignment = {
    horizontal: "center",
  };

  applyThinBorders(cell);
}

function addSummaryTable(
  worksheet,
  startRow,
  title,
  entries,
) {
  worksheet.mergeCells(
    startRow,
    1,
    startRow,
    2,
  );

  const titleCell = worksheet.getCell(
    startRow,
    1,
  );

  titleCell.value = title;
  styleSectionHeader(titleCell);

  const headerRow = worksheet.getRow(
    startRow + 1,
  );

  headerRow.values = ["Item", "Count"];
  headerRow.font = { bold: true };

  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFEAF2F8" },
    };

    applyThinBorders(cell);
  });

  entries.forEach(([label, count], index) => {
    const row = worksheet.getRow(
      startRow + 2 + index,
    );

    row.values = [label, count];

    row.eachCell((cell) => {
      applyThinBorders(cell);
    });

    row.getCell(2).alignment = {
      horizontal: "center",
    };
  });

  return startRow + entries.length + 4;
}

function createReadMeSheet(
  workbook,
  report,
  architectureFindings,
) {
  const sheet = workbook.addWorksheet(
    "Read Me",
    {
      views: [
        {
          showGridLines: false,
        },
      ],
    },
  );

  sheet.columns = [
    { width: 24 },
    { width: 90 },
  ];

  sheet.mergeCells("A1:B1");
  sheet.getCell("A1").value =
    "Gr8BooksNeo Weekly Frontend Architecture Review";
  sheet.getCell("A1").font = {
    bold: true,
    size: 18,
    color: { argb: "FFFFFFFF" },
  };
  sheet.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF17365D" },
  };
  sheet.getCell("A1").alignment = {
    vertical: "middle",
  };
  sheet.getRow(1).height = 30;

  sheet.mergeCells("A3:B3");
  sheet.getCell("A3").value =
    "Purpose";
  styleSectionHeader(sheet.getCell("A3"));

  sheet.getCell("A4").value =
    "What is this file?";
  sheet.getCell("B4").value =
    "A weekly advisory report of frontend architecture findings detected on the develop branch. It is intended for QA, developers, and admin review.";

  sheet.getCell("A5").value =
    "Does BLOCKER mean the build failed?";
  sheet.getCell("B5").value =
    "No. The weekly review is advisory. BLOCKER is the severity inherited from the normal PR detector. QA should verify context before developers refactor existing code.";

  sheet.getCell("A6").value =
    "What should developers do?";
  sheet.getCell("B6").value =
    "Start with confirmed BLOCKER findings, then review WARNING findings. Do not mass-refactor intentional legacy patterns or approved exceptions without evidence.";

  sheet.getCell("A7").value =
    "What about unfinished modules?";
  sheet.getCell("B7").value =
    "An unfinished module is not a failure simply because future files or features are missing. The report evaluates architecture of code that currently exists.";

  sheet.getCell("A8").value =
    "Will this file update?";
  sheet.getCell("B8").value =
    "Yes. A new workbook is generated by the weekly GitHub Actions run. The latest artifact reflects the latest develop branch at the time of that run.";

  for (let rowNumber = 4; rowNumber <= 8; rowNumber += 1) {
    sheet.getCell(rowNumber, 1).font = {
      bold: true,
    };

    sheet.getRow(rowNumber).alignment = {
      vertical: "top",
      wrapText: true,
    };
  }

  sheet.mergeCells("A10:B10");
  sheet.getCell("A10").value =
    "Severity Guide";
  styleSectionHeader(sheet.getCell("A10"));

  const severityRows = [
    [
      "BLOCKER",
      SEVERITY_EXPLANATIONS.blocker,
    ],
    [
      "WARNING",
      SEVERITY_EXPLANATIONS.warning,
    ],
    [
      "INFO",
      SEVERITY_EXPLANATIONS.info,
    ],
  ];

  severityRows.forEach(
    ([severity, description], index) => {
      const rowNumber = 11 + index;

      sheet.getCell(rowNumber, 1).value =
        severity;

      sheet.getCell(rowNumber, 2).value =
        description;

      sheet.getRow(rowNumber).alignment = {
        vertical: "top",
        wrapText: true,
      };
    },
  );

  sheet.getCell("A11").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF4CCCC" },
  };

  sheet.getCell("A12").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFE599" },
  };

  sheet.getCell("A13").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD9EAD3" },
  };

  sheet.mergeCells("A15:B15");
  sheet.getCell("A15").value =
    "Current Run";
  styleSectionHeader(sheet.getCell("A15"));

  const currentRunRows = [
    [
      "Repository",
      report?.repository?.name ?? "",
    ],
    [
      "Branch",
      report?.repository?.branch || "develop",
    ],
    [
      "Commit",
      report?.repository?.commitShort ??
        report?.repository?.commit ??
        "",
    ],
    [
      "Generated",
      report?.generatedAt ??
        new Date().toISOString(),
    ],
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
  ];

  currentRunRows.forEach(
    ([label, value], index) => {
      const rowNumber = 16 + index;

      sheet.getCell(rowNumber, 1).value =
        label;

      sheet.getCell(rowNumber, 2).value =
        value;

      sheet.getCell(rowNumber, 1).font = {
        bold: true,
      };
    },
  );
}

function createSummarySheet(
  workbook,
  report,
  architectureFindings,
) {
  const sheet = workbook.addWorksheet(
    "Summary",
    {
      views: [
        {
          showGridLines: false,
        },
      ],
    },
  );

  sheet.columns = [
    { width: 46 },
    { width: 16 },
    { width: 4 },
    { width: 46 },
    { width: 16 },
  ];

  sheet.mergeCells("A1:E1");
  sheet.getCell("A1").value =
    "Weekly Frontend Architecture Summary";
  sheet.getCell("A1").font = {
    bold: true,
    size: 18,
    color: { argb: "FFFFFFFF" },
  };
  sheet.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF17365D" },
  };
  sheet.getCell("A1").alignment = {
    vertical: "middle",
  };
  sheet.getRow(1).height = 30;

  const blockerCount =
    architectureFindings.filter(
      (finding) =>
        getSeverity(finding.severity) ===
        "blocker",
    ).length;

  const warningCount =
    architectureFindings.filter(
      (finding) =>
        getSeverity(finding.severity) ===
        "warning",
    ).length;

  const infoCount =
    architectureFindings.filter(
      (finding) =>
        getSeverity(finding.severity) ===
        "info",
    ).length;

  const metrics = [
    [
      "Files Scanned",
      Number(
        report?.analysis?.changedFileCount ?? 0,
      ),
    ],
    [
      "Architecture Findings",
      architectureFindings.length,
    ],
    ["Blockers", blockerCount],
    ["Warnings", warningCount],
    ["Information", infoCount],
    [
      "Full Detector Findings",
      Number(report?.summary?.total ?? 0),
    ],
  ];

  metrics.forEach(
    ([label, value], index) => {
      const rowNumber = 3 + index;

      sheet.getCell(rowNumber, 1).value =
        label;

      sheet.getCell(rowNumber, 2).value =
        value;

      styleMetricLabel(
        sheet.getCell(rowNumber, 1),
      );

      styleMetricValue(
        sheet.getCell(rowNumber, 2),
      );
    },
  );

  sheet.getCell("D3").value =
    "Repository";
  sheet.getCell("E3").value =
    report?.repository?.name ?? "";

  sheet.getCell("D4").value =
    "Branch";
  sheet.getCell("E4").value =
    report?.repository?.branch || "develop";

  sheet.getCell("D5").value =
    "Commit";
  sheet.getCell("E5").value =
    report?.repository?.commitShort ??
    report?.repository?.commit ??
    "";

  sheet.getCell("D6").value =
    "Generated";
  sheet.getCell("E6").value =
    report?.generatedAt ??
    new Date().toISOString();

  for (let rowNumber = 3; rowNumber <= 6; rowNumber += 1) {
    styleMetricLabel(
      sheet.getCell(rowNumber, 4),
    );

    applyThinBorders(
      sheet.getCell(rowNumber, 5),
    );
  }

  let nextRow = 11;

  nextRow = addSummaryTable(
    sheet,
    nextRow,
    "Findings by Module",
    countBy(
      architectureFindings,
      (finding) => deriveModule(finding.file),
    ),
  );

  nextRow = addSummaryTable(
    sheet,
    nextRow,
    "Findings by Rule",
    countBy(
      architectureFindings,
      (finding) =>
        String(
          finding.ruleId ?? "unknown",
        ),
    ),
  );

  addSummaryTable(
    sheet,
    nextRow,
    "Findings by Detector",
    countBy(
      architectureFindings,
      (finding) =>
        String(
          finding.detector ??
            finding.category ??
            "unknown",
        ),
    ),
  );
}

function createFindingsSheet(
  workbook,
  architectureFindings,
) {
  const sheet = workbook.addWorksheet(
    "Architecture Findings",
    {
      views: [
        {
          state: "frozen",
          ySplit: 4,
          showGridLines: false,
        },
      ],
    },
  );

  const columns = [
    {
      header: "Severity",
      key: "severity",
      width: 14,
    },
    {
      header: "Priority / Action",
      key: "action",
      width: 28,
    },
    {
      header: "Module",
      key: "module",
      width: 38,
    },
    {
      header: "Location",
      key: "location",
      width: 72,
    },
    {
      header: "Line",
      key: "line",
      width: 9,
    },
    {
      header: "Symbol / Item",
      key: "symbol",
      width: 38,
    },
    {
      header: "Rule",
      key: "rule",
      width: 34,
    },
    {
      header: "Finding",
      key: "finding",
      width: 78,
    },
    {
      header: "Why It Matters",
      key: "whyItMatters",
      width: 68,
    },
    {
      header: "Recommended Fix",
      key: "recommendation",
      width: 78,
    },
    {
      header: "Confidence",
      key: "confidence",
      width: 14,
    },
    {
      header: "Finding ID",
      key: "findingId",
      width: 16,
    },
  ];

  sheet.columns = columns;

  sheet.mergeCells("A1:L1");
  sheet.getCell("A1").value =
    "Frontend Architecture Findings";
  sheet.getCell("A1").font = {
    bold: true,
    size: 18,
    color: { argb: "FFFFFFFF" },
  };
  sheet.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF17365D" },
  };
  sheet.getCell("A1").alignment = {
    vertical: "middle",
  };
  sheet.getRow(1).height = 30;

  sheet.mergeCells("A2:L2");
  sheet.getCell("A2").value =
    "Filter by Severity, Module, Rule, or Finding ID. BLOCKER/WARNING severities are advisory in this weekly report and should be verified by QA before refactoring.";
  sheet.getCell("A2").font = {
    italic: true,
    color: { argb: "FF404040" },
  };
  sheet.getCell("A2").alignment = {
    wrapText: true,
    vertical: "middle",
  };
  sheet.getRow(2).height = 32;

  const headerRowNumber = 4;

  columns.forEach((column, index) => {
    const cell = sheet.getCell(
      headerRowNumber,
      index + 1,
    );

    cell.value = column.header;
    cell.font = {
      bold: true,
      color: { argb: "FFFFFFFF" },
    };

    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };

    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };

    applyThinBorders(cell);
  });

  architectureFindings.forEach(
    (finding, index) => {
      const severity = getSeverity(
        finding.severity,
      );

      const rowNumber =
        headerRowNumber + 1 + index;

      const row = sheet.getRow(rowNumber);

      row.values = [
        SEVERITY_LABELS[severity],
        SEVERITY_ACTIONS[severity],
        deriveModule(finding.file),
        createLocation(finding),
        Number.isInteger(finding.line)
          ? finding.line
          : "",
        extractSymbol(finding),
        String(finding.ruleId ?? ""),
        String(finding.message ?? ""),
        SEVERITY_EXPLANATIONS[severity],
        String(finding.recommendation ?? ""),
        String(finding.confidence ?? ""),
        createFindingKey(finding),
      ];

      row.alignment = {
        vertical: "top",
        wrapText: true,
      };

      row.eachCell((cell) => {
        applyThinBorders(cell);
      });

      const severityCell = row.getCell(1);

      severityCell.font = {
        bold: true,
      };

      if (severity === "blocker") {
        severityCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF4CCCC" },
        };
      } else if (severity === "warning") {
        severityCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFE599" },
        };
      } else {
        severityCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFD9EAD3" },
        };
      }

      row.getCell(5).alignment = {
        horizontal: "center",
        vertical: "top",
      };
    },
  );

  const lastRowNumber = Math.max(
    headerRowNumber + 1,
    headerRowNumber +
      architectureFindings.length,
  );

  sheet.autoFilter = {
    from: {
      row: headerRowNumber,
      column: 1,
    },
    to: {
      row: lastRowNumber,
      column: columns.length,
    },
  };

  sheet.getColumn(4).alignment = {
    wrapText: true,
  };

  sheet.getColumn(8).alignment = {
    wrapText: true,
  };

  sheet.getColumn(9).alignment = {
    wrapText: true,
  };

  sheet.getColumn(10).alignment = {
    wrapText: true,
  };
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
    (
      Array.isArray(report.findings)
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

  createReadMeSheet(
    workbook,
    report,
    architectureFindings,
  );

  createSummarySheet(
    workbook,
    report,
    architectureFindings,
  );

  createFindingsSheet(
    workbook,
    architectureFindings,
  );

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