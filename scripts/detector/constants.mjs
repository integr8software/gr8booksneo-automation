import fs from "node:fs";
import path from "node:path";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

const DEFAULT_STATUS_VALUES = new Set([
  "ACTIVE",
  "INACTIVE",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "CANCELED",
  "DRAFT",
  "COMPLETED",
  "FAILED",
  "SUCCESS",
  "ENABLED",
  "DISABLED",
  "ARCHIVED",
  "DELETED",
  "PROCESSING",
  "PAID",
  "UNPAID",
  "EXPIRED",
]);

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function normalizeDirectory(value) {
  return normalizePath(value)
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  relatedFiles = [],
  evidence = [],
  confidence = "high",
}) {
  return {
    category: "constants",
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
    relatedFiles: relatedFiles.map(normalizePath),
    evidence,
    detector: "constants",
    confidence,
  };
}

function isIgnored(file, config) {
  const normalizedFile = `/${normalizePath(file).toLowerCase()}/`;

  return (config.ignoredPaths ?? []).some((ignoredPath) => {
    const normalizedIgnored = normalizeDirectory(ignoredPath);

    if (!normalizedIgnored) {
      return false;
    }

    return normalizedFile.includes(`/${normalizedIgnored}/`);
  });
}

function isGeneratedFile(file, config) {
  const normalizedFile = normalizePath(file).toLowerCase();

  return (config.generatedCodePatterns ?? []).some((pattern) => {
    const normalizedPattern = normalizePath(pattern).toLowerCase();

    return (
      normalizedPattern.length > 0 &&
      normalizedFile.includes(normalizedPattern)
    );
  });
}

function isSupportedFile(file, config) {
  const extension = path.extname(file).toLowerCase();

  const supportedExtensions =
    config.supportedExtensions ?? DEFAULT_EXTENSIONS;

  return supportedExtensions
    .map((item) => item.toLowerCase())
    .includes(extension);
}

function isInsideDirectory(file, directory) {
  const normalizedFile = normalizePath(file).toLowerCase();
  const normalizedDirectory = normalizeDirectory(directory);

  if (!normalizedDirectory) {
    return false;
  }

  return (
    normalizedFile === normalizedDirectory ||
    normalizedFile.startsWith(`${normalizedDirectory}/`)
  );
}

function isInsideConstantsDirectory(file, config) {
  const rootDirectories =
    config.constants?.rootDirectories ?? ["app/src/constants"];

  return rootDirectories.some((directory) =>
    isInsideDirectory(file, directory),
  );
}

/**
 * Replaces comments with spaces while preserving newlines and string contents.
 * This prevents commented-out literals from becoming findings.
 */
function removeComments(source) {
  let output = "";
  let index = 0;
  let state = "code";

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (current === "'" || current === '"' || current === "`") {
        state =
          current === "'"
            ? "single"
            : current === '"'
              ? "double"
              : "template";

        output += current;
        index += 1;
        continue;
      }

      if (current === "/" && next === "/") {
        state = "line-comment";
        output += "  ";
        index += 2;
        continue;
      }

      if (current === "/" && next === "*") {
        state = "block-comment";
        output += "  ";
        index += 2;
        continue;
      }

      output += current;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (current === "\n") {
        state = "code";
        output += "\n";
      } else {
        output += " ";
      }

      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        state = "code";
        output += "  ";
        index += 2;
        continue;
      }

      output += current === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (state === "single") {
      output += current;

      if (current === "\\" && next !== undefined) {
        output += next;
        index += 2;
        continue;
      }

      if (current === "'") {
        state = "code";
      }

      index += 1;
      continue;
    }

    if (state === "double") {
      output += current;

      if (current === "\\" && next !== undefined) {
        output += next;
        index += 2;
        continue;
      }

      if (current === '"') {
        state = "code";
      }

      index += 1;
      continue;
    }

    if (state === "template") {
      output += current;

      if (current === "\\" && next !== undefined) {
        output += next;
        index += 2;
        continue;
      }

      if (current === "`") {
        state = "code";
      }

      index += 1;
    }
  }

  return output;
}

function decodeSimpleString(rawValue) {
  return rawValue
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'")
    .replaceAll("\\\\", "\\");
}

