export class ReportBuilder {
  constructor() {
    this.findings = [];
  }

  addFinding(finding) {
    this.findings.push({
      ...finding,
      createdAt: new Date().toISOString(),
    });
  }

  getFindings() {
    return this.findings;
  }

  getByCategory(category) {
    return this.findings.filter(
      x => x.category === category
    );
  }

  getSummary() {
    const blockers = this.findings.filter(
      x => x.severity === "blocker"
    ).length;

    const warnings = this.findings.filter(
      x => x.severity === "warning"
    ).length;

    const suggestions = this.findings.filter(
      x => x.severity === "suggestion"
    ).length;

    const info = this.findings.filter(
      x => x.severity === "info"
    ).length;

    return {
      totalFindings: this.findings.length,
      blockers,
      warnings,
      suggestions,
      info,
    };
  }

  hasBlockers() {
    return this.getSummary().blockers > 0;
  }
}