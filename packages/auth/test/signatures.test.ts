import { describe, expect, test } from "bun:test";
import { type Hex, Problem } from "@mandate/contracts";
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  serializeErc6492Signature,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertSameAuthorization,
  authorizationDifferences,
  authorizeExecution,
  erc1271Abi,
  ERC1271_MAGIC,
  isErc6492,
  isMagicValue,
  isRevert,
  parseAuthorization,
  type SignatureReader,
  signatureReader,
  signingDeadlinePassed,
  type StrategyAuthorization,
  strategyAuthorizationHash,
  strategyAuthorizationJson,
  strategyAuthorizationTypedData,
  verifyDigest,
  verifyEoaDigest,
  verifyPersonalSignature,
  verifyStrategyAuthorization,
} from "../src/signatures/index.js";

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const mallory = privateKeyToAccount(`0x${"22".repeat(32)}`);
/** A contract wallet: it has code, so nothing ever ecrecovers to it. */
const walletAddress = "0xb0b0000000000000000000000000000000000b0b" as const;

const card: StrategyAuthorization = {
  origin: "https://app.mandate.test",
  chainId: 8453,
  account: alice.address,
  artifact: "a".repeat(64),
  name: "AAPL dip buyer",
  mode: "auto",
  expires: "2026-09-05T12:00:00.000Z",
  render: "Buy 100 USDC of AAPLc when it trades below 300.00 USDC.\nStop after 5 buys.",
};

function change(patch: Partial<StrategyAuthorization>): StrategyAuthorization {
  return { ...card, ...patch };
}

/**
 * EIP-712 recomputed from the spec, not from viem's helper.
 *
 * `strategyAuthorizationHash` calls `hashTypedData`, so a test that also called it would only
 * prove viem is self-consistent. This encodes the domain separator, the type hash and the struct
 * hash by hand, which is what actually pins the member names, their order and their ABI types —
 * the three things that silently invalidate every stored signature if they move.
 */
function eip712ByHand(input: StrategyAuthorization): Hex {
  const domainType = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId)"));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [
        domainType,
        keccak256(stringToHex("Mandate")),
        keccak256(stringToHex("2")),
        BigInt(input.chainId),
      ],
    ),
  );
  const typeHash = keccak256(
    stringToHex(
      "StrategyAuthorization(string name,string mode,string review,address account,string origin,string expires,bytes32 artifact)",
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        typeHash,
        keccak256(stringToHex(input.name)),
        keccak256(stringToHex(input.mode)),
        keccak256(stringToHex(input.render)),
        input.account.toLowerCase() as Hex,
        keccak256(stringToHex(input.origin)),
        keccak256(stringToHex(input.expires)),
        `0x${input.artifact}`,
      ],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

/** A reader that answers from fixed values and counts what it was asked. */
function reader(
  options: {
    code?: Hex;
    answer?: Hex | undefined;
    predeploy?: boolean | undefined;
    codeFails?: boolean;
  } = {},
) {
  const seen: Array<{ address: Hex; digest: Hex; signature: Hex }> = [];
  let predeployCalls = 0;
  const base: SignatureReader = {
    async code() {
      if (options.codeFails)
        throw Problem.unavailable("The wallet's signature could not be checked onchain right now.");
      return options.code ?? "0x";
    },
    async isValidSignature(address, digest, signature) {
      seen.push({ address, digest, signature });
      return options.answer;
    },
  };
  const value: SignatureReader =
    options.predeploy === undefined
      ? base
      : {
          ...base,
          verifyPredeploy: async () => {
            predeployCalls += 1;
            return options.predeploy === true;
          },
        };
  return { reader: value, seen, predeployCalls: () => predeployCalls };
}

describe("EIP-712 encoding of the review card", () => {
  test("the digest matches a hand-rolled EIP-712 encoding of the same struct", () => {
    expect(strategyAuthorizationHash(card)).toBe(eip712ByHand(card));
  });

  /**
   * A golden vector. Its only job is to fail loudly if the domain, a member name, a member type
   * or the member order is ever edited — each of which invalidates every signature already
   * stored against a live instance.
   */
  test("the digest is pinned", () => {
    expect(strategyAuthorizationHash(card)).toBe(
      "0xdcc0eafcb2adcf48ed09c95e0d13c28a281f9c8756a95075903dcbc3553a4280",
    );
  });

  test("every field of the card moves the digest", () => {
    const digest = strategyAuthorizationHash(card);
    const variants: StrategyAuthorization[] = [
      change({ origin: "https://evil.mandate.test" }),
      change({ chainId: 1 }),
      change({ account: mallory.address }),
      change({ artifact: `${"a".repeat(63)}b` }),
      change({ name: "AAPL dip buyer " }),
      change({ mode: "manual" }),
      change({ expires: "2026-09-05T12:00:01.000Z" }),
      // One character of the words the user actually read.
      change({ render: card.render.replace("300.00", "300.01") }),
    ];
    for (const variant of variants) expect(strategyAuthorizationHash(variant)).not.toBe(digest);
    expect(new Set(variants.map(strategyAuthorizationHash)).size).toBe(variants.length);
  });

  test("account casing normalises but does not change the digest", () => {
    const upper = change({ account: alice.address.toUpperCase().replace("0X", "0x") });
    expect(strategyAuthorizationHash(upper)).toBe(strategyAuthorizationHash(card));
    expect(parseAuthorization(upper).account).toBe(alice.address.toLowerCase() as Hex);
  });

  test("the JSON wire form carries EIP712Domain and hashes identically", () => {
    const json = strategyAuthorizationJson(card);
    expect(json.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ]);
    // The point of the assertion: the hand-declared domain table matches the one viem derives,
    // so serving one form and hashing the other cannot drift.
    expect(keccak256(stringToHex(JSON.stringify(json.message)))).toBe(
      keccak256(stringToHex(JSON.stringify(strategyAuthorizationTypedData(card).message))),
    );
    expect(JSON.parse(JSON.stringify(json)).domain.chainId).toBe(8453);
  });

  test("message.review carries the rendered text verbatim", () => {
    expect(strategyAuthorizationTypedData(card).message.review).toBe(card.render);
    expect(strategyAuthorizationTypedData(card).message.artifact).toBe(`0x${card.artifact}`);
  });
});

