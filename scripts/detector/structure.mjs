import fs from "node:fs";
import path from "node:path";

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function createFinding({
  ruleId,
  severity,
  title,
  message,
  recommendation,
  file,
  line = null,
  confidence = "high",
}) {
  return {
    category: "structure",
    ruleId,
    severity,
    title,
    message,
    recommendation,
    file: normalizePath(file),
    line,
    column: null,
    endLine: null,
    endColumn: null,
    codeSnippet: "",
    relatedFiles: [],
    evidence: [],
    detector: "structure",
    confidence,
  };
}

function isIgnored(file, config) {
  const normalizedFile = `/${normalizePath(file).toLowerCase()}/`;

  return (config.ignoredPaths ?? []).some((ignoredPath) => {
    const normalizedIgnored = normalizePath(ignoredPath)
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();

    return normalizedFile.includes(`/${normalizedIgnored}/`);
  });
}

function isGeneratedFile(file, config) {
  const normalizedFile = normalizePath(file).toLowerCase();

  return (config.generatedCodePatterns ?? []).some((pattern) =>
    normalizedFile.includes(normalizePath(pattern).toLowerCase()),
  );
}

function isSupportedFile(file, config) {
  const extension = path.extname(file).toLowerCase();
  const supportedExtensions =
    config.supportedExtensions ?? [".ts", ".tsx", ".js", ".jsx"];

  return supportedExtensions.includes(extension);
}

function isInsideDirectory(file, directory) {
  const normalizedFile = normalizePath(file).toLowerCase();
  const normalizedDirectory = normalizePath(directory)
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

  return (
    normalizedFile === normalizedDirectory ||
    normalizedFile.startsWith(`${normalizedDirectory}/`) ||
    normalizedFile.includes(`/${normalizedDirectory}/`)
  );
}

function isInsideNamedDirectory(file, directoryName) {
  const segments = normalizePath(file)
    .toLowerCase()
    .split("/")
    .filter(Boolean);

  return segments.includes(directoryName.toLowerCase());
}

function isHookFile(file) {
  const baseName = path.basename(file, path.extname(file));

  return /^use[A-Z][A-Za-z0-9]*$/.test(baseName);
}

function isServiceFile(file) {
  const baseName = path.basename(file).toLowerCase();

  return (
    baseName.includes(".service.") ||
    baseName.endsWith("service.ts") ||
    baseName.endsWith("service.tsx") ||
    baseName.endsWith("service.js") ||
    baseName.endsWith("service.jsx") ||
    baseName.endsWith("api.ts") ||
    baseName.endsWith("api.js")
  );
}

function isTypeFile(file, source) {
  const baseName = path.basename(file).toLowerCase();

  if (
    baseName.includes(".type.") ||
    baseName.includes(".types.") ||
    baseName.endsWith("types.ts") ||
    baseName.endsWith("types.tsx") ||
    baseName.endsWith("types.js") ||
    baseName.endsWith("types.jsx")
  ) {
    return true;
  }

  const hasTypeDeclaration =
    /\bexport\s+(?:declare\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*/.test(
      source,
    ) ||
    /\b(?:interface|type)\s+[A-Za-z_$][\w$]*/.test(source);

  const hasRuntimeDeclaration =
    /\b(?:function|class|const|let|var)\s+[A-Za-z_$][\w$]*/.test(source);

  return hasTypeDeclaration && !hasRuntimeDeclaration;
}

function isUiComponentFile(file, source, config) {
  const extension = path.extname(file).toLowerCase();
  const componentExtensions =
    config.ui?.componentExtensions ?? [".tsx", ".jsx"];

  if (!componentExtensions.includes(extension)) {
    return false;
  }

  const baseName = path.basename(file, extension);

  if (!/^[A-Z][A-Za-z0-9]*$/.test(baseName)) {
    return false;
  }

  return (
    /return\s*\(\s*</.test(source) ||
    /=>\s*\(\s*</.test(source) ||
    /=>\s*</.test(source) ||
    /React\.createElement\s*\(/.test(source)
  );
}

function checkRequiredDirectories({
  repositoryRoot,
  config,
  findings,
}) {
  const structure = config.structure;
  const rule = structure?.rules?.missingRequiredDirectory;

  if (!rule?.enabled) {
    return;
  }

  const sourceRoot = structure.root ?? config.sourceRoot ?? "app/src";
  const requiredDirectories = structure.requiredDirectories ?? [];

  for (const directoryName of requiredDirectories) {
    const relativeDirectory = normalizePath(
      path.posix.join(normalizePath(sourceRoot), directoryName),
    );

    const absoluteDirectory = path.resolve(
      repositoryRoot,
      ...relativeDirectory.split("/"),
    );

    if (fs.existsSync(absoluteDirectory)) {
      continue;
    }

    findings.push(
      createFinding({
        ruleId: "structure.missingRequiredDirectory",
        severity: rule.severity,
        title: "Required frontend directory is missing",
        message: `The required directory "${relativeDirectory}" does not exist.`,
        recommendation: `Create the directory "${relativeDirectory}" to follow the approved frontend structure.`,
        file: relativeDirectory,
        confidence: "high",
      }),
    );
  }
}

function checkHookLocation({
  file,
  config,
  findings,
}) {
  const rule = config.structure?.rules?.misplacedHook;

  if (!rule?.enabled || !isHookFile(file)) {
    return;
  }

  const sharedHookDirectories =
    config.hooks?.sharedHookDirectories ?? ["app/src/hooks"];

  const featureHookDirectoryNames =
    config.hooks?.featureHookDirectoryNames ?? ["hooks"];

  const isInsideSharedHookDirectory = sharedHookDirectories.some((directory) =>
    isInsideDirectory(file, directory),
  );

  const isInsideFeatureHookDirectory = featureHookDirectoryNames.some(
    (directoryName) => isInsideNamedDirectory(file, directoryName),
  );

  if (isInsideSharedHookDirectory || isInsideFeatureHookDirectory) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "structure.misplacedHook",
      severity: rule.severity,
      title: "Hook file is outside an expected hooks directory",
      message: `The changed hook "${path.basename(file)}" is not located in a shared or feature hooks directory.`,
      recommendation:
        "Move shared hooks into app/src/hooks or place feature-specific hooks inside the feature's hooks directory.",
      file,
      confidence: "high",
    }),
  );
}

function checkServiceLocation({
  file,
  config,
  findings,
}) {
  const rule = config.structure?.rules?.misplacedService;

  if (!rule?.enabled || !isServiceFile(file)) {
    return;
  }

  const serviceDirectories =
    config.fetching?.serviceDirectories ?? ["app/src/services"];

  const isInsideServiceDirectory = serviceDirectories.some((directory) =>
    isInsideDirectory(file, directory),
  );

  if (isInsideServiceDirectory || isInsideNamedDirectory(file, "services")) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "structure.misplacedService",
      severity: rule.severity,
      title: "Service file is outside an expected services directory",
      message: `The changed service "${path.basename(file)}" is not located in the services layer.`,
      recommendation:
        "Move API and service implementations into app/src/services or the feature's services directory.",
      file,
      confidence: "high",
    }),
  );
}

