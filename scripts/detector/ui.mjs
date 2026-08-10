import fs from "node:fs";
import path from "node:path";

const DEFAULT_COMPONENT_EXTENSIONS = [".tsx", ".jsx"];

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

function countLines(source) {
  if (!source) {
    return 0;
  }

  return source.split(/\r?\n/).length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  endLine = null,
  endColumn = null,
  codeSnippet = "",
  relatedFiles = [],
  evidence = [],
  confidence = "high",
}) {
  return {
    category: "ui",
    ruleId,
    severity,
    title,
    message,
    recommendation,
    file: normalizePath(file),
    line,
    column,
    endLine,
    endColumn,
    codeSnippet,
    relatedFiles: relatedFiles.map(normalizePath),
    evidence,
    detector: "ui",
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

    return normalizedPattern && normalizedFile.includes(normalizedPattern);
  });
}

function isSupportedComponentFile(file, config) {
  const extension = path.extname(file).toLowerCase();

  const componentExtensions =
    config.ui?.componentExtensions ?? DEFAULT_COMPONENT_EXTENSIONS;

  return componentExtensions
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

function isInsideUiDirectory(file, config) {
  const uiRootDirectories =
    config.ui?.uiRootDirectories ?? ["app/src/ui"];

  return uiRootDirectories.some((directory) =>
    isInsideDirectory(file, directory),
  );
}

function isPascalCaseFileName(file) {
  const extension = path.extname(file);
  const baseName = path.basename(file, extension);

  return /^[A-Z][A-Za-z0-9]*$/.test(baseName);
}

function appearsToContainReactComponent(source) {
  const componentSignals = [
    /\bReact\.createElement\s*\(/,
    /\breturn\s*\(\s*</,
    /\breturn\s*</,
    /=>\s*\(\s*</,
    /=>\s*</,
    /\bJSX\.Element\b/,
    /\bReact\.FC\b/,
    /\bReact\.FunctionComponent\b/,
  ];

  return componentSignals.some((pattern) => pattern.test(source));
}

function getSignalMatches(source, signals) {
  const matches = [];

  for (const signal of signals) {
    if (!signal) {
      continue;
    }

    const pattern = new RegExp(escapeRegExp(signal), "g");

    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      const line = getLineNumber(source, index);

      matches.push({
        signal,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
      });
    }
  }

  return matches.sort((left, right) => left.line - right.line);
}

function checkComponentFileName({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.ui?.rules?.invalidComponentFileName;

  if (!rule?.enabled) {
    return;
  }

  if (!appearsToContainReactComponent(source)) {
    return;
  }

  if (isPascalCaseFileName(file)) {
    return;
  }

  const extension = path.extname(file);
  const currentBaseName = path.basename(file, extension);

  findings.push(
    createFinding({
      ruleId: "ui.invalidComponentFileName",
      severity: rule.severity,
      title: "UI component filename is not PascalCase",
      message: `The component file "${path.basename(file)}" does not follow the required PascalCase filename convention.`,
      recommendation:
        `Rename "${currentBaseName}${extension}" using PascalCase, such as "EmployeeCard${extension}".`,
      file,
      confidence: "high",
    }),
  );
}

function checkComponentSize({
  file,
  source,
  config,
  findings,
}) {
  if (!appearsToContainReactComponent(source)) {
    return;
  }

  const totalLines = countLines(source);

  const recommendedLimit =
    Number(config.ui?.maxRecommendedLines) || 1000;

  const blockingLimit =
    Number(config.ui?.maxBlockingLines) || 1000;

  const extremelyLargeRule =
    config.ui?.rules?.extremelyLargeComponent;

  const largeRule =
    config.ui?.rules?.largeComponent;

  if (
    extremelyLargeRule?.enabled &&
    totalLines > blockingLimit
  ) {
    findings.push(
      createFinding({
        ruleId: "ui.extremelyLargeComponent",
        severity: extremelyLargeRule.severity,
        title: "UI component is extremely large",
        message:
          `The component contains ${totalLines} lines, exceeding the blocking limit of ${blockingLimit} lines.`,
        recommendation:
          "Split the component into smaller UI components, custom hooks, data adapters, and supporting files.",
        file,
        evidence: [
          `Current lines: ${totalLines}`,
          `Blocking limit: ${blockingLimit}`,
        ],
        confidence: "high",
      }),
    );

    return;
  }

  if (
    largeRule?.enabled &&
    totalLines > recommendedLimit
  ) {
    findings.push(
      createFinding({
        ruleId: "ui.largeComponent",
        severity: largeRule.severity,
        title: "UI component is larger than recommended",
        message:
          `The component contains ${totalLines} lines, exceeding the recommended limit of ${recommendedLimit} lines.`,
        recommendation:
          "Review whether sections can be extracted into smaller components, hooks, utility functions, or feature-specific files.",
        file,
        evidence: [
          `Current lines: ${totalLines}`,
          `Recommended limit: ${recommendedLimit}`,
        ],
        confidence: "high",
      }),
    );
  }
}

function stripImportStatements(source) {
  return source
    .replace(
      /^\s*import(?:\s+type)?[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm,
      "",
    )
    .replace(
      /^\s*import\s*["'][^"']+["'];?\s*$/gm,
      "",
    );
}
function normalizeComponentForComparison(source) {
  return stripImportStatements(source)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenSimilarity(leftSource, rightSource) {
  const tokenize = (value) => {
    const normalized = normalizeComponentForComparison(value);
    return new Set(normalized.match(/[a-z_$][a-z0-9_$]*|<\/?[a-z][a-z0-9.-]*/g) ?? []);
  };

  const left = tokenize(leftSource);
  const right = tokenize(rightSource);

  if (left.size < 12 || right.size < 12) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function findFirstResponsibilitySignal(source) {
  const executableSource = stripImportStatements(source);

  const signals = [
    {
      id: "direct-axios",
      label: "direct Axios request",
      pattern:
        /\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/,
      confidence: "high",
    },
    {
      id: "direct-fetch",
      label: "direct fetch request",
      pattern: /\bfetch\s*\(/,
      confidence: "high",
    },
    {
      id: "inline-query",
      label: "inline TanStack Query server-state hook",
      pattern:
        /\b(?:useQuery|useMutation|useInfiniteQuery|useSuspenseQuery)\s*\(\s*\{/,
      confidence: "medium",
    },
    {
      id: "inline-mock-data",
      label: "inline mock or dummy dataset",
      pattern:
        /\b(?:mockData|dummyData|fakeData|sampleData|fixtureData)\b/,
      confidence: "high",
    },
    {
      id: "browser-storage-write",
      label: "browser storage side effect",
      pattern:
        /\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem)\s*\(/,
      confidence: "medium",
    },
  ];

  for (const signal of signals) {
    const match = signal.pattern.exec(executableSource);

    if (!match) {
      continue;
    }

    return {
      ...signal,
      index: match.index,
      matchedText: match[0],
      executableSource,
    };
  }

  return null;
}

function checkMixedResponsibilities({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.ui?.rules?.mixedUiResponsibilities;

  if (!rule?.enabled) {
    return;
  }

  if (!appearsToContainReactComponent(source)) {
    return;
  }

  /*
   * Type imports, interfaces, type aliases, props, and local UI helper types
   * are normal component code. They must not be treated as mixed
   * responsibilities. Only executable non-presentation behavior is checked.
   */
  const signal = findFirstResponsibilitySignal(source);

  if (!signal) {
    return;
  }

  const line = getLineNumber(
    signal.executableSource,
    signal.index,
  );

  findings.push(
    createFinding({
      ruleId: "ui.mixedUiResponsibilities",
      severity: rule.severity,
      title: "UI component may contain non-presentation logic",
      message:
        `The component contains a ${signal.label}.`,
      recommendation:
        "Keep the UI component focused on rendering and interaction. Move server-state logic into a custom hook, API calls into services, and mock/static datasets into data modules.",
      file,
      line,
      column: 1,
      codeSnippet: getCodeLine(source, line),
      evidence: [
        `Signal: ${signal.id}`,
        `Matched code: ${signal.matchedText.trim()}`,
      ],
      confidence: signal.confidence,
    }),
  );
}

function walkFiles({
  currentDirectory,
  repositoryRoot,
  config,
  results,
}) {
  let entries;

  try {
    entries = fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(
      currentDirectory,
      entry.name,
    );

    const relativePath = normalizePath(
      path.relative(repositoryRoot, absolutePath),
    );

    if (isIgnored(relativePath, config)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkFiles({
        currentDirectory: absolutePath,
        repositoryRoot,
        config,
        results,
      });

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!isSupportedComponentFile(relativePath, config)) {
      continue;
    }

    if (isGeneratedFile(relativePath, config)) {
      continue;
    }

    results.push(relativePath);
  }
}

function findPossibleDuplicateComponents({
  repositoryRoot,
  changedFile,
  config,
}) {
  const extension = path.extname(changedFile);
  const changedBaseName = path.basename(
    changedFile,
    extension,
  );

  const uiDirectories =
    config.ui?.uiRootDirectories ?? ["app/src/ui"];

  const candidateFiles = [];

  for (const uiDirectory of uiDirectories) {
    const absoluteUiDirectory = path.resolve(
      repositoryRoot,
      ...normalizePath(uiDirectory).split("/"),
    );

    if (!fs.existsSync(absoluteUiDirectory)) {
      continue;
    }

    walkFiles({
      currentDirectory: absoluteUiDirectory,
      repositoryRoot,
      config,
      results: candidateFiles,
    });
  }

  const normalizedChangedFile =
    normalizePath(changedFile).toLowerCase();

  return candidateFiles.filter((candidateFile) => {
    const normalizedCandidate =
      normalizePath(candidateFile).toLowerCase();

    if (normalizedCandidate === normalizedChangedFile) {
      return false;
    }

    const candidateExtension = path.extname(candidateFile);

    const candidateBaseName = path.basename(
      candidateFile,
      candidateExtension,
    );

    return (
      candidateBaseName.toLowerCase() ===
      changedBaseName.toLowerCase()
    );
  });
}

function checkPossibleDuplicateUi({
  repositoryRoot,
  file,
  source,
  config,
  findings,
}) {
  const rule = config.ui?.rules?.possibleDuplicateUi;

  if (!rule?.enabled) {
    return;
  }

  if (!appearsToContainReactComponent(source)) {
    return;
  }

  const duplicateFiles = findPossibleDuplicateComponents({
    repositoryRoot,
    changedFile: file,
    config,
  });

  if (duplicateFiles.length === 0) {
    return;
  }

  const similarityThreshold = Math.max(
    Number(config.ui?.duplicateSimilarityThreshold) || 0.72,
    0.6,
  );

  const similarFiles = duplicateFiles
    .map((duplicateFile) => {
      const absoluteDuplicate = path.resolve(
        repositoryRoot,
        ...normalizePath(duplicateFile).split("/"),
      );

      if (!fs.existsSync(absoluteDuplicate)) return null;

      const duplicateSource = fs.readFileSync(absoluteDuplicate, "utf8");
      const similarity = tokenSimilarity(source, duplicateSource);

      return { file: duplicateFile, similarity };
    })
    .filter((item) => item && item.similarity >= similarityThreshold)
    .sort((left, right) => right.similarity - left.similarity);

  /*
   * A matching filename alone is not duplication. Names such as Main.tsx,
   * Action.tsx, Page.tsx, and Form.tsx are expected across feature modules.
   * Warn only when the implementations also have substantial similarity.
   */
  if (similarFiles.length === 0) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "ui.possibleDuplicateUi",
      severity: rule.severity,
      title: "Possible duplicate UI component detected",
      message:
        `A component named "${path.basename(file)}" has materially similar implementation in another configured UI directory.`,
      recommendation:
        "Review the related components and reuse or extend an existing shared component only when their responsibilities genuinely overlap.",
      file,
      relatedFiles: similarFiles.slice(0, 10).map((item) => item.file),
      evidence: similarFiles.slice(0, 10).map(
        (item) => `Similar component: ${item.file} (${Math.round(item.similarity * 100)}% token similarity)`,
      ),
      confidence: "medium",
    }),
  );
}

/**
 * Runs frontend UI consistency checks against changed PR files.
 *
 * Only changed files are analyzed. The possible duplicate rule performs
 * a lightweight filename lookup inside configured UI directories.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {string[]} options.files
 * @param {object} options.config
 * @returns {Promise<object[]>}
 */
export async function detectUi({
  repositoryRoot,
  files,
  config,
}) {
  const findings = [];

  if (!config.ui?.enabled) {
    return findings;
  }

  for (const relativeFile of files) {
    const normalizedFile = normalizePath(relativeFile);

    if (!isSupportedComponentFile(normalizedFile, config)) {
      continue;
    }

    if (!isInsideUiDirectory(normalizedFile, config)) {
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

    const source = fs.readFileSync(absoluteFile, "utf8");

    checkComponentFileName({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    checkComponentSize({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    checkMixedResponsibilities({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    checkPossibleDuplicateUi({
      repositoryRoot,
      file: normalizedFile,
      source,
      config,
      findings,
    });
  }

  return findings;
}

export default detectUi;