describe("card validation", () => {
  const bad: Array<[string, StrategyAuthorization]> = [
    ["a non-canonical ISO instant", change({ expires: "2026-09-05T12:00:00Z" })],
    ["a local-time instant", change({ expires: "2026-09-05T12:00:00.000+01:00" })],
    ["an unparseable deadline", change({ expires: "soon" })],
    ["an uppercase artifact", change({ artifact: "A".repeat(64) })],
    ["a 0x-prefixed artifact", change({ artifact: `0x${"a".repeat(62)}` })],
    ["a short artifact", change({ artifact: "a".repeat(63) })],
    ["a non-address account", change({ account: "0x1234" })],
    ["chain id zero", change({ chainId: 0 })],
    ["a fractional chain id", change({ chainId: 8453.5 })],
    ["an empty name", change({ name: "" })],
    ["an oversized render", change({ render: "x".repeat(65_537) })],
    ["a NUL in the render", change({ render: `a${String.fromCharCode(0)}b` })],
  ];
  for (const [name, input] of bad)
    test(`rejects ${name}`, () => {
      expect(() => parseAuthorization(input)).toThrow(Problem);
      try {
        parseAuthorization(input);
      } catch (error) {
        expect((error as Problem).status).toBe(400);
      }
    });

  test("a 65536-character render is still accepted", () => {
    expect(() => parseAuthorization(change({ render: "x".repeat(65_536) }))).not.toThrow();
  });

  test("the signing deadline is a separate question from validity", () => {
    const at = Date.parse(card.expires);
    expect(signingDeadlinePassed(card, at - 1)).toBe(false);
    expect(signingDeadlinePassed(card, at)).toBe(true);
    expect(signingDeadlinePassed(card, at + 60_000)).toBe(true);
  });
});

