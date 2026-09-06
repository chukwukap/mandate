import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORTER_METRICS, referenceAgeSeconds } from "../exporter/samples.js";

/**
 * What this asserts, and why a YAML file needs a test at all.
 *
 * promtool is not installed in this workspace and the Docker daemon is not running, so the
 * usual `promtool check rules` is unavailable here. That only covers syntax anyway. The
 * failures that actually matter in an alerting config are semantic and promtool would pass
 * every one of them:
 *
 *   * an alert selecting a metric that nothing produces. It never fires, and it never tells
 *     anyone it never fires -- it just occupies the slot where real coverage would go.
 *   * a threshold that drifted away from the constant it was derived from.
 *   * a runbook link to a section that does not exist.
 *   * the 26-hour feed bound creeping back into a staleness alert, which is the single
 *     mistake this whole directory is arranged to prevent.
 *
 * So the exporter's own metric list is imported, not retyped, and every name, severity,
 * alertname and anchor is checked against the thing that defines it.
 */

const DIR = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(DIR, path), "utf8");
const yaml = <T>(path: string): T => Bun.YAML.parse(read(path)) as T;

interface Rule {
  alert?: string;
  record?: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
interface RuleFile {
  groups: { name: string; interval?: string; rules: Rule[] }[];
}

const alerts = yaml<RuleFile>("rules/alerts.yml");
const recording = yaml<RuleFile>("rules/recording.yml");
const collector = yaml<{
  metrics: { metric_name: string; query_ref: string }[];
  queries: { query_name: string }[];
}>("collectors/mandate.collector.yml");
const prometheus = yaml<{
  rule_files: string[];
  scrape_configs: { job_name: string }[];
}>("prometheus.yml");
const alertmanager = yaml<{
  route: { receiver: string; routes: { matchers: string[]; receiver: string }[] };
  receivers: { name: string }[];
  inhibit_rules: { source_matchers: string[]; target_matchers: string[]; equal?: string[] }[];
}>("alertmanager.yml");

const alertRules = alerts.groups.flatMap((group) => group.rules);
const recordRules = recording.groups.flatMap((group) => group.rules);

/**
 * Metrics produced by something other than this repository. Kept as an explicit list rather
 * than a permissive fallback: the point of the reference check below is that an unknown name
 * is a bug, and a wildcard escape hatch would let the next typo through silently.
 */
const EXTERNAL_METRICS = new Set([
  "up",
  "probe_success",
  "probe_http_status_code",
  "probe_duration_seconds",
]);

const PRODUCED = new Set<string>([
  ...collector.metrics.map((metric) => metric.metric_name),
  ...EXPORTER_METRICS,
  ...recordRules.flatMap((rule) => (rule.record ? [rule.record] : [])),
  ...EXTERNAL_METRICS,
]);

/** PromQL keywords, aggregators and functions. Anything left over is a metric name. */
const RESERVED = new Set([
  "sum",
  "min",
  "max",
  "avg",
  "count",
  "count_values",
  "stddev",
  "stdvar",
  "topk",
  "bottomk",
  "quantile",
  "group",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "and",
  "or",
  "unless",
  "bool",
  "offset",
  "rate",
  "irate",
  "increase",
  "delta",
  "idelta",
  "deriv",
  "changes",
  "resets",
  "abs",
  "ceil",
  "floor",
  "round",
  "clamp",
  "clamp_min",
  "clamp_max",
  "vector",
  "scalar",
  "time",
  "timestamp",
  "absent",
  "absent_over_time",
  "label_replace",
  "label_join",
  "histogram_quantile",
  "predict_linear",
  "holt_winters",
  "avg_over_time",
  "max_over_time",
  "min_over_time",
  "sum_over_time",
  "count_over_time",
  "quantile_over_time",
  "stddev_over_time",
  "last_over_time",
  "present_over_time",
  "sort",
  "sort_desc",
  "exp",
  "ln",
  "log2",
  "log10",
  "sqrt",
  "sgn",
]);

/**
 * Metric names referenced by an expression.
 *
 * The strips happen in this order and each one is load-bearing: quoted strings first (a label
 * value can contain braces), then label selectors (whose LABEL names would otherwise look
 * like metrics), then range/subquery brackets (`[15m]`), then aggregation groupings -- `by
 * (leg)` puts a bare label name in parentheses and it is indistinguishable from a metric by
 * the time it reaches the tokenizer.
 */
function metricsIn(expr: string): string[] {
  const stripped = expr
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " ");
  const tokens = stripped.match(/[a-zA-Z_][a-zA-Z0-9_:]*/g) ?? [];
  return [...new Set(tokens.filter((token) => !RESERVED.has(token)))];
}

/** Numeric literals that a comparison operator is applied to -- the alert's thresholds. */
function thresholdsIn(expr: string): string[] {
  const matches = expr.matchAll(/(?:>=|<=|==|!=|>|<)\s*(\d+(?:\.\d+)?)/g);
  return [...new Set([...matches].flatMap((match) => (match[1] ? [match[1]] : [])))];
}