function checkTypeLocation({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.structure?.rules?.misplacedType;

  if (!rule?.enabled || !isTypeFile(file, source)) {
    return;
  }

  const sharedTypeDirectories =
    config.types?.sharedTypeDirectories ?? ["app/src/types"];

  const featureTypeDirectoryNames =
    config.types?.featureTypeDirectoryNames ?? ["types"];

  const isInsideSharedTypeDirectory = sharedTypeDirectories.some((directory) =>
    isInsideDirectory(file, directory),
  );

  const isInsideFeatureTypeDirectory = featureTypeDirectoryNames.some(
    (directoryName) => isInsideNamedDirectory(file, directoryName),
  );

  if (isInsideSharedTypeDirectory || isInsideFeatureTypeDirectory) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "structure.misplacedType",
      severity: rule.severity,
      title: "Type file is outside an expected types directory",
      message: `The changed type file "${path.basename(file)}" is not located in a shared or feature types directory.`,
      recommendation:
        "Move reusable types into app/src/types or place feature-specific types inside the feature's types directory.",
      file,
      confidence: "medium",
    }),
  );
}

function checkUiLocation({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.structure?.rules?.misplacedUiComponent;

  if (!rule?.enabled || !isUiComponentFile(file, source, config)) {
    return;
  }

  const uiDirectories =
    config.ui?.uiRootDirectories ?? ["app/src/ui"];

  const isInsideUiDirectory = uiDirectories.some((directory) =>
    isInsideDirectory(file, directory),
  );

  if (isInsideUiDirectory || isInsideNamedDirectory(file, "ui")) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "structure.misplacedUiComponent",
      severity: rule.severity,
      title: "UI component is outside the expected UI directory",
      message: `The changed React component "${path.basename(file)}" is not located under the configured UI structure.`,
      recommendation:
        "Move the component into app/src/ui or the appropriate feature UI directory.",
      file,
      confidence: "medium",
    }),
  );
}

/**
 * Validates the structure of files changed by the pull request.
 *
 * Changed files are inspected directly. The only repository-level checks are
 * lightweight existence checks for configured required directories.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {string[]} options.files
 * @param {object} options.config
 * @returns {Promise<object[]>}
 */
export async function detectStructure({
  repositoryRoot,
  files,
  config,
}) {
  const findings = [];

  if (!Array.isArray(files) || files.length === 0) {
    return findings;
  }

  if (!config.structure?.enabled) {
    return findings;
  }
  checkRequiredDirectories({
    repositoryRoot,
    config,
    findings,
  });

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

    const absoluteFile = path.resolve(
      repositoryRoot,
      ...normalizedFile.split("/"),
    );

    if (!fs.existsSync(absoluteFile)) {
      continue;
    }

    const source = fs.readFileSync(absoluteFile, "utf8");

    checkHookLocation({
      file: normalizedFile,
      config,
      findings,
    });

    checkServiceLocation({
      file: normalizedFile,
      config,
      findings,
    });

    checkTypeLocation({
      file: normalizedFile,
      source,
      config,
      findings,
    });

    checkUiLocation({
      file: normalizedFile,
      source,
      config,
      findings,
    });
  }

  return findings;
}

export default detectStructure;