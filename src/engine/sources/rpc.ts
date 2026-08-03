// Direct chain reads, as a third source alongside GoPlus and DexScreener.
//
// Why this exists: an external reviewer bought a report on X Layer's own USD₮0
// and got 40% coverage, with the token identified only as `0x779ded…`. GoPlus
// answered, DexScreener had no pool on that chain, and nothing else could say
// what the contract even was. But the chain itself can: the token's name,
// symbol, decimals and supply are one `eth_call` away, and whether it is an
// upgradeable proxy is one storage read away. USD₮0 turns out to be exactly
// that — an EIP-1967 proxy — which is a material fact the report could not
// state before.
//
// The same tri-state rule as the other sources: an RPC that will not answer is
// `unavailable`, never evidence. Knowing there is no code at an address is
// different, and is real knowledge: it means the buyer sent a wallet address or
// a contract that does not exist, which is worth refusing before payment.

// More than one endpoint per chain, because a single public RPC is a single
// point of failure and these rate limit. Pinning reads to a block costs one
// extra request per report, which made a chain with only one endpoint fail
// intermittently: publicnode answered 403 and the whole snapshot went
// unavailable, so a report simply lost its on-chain section.
//
// Every fallback below was checked from the deploy host, which is the only place
// whose answer matters: eth.llamarpc.com and base.llamarpc.com both 403 from
// there, and polygon-rpc.com 401s, so none of them are listed.
const RPC_URLS: Record<string, string[]> = {
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://rpc.ankr.com/eth"],
  bsc: [
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
  ],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
  polygon: ["https://polygon-bor-rpc.publicnode.com"],
  // X Layer's own public endpoints, with OKX's as the fallback.
  xlayer: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
};

// ERC-20 and ownership selectors we call.
const SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  owner: "0x8da5cb5b",
  getOwner: "0x893d20e8",
} as const;

// EIP-1967 storage slots. A non-zero implementation slot is the strongest
// available signal that an address is an upgradeable proxy.
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/**
 * Function selectors whose presence in deployed bytecode indicates a capability.
 *
 * This is a heuristic and is labelled as one wherever it surfaces: a selector
 * appears as a PUSH4 constant in the dispatch table, so we look for `63` + the
 * selector. It can miss unusual dispatchers and, in principle, collide with an
 * unrelated constant. It is evidence, not proof, and the report says so.
 */
const CAPABILITY_SELECTORS: Record<string, string[]> = {
  mint: ["40c10f19", "a0712d68"], // mint(address,uint256), mint(uint256)
  burnFrom: ["79cc6790"],
  pause: ["8456cb59", "3f4ba83a"], // pause(), unpause()
  blacklist: ["f9f92be4", "0ecb93c0", "fe575a87", "e47d6060"], // USDC/USDT styles
  upgradeable: ["3659cfe6", "4f1ef286"], // upgradeTo, upgradeToAndCall
  ownable: ["8da5cb5b", "f2fde38b", "715018a6"],
};

export interface RpcFacts {
  status: "ok";
  /** False means no code at the address: an EOA, or nothing deployed. */
  isContract: boolean;
  name?: string;
  symbol?: string;
  decimals?: number;
  /** Human units, already divided by 10**decimals when both are known. */
  totalSupply?: number;
  /** Exact value as a decimal string; totalSupply may be absent when too large. */
  totalSupplyExact?: string;
  /** Non-zero EIP-1967 implementation slot. */
  proxyImplementation?: string;
  proxyAdmin?: string;
  /** From owner() or getOwner(); the zero address means ownership renounced. */
  owner?: string;
  ownerRenounced?: boolean;
  /** Heuristic, from the deployed bytecode (the implementation's, for a proxy). */
  capabilities?: string[];
  bytecodeBytes?: number;
  /** Pins the reads to a point in chain history, for the signed attestation. */
  chainId?: number;
  blockNumber?: number;
  provenance?: { url?: string; retrievedAt?: string; responseSha256?: string };
}

export type RpcSnapshot = RpcFacts | { status: "unavailable" };

export function rpcSupports(chain: string): boolean {
  return chain.toLowerCase() in RPC_URLS;
}

const ZERO = "0x0000000000000000000000000000000000000000";

// ── minimal ABI decoding ────────────────────────────────────────────────────
// Four return shapes, no dependency. Pulling in a full ABI library to read six
// values would be the larger risk.