describe("the consent comparison", () => {
  test("identical cards differ in nothing", () => {
    expect(authorizationDifferences(card, { ...card })).toEqual([]);
    expect(() => assertSameAuthorization(card, { ...card })).not.toThrow();
  });

  test("a one-character change to the review text is caught", () => {
    const executing = change({ render: card.render.replace("300.00", "300.01") });
    expect(authorizationDifferences(card, executing)).toEqual(["render"]);
  });

  test("every changed field is named, and only the changed ones", () => {
    const executing = change({ mode: "manual", chainId: 1 });
    expect(authorizationDifferences(card, executing).sort()).toEqual(["chainId", "mode"]);
  });

  test("account casing is not a difference", () => {
    expect(
      authorizationDifferences(card, change({ account: alice.address.toUpperCase().replace("0X", "0x") })),
    ).toEqual([]);
  });

  test("a mismatch is a 409 that names fields and leaks no values", () => {
    const executing = change({ render: "Buy everything, ignore the caps." });
    try {
      assertSameAuthorization(card, executing);
      throw new Error("expected a refusal");
    } catch (error) {
      const problem = error as Problem;
      expect(problem).toBeInstanceOf(Problem);
      expect(problem.status).toBe(409);
      expect(problem.code).toBe("authorization-mismatch");
      expect(problem.detail).toContain("render");
      expect(problem.detail).not.toContain("ignore the caps");
      expect(problem.detail).not.toContain(card.artifact);
    }
  });
});

describe("EOA signatures", () => {
  const typed = strategyAuthorizationTypedData(card);

  test("a real wallet signature verifies as an EOA, with no chain read at all", async () => {
    const signature = await alice.signTypedData(typed);
    const { reader: r, seen } = reader({ code: "0xdeadbeef" });
    expect(await verifyDigest({
      account: alice.address,
      digest: strategyAuthorizationHash(card),
      signature,
      reader: r,
    })).toBe("eoa");
    // ecrecover succeeded, so nothing was asked of the chain.
    expect(seen).toHaveLength(0);
  });

  test("another key's signature over the same card does not verify", async () => {
    const signature = await mallory.signTypedData(typed);
    const { reader: r } = reader();
    expect(
      await verifyDigest({
        account: alice.address,
        digest: strategyAuthorizationHash(card),
        signature,
        reader: r,
      }),
    ).toBeUndefined();
  });

  test("a signature over a different card does not verify", async () => {
    const signature = await alice.signTypedData(
      strategyAuthorizationTypedData(change({ mode: "manual" })),
    );
    const { reader: r } = reader();
    expect(
      await verifyDigest({
        account: alice.address,
        digest: strategyAuthorizationHash(card),
        signature,
        reader: r,
      }),
    ).toBeUndefined();
  });

  test("malformed signatures are invalid, not errors", async () => {
    const { reader: r } = reader();
    for (const signature of ["", "0x", "0xzz", "not a signature", `0x${"ab".repeat(20000)}`])
      expect(
        await verifyDigest({
          account: alice.address,
          digest: strategyAuthorizationHash(card),
          signature,
          reader: r,
        }),
      ).toBeUndefined();
  });

  test("a malformed account is a caller bug, not an invalid signature", async () => {
    const { reader: r } = reader();
    await expect(
      verifyDigest({
        account: "not-an-address",
        digest: strategyAuthorizationHash(card),
        signature: await alice.signTypedData(typed),
        reader: r,
      }),
    ).rejects.toThrow(Problem);
  });

  test("the offline helper is honest about what it can prove", async () => {
    const signature = await alice.signTypedData(typed);
    expect(await verifyEoaDigest(alice.address, strategyAuthorizationHash(card), signature)).toBe(
      true,
    );
    expect(await verifyEoaDigest(walletAddress, strategyAuthorizationHash(card), signature)).toBe(
      false,
    );
  });
});

