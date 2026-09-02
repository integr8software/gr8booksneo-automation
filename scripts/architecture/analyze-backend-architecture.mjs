#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "coverage", "generated", ".next", ".git"].includes(entry.name)) continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function lineNumberForIndex(text, index) {
  if (index < 0) return null;
  return text.slice(0, index).split(/\r?\n/).length;
}

function moduleFromFile(relativeFile) {
  const p = normalizePath(relativeFile);
  const match = p.match(/^src\/modules\/([^/]+)/);
  if (match) return match[1];
  if (p.startsWith("src/common/")) return "common";
  if (p.startsWith("src/storage/")) return "storage";
  if (p.startsWith("src/config/")) return "config";
  return p.split("/")[1] || "root";
}

function findingId(rule, file, line, symbol = "") {
  return crypto
    .createHash("sha1")
    .update(`${rule}|${file}|${line ?? ""}|${symbol}`)
    .digest("hex")
    .slice(0, 12);
}

const findings = [];

function addFinding({
  severity,
  rule,
  module,
  file,
  line = null,
  symbol = "",
  finding,
  whyItMatters,
  recommendation,
  confidence = "HIGH",
  detector = "backend-architecture",
}) {
  findings.push({
    id: findingId(rule, file, line, symbol),
    severity,
    priority: severity === "BLOCKER" ? "Fix / review first" : severity === "WARNING" ? "Review" : "Informational",
    module,
    file,
    line,
    symbol,
    rule,
    finding,
    whyItMatters,
    recommendation,
    confidence,
    detector,
  });
}

function endpointBlocks(lines) {
  const routeRegex = /^\s*@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(/;
  const routeIndexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (routeRegex.test(lines[i])) routeIndexes.push(i);
  }

  return routeIndexes.map((routeIndex, position) => {
    const previousRoute = position > 0 ? routeIndexes[position - 1] : -1;
    const nextRoute = position + 1 < routeIndexes.length ? routeIndexes[position + 1] : lines.length;
    const start = previousRoute + 1;
    const end = nextRoute - 1;
    return {
      routeIndex,
      line: routeIndex + 1,
      text: lines.slice(start, end + 1).join("\n"),
      routeText: lines[routeIndex].trim(),
    };
  });
}

