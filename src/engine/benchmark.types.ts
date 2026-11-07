/** Pure metric definitions for the benchmarking engine (safe to import from client components). */
export type MetricKey = "laborPerEmployee" | "repetitiveShare" | "recoverableHrsPerFte" | "automationScoreAvg" | "reworkRate" | "handoffsPerRun" | "realizablePerFte" | "verifiedPerFte";
export type MetricDef = { key: MetricKey; label: string; unit: "usd" | "pct" | "hours" | "score" | "count"; better: "higher" | "lower" | "neutral"; formula: string };
export const METRICS: MetricDef[] = [
  { key: "laborPerEmployee", label: "Labor $ per employee", unit: "usd", better: "neutral", formula: "annual loaded labor ÷ employees analyzed" },
  { key: "repetitiveShare", label: "Repetitive share of time", unit: "pct", better: "lower", formula: "repetitive hrs/wk ÷ observed hrs/wk" },
  { key: "recoverableHrsPerFte", label: "Recoverable hrs/wk per FTE", unit: "hours", better: "higher", formula: "recoverable hrs/wk ÷ employees" },
  { key: "automationScoreAvg", label: "Avg automation score", unit: "score", better: "higher", formula: "hours-weighted workflow automation score" },
  { key: "reworkRate", label: "Rework rate", unit: "pct", better: "lower", formula: "hours-weighted workflow rework rate" },
  { key: "handoffsPerRun", label: "Hand-offs per run", unit: "count", better: "lower", formula: "hours-weighted workflow hand-off count" },
  { key: "realizablePerFte", label: "Realizable $ per FTE", unit: "usd", better: "higher", formula: "realizable annual savings ÷ employees" },
  { key: "verifiedPerFte", label: "Verified $ per FTE", unit: "usd", better: "higher", formula: "verified annualized savings ÷ employees" },
];
