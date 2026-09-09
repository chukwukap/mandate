/**
 * One word per state, used everywhere a state is shown.
 *
 * The Overview used to print the raw status ("armed") beside a list that said "Watching" and a
 * button that said "Start watching" — three names for one fact, on adjacent screens.
 */
const LABELS: Record<string, string> = {
  armed: "Watching",
  paused: "Paused",
  halted: "Stopped",
  ended: "Ended",
  confirmed: "Completed",
  signal: "Signal",
  refunded: "Returned",
  pending: "Pending",
  admitted: "Queued",
  reverted: "Failed",
  cancelled: "Cancelled",
  recovery_required: "Needs review",
};

export const statusLabel = (status: string) => LABELS[status] ?? status;

export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status}`}>
      <i />
      {statusLabel(status)}
    </span>
  );
}