function extractStringLiterals(source) {
  const literals = [];
  const cleanedSource = removeComments(source);

  const pattern =
    /(["'])(?:(?=(\\?))\2.)*?\1|`(?:\\.|[^`])*`/gs;

  for (const match of cleanedSource.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const quote = raw[0];

    let value = raw.slice(1, -1);

    if (quote === "`" && value.includes("${")) {
      continue;
    }

    value = decodeSimpleString(value);

    literals.push({
      value,
      raw,
      index,
      line: getLineNumber(cleanedSource, index),
    });
  }

  return literals;
}

function isIgnoredLiteral(value, config) {
  const ignoredLiterals =
    config.constants?.ignoredLiterals ?? [];

  return ignoredLiterals.includes(value);
}

function isUsefulLiteral(value, config) {
  const minimumStringLength =
    Number(config.constants?.minimumStringLength) || 3;

  if (value.length < minimumStringLength) {
    return false;
  }

  if (isIgnoredLiteral(value, config)) {
    return false;
  }

  if (/^\s+$/.test(value)) {
    return false;
  }

  if (/^[0-9]+$/.test(value)) {
    return false;
  }

  return true;
}

function checkRepeatedLiterals({
  file,
  source,
  literals,
  config,
  findings,
}) {
  const rule = config.constants?.rules?.repeatedLiteral;

  if (
    !rule?.enabled ||
    config.constants?.detectRepeatedLiterals === false
  ) {
    return;
  }

  const threshold =
    Number(config.constants?.minimumOccurrences) || 3;

  const grouped = new Map();

  for (const literal of literals) {
    if (!isUsefulLiteral(literal.value, config)) {
      continue;
    }

    const existing = grouped.get(literal.value) ?? [];
    existing.push(literal);
    grouped.set(literal.value, existing);
  }

  for (const [value, occurrences] of grouped.entries()) {
    if (occurrences.length < threshold) {
      continue;
    }

    const first = occurrences[0];

    findings.push(
      createFinding({
        ruleId: "constants.repeatedLiteral",
        severity: rule.severity,
        title: "Repeated literal may need a shared constant",
        message:
          `The literal "${value}" appears ${occurrences.length} times in this changed file.`,
        recommendation:
          "Extract the repeated value into a named constant when it represents shared business or UI meaning.",
        file,
        line: first.line,
        column: 1,
        codeSnippet: getCodeLine(source, first.line),
        evidence: occurrences
          .slice(0, 10)
          .map((occurrence) => `Occurrence at line ${occurrence.line}`),
        confidence: "medium",
      }),
    );
  }
}

function isStatusValue(value) {
  const normalized = value.trim().toUpperCase();

  if (DEFAULT_STATUS_VALUES.has(normalized)) {
    return true;
  }

  return /^(ACTIVE|INACTIVE|PENDING|APPROVED|REJECTED|DRAFT|FAILED|SUCCESS|COMPLETED|CANCELLED|CANCELED|ARCHIVED|DELETED|ENABLED|DISABLED)$/.test(
    normalized,
  );
}

function checkHardcodedStatuses({
  file,
  source,
  literals,
  config,
  findings,
}) {
  const rule = config.constants?.rules?.hardcodedStatus;

  if (!rule?.enabled) {
    return;
  }

  const alreadyReported = new Set();

  for (const literal of literals) {
    if (!isStatusValue(literal.value)) {
      continue;
    }

    const normalizedValue = literal.value.toUpperCase();

    if (alreadyReported.has(normalizedValue)) {
      continue;
    }

    alreadyReported.add(normalizedValue);

    findings.push(
      createFinding({
        ruleId: "constants.hardcodedStatus",
        severity: rule.severity,
        title: "Hardcoded status value detected",
        message:
          `The status value "${literal.value}" is written directly in production code.`,
        recommendation:
          "Use a centralized status constant, enum, or generated API type instead of repeating raw status strings.",
        file,
        line: literal.line,
        column: 1,
        codeSnippet: getCodeLine(source, literal.line),
        evidence: [`Detected status: ${literal.value}`],
        confidence: "medium",
      }),
    );
  }
}

function looksLikePermission(value) {
  const trimmed = value.trim();

  if (
    /^(can|has|allow|manage|view|create|read|update|delete|edit|approve|reject)[.:_-][A-Za-z0-9._:-]+$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  if (
    /^[A-Za-z][A-Za-z0-9_-]*\.(create|read|view|update|delete|edit|manage|approve|reject)$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  if (
    /^(permission|permissions|role|roles)[.:_-][A-Za-z0-9._:-]+$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}

function checkHardcodedPermissions({
  file,
  source,
  literals,
  config,
  findings,
}) {
  const rule =
    config.constants?.rules?.hardcodedPermission;

  if (!rule?.enabled) {
    return;
  }

  const alreadyReported = new Set();

  for (const literal of literals) {
    if (!looksLikePermission(literal.value)) {
      continue;
    }

    const normalizedValue = literal.value.toLowerCase();

    if (alreadyReported.has(normalizedValue)) {
      continue;
    }

    alreadyReported.add(normalizedValue);

    findings.push(
      createFinding({
        ruleId: "constants.hardcodedPermission",
        severity: rule.severity,
        title: "Hardcoded permission value detected",
        message:
          `The permission value "${literal.value}" is written directly in the changed file.`,
        recommendation:
          "Reference a centralized permission constant to avoid inconsistent permission names.",
        file,
        line: literal.line,
        column: 1,
        codeSnippet: getCodeLine(source, literal.line),
        evidence: [`Detected permission: ${literal.value}`],
        confidence: "medium",
      }),
    );
  }
}

function findQueryKeyLiterals(source) {
  const results = [];

  const patterns = [
    /\bqueryKey\s*:\s*\[\s*(['"`])([^'"`]+)\1/g,
    /\binvalidateQueries\s*\(\s*\{\s*queryKey\s*:\s*\[\s*(['"`])([^'"`]+)\1/g,
    /\bsetQueryData\s*\(\s*\[\s*(['"`])([^'"`]+)\1/g,
    /\bgetQueryData\s*\(\s*\[\s*(['"`])([^'"`]+)\1/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;

      results.push({
        value: match[2],
        index,
        line: getLineNumber(source, index),
      });
    }
  }

  return results.sort((left, right) => left.index - right.index);
}

function checkHardcodedQueryKeys({
  file,
  source,
  config,
  findings,
}) {
  const rule =
    config.constants?.rules?.hardcodedQueryKey;

  if (!rule?.enabled) {
    return;
  }

  const matches = findQueryKeyLiterals(source);
  const alreadyReported = new Set();

  for (const match of matches) {
    const normalizedValue = match.value.toLowerCase();

    if (alreadyReported.has(normalizedValue)) {
      continue;
    }

    alreadyReported.add(normalizedValue);

    findings.push(
      createFinding({
        ruleId: "constants.hardcodedQueryKey",
        severity: rule.severity,
        title: "Hardcoded TanStack Query key detected",
        message:
          `The query key "${match.value}" is declared directly in the changed file.`,
        recommendation:
          "Move reusable query keys into a centralized query-key constant or query-key factory.",
        file,
        line: match.line,
        column: 1,
        codeSnippet: getCodeLine(source, match.line),
        evidence: [`Detected query key: ${match.value}`],
        confidence: "high",
      }),
    );
  }
}

function findStorageKeyLiterals(source) {
  const results = [];

  const pattern =
    /\b(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*(['"`])([^'"`]+)\1/g;

  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;

    results.push({
      value: match[2],
      operation: match[0]
        .match(/\.(getItem|setItem|removeItem)/)?.[1] ?? "storage",
      index,
      line: getLineNumber(source, index),
    });
  }

  return results;
}

function checkHardcodedStorageKeys({
  file,
  source,
  config,
  findings,
}) {
  const rule =
    config.constants?.rules?.hardcodedStorageKey;

  if (!rule?.enabled) {
    return;
  }

  const matches = findStorageKeyLiterals(source);
  const alreadyReported = new Set();

  for (const match of matches) {
    const normalizedValue = match.value.toLowerCase();

    if (alreadyReported.has(normalizedValue)) {
      continue;
    }

    alreadyReported.add(normalizedValue);

    findings.push(
      createFinding({
        ruleId: "constants.hardcodedStorageKey",
        severity: rule.severity,
        title: "Hardcoded browser storage key detected",
        message:
          `The storage key "${match.value}" is passed directly to ${match.operation}().`,
        recommendation:
          "Use a centralized storage-key constant to prevent inconsistent browser storage access.",
        file,
        line: match.line,
        column: 1,
        codeSnippet: getCodeLine(source, match.line),
        evidence: [
          `Storage operation: ${match.operation}`,
          `Storage key: ${match.value}`,
        ],
        confidence: "high",
      }),
    );
  }
}

/**
 * Runs constant consistency checks against files changed by the PR.
 *
 * The detector analyzes changed files only. It does not scan the entire
 * repository for repeated literals or duplicate constants.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {string[]} options.files
 * @param {object} options.config
 * @returns {Promise<object[]>}
 */
export async function detectConstants({
  repositoryRoot,
  files,
  config,
}) {
  const findings = [];

  if (!config.constants?.enabled) {
    return findings;
  }

  for (const relativeFile of files) {
    const normalizedFile = normalizePath(relativeFile);

    if (!isSupportedFile(normalizedFile, config)) {
      continue;
    }

    if (isIgnored(normalizedFile, config)) {
      continue;
    }

    if (isGeneratedFile(normalizedFile, config)) {
      continue;
    }

    // Raw literals inside centralized constant files are expected.
    if (isInsideConstantsDirectory(normalizedFile, config)) {
      continue;
    }

    const absoluteFile = path.resolve(
      repositoryRoot,
      ...normalizedFile.split("/"),
    );

    if (!fs.existsSync(absoluteFile)) {
      continue;
    }

    const source = fs.readFileSync(absoluteFile, "utf8");
    const literals = extractStringLiterals(source);

    checkRepeatedLiterals({
      file: normalizedFile,
      source,
      literals,
      config,
      findings,
    });

    checkHardcodedStatuses({
      file: normalizedFile,
      source,
      literals,
      config,
      findings,
    });

    checkHardcodedPermissions({
      file: normalizedFile,
      source,
      literals,
      config,
      findings,
    });

    checkHardcodedQueryKeys({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    checkHardcodedStorageKeys({
      file: normalizedFile,
      source,
      config,
      findings,
    });
  }

  return findings;
}

export default detectConstants;