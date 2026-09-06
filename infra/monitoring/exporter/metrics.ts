/**
 * Prometheus text exposition format, written by hand.
 *
 * This exporter has no dependencies beyond `node:` builtins, and that is deliberate rather
 * than minimalist posturing. It is a monitoring sidecar: it has to come up and report that
 * the application is broken in exactly the situations where the application is broken, which
 * includes "someone shipped a dependency the workspace cannot install". Sharing
 * `node_modules` with the thing under observation couples the observer's uptime to the
 * observed. prom-client would also bring a default registry full of Node process metrics
 * that say nothing about whether anyone's money is moving.
 *
 * The format is specified precisely enough that writing it is a smaller risk than depending
 * on a library to: <https://prometheus.io/docs/instrumenting/exposition_formats/>.
 */

export type MetricType = "gauge" | "counter";

export interface Sample {
  readonly labels?: Readonly<Record<string, string>> | undefined;
  /** Float64. Never a money amount — see the comment on `render`. */
  readonly value: number;
}

export interface MetricFamily {
  readonly name: string;
  readonly type: MetricType;
  /** One line, no trailing period needed; rendered after `# HELP <name> `. */
  readonly help: string;
  readonly samples: readonly Sample[];
}

/**
 * Metric and label names are `[a-zA-Z_][a-zA-Z0-9_]*`. A name that fails this is a bug in
 * this exporter, not bad input, so it throws: emitting an unparseable exposition would make
 * Prometheus drop the WHOLE scrape, taking every healthy metric down with the malformed one.
 */
const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * HELP text escapes only backslash and newline. `"` is NOT escaped here — doing so is the
 * common copy-paste error from the label rules below and produces a visible stray backslash
 * in every dashboard tooltip.
 */
function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Label VALUES escape backslash, double quote and newline. Order matters: backslash first. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Prometheus accepts `NaN`, `+Inf` and `-Inf` as sample values, and they mean different
 * things from 0. A missing reading rendered as 0 reads as "this feed is perfectly fresh";
 * NaN propagates through PromQL arithmetic and keeps a comparison alert from firing on a
 * value nobody measured. So absent readings become NaN, never a zero.
 */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  // `String` is exact for every float64 and never emits a thousands separator or a locale
  // decimal comma, which is the failure mode of `toLocaleString`/`toFixed` here.
  return String(value);
}

function renderLabels(labels: Readonly<Record<string, string>> | undefined): string {
  if (!labels) return "";
  const pairs = Object.entries(labels).filter(([, value]) => value !== undefined);
  if (pairs.length === 0) return "";
  for (const [name] of pairs) if (!NAME.test(name)) throw new Error(`Invalid label name: ${name}`);
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

/**
 * Render families to the exposition format.
 *
 * A family with zero samples still emits its HELP and TYPE lines. That is not cosmetic: a
 * series that vanishes when the answer is "none" makes `mandate_asset_blocked == 0`
 * indistinguishable in PromQL from "the exporter never ran", and those need opposite
 * responses. The same reasoning as `metrics_schedule()` returning 0 rather than NULL in
 * infra/postgres/04-metrics.sql.
 *
 * NOTHING RENDERED HERE IS A MONEY AMOUNT. Prometheus samples are float64, and this
 * repository's rule is that value is a bigint or a decimal string. A price that survives the
 * round trip today would still be wrong to publish: metrics are downsampled, retention-
 * limited and lossy by design, and the moment a USDC figure appears on a dashboard somebody
 * reconciles against it. Ratios, counts, ages and tick spacings only.
 */
export function render(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    if (!NAME.test(family.name)) throw new Error(`Invalid metric name: ${family.name}`);
    if (seen.has(family.name)) throw new Error(`Duplicate metric family: ${family.name}`);
    seen.add(family.name);
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples)
      lines.push(`${family.name}${renderLabels(sample.labels)} ${formatValue(sample.value)}`);
  }
  // A trailing newline is required; a scrape of a body that does not end in one is rejected.
  return `${lines.join("\n")}\n`;
}
