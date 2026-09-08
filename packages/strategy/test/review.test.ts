import { expect, test } from "bun:test";
import {
  artifactId,
  authorizationMessage,
  canonical,
  digest,
  review,
} from "../src/review/index.js";
import type { Asset, Envelope, Plan } from "../src/validation/index.js";
import { capsSchema, validatePlan } from "../src/validation/index.js";

const AAPL: Asset = {
  symbol: "AAPLc",
  token: `0x${"11".repeat(20)}`,
  feed: `0x${"22".repeat(20)}`,
  decimals: 8,
};
const NVDA: Asset = {
  symbol: "NVDAc",
  token: `0x${"33".repeat(20)}`,
  feed: `0x${"44".repeat(20)}`,
  decimals: 8,
};
const CAPS = {
  lifetime: "100",
  per_order: "10",
  per_period: "20",
  period_secs: 86400,
  max_orders_per_period: 2,
  cooldown_secs: 60,
  expires_at: "2027-01-01T00:00:00Z",
};

function threshold(value: string, feedUri = "oracle:AAPLc") {
  return {
    id: "below",
    op: "lt",
    args: [
      { kind: "feed", feed: feedUri },
      { kind: "const", value },
    ],
  };
}
function planFor(nodes: unknown[], actions: unknown[], assets: readonly Asset[]): Plan {
  return validatePlan(
    {
      params: [{ id: "limit", label: "Entry limit", value: "200" }],
      nodes,
      machines: [
        {
          id: "m",
          scope: "portfolio",
          initial: "watch",
          states: [{ id: "watch", transitions: [{ when: "below", to: "watch", actions }] }],
        },
      ],
    },
    assets,
  );
}
function envelopeFor(assets: readonly Asset[], caps = CAPS): Envelope {
  return {
    version: "mandate/2",
    caps: capsSchema.parse(caps),
    assets: [...assets],
    quote: `0x${"55".repeat(20)}`,
    venue: "aerodrome",
  };
}
const NOTIFY = [{ action: "notify", message: "Price condition met" }];

test("canonical form ignores key order and binds every meaningful change", () => {
  expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  // A plan read back out of JSONB does not preserve insertion order, so key-order
  // independence is what lets the worker reproduce the API's artifact id.
  expect(digest({ a: "10" })).not.toBe(digest({ a: "100" }));
  expect(canonical([1, "a", true, null])).toBe('[1,"a",true,null]');
  expect(canonical({ 'b"q': 1 })).toBe('{"b\\"q":1}');
});

test("values that would silently collide are refused, not encoded", () => {
  // This is the provenance root of what the user signs, so a collision is a
  // forged commitment, not a formatting nit.
  expect(() => canonical({ expires: new Date(0) })).toThrow("Cannot commit to a Date");
  expect(() => canonical({ n: Number.NaN })).toThrow("non-finite");
  expect(() => canonical({ n: Number.POSITIVE_INFINITY })).toThrow("non-finite");
  expect(() => canonical({ n: 1n })).toThrow("bigint");
  expect(() => canonical({ n: undefined })).toThrow("undefined");
  expect(() => canonical({ n: new Map() })).toThrow("Map");
  expect(() => canonical({ n: () => 1 })).toThrow("function");
  // JSON.stringify collapses all four of these onto values that already exist.
  expect(JSON.stringify({ d: new Date(0) }).includes("1970")).toBe(true);
  expect(JSON.stringify({ n: Number.NaN })).toBe('{"n":null}');
  expect(canonical({ n: -0 })).not.toBe(canonical({ n: 0 }));
  // The message names the offending path so a caller can find it.
  expect(() => canonical({ draft: { expires: new Date(0) } })).toThrow("$.draft.expires");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => canonical(cyclic)).toThrow("cyclic");
});

test("review is deterministic and states what the signature actually authorises", () => {
  const plan = planFor([threshold("200")], NOTIFY, [AAPL]);
  const envelope = envelopeFor([AAPL]);
  const a = review(plan, envelope);
  expect(a).toEqual(review(plan, envelope));
  expect(a.render_text).toContain(AAPL.token);
  expect(a.render_text).toContain("Mandate's server");
  expect(a.render_text).toContain("Price condition met");
  expect(a.card.parameters).toEqual(["Entry limit: 200"]);
  // Nodes are expanded, so the user reads the condition rather than an id.
  expect(a.card.rules[0]).toContain("when lt(oracle:AAPLc, 200)");
  expect(a.card.rules[0]).toContain("once on a rising edge");
  expect(a.render_sha256).toHaveLength(64);
});