describe("alert rules reference metrics that exist", () => {
  test("every metric selected by an alert or recording rule is produced somewhere", () => {
    const unknown: string[] = [];
    for (const rule of [...alertRules, ...recordRules])
      for (const metric of metricsIn(rule.expr))
        if (!PRODUCED.has(metric)) unknown.push(`${rule.alert ?? rule.record}: ${metric}`);
    expect(unknown).toEqual([]);
  });

  test("every metric that is produced is read by a rule or shown on the dashboard", () => {
    // The other direction. A metric nobody looks at is scrape cost, storage and one more
    // series to reason about during an incident, with no reader to notice when it breaks.
    const dashboard = read("grafana/mandate.dashboard.json");
    const referenced = new Set(
      [...alertRules, ...recordRules].flatMap((rule) => metricsIn(rule.expr)),
    );
    // A word-boundary match, not `includes`: `mandate_executions` is a prefix of
    // `mandate_executions_open`, so a substring test would report the census as covered
    // because a different metric happens to start with its name.
    const onDashboard = (name: string) => new RegExp(`${name}(?![A-Za-z0-9_])`).test(dashboard);
    const orphans = [...collector.metrics.map((m) => m.metric_name), ...EXPORTER_METRICS].filter(
      (name) => !referenced.has(name) && !onDashboard(name),
    );
    expect(orphans).toEqual([]);
  });

  test("every collector metric names a query that exists", () => {
    const queries = new Set(collector.queries.map((query) => query.query_name));
    for (const metric of collector.metrics) expect(queries.has(metric.query_ref)).toBe(true);
  });

  test("a job selector in an expression names a job prometheus actually scrapes", () => {
    const jobs = new Set(prometheus.scrape_configs.map((config) => config.job_name));
    const selectors = [...alertRules, ...recordRules].flatMap((rule) => [
      ...rule.expr.matchAll(/job\s*=~?\s*"([^"]+)"/g),
    ]);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(jobs.has(selector[1] ?? "")).toBe(true);
  });
});

