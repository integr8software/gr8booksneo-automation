import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function normalizePath(value) {
  return value.replaceAll("\\", "/");
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
    category: "types",
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
    detector: "types",
    confidence,
  };
}

function isIgnored(file, config) {
  const normalized = `/${normalizePath(file).toLowerCase()}/`;

  return (config.ignoredPaths ?? []).some((ignoredPath) => {
    const ignored = normalizePath(ignoredPath).toLowerCase();
    return normalized.includes(`/${ignored}/`);
  });
}

function isGeneratedFile(file, config) {
  const normalized = normalizePath(file).toLowerCase();

  return (config.generatedCodePatterns ?? []).some((pattern) =>
    normalized.includes(normalizePath(pattern).toLowerCase()),
  );
}

function isInsideTypesDirectory(file, config) {
  const normalized = normalizePath(file);
  const directory = path.posix.dirname(normalized);

  const sharedDirectories =
    config.types?.sharedTypeDirectories ?? [
      "app/src/types",
      "app/src/shared/types",
      "app/src/lib/types",
    ];

  if (
    sharedDirectories.some((sharedDirectory) => {
      const root = normalizePath(sharedDirectory).replace(/\/+$/, "");

      return directory === root || directory.startsWith(`${root}/`);
    })
  ) {
    return true;
  }

  const featureDirectoryNames =
    config.types?.featureTypeDirectoryNames ?? ["types"];

  return directory
    .split("/")
    .some((segment) => featureDirectoryNames.includes(segment));
}

function isUiFile(file, config) {
  const normalized = normalizePath(file);

  return (config.ui?.uiRootDirectories ?? ["app/src/ui"]).some((root) => {
    const normalizedRoot = normalizePath(root).replace(/\/+$/, "");

    return (
      normalized === normalizedRoot ||
      normalized.startsWith(`${normalizedRoot}/`)
    );
  });
}

function findDeclaredTypes(source) {
  const results = [];

  const pattern =
    /\b(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)\b/g;

  for (const match of source.matchAll(pattern)) {
    results.push({
      name: match[1],
      index: match.index ?? 0,
      declaration: match[0],
    });
  }

  return results;
}

function appearsToBeApiDto(typeName) {
  return /(Request|Response|Dto|DTO|Payload|Result|ApiModel)$/i.test(typeName);
}

function appearsFrontendSpecific(typeName) {
  return /(Props|FormValues|FormData|ViewModel|TableRow|UiState|UIState|Option|Item|Column)$/i.test(
    typeName,
  );
}

function detectExplicitAny({ file, source, config, findings }) {
  const rule = config.types?.rules?.explicitAnyIntroduced;

  if (!rule?.enabled) {
    return;
  }

  const patterns = [
    /:\s*any\b/g,
    /\bas\s+any\b/g,
    /<any>/g,
    /\bArray<any>\b/g,
    /\bPromise<any>\b/g,
  ];

  const seenLines = new Set();

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = getLineNumber(source, match.index ?? 0);

      if (seenLines.has(line)) {
        continue;
      }

      seenLines.add(line);

      findings.push(
        createFinding({
          ruleId: "types.explicitAnyIntroduced",
          severity: rule.severity,
          title: "Explicit any type detected",
          message: "The file introduces an explicit any type.",
          recommendation:
            "Replace any with an existing shared type, generated Orval DTO, unknown, or a clearly defined frontend-specific type.",
          file,
          line,
          column: 1,
          codeSnippet: getCodeLine(source, line),
          confidence: "high",
        }),
      );
    }
  }
}

function detectManualApiDto({ file, source, config, findings }) {
  const rule = config.types?.rules?.manualApiDto;

  if (!rule?.enabled || isGeneratedFile(file, config)) {
    return;
  }

  const declaredTypes = findDeclaredTypes(source);

  for (const declaredType of declaredTypes) {
    if (
      !appearsToBeApiDto(declaredType.name) ||
      appearsFrontendSpecific(declaredType.name)
    ) {
      continue;
    }

    const line = getLineNumber(source, declaredType.index);

    findings.push(
      createFinding({
        ruleId: "types.manualApiDto",
        severity: rule.severity,
        title: "Possible manually declared API DTO",
        message: `"${declaredType.name}" looks like an API request or response DTO declared manually.`,
        recommendation:
          "Use the Orval-generated API type. When the generated DTO is incorrect, update the OpenAPI schema instead of duplicating it in the frontend.",
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        confidence: "medium",
      }),
    );
  }
}

