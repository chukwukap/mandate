export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status}`}>
      <i />
      {(
        {
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
        } as Record<string, string>
      )[status] ?? status}
    </span>
  );
}
