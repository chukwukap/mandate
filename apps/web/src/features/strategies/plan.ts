export function makePlan(
  symbol: string,
  direction: "lt" | "gt",
  threshold: string,
  amount: string,
) {
  return {
    nodes: [
      {
        id: "target",
        op: direction,
        args: [
          { kind: "feed", feed: `oracle:${symbol}` },
          { kind: "const", value: threshold },
        ],
      },
    ],
    machines: [
      {
        id: "entry",
        scope: "portfolio",
        initial: "watching",
        states: [
          {
            id: "watching",
            transitions: [
              {
                when: "target",
                fires: "on_edge",
                to: "watching",
                actions: [
                  {
                    action: "order",
                    asset: 0,
                    side: "buy",
                    size: { unit: "quote", value: amount },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