function detectTypeOutsideExpectedLocation({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.types?.rules?.typeOutsideExpectedLocation;

  if (!rule?.enabled || isInsideTypesDirectory(file, config)) {
    return;
  }

  const declaredTypes = findDeclaredTypes(source);

  if (declaredTypes.length === 0) {
    return;
  }

  // Component props and small UI-local types are allowed in UI files.
  const nonLocalTypes = declaredTypes.filter(
    ({ name }) =>
      !appearsFrontendSpecific(name) &&
      !name.endsWith("Props") &&
      !name.endsWith("State"),
  );

  if (nonLocalTypes.length === 0) {
    return;
  }

  const first = nonLocalTypes[0];
  const line = getLineNumber(source, first.index);

  findings.push(
    createFinding({
      ruleId: "types.typeOutsideExpectedLocation",
      severity: rule.severity,
      title: "Reusable type may be in the wrong location",
      message: `"${first.name}" is declared outside a shared or module-specific types folder.`,
      recommendation:
        "Keep component-local props and UI state near the component, but move reusable business or shared types into the appropriate types directory.",
      file,
      line,
      column: 1,
      codeSnippet: getCodeLine(source, line),
      confidence: isUiFile(file, config) ? "medium" : "high",
    }),
  );
}

function detectTemporaryTypeWithoutReference({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.types?.rules?.temporaryTypeWithoutReference;

  if (!rule?.enabled) {
    return;
  }

  const temporaryPattern =
    /\b(?:temporary|temp|backend schema incomplete|schema gap)\b/i;

  if (!temporaryPattern.test(source)) {
    return;
  }

  const requiredMarkers =
    config.types?.temporaryTypeMarkers ?? [
      "TODO",
      "FIXME",
      "ticket",
      "temporary",
    ];

  const hasReference = requiredMarkers.some((marker) => {
    if (marker.toLowerCase() === "temporary") {
      return false;
    }

    return source.toLowerCase().includes(marker.toLowerCase());
  });

  if (hasReference) {
    return;
  }

  const match = temporaryPattern.exec(source);
  const line = getLineNumber(source, match?.index ?? 0);

  findings.push(
    createFinding({
      ruleId: "types.temporaryTypeWithoutReference",
      severity: rule.severity,
      title: "Temporary type has no ticket reference",
      message:
        "The file appears to contain a temporary frontend type without a TODO, FIXME, or ticket reference.",
      recommendation:
        "Add a TODO or ticket reference explaining when the temporary type should be removed.",
      file,
      line,
      column: 1,
      codeSnippet: getCodeLine(source, line),
      confidence: "medium",
    }),
  );
}

/**
 * Runs TypeScript type consistency checks.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {string[]} options.files
 * @param {object} options.config
 * @returns {Promise<object[]>}
 */
export async function detectTypes({
  repositoryRoot,
  files,
  config,
}) {
  const findings = [];

  if (!config.types?.enabled) {
    return findings;
  }

  for (const relativeFile of files) {
    const extension = path.extname(relativeFile).toLowerCase();

    if (!SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }

    if (isIgnored(relativeFile, config)) {
      continue;
    }

    if (isGeneratedFile(relativeFile, config)) {
      continue;
    }

    const absoluteFile = path.resolve(repositoryRoot, relativeFile);

    if (!fs.existsSync(absoluteFile)) {
      continue;
    }

    const source = fs.readFileSync(absoluteFile, "utf8");

    detectExplicitAny({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectManualApiDto({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectTypeOutsideExpectedLocation({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectTemporaryTypeWithoutReference({
      file: relativeFile,
      source,
      config,
      findings,
    });
  }

  return findings;
}

export default detectTypes;