import fs from "node:fs";
import path from "node:path";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json"];

const DEFAULT_MOCK_PATTERNS = [
  "mock",
  "dummy",
  "fake",
  "sample",
  "fixture",
  "testdata",
  "__mock__",
];

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function normalizeDirectory(value) {
  return normalizePath(value)
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function getLineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function getCodeLine(source, lineNumber) {
  return source.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
}

function createFinding({
  ruleId,
  severity,
  title,
  message,
  recommendation,
  file,
  line = null,
  column = null,
  codeSnippet = "",
  evidence = [],
  confidence = "high",
}) {
  return {
    category: "data",
    ruleId,
    severity,
    title,
    message,
    recommendation,
    file: normalizePath(file),
    line,
    column,
    endLine: null,
    endColumn: null,
    codeSnippet,
    relatedFiles: [],
    evidence,
    detector: "data",
    confidence,
  };
}

function isIgnored(file, config) {
  const normalizedFile = `/${normalizePath(file).toLowerCase()}/`;

  return (config.ignoredPaths ?? []).some((ignoredPath) => {
    const normalizedIgnored = normalizeDirectory(ignoredPath);

    return normalizedIgnored &&
      normalizedFile.includes(`/${normalizedIgnored}/`);
  });
}

function isGeneratedFile(file, config) {
  const normalizedFile = normalizePath(file).toLowerCase();

  return (config.generatedCodePatterns ?? []).some((pattern) => {
    const normalizedPattern = normalizePath(pattern).toLowerCase();

    return normalizedPattern &&
      normalizedFile.includes(normalizedPattern);
  });
}

function isSupportedFile(file, config) {
  const extension = path.extname(file).toLowerCase();

  const supported =
    config.supportedExtensions ?? DEFAULT_EXTENSIONS;

  return supported
    .map((item) => item.toLowerCase())
    .includes(extension);
}

function isInsideDirectory(file, directory) {
  const normalizedFile = normalizePath(file).toLowerCase();
  const normalizedDirectory = normalizeDirectory(directory);

  return (
    normalizedDirectory &&
    (normalizedFile === normalizedDirectory ||
      normalizedFile.startsWith(`${normalizedDirectory}/`))
  );
}

function isInsideDataDirectory(file, config) {
  const directories =
    config.data?.rootDirectories ?? ["app/src/data"];

  return directories.some((directory) =>
    isInsideDirectory(file, directory),
  );
}

function detectMockFileName(file, config, findings) {
  const rule = config.data?.rules?.mockFileCommitted;

  if (!rule?.enabled) {
    return;
  }

  const lower = normalizePath(file).toLowerCase();

  const patterns =
    config.data?.mockIndicators ?? DEFAULT_MOCK_PATTERNS;

  for (const pattern of patterns) {
    if (!lower.includes(pattern.toLowerCase())) {
      continue;
    }

    findings.push(
      createFinding({
        ruleId: "data.mockFileCommitted",
        severity: rule.severity,
        title: "Mock or temporary data file detected",
        message:
          `The filename contains "${pattern}".`,
        recommendation:
          "Remove temporary data before merging or move it into approved test fixtures.",
        file,
        evidence: [`Matched filename pattern: ${pattern}`],
      }),
    );

    return;
  }
}

function detectMockImports(file, source, config, findings) {
  const rule = config.data?.rules?.mockImport;

  if (!rule?.enabled) {
    return;
  }

  const patterns =
    config.data?.mockIndicators ?? DEFAULT_MOCK_PATTERNS;

  for (const pattern of patterns) {
    const regex = new RegExp(
      `from\\s+["'][^"']*${pattern}[^"']*["']`,
      "ig",
    );

    for (const match of source.matchAll(regex)) {
      const index = match.index ?? 0;
      const line = getLineNumber(source, index);

      findings.push(
        createFinding({
          ruleId: "data.mockImport",
          severity: rule.severity,
          title: "Mock data imported",
          message:
            `Production code imports "${pattern}" data.`,
          recommendation:
            "Replace mock imports with production services or API calls.",
          file,
          line,
          column: 1,
          codeSnippet: getCodeLine(source, line),
          evidence: [match[0]],
        }),
      );

      return;
    }
  }
}

function detectInlineMockData(file, source, config, findings) {
  const rule = config.data?.rules?.inlineMockData;

  if (!rule?.enabled) {
    return;
  }

  const indicators = [
    /\bmockData\b/i,
    /\bdummyData\b/i,
    /\bfakeData\b/i,
    /\bsampleData\b/i,
    /\bfixtureData\b/i,
  ];

  for (const regex of indicators) {
    const match = regex.exec(source);

    if (!match) {
      continue;
    }

    const line = getLineNumber(source, match.index);

    findings.push(
      createFinding({
        ruleId: "data.inlineMockData",
        severity: rule.severity,
        title: "Inline mock data detected",
        message:
          "The changed file contains inline mock data.",
        recommendation:
          "Replace inline mock data with real API responses before merging.",
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        evidence: [match[0]],
      }),
    );

    return;
  }
}

function detectLargeStaticArrays(file, source, config, findings) {
  const rule = config.data?.rules?.largeStaticDataset;

  if (!rule?.enabled) {
    return;
  }

  const matches =
    source.match(/\[[\s\S]{3000,}\]/g);

  if (!matches?.length) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "data.largeStaticDataset",
      severity: rule.severity,
      title: "Large static dataset detected",
      message:
        "The changed file contains a very large inline array.",
      recommendation:
        "Move large datasets into approved data modules or retrieve them from the backend.",
      file,
      evidence: [
        `Detected ${matches.length} large array(s)`,
      ],
      confidence: "medium",
    }),
  );
}

export async function detectData({
  repositoryRoot,
  files,
  config,
}) {
  const findings = [];

  if (!config.data?.enabled) {
    return findings;
  }

  for (const relativeFile of files) {
    const file = normalizePath(relativeFile);

    if (!isSupportedFile(file, config)) {
      continue;
    }

    if (isIgnored(file, config)) {
      continue;
    }

    if (isGeneratedFile(file, config)) {
      continue;
    }

    const absoluteFile = path.resolve(
      repositoryRoot,
      ...file.split("/"),
    );

    if (!fs.existsSync(absoluteFile)) {
      continue;
    }

    const source = fs.readFileSync(
      absoluteFile,
      "utf8",
    );

    detectMockFileName(file, config, findings);

    if (!isInsideDataDirectory(file, config)) {
      detectMockImports(
        file,
        source,
        config,
        findings,
      );

      detectInlineMockData(
        file,
        source,
        config,
        findings,
      );

      detectLargeStaticArrays(
        file,
        source,
        config,
        findings,
      );
    }
  }

  return findings;
}

export default detectData;