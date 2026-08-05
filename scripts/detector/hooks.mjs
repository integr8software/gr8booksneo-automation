import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const BUILT_IN_HOOK_PATTERN =
  /\b(useState|useEffect|useLayoutEffect|useMemo|useCallback|useReducer|useRef|useContext|useImperativeHandle|useDeferredValue|useTransition|useId|useSyncExternalStore|useInsertionEffect)\s*\(/;

const TANSTACK_HOOK_PATTERN =
  /\b(useQuery|useMutation|useInfiniteQuery|useSuspenseQuery|useQueries)\s*\(/;

const DIRECT_FETCH_PATTERN = /\bfetch\s*\(/;

const DIRECT_AXIOS_PATTERN =
  /\baxios\s*\.\s*(get|post|put|patch|delete|request)\s*\(/i;

const AXIOS_INSTANCE_PATTERN =
  /\b(api|apiClient|http|httpClient|axiosInstance)\s*\.\s*(get|post|put|patch|delete|request)\s*\(/i;

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
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
  confidence = "high",
}) {
  return {
    category: "hooks",
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
    evidence: [],
    detector: "hooks",
    confidence,
  };
}

function isIgnored(file, ignoredPaths = []) {
  const normalized = `/${normalizePath(file).toLowerCase()}/`;

  return ignoredPaths.some((ignoredPath) => {
    const ignored = normalizePath(ignoredPath).toLowerCase();
    return normalized.includes(`/${ignored}/`);
  });
}

function isGeneratedFile(file, generatedPatterns = []) {
  const normalized = normalizePath(file).toLowerCase();

  return generatedPatterns.some((pattern) =>
    normalized.includes(normalizePath(pattern).toLowerCase()),
  );
}

function isUiFile(file, config) {
  const normalized = normalizePath(file);

  const uiRoots = config.ui?.uiRootDirectories ?? ["app/src/ui"];

  return uiRoots.some((root) => {
    const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
    return (
      normalized === normalizedRoot ||
      normalized.startsWith(`${normalizedRoot}/`)
    );
  });
}

function isInsideHooksDirectory(file, config) {
  const normalized = normalizePath(file);
  const directory = normalizePath(path.posix.dirname(normalized));

  const sharedHookDirectories =
    config.hooks?.sharedHookDirectories ?? [
      "app/src/hooks",
      "app/src/shared/hooks",
    ];

  if (
    sharedHookDirectories.some((hookDirectory) => {
      const normalizedHookDirectory = normalizePath(hookDirectory).replace(
        /\/+$/,
        "",
      );

      return (
        directory === normalizedHookDirectory ||
        directory.startsWith(`${normalizedHookDirectory}/`)
      );
    })
  ) {
    return true;
  }

  const featureDirectoryNames =
    config.hooks?.featureHookDirectoryNames ?? ["hooks"];

  return directory
    .split("/")
    .some((segment) => featureDirectoryNames.includes(segment));
}

function hasValidHookFileName(file) {
  const fileName = path.basename(file);

  return /^use[A-Z][A-Za-z0-9]*\.(ts|tsx|js|jsx)$/.test(fileName);
}

function containsReactHookUsage(source) {
  return BUILT_IN_HOOK_PATTERN.test(source) || TANSTACK_HOOK_PATTERN.test(source);
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

      if (current === "'" || current === '"' || current === "`") {
        output += " ";
        index += 1;
        state = current === "'" ? "single-string" : current === '"' ? "double-string" : "template-string";
        continue;
      }

      output += current;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (current === "\\n") {
        output += "\\n";
        state = "code";
      } else if (current === "\\r") {
        output += "\\r";
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
      output += current === "\\n" || current === "\\r" ? current : " ";
      index += 1;
      continue;
    }

    const closingCharacter = state === "single-string" ? "'" : state === "double-string" ? '"' : "`";

    if (current === "\\\\") {
      output += " ";
      if (next !== undefined) {
        output += next === "\\n" || next === "\\r" ? next : " ";
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

    output += current === "\\n" || current === "\\r" ? current : " ";
    index += 1;
  }

  return output;
}

function findMatchingBrace(maskedSource, openingBraceIndex) {
  let depth = 0;

  for (let index = openingBraceIndex; index < maskedSource.length; index += 1) {
    const character = maskedSource[index];

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function extractFunctionBody(source, functionIndex) {
  const maskedSource = maskCommentsAndStrings(source);
  const openingBraceIndex = maskedSource.indexOf("{", functionIndex);

  if (openingBraceIndex < 0) {
    return "";
  }

  const closingBraceIndex = findMatchingBrace(maskedSource, openingBraceIndex);

  if (closingBraceIndex < 0) {
    return "";
  }

  return source.slice(openingBraceIndex + 1, closingBraceIndex);
}


function findExportedFunctionNames(source) {
  const results = [];

  const functionPattern =
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;

  for (const match of source.matchAll(functionPattern)) {
    results.push({
      name: match[1],
      index: match.index ?? 0,
    });
  }

  const variablePattern =
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;

  for (const match of source.matchAll(variablePattern)) {
    results.push({
      name: match[1],
      index: match.index ?? 0,
    });
  }

  return results;
}

function detectInvalidHookName({
  file,
  source,
  hookConfig,
  findings,
}) {
  const rule = hookConfig.rules?.invalidHookName;

  if (!rule?.enabled || !containsReactHookUsage(source)) {
    return;
  }

  const functions = findExportedFunctionNames(source);

  for (const entry of functions) {
    if (
      entry.name.startsWith("use") ||
      /^[A-Z]/.test(entry.name)
    ) {
      continue;
    }

    const functionBody = extractFunctionBody(
      source,
      entry.index,
    );

    if (!functionBody) {
      continue;
    }

    const maskedFunctionBody =
      maskCommentsAndStrings(functionBody);

    if (!containsReactHookUsage(maskedFunctionBody)) {
      continue;
    }

    const line = getLineNumber(source, entry.index);

    findings.push(
      createFinding({
        ruleId: "hooks.invalidHookName",
        severity: rule.severity,
        title: "Custom hook name must start with use",
        message: `"${entry.name}" directly calls React hooks but its name does not start with "use".`,
        recommendation:
          `Move the hook call to the component top level or rename "${entry.name}" as a real custom hook beginning with "use".`,
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        confidence: "high",
      }),
    );
  }
}

function detectInvalidHookFileName({
  file,
  hookConfig,
  findings,
}) {
  const rule = hookConfig.rules?.invalidHookName;

  if (!rule?.enabled || !isInsideHooksDirectory(file, { hooks: hookConfig })) {
    return;
  }

  if (hasValidHookFileName(file)) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "hooks.invalidHookFileName",
      severity: rule.severity,
      title: "Hook file name must start with use",
      message: `"${path.basename(file)}" is inside a hooks directory but does not follow the usePascalCase naming convention.`,
      recommendation:
        "Rename the hook file to a clear name such as useEmployees.ts or useEmployeeForm.ts.",
      file,
      confidence: "high",
    }),
  );
}

function detectHookOutsideExpectedLocation({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.hooks?.rules?.hookOutsideExpectedLocation;

  if (!rule?.enabled) {
    return;
  }

  const fileName = path.basename(file);
  const appearsToBeHook =
    /^use[A-Z][A-Za-z0-9]*\.(ts|tsx|js|jsx)$/.test(fileName) ||
    findExportedFunctionNames(source).some((entry) =>
      entry.name.startsWith("use"),
    );

  if (!appearsToBeHook || isInsideHooksDirectory(file, config)) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "hooks.hookOutsideExpectedLocation",
      severity: rule.severity,
      title: "Hook is outside an expected hooks folder",
      message: `"${fileName}" appears to define a custom hook but is not stored inside a shared or module-specific hooks directory.`,
      recommendation:
        "Move reusable hooks to the shared hooks folder and feature-specific hooks to the related module's hooks folder.",
      file,
      confidence: "high",
    }),
  );
}

function detectDirectApiCallsInUi({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.hooks?.rules?.apiCallInsideUi;

  if (!rule?.enabled || !isUiFile(file, config)) {
    return;
  }

  const patterns = [
    {
      regex: DIRECT_FETCH_PATTERN,
      label: "fetch()",
    },
    {
      regex: DIRECT_AXIOS_PATTERN,
      label: "direct Axios call",
    },
    {
      regex: AXIOS_INSTANCE_PATTERN,
      label: "direct API client call",
    },
  ];

  for (const pattern of patterns) {
    const match = pattern.regex.exec(source);

    if (!match) {
      continue;
    }

    const line = getLineNumber(source, match.index);

    findings.push(
      createFinding({
        ruleId: "hooks.apiCallInsideUi",
        severity: rule.severity,
        title: "Direct API call found inside a UI component",
        message: `${pattern.label} was found directly inside a UI file.`,
        recommendation:
          "Move the API request into the service layer and access server data through a custom TanStack Query hook.",
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        confidence: "high",
      }),
    );
  }
}

function detectServerStateWithoutTanstackQuery({
  file,
  source,
  config,
  findings,
}) {
  const rule =
    config.hooks?.rules?.serverStateWithoutTanstackQuery;

  if (!rule?.enabled || !isInsideHooksDirectory(file, config)) {
    return;
  }

  const containsApiCall =
    DIRECT_FETCH_PATTERN.test(source) ||
    DIRECT_AXIOS_PATTERN.test(source) ||
    AXIOS_INSTANCE_PATTERN.test(source);

  const usesTanstackQuery = TANSTACK_HOOK_PATTERN.test(source);

  if (!containsApiCall || usesTanstackQuery) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "hooks.serverStateWithoutTanstackQuery",
      severity: rule.severity,
      title: "Server state hook may not use TanStack Query",
      message:
        "This hook appears to perform an API request without using a TanStack Query hook.",
      recommendation:
        "Use useQuery, useMutation, or another appropriate TanStack Query hook unless there is a documented reason not to.",
      file,
      confidence: "medium",
    }),
  );
}