describe("every alert is actionable", () => {
  test("alert names are unique", () => {
    const names = alertRules.map((rule) => rule.alert);
    expect(new Set(names).size).toBe(names.length);
  });

  test("each alert carries a severity, a component, a delay and the five annotations", () => {
    for (const rule of alertRules) {
      const where = rule.alert ?? "(unnamed)";
      expect(where, `${where} has no name`).toBeTruthy();
      // No `for` means a single unlucky scrape pages someone.
      expect(rule.for, `${where} has no for:`).toBeTruthy();
      expect(["critical", "warning", "info"], `${where} severity`).toContain(
        rule.labels?.severity ?? "",
      );
      expect(rule.labels?.component, `${where} component`).toBeTruthy();
      for (const key of ["summary", "description", "derivation", "action", "runbook"])
        expect(rule.annotations?.[key], `${where} is missing the ${key} annotation`).toBeTruthy();
    }
  });

  test("every threshold in an expression is quoted in the alert's own justification", () => {
    // The rule this directory is built on: a number nobody can defend gets tuned away the
    // first time it is inconvenient. Stating it in `derivation` is what makes it defensible,
    // and stating it VERBATIM is what makes this check able to notice when it drifts.
    const missing: string[] = [];
    for (const rule of alertRules) {
      const text = Object.values(rule.annotations ?? {}).join(" ");
      for (const threshold of thresholdsIn(rule.expr))
        if (!text.includes(threshold)) missing.push(`${rule.alert}: ${threshold}`);
    }
    expect(missing).toEqual([]);
  });

  test("every runbook anchor resolves to a heading in the README", () => {
    const readme = read("README.md");
    const anchors = new Set(
      [...readme.matchAll(/^#{2,4}\s+(.+)$/gm)].map(([, heading]) =>
        (heading ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, "")
          .replace(/ /g, "-"),
      ),
    );
    const broken: string[] = [];
    for (const rule of alertRules) {
      const anchor = (rule.annotations?.runbook ?? "").split("#")[1] ?? "";
      if (!anchors.has(anchor)) broken.push(`${rule.alert}: #${anchor}`);
    }
    expect(broken).toEqual([]);
  });
});

describe("routing and suppression match the rules", () => {
  test("every severity a rule emits has a route, and every route matches a severity in use", () => {
    const emitted = new Set(alertRules.map((rule) => rule.labels?.severity));
    const routed = new Set(
      alertmanager.route.routes.flatMap((route) =>
        route.matchers.flatMap((matcher) =>
          [...matcher.matchAll(/severity="([^"]+)"/g)].map((m) => m[1]),
        ),
      ),
    );
    expect([...emitted].sort()).toEqual([...routed].sort());
  });

  test("every route names a receiver that is defined", () => {
    const receivers = new Set(alertmanager.receivers.map((receiver) => receiver.name));
    expect(receivers.has(alertmanager.route.receiver)).toBe(true);
    for (const route of alertmanager.route.routes) expect(receivers.has(route.receiver)).toBe(true);
  });

  test("every alertname in an inhibit rule exists", () => {
    const names = new Set(alertRules.map((rule) => rule.alert));
    const referenced = alertmanager.inhibit_rules.flatMap((inhibit) =>
      [...inhibit.source_matchers, ...inhibit.target_matchers].flatMap((matcher) =>
        (matcher.match(/alertname=~?"([^"]+)"/)?.[1] ?? "").split("|"),
      ),
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) expect(names.has(name), `inhibit names ${name}`).toBe(true);
  });

  test("an inhibit rule that suppresses a per-symbol alert is scoped by symbol", () => {
    // Without `equal: [symbol]`, AAPLc going unusable would silently suppress the warning
    // for every other symbol -- the exact shape of bug that makes an operator trust a quiet
    // dashboard during an incident.
    for (const inhibit of alertmanager.inhibit_rules) {
      const touchesSymbol = [...inhibit.source_matchers, ...inhibit.target_matchers].some(
        (matcher) =>
          matcher.includes("MandateReferenceFeed") || matcher.includes("MandateQuoteDeviation"),
      );
      if (touchesSymbol) expect(inhibit.equal).toEqual(["symbol"]);
    }
  });
});

describe("prometheus configuration", () => {
  test("every rule_files entry resolves to a file that exists", () => {
    const present = new Set(readdirSync(join(DIR, "rules")).map((name) => `rules/${name}`));
    expect(prometheus.rule_files.length).toBeGreaterThan(0);
    for (const path of prometheus.rule_files) expect(present.has(path)).toBe(true);
    // And no rule file is left unloaded, which is how a whole group goes quiet.
    for (const path of present) expect(prometheus.rule_files).toContain(path);
  });

  test("the sql_exporter DSN placeholder carries no password", () => {
    const config = yaml<{ target: { data_source_name: string } }>("sql_exporter.yml");
    const dsn = config.target.data_source_name;
    // `user:password@host`. The roles in 01-roles.sql are created without passwords on
    // purpose; a credential committed here would outlive every rotation.
    expect(dsn).not.toMatch(/:\/\/[^:@/]+:[^@/]+@/);
    expect(dsn).toContain("mandate_metrics");
  });

  test("blackbox accepts the 503 that /ready is designed to return", () => {
    const config = yaml<{ modules: Record<string, { http: { valid_status_codes: number[] } }> }>(
      "blackbox.yml",
    );
    const codes = config.modules.mandate_api_reachable?.http.valid_status_codes ?? [];
    expect(codes).toContain(200);
    // Listing 200 alone would make this probe a second, worse copy of the readiness alert.
    expect(codes).toContain(503);
  });
});

describe("the feed staleness bound is the validation bound, not the display bound", () => {
  /** The one alert whose threshold decides whether this system pages every weekend. */
  const unusable = alertRules.find((rule) => rule.alert === "MandateReferenceFeedUnusable");
  const threshold = Number(thresholdsIn(unusable?.expr ?? "")[0]);

  test("it is exactly MAX_VALIDATION_AGE", () => {
    expect(threshold).toBe(96 * 3600);
  });

  test("no rule alerts on the 26h display gauge", () => {
    // `mandate_reference_stale` is the API's own 26h verdict. Every symbol is 1 for the whole
    // of every weekend by design, so an alert reading it is an alert that fires 52 times a
    // year and gets muted.
    for (const rule of [...alertRules, ...recordRules])
      expect(rule.expr, `${rule.alert ?? rule.record}`).not.toContain("mandate_reference_stale");
    expect(thresholdsIn(unusable?.expr ?? "")).not.toContain(String(26 * 3600));
  });

  test("a weekend-aged feed does not trip it and a genuinely dead one does", () => {
    // Measured on a Sunday: every one of the seven feeds was 37-43h old while its Aerodrome
    // pool traded normally. Fed through the exporter's own age function, not a literal.
    const nowMs = Date.UTC(2026, 0, 4, 18, 0, 0);
    const at = (hours: number) => Math.floor(nowMs / 1000) - Math.round(hours * 3600);
    for (const hours of [37, 40, 43, 64, 88])
      expect(referenceAgeSeconds(at(hours), nowMs), `${hours}h`).toBeLessThanOrEqual(threshold);
    for (const hours of [97, 120])
      expect(referenceAgeSeconds(at(hours), nowMs), `${hours}h`).toBeGreaterThan(threshold);
  });

  test("an unreadable feed cannot trip a staleness comparison, so it has its own alert", () => {
    // NaN fails every comparison, including `> 345600`. Without a dedicated alert on
    // availability, a feed that cannot be read at all would be silently invisible forever.
    expect(referenceAgeSeconds(0, Date.now())).toBeNaN();
    expect(alertRules.some((rule) => rule.alert === "MandateReferenceFeedUnreadable")).toBe(true);
  });
});