test("any change a user would care about changes both the render hash and the artifact id", () => {
  const assets = [AAPL];
  const plan = planFor([threshold("200")], NOTIFY, assets);
  const envelope = envelopeFor(assets);
  const base = review(plan, envelope);
  const commit = (p: Plan, e: Envelope) => ({
    id: "d1",
    user: "u1",
    account: "0xabc",
    name: "Dip buyer",
    mode: "auto",
    plan: p,
    envelope: e,
    render: review(p, e).render_text,
    expires: "2026-09-05T12:30:00.000Z",
  });
  const baseId = artifactId(commit(plan, envelope));

  const changed: [string, Plan, Envelope][] = [
    ["threshold", planFor([threshold("199")], NOTIFY, assets), envelope],
    ["cap", plan, envelopeFor(assets, { ...CAPS, per_order: "9" })],
    ["expiry", plan, envelopeFor(assets, { ...CAPS, expires_at: "2027-01-02T00:00:00Z" })],
    ["asset", planFor([threshold("200", "oracle:NVDAc")], NOTIFY, [NVDA]), envelopeFor([NVDA])],
  ];
  for (const [label, p, e] of changed) {
    expect(`${label}:${review(p, e).render_sha256}`).not.toBe(`${label}:${base.render_sha256}`);
    expect(artifactId(commit(p, e))).not.toBe(baseId);
  }
  // The rendered words are inside the artifact id too, so the id cannot survive a
  // change to what the user actually read.
  expect(artifactId({ ...commit(plan, envelope), render: `${base.render_text} ` })).not.toBe(
    baseId,
  );
});

test("artifactId and authorizationMessage reproduce the strings built by hand today", () => {
  const plan = planFor([threshold("200")], NOTIFY, [AAPL]);
  const envelope = envelopeFor([AAPL]);
  const rendered = review(plan, envelope);
  const id = "9f5c1e2a-0000-4000-8000-000000000001";
  const user = "user-1";
  const account = "0x00000000000000000000000000000000000000aa";
  const name = "Dip buyer";
  const mode = "auto";
  const origin = "https://app.example";
  const expiresAt = new Date("2026-09-05T12:30:00.000Z");

  // Byte-for-byte the blocks in apps/api/src/modules/strategies/routes.ts,
  // packages/execution/src/admission.ts and apps/worker/test/worker.test.ts. A
  // single added space in any one of them makes every strategy fail admission as
  // "observation-or-authority-unavailable", with nothing to say why.
  const handBuiltId = digest({
    id,
    user,
    account,
    name,
    mode,
    plan,
    envelope,
    render: rendered.render_text,
    expires: expiresAt.toISOString(),
  });
  const handBuiltMessage = `Mandate strategy authorization\nOrigin: ${origin}\nChain: 8453\nAccount: ${account}\nArtifact: ${handBuiltId}\nName: ${name}\nRequested mode: ${mode}\nSign before: ${expiresAt.toISOString()}\n\n${rendered.render_text}`;

  const commitment = {
    id,
    user,
    account,
    name,
    mode,
    plan,
    envelope,
    render: rendered.render_text,
    expires: expiresAt.toISOString(),
  };
  expect(artifactId(commitment)).toBe(handBuiltId);
  expect(
    authorizationMessage({
      origin,
      chainId: 8453,
      account,
      artifact: artifactId(commitment),
      name,
      mode,
      expires: expiresAt.toISOString(),
      render: rendered.render_text,
    }),
  ).toBe(handBuiltMessage);

  // Origin and chain are inside the signed text, so a signature collected by one
  // deployment cannot be replayed against another.
  const elsewhere = authorizationMessage({
    origin: "https://evil.example",
    chainId: 8453,
    account,
    artifact: artifactId(commitment),
    name,
    mode,
    expires: expiresAt.toISOString(),
    render: rendered.render_text,
  });
  expect(elsewhere).not.toBe(handBuiltMessage);
});

test("a pool price used without its oracle is disclosed in the text that is signed", () => {
  // AAPLc/USDC quotes $320.22 at tick spacing 10 and $37,861 at tick spacing 200 —
  // an 11,729% error on the same pair. A condition that reads a pool price with no
  // Chainlink cross-check is deciding on the unverified number, and only the signer
  // can accept that.
  const risky = review(
    planFor([threshold("200", "dex:AAPLc")], NOTIFY, [AAPL]),
    envelopeFor([AAPL]),
  );
  expect(risky.card.cautions[0]).toContain("dex:AAPLc");
  expect(risky.card.cautions[0]).toContain("Pool prices can be moved");
  expect(risky.render_text).toContain("dex:AAPLc is a pool price");

  // With the oracle read alongside it, there is nothing to warn about.
  const hedged = review(
    planFor(
      [
        {
          id: "pool",
          op: "lt",
          args: [
            { kind: "feed", feed: "dex:AAPLc" },
            { kind: "const", value: "200" },
          ],
        },
        {
          id: "ref",
          op: "lt",
          args: [
            { kind: "feed", feed: "oracle:AAPLc" },
            { kind: "const", value: "200" },
          ],
        },
        {
          id: "below",
          op: "and",
          args: [
            { kind: "node", node: "pool" },
            { kind: "node", node: "ref" },
          ],
        },
      ],
      NOTIFY,
      [AAPL],
    ),
    envelopeFor([AAPL]),
  );
  expect(hedged.card.cautions).toEqual([]);
});