/**
 * Runs hooks consistency checks.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot Absolute frontend repository root.
 * @param {string[]} options.files Repository-relative files to analyze.
 * @param {object} options.config Parsed frontend-standards.json.
 * @returns {Promise<object[]>}
 */
export async function detectHooks({
  repositoryRoot,
  files,
  config,
}) {
  const findings = [];
  const hookConfig = config.hooks ?? {};

  if (!hookConfig.enabled) {
    return findings;
  }

  for (const relativeFile of files) {
    const extension = path.extname(relativeFile).toLowerCase();

    if (!SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }

    if (isIgnored(relativeFile, config.ignoredPaths ?? [])) {
      continue;
    }

    if (
      isGeneratedFile(
        relativeFile,
        config.generatedCodePatterns ?? [],
      )
    ) {
      continue;
    }

    const absoluteFile = path.resolve(repositoryRoot, relativeFile);

    if (!fs.existsSync(absoluteFile)) {
      continue;
    }

    const source = fs.readFileSync(absoluteFile, "utf8");

    detectInvalidHookFileName({
      file: relativeFile,
      hookConfig,
      findings,
    });

    detectInvalidHookName({
      file: relativeFile,
      source,
      hookConfig,
      findings,
    });

    detectHookOutsideExpectedLocation({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectDirectApiCallsInUi({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectServerStateWithoutTanstackQuery({
      file: relativeFile,
      source,
      config,
      findings,
    });
  }

  return findings;
}

export default detectHooks;