function decodeString(hex: string): string | undefined {
  const body = strip(hex);
  if (!body) return undefined;
  try {
    // Dynamic string: offset, length, data. Some older tokens return a padded
    // bytes32 instead, which has no offset word.
    if (body.length >= 128) {
      const offset = Number(BigInt("0x" + body.slice(0, 64)));
      if (offset === 32) {
        const len = Number(BigInt("0x" + body.slice(64, 128)));
        if (len > 0 && len <= 256) return utf8(body.slice(128, 128 + len * 2));
      }
    }
    if (body.length === 64) return utf8(body).replace(/\0+$/, "") || undefined;
  } catch {
    /* fall through */
  }
  return undefined;
}

function utf8(hex: string): string {
  const bytes = hex.match(/.{2}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 16))).toString("utf8").replace(/\0/g, "");
}

function decodeUint(hex: string): bigint | undefined {
  const body = strip(hex);
  if (!body) return undefined;
  try {
    return BigInt("0x" + body.slice(0, 64));
  } catch {
    return undefined;
  }
}

function decodeAddress(hex: string): string | undefined {
  const body = strip(hex);
  if (!body || body.length < 64) return undefined;
  const addr = "0x" + body.slice(24, 64);
  return /^0x[0-9a-f]{40}$/i.test(addr) ? addr.toLowerCase() : undefined;
}

