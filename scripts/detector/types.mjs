import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
]);

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
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
    const ignored = normalizePath(ignoredPath)
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();

    return ignored && normalized.includes(`/${ignored}/`);
  });
}

function isGeneratedFile(file, config) {
  const normalized = normalizePath(file).toLowerCase();

  return (config.generatedCodePatterns ?? []).some((pattern) => {
    const normalizedPattern = normalizePath(pattern).toLowerCase();

    return (
      normalizedPattern &&
      normalized.includes(normalizedPattern)
    );
  });
}

function isValidationFile(file) {
  const fileName = path.basename(file).toLowerCase();
  const normalized = normalizePath(file).toLowerCase();

  return (
    normalized.includes("/validations/") ||
    normalized.includes("/validation/") ||
    normalized.includes("/validators/") ||
    normalized.includes("/schemas/") ||
    fileName.endsWith("validation.ts") ||
    fileName.endsWith("validation.tsx") ||
    fileName.endsWith("validation.js") ||
    fileName.endsWith("validation.jsx") ||
    fileName.endsWith("validator.ts") ||
    fileName.endsWith("validator.tsx") ||
    fileName.endsWith("schema.ts") ||
    fileName.endsWith("schema.tsx") ||
    fileName.includes(".validation.") ||
    fileName.includes(".validator.") ||
    fileName.includes(".schema.")
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
      const root = normalizePath(sharedDirectory).replace(
        /\/+$/,
        "",
      );

      return (
        directory === root ||
        directory.startsWith(`${root}/`)
      );
    })
  ) {
    return true;
  }

  const featureDirectoryNames =
    config.types?.featureTypeDirectoryNames ?? ["types"];

  return directory
    .split("/")
    .some((segment) =>
      featureDirectoryNames.includes(segment),
    );
}

function isUiFile(file, config) {
  const normalized = normalizePath(file);

  return (
    config.ui?.uiRootDirectories ?? ["app/src/ui"]
  ).some((root) => {
    const normalizedRoot = normalizePath(root).replace(
      /\/+$/,
      "",
    );

    return (
      normalized === normalizedRoot ||
      normalized.startsWith(`${normalizedRoot}/`)
    );
  });
}

/**
 * Replaces comments and string contents with spaces while preserving:
 * - total character positions
 * - line breaks
 *
 * This prevents phrases such as:
 *
 * "inventory transaction type name"
 *
 * from being incorrectly interpreted as:
 *
 * type name
 */
function maskCommentsAndStrings(source) {
  let output = "";
  let index = 0;
  let state = "code";

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (current === "/" && next === "/") {
        output += "  ";
        index += 2;
        state = "line-comment";
        continue;
      }

      if (current === "/" && next === "*") {
        output += "  ";
        index += 2;
        state = "block-comment";
        continue;
      }

      if (current === "'") {
        output += " ";
        index += 1;
        state = "single-string";
        continue;
      }

      if (current === '"') {
        output += " ";
        index += 1;
        state = "double-string";
        continue;
      }

      if (current === "`") {
        output += " ";
        index += 1;
        state = "template-string";
        continue;
      }

      output += current;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (current === "\n") {
        output += "\n";
        state = "code";
      } else if (current === "\r") {
        output += "\r";
      } else {
        output += " ";
      }

      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        output += "  ";
        index += 2;
        state = "code";
        continue;
      }

      output +=
        current === "\n" || current === "\r"
          ? current
          : " ";

      index += 1;
      continue;
    }

    if (
      state === "single-string" ||
      state === "double-string" ||
      state === "template-string"
    ) {
      const closingCharacter =
        state === "single-string"
          ? "'"
          : state === "double-string"
            ? '"'
            : "`";

      if (current === "\\") {
        output += " ";

        if (next !== undefined) {
          output +=
            next === "\n" || next === "\r"
              ? next
              : " ";

          index += 2;
        } else {
          index += 1;
        }

        continue;
      }

      if (current === closingCharacter) {
        output += " ";
        index += 1;
        state = "code";
        continue;
      }

      output +=
        current === "\n" || current === "\r"
          ? current
          : " ";

      index += 1;
    }
  }

  return output;
}