describe("ERC-1271 contract wallets", () => {
  const digest = strategyAuthorizationHash(change({ account: walletAddress }));
  const signature = "0xfeed" as const;

  test("a padded magic value from a deployed wallet verifies", async () => {
    const { reader: r, seen } = reader({
      code: "0x60806040",
      answer: pad(ERC1271_MAGIC, { dir: "right", size: 32 }),
    });
    expect(
      await verifyDigest({ account: walletAddress, digest, signature, reader: r }),
    ).toBe("erc1271");
    expect(seen).toEqual([{ address: walletAddress, digest, signature }]);
  });

  test("a bare four-byte magic value is also accepted", async () => {
    const { reader: r } = reader({ code: "0x60806040", answer: ERC1271_MAGIC });
    expect(await verifyDigest({ account: walletAddress, digest, signature, reader: r })).toBe(
      "erc1271",
    );
  });

  test("any other answer is a refusal", async () => {
    for (const answer of [
      "0x00000000",
      pad("0xffffffff", { dir: "right", size: 32 }),
      "0x",
      undefined,
    ] as Array<Hex | undefined>) {
      const { reader: r } = reader({ code: "0x60806040", answer });
      expect(
        await verifyDigest({ account: walletAddress, digest, signature, reader: r }),
      ).toBeUndefined();
    }
  });

  test("an address with no code is refused without an eth_call", async () => {
    const { reader: r, seen } = reader({ code: "0x", answer: ERC1271_MAGIC });
    expect(
      await verifyDigest({ account: walletAddress, digest, signature, reader: r }),
    ).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  test("an unreachable chain is a 503, never an invalid signature", async () => {
    const { reader: r } = reader({ codeFails: true });
    const failed = verifyDigest({ account: walletAddress, digest, signature, reader: r });
    await expect(failed).rejects.toThrow(Problem);
    await failed.catch((error: Problem) => {
      expect(error.status).toBe(503);
    });
  });

  test("isMagicValue only looks at the leading four bytes", () => {
    expect(isMagicValue(pad(ERC1271_MAGIC, { dir: "right", size: 32 }))).toBe(true);
    expect(isMagicValue("0x1626BA7E")).toBe(true);
    expect(isMagicValue("0x1626ba7")).toBe(false);
    expect(isMagicValue("0x")).toBe(false);
    expect(isMagicValue(undefined)).toBe(false);
  });
});

describe("ERC-6492 counterfactual wallets", () => {
  const digest = strategyAuthorizationHash(change({ account: walletAddress }));
  const inner = "0xc0ffee" as const;
  const wrapped = serializeErc6492Signature({
    address: "0xfac0000000000000000000000000000000000fac",
    data: "0xdeadbeef",
    signature: inner,
  });

  test("the wrapper is detected", () => {
    expect(isErc6492(wrapped)).toBe(true);
    expect(isErc6492(inner)).toBe(false);
  });

  test("a deployed wallet is asked with the inner signature, not the envelope", async () => {
    const { reader: r, seen } = reader({
      code: "0x60806040",
      answer: pad(ERC1271_MAGIC, { dir: "right", size: 32 }),
    });
    expect(
      await verifyDigest({ account: walletAddress, digest, signature: wrapped, reader: r }),
    ).toBe("erc6492");
    expect(seen[0]?.signature).toBe(inner);
  });

  test("an undeployed wallet uses the predeploy capability when it exists", async () => {
    const yes = reader({ code: "0x", predeploy: true });
    expect(
      await verifyDigest({ account: walletAddress, digest, signature: wrapped, reader: yes.reader }),
    ).toBe("erc6492");
    expect(yes.predeployCalls()).toBe(1);

    const no = reader({ code: "0x", predeploy: false });
    expect(
      await verifyDigest({ account: walletAddress, digest, signature: wrapped, reader: no.reader }),
    ).toBeUndefined();
  });

  test("an undeployed wallet with no predeploy capability is told what to do, not called invalid", async () => {
    const { reader: r } = reader({ code: "0x" });
    const failed = verifyDigest({
      account: walletAddress,
      digest,
      signature: wrapped,
      reader: r,
    });
    await expect(failed).rejects.toThrow(Problem);
    await failed.catch((error: Problem) => {
      expect(error.status).toBe(409);
      expect(error.code).toBe("wallet-not-deployed");
    });
  });

  test("a wrapped signature never takes the ecrecover shortcut", async () => {
    // The inner half here is a genuine EOA signature by alice over this digest. Recovering it
    // would produce alice, so an implementation that ecrecovered a wrapped signature and compared
    // against `account` would still say no here — but it would also skip the chain entirely for a
    // wallet whose real answer lives onchain. Asserting the chain WAS asked is what pins it.
    const eoa = await alice.signMessage({ message: "unrelated" });
    const envelope = serializeErc6492Signature({
      address: "0xfac0000000000000000000000000000000000fac",
      data: "0xdeadbeef",
      signature: eoa,
    });
    const { reader: r, seen } = reader({ code: "0x60806040", answer: ERC1271_MAGIC });
    await verifyDigest({ account: alice.address, digest, signature: envelope, reader: r });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signature).toBe(eoa);
  });
});

describe("the viem adapter", () => {
  const digest = strategyAuthorizationHash(card);

  function client(behaviour: {
    code?: Hex;
    call?: () => Promise<{ data?: Hex }>;
    verifyHash?: () => Promise<boolean>;
  }) {
    const calls: Array<{ to: Hex; data: Hex }> = [];
    return {
      calls,
      client: {
        getCode: async () => behaviour.code,
        call: async (args: { to: Hex; data: Hex }) => {
          calls.push(args);
          return behaviour.call ? behaviour.call() : { data: undefined };
        },
        ...(behaviour.verifyHash ? { verifyHash: behaviour.verifyHash } : {}),
      },
    };
  }

  test("getCode returning undefined reads as an undeployed address", async () => {
    expect(await signatureReader(client({}).client).code(walletAddress)).toBe("0x");
  });

  test("the eth_call carries a real isValidSignature payload", async () => {
    const fixture = client({ call: async () => ({ data: ERC1271_MAGIC }) });
    const answer = await signatureReader(fixture.client).isValidSignature(
      walletAddress,
      digest,
      "0xabcd",
    );
    expect(answer).toBe(ERC1271_MAGIC);
    expect(fixture.calls[0]).toEqual({
      to: walletAddress,
      data: encodeFunctionData({
        abi: erc1271Abi,
        functionName: "isValidSignature",
        args: [digest, "0xabcd"],
      }),
    });
  });

  test("a revert is a refusal; anything else is an outage", async () => {
    const reverted = Object.assign(new Error("call failed"), {
      name: "CallExecutionError",
      cause: Object.assign(new Error("execution reverted"), {
        name: "ContractFunctionRevertedError",
      }),
    });
    const revertReader = signatureReader(
      client({
        call: () => Promise.reject(reverted),
      }).client,
    );
    expect(await revertReader.isValidSignature(walletAddress, digest, "0xabcd")).toBeUndefined();

    const offline = Object.assign(new Error("fetch failed"), {
      name: "HttpRequestError",
      cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const offlineReader = signatureReader(client({ call: () => Promise.reject(offline) }).client);
    await expect(
      offlineReader.isValidSignature(walletAddress, digest, "0xabcd"),
    ).rejects.toThrow(Problem);
  });

  test("isRevert reads geth's JSON-RPC code and ignores ambiguous ones", () => {
    expect(isRevert({ cause: { cause: { code: 3, message: "execution reverted" } } })).toBe(true);
    expect(isRevert({ name: "ExecutionRevertedError" })).toBe(true);
    // -32000 also means "header not found" and rate limiting, so it must NOT read as a refusal.
    expect(isRevert({ code: -32000 })).toBe(false);
    expect(isRevert(new Error("boom"))).toBe(false);
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isRevert(loop)).toBe(false);
  });

  test("verifyPredeploy exists only when the client can do a deployless call", async () => {
    expect(signatureReader(client({}).client).verifyPredeploy).toBeUndefined();
    const capable = signatureReader(client({ verifyHash: async () => true }).client);
    expect(await capable.verifyPredeploy?.(walletAddress, digest, "0xabcd")).toBe(true);
  });

  test("a failing deployless call is an outage, not a refusal", async () => {
    const capable = signatureReader(
      client({
        verifyHash: () => Promise.reject(new Error("node down")),
      }).client,
    );
    await expect(capable.verifyPredeploy?.(walletAddress, digest, "0xabcd")).rejects.toThrow(
      Problem,
    );
  });
});

describe("authorizeExecution — the consent boundary end to end", () => {
  test("the signed card and the executing card agree, and the signature covers them", async () => {
    const signature = await alice.signTypedData(strategyAuthorizationTypedData(card));
    const { reader: r } = reader();
    const verified = await authorizeExecution({
      signed: card,
      executing: { ...card },
      signature,
      reader: r,
    });
    expect(verified).toEqual({
      account: alice.address.toLowerCase() as Hex,
      digest: strategyAuthorizationHash(card),
      method: "eoa",
    });
  });

  /**
   * The failure this whole module exists to prevent: a valid signature over the card the user
   * read, presented alongside a plan whose cap has been widened. Nothing about the signature is
   * wrong; the artifact underneath it moved, and that has to stop the trade.
   */
  test("a valid signature over a stale card cannot authorise a changed one", async () => {
    const signature = await alice.signTypedData(strategyAuthorizationTypedData(card));
    const executing = change({ artifact: `${"a".repeat(63)}b` });
    const { reader: r } = reader();
    const failed = authorizeExecution({ signed: card, executing, signature, reader: r });
    await expect(failed).rejects.toThrow(Problem);
    await failed.catch((error: Problem) => {
      expect(error.code).toBe("authorization-mismatch");
      expect(error.status).toBe(409);
    });
  });

  test("agreeing cards with a signature by the wrong key are a 400", async () => {
    const signature = await mallory.signTypedData(strategyAuthorizationTypedData(card));
    const { reader: r } = reader();
    const failed = authorizeExecution({
      signed: card,
      executing: { ...card },
      signature,
      reader: r,
    });
    await expect(failed).rejects.toThrow(Problem);
    await failed.catch((error: Problem) => {
      expect(error.code).toBe("invalid-signature");
      expect(error.status).toBe(400);
    });
  });

  test("a smart wallet is authorised through ERC-1271", async () => {
    const wallet = change({ account: walletAddress });
    const { reader: r } = reader({
      code: "0x60806040",
      answer: pad(ERC1271_MAGIC, { dir: "right", size: 32 }),
    });
    const verified = await authorizeExecution({
      signed: wallet,
      executing: { ...wallet },
      signature: "0xdeadbeef",
      reader: r,
    });
    expect(verified.method).toBe("erc1271");
    expect(verified.account).toBe(walletAddress);
  });

  test("verifyStrategyAuthorization reports the digest it checked", async () => {
    const signature = await alice.signTypedData(strategyAuthorizationTypedData(card));
    const { reader: r } = reader();
    const verified = await verifyStrategyAuthorization({
      authorization: card,
      signature,
      reader: r,
    });
    expect(verified?.digest).toBe(strategyAuthorizationHash(card));
    expect(verified?.method).toBe("eoa");
  });
});

describe("personal_sign, the path the app signs today", () => {
  /** Byte-for-byte the shape `authorizationMessage` in @mandate/strategy produces. */
  const message = [
    "Mandate strategy authorization",
    `Origin: ${card.origin}`,
    `Chain: ${card.chainId}`,
    `Account: ${card.account.toLowerCase()}`,
    `Artifact: ${card.artifact}`,
    `Name: ${card.name}`,
    `Requested mode: ${card.mode}`,
    `Sign before: ${card.expires}`,
    "",
    card.render,
  ].join("\n");

  test("an EOA signature over the exact message verifies", async () => {
    const signature = await alice.signMessage({ message });
    const { reader: r } = reader();
    const verified = await verifyPersonalSignature({
      account: alice.address,
      message,
      signature,
      reader: r,
    });
    expect(verified?.method).toBe("eoa");
    expect(verified?.account).toBe(alice.address.toLowerCase() as Hex);
  });

  test("one changed character in the message invalidates it", async () => {
    const signature = await alice.signMessage({ message });
    const { reader: r } = reader();
    expect(
      await verifyPersonalSignature({
        account: alice.address,
        message: message.replace("Requested mode: auto", "Requested mode: manual"),
        signature,
        reader: r,
      }),
    ).toBeUndefined();
  });

  test("a smart wallet gets the ERC-1271 path the plain verifier cannot offer", async () => {
    const { reader: r, seen } = reader({ code: "0x60806040", answer: ERC1271_MAGIC });
    const verified = await verifyPersonalSignature({
      account: walletAddress,
      message,
      signature: "0xbeef",
      reader: r,
    });
    expect(verified?.method).toBe("erc1271");
    // EIP-191, not the raw string: the wallet is asked about the prefixed digest, rebuilt here
    // from the spec so this asserts the prefixing rather than re-running the same helper.
    const bytes = stringToHex(message).length / 2 - 1;
    const prefix = `${String.fromCharCode(0x19)}Ethereum Signed Message:\n${bytes}`;
    expect(seen[0]?.digest).toBe(keccak256(concatHex([stringToHex(prefix), stringToHex(message)])));
  });
});