function strip(hex: string | undefined): string {
  if (!hex || hex === "0x") return "";
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

// ── transport ───────────────────────────────────────────────────────────────

interface RpcCall {
  method: string;
  params: unknown[];
}

// X Layer's public RPC rejects more than ten calls in one batch with
// -32014 "too many RPC calls", which would have made the chain this feature
// exists for the one chain it never worked on. Chunk below that everywhere.
const MAX_BATCH = 8;

async function batch(url: string, calls: RpcCall[], timeoutMs: number): Promise<(string | undefined)[]> {
  if (calls.length > MAX_BATCH) {
    const out: (string | undefined)[] = [];
    for (let i = 0; i < calls.length; i += MAX_BATCH) {
      out.push(...(await batch(url, calls.slice(i, i + MAX_BATCH), timeoutMs)));
    }
    return out;
  }
  const payload = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new Error("rpc did not answer a batch with an array");
  const out: (string | undefined)[] = new Array(calls.length).fill(undefined);
  for (const entry of json as { id?: number; result?: string; error?: unknown }[]) {
    const i = (entry?.id ?? 0) - 1;
    // A reverting eth_call is a normal answer here: it means the contract does
    // not implement that method, not that the chain is unavailable.
    if (i >= 0 && i < out.length && typeof entry.result === "string") out[i] = entry.result;
  }
  return out;
}

// `at` is a block tag. It defaults to "latest" only for callers that have no
// height yet; the snapshot always passes the height it pinned, so every fact in
// a report comes from the same block.
const call = (to: string, data: string, at: string = "latest"): RpcCall => ({
  method: "eth_call",
  params: [{ to, data }, at],
});

/**
 * Reads what the chain can tell us about a token address.
 *
 * One batched round trip, then a second only when the address turns out to be a
 * proxy and its implementation's bytecode is the one worth scanning.
 */
/**
 * Exact decimal string from a raw integer amount, without going through a float.
 *
 * `Number(raw / 10n ** decimals)` truncates before it converts: 150 raw with 2
 * decimals became 1, not 1.5. Quotient and remainder keep every digit, and large
 * supplies stay exact instead of silently losing precision past 2^53.
 */
export function formatUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export async function fetchChainFacts(chain: string, address: string): Promise<RpcSnapshot> {
  const urls = RPC_URLS[chain.toLowerCase()];
  if (!urls) return { status: "unavailable" };

  for (const url of urls) {
    try {
      // Pin every read to one block.
      //
      // All of these used "latest" and the height was asked for in a later
      // chunk, so owner, implementation slot, bytecode and supply could each
      // come from a different block during an upgrade or an ownership transfer,
      // while the report attested to a single height that pinned none of them.
      // Ask for the height first, then read everything at exactly that tag.
      const [chainIdHex, blockHex] = await batch(
        url,
        [{ method: "eth_chainId", params: [] }, { method: "eth_blockNumber", params: [] }],
        9000,
      );
      // Without a height there is nothing to pin to, so fall back rather than
      // silently reading "latest" again and calling it pinned.
      if (!blockHex) throw new Error("no answer to eth_blockNumber");
      const at = blockHex;

      const [code, name, symbol, decimals, supply, implSlot, adminSlot, owner, getOwner] =
        await batch(
          url,
          [
            { method: "eth_getCode", params: [address, at] },
            call(address, SEL.name, at),
            call(address, SEL.symbol, at),
            call(address, SEL.decimals, at),
            call(address, SEL.totalSupply, at),
            { method: "eth_getStorageAt", params: [address, SLOT_IMPL, at] },
            { method: "eth_getStorageAt", params: [address, SLOT_ADMIN, at] },
            call(address, SEL.owner, at),
            call(address, SEL.getOwner, at),
          ],
          9000,
        );

      // eth_getCode is the one call that must answer; without it we know nothing.
      if (code === undefined) throw new Error("no answer to eth_getCode");

      const num = (h?: string) => {
        try {
          return h ? Number(BigInt(h)) : undefined;
        } catch {
          return undefined;
        }
      };
      const chainId = num(chainIdHex);
      const blockNumber = num(blockHex);
      const provenance = { url, retrievedAt: new Date().toISOString() };

      const bytecode = strip(code);
      if (bytecode.length === 0) {
        // Real knowledge: nothing is deployed here.
        return { status: "ok", isContract: false, chainId, blockNumber, provenance };
      }

      const impl = decodeAddress(implSlot ?? "");
      const admin = decodeAddress(adminSlot ?? "");
      const proxyImplementation = impl && impl !== ZERO ? impl : undefined;
      const proxyAdmin = admin && admin !== ZERO ? admin : undefined;

      // For a proxy, the dispatch table that matters belongs to the
      // implementation; scanning the proxy's own bytecode would find nothing.
      let scanned = bytecode;
      if (proxyImplementation) {
        try {
          const [implCode] = await batch(
            url,
            // Same height as everything else: reading the implementation at a
            // later block could describe a contract the report never analysed.
            [{ method: "eth_getCode", params: [proxyImplementation, at] }],
            8000,
          );
          if (strip(implCode)) scanned = strip(implCode);
        } catch {
          /* keep the proxy's bytecode; capabilities stay best-effort */
        }
      }

      const capabilities = Object.entries(CAPABILITY_SELECTORS)
        .filter(([, sels]) => sels.some((s) => scanned.includes("63" + s)))
        .map(([name]) => name);

      const dec = decodeUint(decimals ?? "");
      const decimalsNum = dec !== undefined && dec <= 36n ? Number(dec) : undefined;
      const supplyRaw = decodeUint(supply ?? "");
      // BigInt division truncates, so a raw supply of 150 with 2 decimals came
      // out as 1 rather than 1.5, and a large supply could exceed the safe
      // integer range on the way to a number. Keep the exact value as a decimal
      // string, and offer the number only when it is safely representable.
      const totalSupplyExact =
        supplyRaw !== undefined && decimalsNum !== undefined
          ? formatUnits(supplyRaw, decimalsNum)
          : undefined;
      const totalSupply =
        totalSupplyExact !== undefined && Number.isSafeInteger(Math.trunc(Number(totalSupplyExact)))
          ? Number(totalSupplyExact)
          : undefined;

      const ownerAddr = decodeAddress(owner ?? "") ?? decodeAddress(getOwner ?? "");

      return {
        status: "ok",
        isContract: true,
        name: decodeString(name ?? ""),
        symbol: decodeString(symbol ?? ""),
        decimals: decimalsNum,
        totalSupply: Number.isFinite(totalSupply) ? totalSupply : undefined,
        proxyImplementation,
        proxyAdmin,
        owner: ownerAddr,
        ownerRenounced: ownerAddr ? ownerAddr === ZERO : undefined,
        capabilities: capabilities.length ? capabilities : undefined,
        bytecodeBytes: Math.floor(bytecode.length / 2),
        chainId,
        blockNumber,
        provenance,
      };
    } catch (e) {
      // Try the next endpoint before giving up, but say why. A silent fallback
      // hid a live regression: the snapshot reported unavailable in production
      // while every one of these calls succeeded by hand from the same box.
      console.error("[rpc]", chain, url, String((e as Error)?.message ?? e).slice(0, 200));
    }
  }
  return { status: "unavailable" };
}
