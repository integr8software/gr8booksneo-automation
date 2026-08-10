import fs from "node:fs";
import path from "node:path";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const STATUS_VALUES = new Set([
  "ACTIVE", "INACTIVE", "PENDING", "APPROVED", "REJECTED", "CANCELLED",
  "CANCELED", "DRAFT", "COMPLETED", "FAILED", "SUCCESS", "ENABLED",
  "DISABLED", "ARCHIVED", "DELETED", "PROCESSING", "PAID", "UNPAID", "EXPIRED",
]);
const COMMON_UI_LITERALS = new Set([
  "active", "inactive", "completed", "cancelled", "canceled", "pending",
  "list", "map", "edit", "view", "save", "cancel", "close", "button",
  "submit", "reset", "code", "name", "description", "branch", "cold",
  "ambient", "bulk", "hazmat", "general", "open", "progress", "readiness",
  "text", "amount", "number", "currency", "date", "datetime",
  "dropdown", "checkbox", "radio", "switch", "action",
  "left", "right", "center", "justify",
  "particulars", "remarks", "reference", "referenceno", "status",
  "header", "footer", "page", "row", "column",
  "true", "false", "null", "undefined",
  // Validation/config vocabulary: these describe library behavior, not business constants.
  "alphanumeric", "email", "required", "optional", "nullable",
]);

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}
function normalizeDirectory(value) {
  return normalizePath(value).replace(/^\/+|\/+$/g, "").toLowerCase();
}
function getLineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}
function getCodeLine(source, lineNumber) {
  return source.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
}
function createFinding({ ruleId, severity, title, message, recommendation, file,
  line = null, column = null, codeSnippet = "", relatedFiles = [], evidence = [],
  confidence = "high" }) {
  return {
    category: "constants", ruleId, severity, title, message, recommendation,
    file: normalizePath(file), line, column, endLine: null, endColumn: null,
    codeSnippet, relatedFiles: relatedFiles.map(normalizePath), evidence,
    detector: "constants", confidence,
  };
}
function isIgnored(file, config) {
  const normalized = `/${normalizePath(file).toLowerCase()}/`;
  return (config.ignoredPaths ?? []).some((item) => {
    const ignored = normalizeDirectory(item);
    return ignored && normalized.includes(`/${ignored}/`);
  });
}
function isGeneratedFile(file, config) {
  const normalized = normalizePath(file).toLowerCase();
  return (config.generatedCodePatterns ?? []).some((item) => {
    const pattern = normalizePath(item).toLowerCase();
    return pattern && normalized.includes(pattern);
  });
}
function isSupportedFile(file, config) {
  const supported = config.supportedExtensions ?? DEFAULT_EXTENSIONS;
  return supported.map((item) => item.toLowerCase())
    .includes(path.extname(file).toLowerCase());
}
function isInsideDirectory(file, directory) {
  const normalizedFile = normalizePath(file).toLowerCase();
  const normalizedDirectory = normalizeDirectory(directory);
  return normalizedDirectory &&
    (normalizedFile === normalizedDirectory || normalizedFile.startsWith(`${normalizedDirectory}/`));
}
function isInsideConstantsDirectory(file, config) {
  return (config.constants?.rootDirectories ?? ["app/src/constants"])
    .some((root) => isInsideDirectory(file, root));
}
function isMockOrDataFile(file) {
  const normalized = `/${normalizePath(file).toLowerCase()}`;
  return normalized.includes("/mock") || normalized.includes("/mocks/") ||
    normalized.includes("/fixtures/") || normalized.includes("/fixture") ||
    normalized.includes("/dummy") || normalized.includes("/sample") ||
    normalized.includes("/data/") ||
    /(?:mock|fixture|dummy|sample)data\.(ts|tsx|js|jsx)$/i.test(normalized);
}
function removeComments(source) {
  let output = "";
  let index = 0;
  let state = "code";
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        output += "  "; index += 2; state = "line"; continue;
      }
      if (current === "/" && next === "*") {
        output += "  "; index += 2; state = "block"; continue;
      }
      output += current; index += 1; continue;
    }
    if (state === "line") {
      if (current === "\n") { output += "\n"; state = "code"; }
      else output += " ";
      index += 1; continue;
    }
    if (current === "*" && next === "/") {
      output += "  "; index += 2; state = "code"; continue;
    }
    output += current === "\n" ? "\n" : " ";
    index += 1;
  }
  return output;
}
function extractStringLiterals(source) {
  const cleaned = removeComments(source);
  const literals = [];
  const pattern = /(["'])(?:(?=(\\?))\2.)*?\1|`(?:\\.|[^`])*`/gs;
  for (const match of cleaned.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (raw[0] === "`" && raw.includes("${")) continue;
    const line = getLineNumber(cleaned, index);
    literals.push({ value: raw.slice(1, -1), index, line, codeLine: getCodeLine(source, line) });
  }
  return literals;
}
function isTailwindOrCssLiteral(value) {
  const text = value.trim();
  if (!text) return false;
  return /\b(?:sm|md|lg|xl|2xl):[A-Za-z0-9_[\]():./%-]+/.test(text) ||
    /\b(?:min-w|max-w|w|h|p|px|py|m|mx|my|gap|grid|flex|text|bg|border|rounded|items|justify|space|col|row|shadow|hover|focus|dark)-/.test(text) ||
    (text.includes(" ") && /^[A-Za-z0-9_:[\]()./%#-]+(?:\s+[A-Za-z0-9_:[\]()./%#-]+)+$/.test(text));
}
function isHtmlOrJsxAttributeLiteral(literal) {
  return /\b(?:type|variant|mode|size|role|method|target|rel|aria-[\w-]+|data-[\w-]+|className)\s*=\s*["'`]/i
    .test(literal.codeLine);
}
function isTypeUnionLiteral(literal) {
  const line = literal.codeLine;
  return /^\s*(?:export\s+)?type\s+\w+\s*=/.test(line) ||
    /["'`][^"'`]+["'`]\s*\|\s*["'`]/.test(line);
}
function isObjectKeyLiteral(literal) {
  return /^\s*["'`][^"'`]+["'`]\s*:/.test(literal.codeLine);
}
function isPresentationOrFallbackLiteral(literal) {
  const line = literal.codeLine;

  return (
    /\b(?:label|title|text|placeholder|caption|displayName)\s*[:=]/i.test(line) ||
    /\|\|\s*["'`]/.test(line) ||
    /\?\s*["'`][^"'`]+["'`]\s*:\s*["'`]/.test(line) ||
    /\b(?:kind|type|variant|align|alignment|field|column|accessorKey|dataIndex|key)\s*[:=]/i.test(line) ||
    /\b(?:update|set|patch|change)[A-Za-z0-9_]*\s*\(/.test(line) ||
    /\b(?:headerCell|reportTableCell|receivingReportColumn)\s*\(/i.test(line)
  );
}

function isUsefulRepeatedLiteral(literal, config) {
  const value = literal.value.trim();
  const minimum = Number(config.constants?.minimumStringLength) || 3;

  return value.length >= minimum &&
    !(config.constants?.ignoredLiterals ?? []).includes(value) &&
    !COMMON_UI_LITERALS.has(value.toLowerCase()) &&
    !isTailwindOrCssLiteral(value) &&
    !isHtmlOrJsxAttributeLiteral(literal) &&
    !isTypeUnionLiteral(literal) &&
    !isObjectKeyLiteral(literal) &&
    !isPresentationOrFallbackLiteral(literal) &&
    !/^\d+$/.test(value) &&
    !/^\s+$/.test(value);
}
function looksLikeBusinessIdentifier(value) {
  const text = value.trim();
  return /^[A-Z][A-Z0-9_]{2,}$/.test(text) ||
    /^(?:permission|role|feature|storage|query|route|api)[.:/_-][A-Za-z0-9.:/_-]+$/i.test(text) ||
    /^[a-z][a-z0-9]+(?:[._:-][a-z0-9]+){2,}$/i.test(text);
}
function checkRepeatedLiterals({ file, source, literals, config, findings }) {
  const rule = config.constants?.rules?.repeatedLiteral;
  if (!rule?.enabled || config.constants?.detectRepeatedLiterals === false || isMockOrDataFile(file)) return;
  const threshold = Math.max(Number(config.constants?.minimumOccurrences) || 3, 3);
  const grouped = new Map();
  for (const literal of literals) {
    if (!isUsefulRepeatedLiteral(literal, config)) continue;
    const list = grouped.get(literal.value) ?? [];
    list.push(literal); grouped.set(literal.value, list);
  }
  for (const [value, occurrences] of grouped.entries()) {
    if (occurrences.length < threshold) continue;
    if (!looksLikeBusinessIdentifier(value) && occurrences.length < 5) continue;
    const first = occurrences[0];
    findings.push(createFinding({
      ruleId: "constants.repeatedLiteral", severity: rule.severity,
      title: "Repeated business literal detected",
      message: `The literal "${value}" appears ${occurrences.length} times in this changed file.`,
      recommendation: "Extract the repeated value into a local constant when it is reused within this file. Use a shared constant only when the same value is reused across multiple modules.",
      file, line: first.line, column: 1, codeSnippet: getCodeLine(source, first.line),
      evidence: occurrences.slice(0, 10).map((item) => `Occurrence at line ${item.line}`),
      confidence: looksLikeBusinessIdentifier(value) ? "high" : "medium",
    }));
  }
}
function statusContextIsMeaningful(literal) {
  const line = literal.codeLine;

  if (
    isHtmlOrJsxAttributeLiteral(literal) ||
    isTypeUnionLiteral(literal) ||
    isPresentationOrFallbackLiteral(literal) ||
    /\bconfig\.statuses\b/i.test(line)
  ) {
    return false;
  }

  return (
    /\b(?:status|approvalStatus|processingStatus)\s*[:=]/i.test(line) ||
    /\b(?:status|approvalStatus|processingStatus)\s*(?:===|!==|==|!=)/i.test(line)
  );
}
function checkHardcodedStatuses({ file, source, literals, config, findings }) {
  const rule = config.constants?.rules?.hardcodedStatus;
  if (!rule?.enabled || isMockOrDataFile(file)) return;
  const grouped = new Map();
  for (const literal of literals) {
    const normalized = literal.value.trim().toUpperCase();
    if (!STATUS_VALUES.has(normalized) || !statusContextIsMeaningful(literal)) continue;
    const list = grouped.get(normalized) ?? [];
    list.push(literal); grouped.set(normalized, list);
  }
  // Two occurrences in one changed file is commonly ordinary inline UI logic.
  // Require at least three meaningful status uses before recommending extraction.
  const threshold = Math.max(
    Number(config.constants?.minimumStatusOccurrences) || 3,
    3,
  );

  for (const occurrences of grouped.values()) {
    if (occurrences.length < threshold) continue;
    const first = occurrences[0];
    findings.push(createFinding({
      ruleId: "constants.hardcodedStatus", severity: rule.severity,
      title: "Repeated hardcoded status value detected",
      message: `The status value "${first.value}" appears ${occurrences.length} times in status-related logic.`,
      recommendation: "Use an existing status constant, enum, or generated API type when the same status is reused across logic.",
      file, line: first.line, column: 1, codeSnippet: getCodeLine(source, first.line),
      evidence: occurrences.slice(0, 10).map((item) => `Occurrence at line ${item.line}`),
      confidence: "high",
    }));
  }
}
function looksLikePermission(value) {
  const text = value.trim();
  return /^(?:can|has|allow|manage|view|create|read|update|delete|edit|approve|reject)[.:_-][A-Za-z0-9._:-]+$/i.test(text) ||
    /^[A-Za-z][A-Za-z0-9_-]*\.(?:create|read|view|update|delete|edit|manage|approve|reject)$/i.test(text) ||
    /^(?:permission|permissions|role|roles)[.:_-][A-Za-z0-9._:-]+$/i.test(text);
}
function checkHardcodedPermissions({ file, source, literals, config, findings }) {
  const rule = config.constants?.rules?.hardcodedPermission;
  if (!rule?.enabled || isMockOrDataFile(file)) return;
  const seen = new Set();
  for (const literal of literals) {
    if (!looksLikePermission(literal.value)) continue;
    const key = literal.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(createFinding({
      ruleId: "constants.hardcodedPermission", severity: rule.severity,
      title: "Hardcoded permission identifier detected",
      message: `The permission identifier "${literal.value}" is written directly in the changed file.`,
      recommendation: "Reference the centralized permission definition to prevent inconsistent authorization checks.",
      file, line: literal.line, column: 1, codeSnippet: getCodeLine(source, literal.line),
      evidence: [`Permission identifier: ${literal.value}`], confidence: "high",
    }));
  }
}
function checkHardcodedQueryKeys({ file, source, config, findings }) {
  const rule = config.constants?.rules?.hardcodedQueryKey;
  if (!rule?.enabled || isMockOrDataFile(file)) return;
  const patterns = [
    /\bqueryKey\s*:\s*\[\s*(["'`])([^"'`]+)\1/g,
    /\binvalidateQueries\s*\(\s*\{\s*queryKey\s*:\s*\[\s*(["'`])([^"'`]+)\1/g,
    /\b(?:setQueryData|getQueryData)\s*\(\s*\[\s*(["'`])([^"'`]+)\1/g,
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (seen.has(match[2])) continue;
      seen.add(match[2]);
      const line = getLineNumber(source, match.index ?? 0);
      findings.push(createFinding({
        ruleId: "constants.hardcodedQueryKey", severity: rule.severity,
        title: "Hardcoded TanStack Query key detected",
        message: `The query key "${match[2]}" is declared directly in the changed file.`,
        recommendation: "Use a centralized query-key constant or query-key factory.",
        file, line, column: 1, codeSnippet: getCodeLine(source, line),
        evidence: [`Query key: ${match[2]}`], confidence: "high",
      }));
    }
  }
}
function checkHardcodedStorageKeys({ file, source, config, findings }) {
  const rule = config.constants?.rules?.hardcodedStorageKey;
  if (!rule?.enabled || isMockOrDataFile(file)) return;
  const pattern = /\b(?:localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*(["'`])([^"'`]+)\2/g;
  const seen = new Set();
  for (const match of source.matchAll(pattern)) {
    if (seen.has(match[3])) continue;
    seen.add(match[3]);
    const line = getLineNumber(source, match.index ?? 0);
    findings.push(createFinding({
      ruleId: "constants.hardcodedStorageKey", severity: rule.severity,
      title: "Hardcoded browser storage key detected",
      message: `The storage key "${match[3]}" is passed directly to ${match[1]}().`,
      recommendation: "Use a centralized storage-key constant to prevent inconsistent browser storage access.",
      file, line, column: 1, codeSnippet: getCodeLine(source, line),
      evidence: [`Storage operation: ${match[1]}`, `Storage key: ${match[3]}`], confidence: "high",
    }));
  }
}
export async function detectConstants({ repositoryRoot, files, config }) {
  const findings = [];
  if (!config.constants?.enabled) return findings;
  for (const relativeFile of files) {
    const file = normalizePath(relativeFile);
    if (!isSupportedFile(file, config) || isIgnored(file, config) ||
      isGeneratedFile(file, config) || isInsideConstantsDirectory(file, config)) continue;
    const absoluteFile = path.resolve(repositoryRoot, ...file.split("/"));
    if (!fs.existsSync(absoluteFile)) continue;
    const source = fs.readFileSync(absoluteFile, "utf8");
    const literals = extractStringLiterals(source);
    checkRepeatedLiterals({ file, source, literals, config, findings });
    checkHardcodedStatuses({ file, source, literals, config, findings });
    checkHardcodedPermissions({ file, source, literals, config, findings });
    checkHardcodedQueryKeys({ file, source, config, findings });
    checkHardcodedStorageKeys({ file, source, config, findings });
  }
  return findings;
}
export default detectConstants;
