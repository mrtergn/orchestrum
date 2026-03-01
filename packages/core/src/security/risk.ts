export type RiskFactors = {
  filesChanged: number;
  diffLines: number;
  securityPathHits: number;
};

export function computeRiskScore(input: {
  changedFiles: string[];
  diffText: string;
  securityPaths?: string[];
}): { score: number; factors: RiskFactors } {
  const filesChanged = input.changedFiles.length;
  const diffLines = input.diffText.split(/\r?\n/).filter(Boolean).length;
  const securityPaths = input.securityPaths ?? ["security", "auth", "crypto"];
  const securityPathHits = input.changedFiles.filter((file) =>
    securityPaths.some((p) => file.toLowerCase().includes(p.toLowerCase()))
  ).length;

  const filesScore = Math.min(1, filesChanged / 20);
  const diffScore = Math.min(1, diffLines / 800);
  const securityScore = Math.min(1, securityPathHits / 3);
  const score = clamp(filesScore * 0.4 + diffScore * 0.4 + securityScore * 0.2, 0, 1);
  return {
    score,
    factors: { filesChanged, diffLines, securityPathHits }
  };
}

export function extractVulnerabilityScore(outputJson: unknown, outputText: string | null): number | null {
  const payload = outputJson && typeof outputJson === "object" ? (outputJson as any) : null;
  const fromJson =
    payload?.vulnerability_score ??
    payload?.exploit_probability ??
    payload?.risk_score ??
    payload?.score;
  if (typeof fromJson === "number") return normalizeScore(fromJson);
  if (outputText) {
    const match = outputText.match(/(vulnerability|exploit|risk)[^0-9]*(\d+(\.\d+)?)/i);
    if (match?.[2]) {
      return normalizeScore(Number(match[2]));
    }
  }
  return null;
}

function normalizeScore(value: number): number {
  if (value > 1) {
    return clamp(value / 100, 0, 1);
  }
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