function propertyDecoratorBlock(lines, propertyIndex) {
  const propertyRegex = /^\s*(readonly\s+)?[A-Za-z_$][A-Za-z0-9_$]*[!?]?\s*:/;
  let start = 0;
  for (let i = propertyIndex - 1; i >= 0; i -= 1) {
    if (propertyRegex.test(lines[i]) || /^\s*(export\s+)?class\s+/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  return lines.slice(start, propertyIndex).join("\n");
}

function analyzeController(file, relativeFile, text, lines) {
  const module = moduleFromFile(relativeFile);
  const blocks = endpointBlocks(lines);
  if (blocks.length === 0) return;

  if (!/@ApiTags\s*\(/.test(text)) {
    const idx = text.search(/@Controller\s*\(/);
    addFinding({
      severity: "BLOCKER",
      rule: "backend.arch.swagger.controller.tags",
      module,
      file: relativeFile,
      line: lineNumberForIndex(text, idx),
      symbol: "@ApiTags",
      finding: "Controller exposes public routes but has no @ApiTags() Swagger metadata.",
      whyItMatters: "Consistent controller tags keep the generated API contract discoverable and organized.",
      recommendation: "Add @ApiTags() using the existing convention for this module.",
    });
  }

  const classHasGuard = /@UseGuards\s*\([^)]*(Jwt|Auth)/i.test(text);
  const classHasBearer = /@ApiBearerAuth\s*\(/.test(text);

  for (const block of blocks) {
    if (!/@ApiOperation\s*\(/.test(block.text)) {
      addFinding({
        severity: "BLOCKER",
        rule: "backend.arch.swagger.endpoint.operation",
        module,
        file: relativeFile,
        line: block.line,
        symbol: block.routeText,
        finding: "Public endpoint is missing nearby @ApiOperation() metadata.",
        whyItMatters: "The API contract should explain the purpose of every public endpoint.",
        recommendation: "Add a concise @ApiOperation() description beside this route.",
      });
    }

    if (!/@Api(OkResponse|CreatedResponse|AcceptedResponse|NoContentResponse|BadRequestResponse|UnauthorizedResponse|ForbiddenResponse|NotFoundResponse|ConflictResponse|Response)\s*\(/.test(block.text)) {
      addFinding({
        severity: "BLOCKER",
        rule: "backend.arch.swagger.endpoint.response",
        module,
        file: relativeFile,
        line: block.line,
        symbol: block.routeText,
        finding: "Public endpoint has no nearby Swagger response decorator.",
        whyItMatters: "Response metadata makes API contracts clearer for frontend consumers and generated documentation.",
        recommendation: "Document the relevant success/error response using the project's existing Swagger response style.",
      });
    }

    const endpointHasGuard = /@UseGuards\s*\([^)]*(Jwt|Auth)/i.test(block.text);
    const endpointHasBearer = /@ApiBearerAuth\s*\(/.test(block.text);
    if ((endpointHasGuard && !endpointHasBearer) || (classHasGuard && !classHasBearer && !endpointHasBearer)) {
      addFinding({
        severity: "BLOCKER",
        rule: "backend.arch.swagger.endpoint.bearer-auth",
        module,
        file: relativeFile,
        line: block.line,
        symbol: block.routeText,
        finding: "Authenticated endpoint is missing @ApiBearerAuth() documentation.",
        whyItMatters: "Consumers need the generated API contract to accurately show authentication requirements.",
        recommendation: "Add @ApiBearerAuth() at the controller or endpoint level using the existing project convention.",
      });
    }
  }

  const prismaIndex = text.search(/\bPrismaService\b|this\.prisma\b|\$transaction\s*\(/);
  if (prismaIndex >= 0) {
    addFinding({
      severity: "BLOCKER",
      rule: "backend.arch.controller.prisma-access",
      module,
      file: relativeFile,
      line: lineNumberForIndex(text, prismaIndex),
      symbol: "Prisma access",
      finding: "Controller appears to access Prisma/persistence directly.",
      whyItMatters: "Controllers should own HTTP concerns while services own module business behavior and persistence orchestration.",
      recommendation: "Move persistence/business behavior into the service and keep the controller focused on request/response delegation.",
    });
  }
}

function analyzeDto(file, relativeFile, text, lines) {
  const normalized = normalizePath(relativeFile);
  const module = moduleFromFile(relativeFile);
  const apiFacing = /\/[^/]*(create|update|save|patch|request|response|query|filter|params?)[^/]*\.dto\.ts$/i.test(normalized);
  if (!apiFacing) return;

  const isResponse = /\/[^/]*response[^/]*\.dto\.ts$/i.test(normalized);
  const propertyRegex = /^\s*(?:readonly\s+)?(?<name>[A-Za-z_$][A-Za-z0-9_$]*)[!?]?\s*:/;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(propertyRegex);
    if (!match) continue;

    const decorators = propertyDecoratorBlock(lines, i);
    const name = match.groups?.name || "field";

    if (!/@ApiProperty(Optional)?\s*\(/.test(decorators)) {
      addFinding({
        severity: "BLOCKER",
        rule: "backend.arch.swagger.dto.metadata",
        module,
        file: relativeFile,
        line: i + 1,
        symbol: name,
        finding: `API DTO field "${name}" has no nearby @ApiProperty()/@ApiPropertyOptional() metadata.`,
        whyItMatters: "DTO Swagger metadata keeps request/response schemas accurate for generated API documentation.",
        recommendation: "Add the appropriate Swagger property decorator using the project's existing DTO conventions.",
      });
    }

    if (!isResponse && !/@(Is|Validate|Matches|Min|Max|Length|Array|ValidateIf)[A-Za-z0-9_]*\s*\(/.test(decorators)) {
      addFinding({
        severity: "WARNING",
        rule: "backend.arch.dto.validation",
        module,
        file: relativeFile,
        line: i + 1,
        symbol: name,
        finding: `Input DTO field "${name}" has no nearby class-validator decorator.`,
        whyItMatters: "Input validation protects API boundaries from malformed or unexpected values.",
        recommendation: "Confirm validation is intentionally unnecessary; otherwise add the appropriate class-validator decorator.",
        confidence: "MEDIUM",
      });
    }
  }
}

function analyzeService(file, relativeFile, text) {
  const module = moduleFromFile(relativeFile);

  const businessPattern = /(\$transaction|journal|ledger|debit|credit|balance|reconcil|vat|tax|currency|exchange|inventory|stock|quantity|amount|total|discount|permission|authori[sz]|duplicate|approve|approval|status|transition|rollback|posting|posted)/i;
  const match = text.match(businessPattern);
  if (!match) return;

  const specPath = file.replace(/\.service\.ts$/i, ".service.spec.ts");
  if (!fs.existsSync(specPath)) {
    addFinding({
      severity: "BLOCKER",
      rule: "backend.arch.jest.service.business-logic",
      module,
      file: relativeFile,
      line: lineNumberForIndex(text, match.index ?? 0),
      symbol: match[0],
      finding: "Service contains likely business-critical behavior but no colocated service Jest spec was found.",
      whyItMatters: "ERP business rules such as calculations, transactions, permissions, duplicate prevention, and state transitions need behavioral protection.",
      recommendation: "Add focused Jest coverage for meaningful behavior, edge/failure cases, and transaction behavior where applicable. Do not add artificial tests for simple CRUD.",
      confidence: "MEDIUM",
    });
  }
}

function analyzeConditionalLogic(file, relativeFile, text) {
  const module = moduleFromFile(relativeFile);
  const logicPattern = /\bif\s*\(|\bswitch\s*\(|\bthrow\s+new\b|\bfor(?:Each)?\s*\(|\bwhile\s*\(|permission|currency|amount|total|status|normalize|transform/i;
  const match = text.match(logicPattern);
  if (!match) return;

  const specPath = file.replace(/\.ts$/i, ".spec.ts");
  if (!fs.existsSync(specPath)) {
    addFinding({
      severity: "WARNING",
      rule: "backend.arch.jest.conditional-logic",
      module,
      file: relativeFile,
      line: lineNumberForIndex(text, match.index ?? 0),
      symbol: match[0],
      finding: "Non-trivial helper/application-rule logic has no colocated Jest spec.",
      whyItMatters: "Focused tests are useful when utilities, mappers, guards, pipes, or interceptors contain behavior that can realistically break.",
      recommendation: "Review whether a small behavioral Jest spec would add value. Skip tests for trivial projection/wiring.",
      confidence: "MEDIUM",
    });
  }
}

function analyzeModule(relativeFile, text) {
  if (!relativeFile.endsWith(".module.ts")) return;
  if (!/@Module\s*\(/.test(text)) {
    addFinding({
      severity: "BLOCKER",
      rule: "backend.arch.module.decorator",
      module: moduleFromFile(relativeFile),
      file: relativeFile,
      line: 1,
      symbol: "@Module",
      finding: "NestJS module file does not contain an @Module() decorator.",
      whyItMatters: "Module metadata is the structural wiring point for NestJS providers, controllers, and imports.",
      recommendation: "Confirm this is intended; otherwise restore the normal NestJS @Module() structure.",
    });
  }
}

const args = parseArgs(process.argv);
const repositoryRoot = path.resolve(args["repository-root"] || process.cwd());
const outputPath = path.resolve(
  args.output ||
    path.join(repositoryRoot, "reports", "weekly-architecture", "backend-architecture-results.json"),
);

const srcRoot = path.join(repositoryRoot, "src");
if (!fs.existsSync(srcRoot)) {
  console.error(`Backend src directory not found: ${srcRoot}`);
  process.exit(2);
}

const files = walk(srcRoot)
  .filter((file) => file.endsWith(".ts"))
  .filter((file) => !file.endsWith(".spec.ts"))
  .filter((file) => !file.endsWith(".d.ts"));

for (const file of files) {
  const relativeFile = normalizePath(path.relative(repositoryRoot, file));
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  analyzeModule(relativeFile, text);

  if (/\.controller\.ts$/i.test(relativeFile)) {
    analyzeController(file, relativeFile, text, lines);
  } else if (/\/dto\/.+\.dto\.ts$/i.test(relativeFile)) {
    analyzeDto(file, relativeFile, text, lines);
  } else if (/\.service\.ts$/i.test(relativeFile)) {
    analyzeService(file, relativeFile, text);
  } else if (/\.(mapper|util|utils|guard|pipe|interceptor)\.ts$/i.test(relativeFile)) {
    analyzeConditionalLogic(file, relativeFile, text);
  }
}

const severityRank = { BLOCKER: 0, WARNING: 1, INFORMATION: 2 };
findings.sort((a, b) => {
  const severity = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
  if (severity !== 0) return severity;
  const file = a.file.localeCompare(b.file);
  if (file !== 0) return file;
  return (a.line ?? 0) - (b.line ?? 0);
});

const counts = findings.reduce(
  (acc, item) => {
    acc[item.severity] = (acc[item.severity] || 0) + 1;
    return acc;
  },
  { BLOCKER: 0, WARNING: 0, INFORMATION: 0 },
);

const result = {
  tool: "Backend Weekly Architecture Review",
  policy: "weekly-full-tree-advisory",
  repositoryRoot: normalizePath(repositoryRoot),
  generatedAt: new Date().toISOString(),
  filesScanned: files.length,
  architectureFindingCount: findings.length,
  counts: {
    blocker: counts.BLOCKER,
    warning: counts.WARNING,
    information: counts.INFORMATION,
  },
  advisoryOnly: true,
  notes: [
    "BLOCKER is a finding classification only; this weekly review is advisory and does not block merges.",
    "The analyzer inspects files that currently exist. Missing future files/features in unfinished modules are not treated as architecture failures.",
    "Heuristic findings require developer/QA context review before refactoring.",
  ],
  findings,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(`Backend weekly architecture scan complete.`);
console.log(`Files scanned: ${result.filesScanned}`);
console.log(`Architecture findings: ${result.architectureFindingCount}`);
console.log(`Blocker-class: ${result.counts.blocker}`);
console.log(`Warnings: ${result.counts.warning}`);
console.log(`Output: ${outputPath}`);

// Weekly review is intentionally advisory.
process.exit(0);
