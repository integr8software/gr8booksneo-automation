import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
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
    category: "types", ruleId, severity, title, message, recommendation,
    file: normalizePath(file), line, column, endLine: null, endColumn: null,
    codeSnippet, relatedFiles: relatedFiles.map(normalizePath), evidence,
    detector: "types", confidence,
  };
}
function isIgnored(file, config) {
  const normalized = `/${normalizePath(file).toLowerCase()}/`;
  return (config.ignoredPaths ?? []).some((item) => {
    const ignored = normalizePath(item).replace(/^\/+|\/+$/g, "").toLowerCase();
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
function isValidationFile(file) {
  const normalized = normalizePath(file).toLowerCase();
  const fileName = path.basename(normalized);
  return normalized.includes("/validations/") || normalized.includes("/validation/") ||
    normalized.includes("/validators/") || normalized.includes("/schemas/") ||
    /(?:validation|validator|schema)\.(ts|tsx|js|jsx)$/.test(fileName) ||
    /\.(?:validation|validator|schema)\.(ts|tsx|js|jsx)$/.test(fileName);
}
function isInsideTypesDirectory(file, config) {
  const normalized = normalizePath(file);
  const directory = path.posix.dirname(normalized);
  const shared = config.types?.sharedTypeDirectories ?? [
    "app/src/types", "app/src/shared/types", "app/src/lib/types",
  ];
  if (shared.some((root) => {
    const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
    return directory === normalizedRoot || directory.startsWith(`${normalizedRoot}/`);
  })) return true;
  const names = config.types?.featureTypeDirectoryNames ?? ["types"];
  return directory.split("/").some((segment) => names.includes(segment));
}
function isUiFile(file, config) {
  const normalized = normalizePath(file);
  return (config.ui?.uiRootDirectories ?? ["app/src/ui"]).some((root) => {
    const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
}
function isHooksFile(file) {
  const normalized = normalizePath(file).toLowerCase();
  return normalized.includes("/hooks/") || /^use[A-Z].*\.(ts|tsx|js|jsx)$/.test(path.basename(file));
}
function maskCommentsAndStrings(source) {
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
      if (current === "'" || current === '"' || current === "`") {
        output += " "; index += 1;
        state = current === "'" ? "single" : current === '"' ? "double" : "template";
        continue;
      }
      output += current; index += 1; continue;
    }
    if (state === "line") {
      if (current === "\n") { output += "\n"; state = "code"; }
      else output += " ";
      index += 1; continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        output += "  "; index += 2; state = "code"; continue;
      }
      output += current === "\n" || current === "\r" ? current : " ";
      index += 1; continue;
    }
    const closing = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (current === "\\") {
      output += " ";
      if (next !== undefined) {
        output += next === "\n" || next === "\r" ? next : " "; index += 2;
      } else index += 1;
      continue;
    }
    if (current === closing) {
      output += " "; index += 1; state = "code"; continue;
    }
    output += current === "\n" || current === "\r" ? current : " ";
    index += 1;
  }
  return output;
}
function findDeclaredTypes(source) {
  const masked = maskCommentsAndStrings(source);
  const results = [];
  const pattern = /\b(export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/g;
  for (const match of masked.matchAll(pattern)) {
    results.push({ exported: Boolean(match[1]), kind: match[2], name: match[3], index: match.index ?? 0 });
  }
  return results;
}
function appearsToBeApiDto(name) {
  return /(Request|Response|Dto|DTO|Payload|ApiResult|ApiModel)$/i.test(name);
}
function appearsFrontendSpecific(name) {
  return /(Props|FormValues|FormErrors|FormData|ViewModel|TableRow|RowData|ColumnDef|Column|Filter|Dialog|Modal|Drawer|UiState|UIState|LocalState|Option|Item|CardItem|TabItem|DisplayModel|ContextValue|Ref)$/i.test(name);
}
function isTemporaryTypeName(name) {
  return /^(Temporary|Temp|Legacy|Fallback)/i.test(name);
}
function countIdentifierReferences(source, name) {
  const masked = maskCommentsAndStrings(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...masked.matchAll(new RegExp(`\\b${escaped}\\b`, "g"))].length;
}
function hasTemporaryMarkerNearDeclaration(source, index, markers) {
  const nearby = source.slice(Math.max(0, index - 500), Math.min(source.length, index + 500)).toLowerCase();
  return markers.some((marker) => {
    const normalized = String(marker).toLowerCase();
    return normalized && normalized !== "temporary" && nearby.includes(normalized);
  });
}
function detectExplicitAny({ file, source, config, findings }) {
  const rule = config.types?.rules?.explicitAnyIntroduced;
  if (!rule?.enabled) return;
  const masked = maskCommentsAndStrings(source);
  const patterns = [/:\s*any\b/g, /\bas\s+any\b/g, /<any>/g,
    /\bArray\s*<\s*any\s*>/g, /\bPromise\s*<\s*any\s*>/g,
    /\bRecord\s*<[^,>]+,\s*any\s*>/g];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const line = getLineNumber(masked, match.index ?? 0);
      if (seen.has(line)) continue;
      seen.add(line);
      findings.push(createFinding({
        ruleId: "types.explicitAnyIntroduced", severity: rule.severity,
        title: "Explicit any type detected", message: "The changed file introduces an explicit any type.",
        recommendation: "Replace any with an existing shared type, generated Orval DTO, unknown, or a clearly defined frontend-specific type.",
        file, line, column: 1, codeSnippet: getCodeLine(source, line), confidence: "high",
      }));
    }
  }
}
function detectManualApiDto({ file, source, config, findings }) {
  const rule = config.types?.rules?.manualApiDto;
  if (!rule?.enabled || isGeneratedFile(file, config)) return;
  for (const declared of findDeclaredTypes(source)) {
    if (!declared.exported || !appearsToBeApiDto(declared.name) || appearsFrontendSpecific(declared.name)) continue;
    const line = getLineNumber(source, declared.index);
    findings.push(createFinding({
      ruleId: "types.manualApiDto", severity: rule.severity,
      title: "Possible manually declared API DTO",
      message: `"${declared.name}" looks like an exported API request or response DTO declared manually.`,
      recommendation: "Use the Orval-generated API type. Fix the OpenAPI schema when the generated contract is incorrect.",
      file, line, column: 1, codeSnippet: getCodeLine(source, line),
      evidence: [`Declaration kind: ${declared.kind}`, `Declaration name: ${declared.name}`], confidence: "medium",
    }));
  }
}
function detectTypeOutsideExpectedLocation({ file, source, config, findings }) {
  const rule = config.types?.rules?.typeOutsideExpectedLocation;
  if (!rule?.enabled || isInsideTypesDirectory(file, config) || isValidationFile(file)) return;
  for (const declared of findDeclaredTypes(source)) {
    const references = countIdentifierReferences(source, declared.name);
    const localFrontendType = appearsFrontendSpecific(declared.name) ||
      ((isUiFile(file, config) || isHooksFile(file)) && !declared.exported);
    if (localFrontendType) continue;
    if (!declared.exported && references <= 3) continue;
    const line = getLineNumber(source, declared.index);
    findings.push(createFinding({
      ruleId: "types.typeOutsideExpectedLocation", severity: rule.severity,
      title: "Reusable exported type may be in the wrong location",
      message: `"${declared.name}" appears reusable and is declared outside a shared or module-specific types folder.`,
      recommendation: "Keep genuinely local UI/helper types beside their implementation. Move exported or reused business types into the appropriate types directory.",
      file, line, column: 1, codeSnippet: getCodeLine(source, line),
      evidence: [`Declaration kind: ${declared.kind}`, `Exported: ${declared.exported}`, `References in file: ${references}`],
      confidence: declared.exported ? "high" : "medium",
    }));
    return;
  }
}
function detectTemporaryTypeWithoutReference({ file, source, config, findings }) {
  const rule = config.types?.rules?.temporaryTypeWithoutReference;
  if (!rule?.enabled) return;
  const markers = config.types?.temporaryTypeMarkers ?? ["TODO", "FIXME", "ticket", "temporary"];
  for (const declared of findDeclaredTypes(source)) {
    if (!isTemporaryTypeName(declared.name) || hasTemporaryMarkerNearDeclaration(source, declared.index, markers)) continue;
    const line = getLineNumber(source, declared.index);
    findings.push(createFinding({
      ruleId: "types.temporaryTypeWithoutReference", severity: rule.severity,
      title: "Temporary type has no ticket reference",
      message: `"${declared.name}" appears temporary but has no nearby TODO, FIXME, or ticket reference.`,
      recommendation: "Add a TODO or ticket reference explaining why the temporary type exists and when it should be removed.",
      file, line, column: 1, codeSnippet: getCodeLine(source, line),
      evidence: [`Temporary declaration: ${declared.name}`], confidence: "medium",
    }));
  }
}
export async function detectTypes({ repositoryRoot, files, config }) {
  const findings = [];
  if (!config.types?.enabled) return findings;
  for (const relativeFile of files) {
    const file = normalizePath(relativeFile);
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) || isIgnored(file, config) || isGeneratedFile(file, config)) continue;
    const absoluteFile = path.resolve(repositoryRoot, ...file.split("/"));
    if (!fs.existsSync(absoluteFile)) continue;
    const source = fs.readFileSync(absoluteFile, "utf8");
    detectExplicitAny({ file, source, config, findings });
    detectManualApiDto({ file, source, config, findings });
    detectTypeOutsideExpectedLocation({ file, source, config, findings });
    detectTemporaryTypeWithoutReference({ file, source, config, findings });
  }
  return findings;
}
export default detectTypes;
