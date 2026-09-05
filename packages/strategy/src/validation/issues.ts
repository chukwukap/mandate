import { Problem } from "@mandate/contracts";
import type { ZodError } from "zod";

/**
 * One actionable rejection, addressed at the part of the plan that caused it.
 * `path` is a dotted pointer (`machines.0.states.1.transitions.0.when`) so a client
 * can highlight the offending rule instead of showing a wall of text.
 */
export type PlanIssue = { readonly path: string; readonly code: string; readonly message: string };

/**
 * A plan that parsed but cannot be signed. It is an RFC7807 Problem so an API route
 * can rethrow it untouched and the user sees every field that needs fixing, rather
 * than the first failure flattened into a generic message.
 */
export class PlanInvalid extends Problem {
  constructor(readonly issues: readonly PlanIssue[]) {
    super(400, "invalid-plan", "Invalid strategy", describe(issues));
  }
  static at(path: string, code: string, message: string): PlanInvalid {
    return new PlanInvalid([{ path, code, message }]);
  }
}

function describe(issues: readonly PlanIssue[]): string {
  if (issues.length === 0) return "The strategy is invalid.";
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
}

/**
 * Flatten a zod failure into issues. A raw ZodError reaching a route produces an
 * unreadable nested blob; the user needs "nodes.0.op: invalid value", not a dump.
 */
export function issuesFromZod(error: ZodError): PlanIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    code: `schema-${issue.code}`,
    message: issue.message,
  }));
}

/** Collects issues so validation can report every problem in one pass, not just the first. */
export class IssueLog {
  private readonly issues: PlanIssue[] = [];
  add(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }
  throwIfAny(): void {
    if (this.issues.length > 0) throw new PlanInvalid(this.issues);
  }
}