test("plan-specific surprises are disclosed, and only where they apply", () => {
  const plain = review(planFor([threshold("200")], NOTIFY, [AAPL]), envelopeFor([AAPL]));
  expect(plain.card.cautions).toEqual([]);

  // routes.ts refuses to prepare a permission for any plan containing a sell (409
  // sell-permission-required). Without this the user signs a review, then discovers
  // at arming that half the strategy can never run.
  const selling = review(
    planFor(
      [threshold("200")],
      [{ action: "order", asset: 0, side: "sell", size: { unit: "base", value: "1" } }],
      [AAPL],
    ),
    envelopeFor([AAPL]),
  );
  expect(selling.card.cautions.join("\n")).toContain("Automatic sell authority is not available");

  // Equity includes stock, which cannot be spent.
  const equitySized = review(
    planFor(
      [threshold("200")],
      [{ action: "order", asset: 0, side: "buy", size: { unit: "pct_equity", bps: 10_000 } }],
      [AAPL],
    ),
    envelopeFor([AAPL]),
  );
  expect(equitySized.card.cautions.join("\n")).toContain("Stock cannot be spent");

  // Rules address assets by position in the signed list.
  const multi = review(
    planFor([threshold("200")], NOTIFY, [AAPL, NVDA]),
    envelopeFor([AAPL, NVDA]),
  );
  expect(multi.card.cautions.join("\n")).toContain("0=AAPLc, 1=NVDAc");

  // Every caution is inside render_text: one the signature does not cover is decoration.
  for (const caution of [
    ...selling.card.cautions,
    ...equitySized.card.cautions,
    ...multi.card.cautions,
  ])
    expect(
      [selling.render_text, equitySized.render_text, multi.render_text].some((t) =>
        t.includes(caution),
      ),
    ).toBe(true);
});

test("a basket discloses that its rules do not hold each other back", () => {
  // The single most surprising property of a multi-asset strategy. Cooldowns are keyed per
  // machine and per transition, so every rule in a basket is independent and all of them can be
  // admitted inside one evaluation — while the authority block says "cooldown per rule", which
  // reads like a limit on the strategy as a whole.
  const basket = validatePlan(
    {
      nodes: [
        {
          id: "cheap_aapl",
          op: "lt",
          args: [
            { kind: "feed", feed: "oracle:AAPLc" },
            { kind: "const", value: "200" },
          ],
        },
        {
          id: "cheap_nvda",
          op: "lt",
          args: [
            { kind: "feed", feed: "oracle:NVDAc" },
            { kind: "const", value: "150" },
          ],
        },
      ],
      machines: [0, 1].map((index) => ({
        id: `entry_${index}`,
        scope: "portfolio",
        initial: "watching",
        states: [
          {
            id: "watching",
            transitions: [
              {
                when: index === 0 ? "cheap_aapl" : "cheap_nvda",
                to: "watching",
                actions: [
                  {
                    action: "order",
                    asset: index,
                    side: "buy",
                    size: { unit: "quote", value: "50" },
                  },
                ],
              },
            ],
          },
        ],
      })),
    },
    [AAPL, NVDA],
  );
  const rendered = review(basket, envelopeFor([AAPL, NVDA]));
  const text = rendered.card.cautions.join("\n");
  expect(text).toContain("2 rules can trigger in the same evaluation");
  expect(text).toContain("not to the strategy as a whole");
  // Signed, not merely displayed.
  expect(rendered.render_text).toContain("2 rules can trigger in the same evaluation");

  // A rule that only notifies spends nothing, so it is not one of the rules being counted.
  const oneBuyer = review(
    planFor([threshold("200")], NOTIFY, [AAPL, NVDA]),
    envelopeFor([AAPL, NVDA]),
  );
  expect(oneBuyer.card.cautions.join("\n")).not.toContain("rules can trigger in the same");
});

test("an expression too deep to read is refused rather than rendered", () => {
  // Nesting expands multiplicatively; the failure belongs at a rejected draft, not
  // at a 64000-character card the user scrolls past.
  const nodes: unknown[] = [
    {
      id: "n0",
      op: "add",
      args: [
        { kind: "const", value: "1".repeat(40) },
        { kind: "const", value: "1".repeat(40) },
      ],
    },
  ];
  for (let i = 1; i < 12; i++)
    nodes.push({
      id: `n${i}`,
      op: "add",
      args: [
        { kind: "node", node: `n${i - 1}` },
        { kind: "node", node: `n${i - 1}` },
      ],
    });
  nodes.push({
    id: "below",
    op: "lt",
    args: [
      { kind: "node", node: "n11" },
      { kind: "const", value: "1" },
    ],
  });
  expect(() => review(planFor(nodes, NOTIFY, [AAPL]), envelopeFor([AAPL]))).toThrow(
    "too complex to review",
  );
});