function findDeclaredTypes(source) {
  const maskedSource = maskCommentsAndStrings(source);
  const results = [];

  const pattern =
    /\b(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/g;

  for (const match of maskedSource.matchAll(pattern)) {
    results.push({
      kind: match[1],
      name: match[2],
      index: match.index ?? 0,
      declaration: source
        .slice(
          match.index ?? 0,
          (match.index ?? 0) + match[0].length,
        )
        .trim(),
    });
  }

  return results;
}

function appearsToBeApiDto(typeName) {
  return /(Request|Response|Dto|DTO|Payload|Result|ApiModel)$/i.test(
    typeName,
  );
}

function appearsFrontendSpecific(typeName) {
  return /(Props|FormValues|FormData|ViewModel|TableRow|UiState|UIState|Option|Column|LocalState|DisplayModel)$/i.test(
    typeName,
  );
}

function isTemporaryTypeName(typeName) {
  return /^(Temporary|Temp|Legacy|Fallback)/i.test(typeName);
}

function hasTemporaryMarkerNearDeclaration(
  source,
  declarationIndex,
  markers,
) {
  const start = Math.max(0, declarationIndex - 500);
  const end = Math.min(
    source.length,
    declarationIndex + 500,
  );

  const nearbySource = source
    .slice(start, end)
    .toLowerCase();

  return markers.some((marker) => {
    const normalizedMarker = String(marker).toLowerCase();

    if (!normalizedMarker) {
      return false;
    }

    if (normalizedMarker === "temporary") {
      return false;
    }

    return nearbySource.includes(normalizedMarker);
  });
}

function detectExplicitAny({
  file,
  source,
  config,
  findings,
}) {
  const rule =
    config.types?.rules?.explicitAnyIntroduced;

  if (!rule?.enabled) {
    return;
  }

  const maskedSource = maskCommentsAndStrings(source);

  const patterns = [
    /:\s*any\b/g,
    /\bas\s+any\b/g,
    /<any>/g,
    /\bArray\s*<\s*any\s*>/g,
    /\bPromise\s*<\s*any\s*>/g,
    /\bRecord\s*<[^,>]+,\s*any\s*>/g,
  ];

  const seenLines = new Set();

  for (const pattern of patterns) {
    for (const match of maskedSource.matchAll(pattern)) {
      const line = getLineNumber(
        maskedSource,
        match.index ?? 0,
      );

      if (seenLines.has(line)) {
        continue;
      }

      seenLines.add(line);

      findings.push(
        createFinding({
          ruleId: "types.explicitAnyIntroduced",
          severity: rule.severity,
          title: "Explicit any type detected",
          message:
            "The changed file introduces an explicit any type.",
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

function detectManualApiDto({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.types?.rules?.manualApiDto;

  if (
    !rule?.enabled ||
    isGeneratedFile(file, config)
  ) {
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

    const line = getLineNumber(
      source,
      declaredType.index,
    );

    findings.push(
      createFinding({
        ruleId: "types.manualApiDto",
        severity: rule.severity,
        title: "Possible manually declared API DTO",
        message:
          `"${declaredType.name}" looks like an API request or response DTO declared manually.`,
        recommendation:
          "Use the Orval-generated API type. If the generated DTO is incorrect, update the OpenAPI schema instead of duplicating the API contract in the frontend.",
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        evidence: [
          `Declaration kind: ${declaredType.kind}`,
          `Declaration name: ${declaredType.name}`,
        ],
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
  const rule =
    config.types?.rules?.typeOutsideExpectedLocation;

  if (!rule?.enabled) {
    return;
  }

  if (isInsideTypesDirectory(file, config)) {
    return;
  }

  /*
   * Validation files are allowed to contain schema-related declarations,
   * inferred schema types, and local validation helpers.
   *
   * These should not be reported as reusable business types merely because
   * their filenames or validation messages contain the word "type".
   */
  if (isValidationFile(file)) {
    return;
  }

  const declaredTypes = findDeclaredTypes(source);

  if (declaredTypes.length === 0) {
    return;
  }

  const reusableTypes = declaredTypes.filter(
    ({ name }) => {
      if (appearsFrontendSpecific(name)) {
        return false;
      }

      if (name.endsWith("Props")) {
        return false;
      }

      if (name.endsWith("State")) {
        return false;
      }

      if (name.endsWith("ContextValue")) {
        return false;
      }

      if (name.endsWith("Ref")) {
        return false;
      }

      return true;
    },
  );

  if (reusableTypes.length === 0) {
    return;
  }

  const first = reusableTypes[0];
  const line = getLineNumber(source, first.index);

  findings.push(
    createFinding({
      ruleId: "types.typeOutsideExpectedLocation",
      severity: rule.severity,
      title: "Reusable type may be in the wrong location",
      message:
        `"${first.name}" is declared outside a shared or module-specific types folder.`,
      recommendation:
        "Keep component-local props and UI state near the component, but move reusable business or shared types into the appropriate types directory.",
      file,
      line,
      column: 1,
      codeSnippet: getCodeLine(source, line),
      evidence: [
        `Declaration kind: ${first.kind}`,
        `Declaration name: ${first.name}`,
      ],
      confidence: isUiFile(file, config)
        ? "medium"
        : "high",
    }),
  );
}

function detectTemporaryTypeWithoutReference({
  file,
  source,
  config,
  findings,
}) {
  const rule =
    config.types?.rules?.temporaryTypeWithoutReference;

  if (!rule?.enabled) {
    return;
  }

  const declaredTypes = findDeclaredTypes(source);

  if (declaredTypes.length === 0) {
    return;
  }

  const markers =
    config.types?.temporaryTypeMarkers ?? [
      "TODO",
      "FIXME",
      "ticket",
      "temporary",
    ];

  for (const declaredType of declaredTypes) {
    if (!isTemporaryTypeName(declaredType.name)) {
      continue;
    }

    const hasReference =
      hasTemporaryMarkerNearDeclaration(
        source,
        declaredType.index,
        markers,
      );

    if (hasReference) {
      continue;
    }

    const line = getLineNumber(
      source,
      declaredType.index,
    );

    findings.push(
      createFinding({
        ruleId:
          "types.temporaryTypeWithoutReference",
        severity: rule.severity,
        title:
          "Temporary type has no ticket reference",
        message:
          `"${declaredType.name}" appears to be temporary but has no nearby TODO, FIXME, or ticket reference.`,
        recommendation:
          "Add a TODO or ticket reference explaining why the temporary type exists and when it should be removed.",
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        evidence: [
          `Temporary declaration: ${declaredType.name}`,
        ],
        confidence: "medium",
      }),
    );
  }
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
    const normalizedFile = normalizePath(relativeFile);
    const extension = path
      .extname(normalizedFile)
      .toLowerCase();

    if (!SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }

    if (isIgnored(normalizedFile, config)) {
      continue;
    }

    if (isGeneratedFile(normalizedFile, config)) {
      continue;
    }

    const absoluteFile = path.resolve(
      repositoryRoot,
      ...normalizedFile.split("/"),
    );

    if (!fs.existsSync(absoluteFile)) {
      continue;
    }

    const source = fs.readFileSync(
      absoluteFile,
      "utf8",
    );

    detectExplicitAny({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    detectManualApiDto({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    detectTypeOutsideExpectedLocation({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    detectTemporaryTypeWithoutReference({
      file: normalizedFile,
      source,
      config,
      findings,
    });
  }

  return findings;
}

export default detectTypes;