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

const RPC_URLS: Record<string, string[]> = {
  ethereum: ["https://ethereum-rpc.publicnode.com"],
  bsc: ["https://bsc-rpc.publicnode.com"],
  base: ["https://base-rpc.publicnode.com"],
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com"],
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
  /** Non-zero EIP-1967 implementation slot. */
  proxyImplementation?: string;
  proxyAdmin?: string;
  /** From owner() or getOwner(); the zero address means ownership renounced. */
  owner?: string;
  ownerRenounced?: boolean;
  /** Heuristic, from the deployed bytecode (the implementation's, for a proxy). */
  capabilities?: string[];
  bytecodeBytes?: number;
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

async function batch(url: string, calls: RpcCall[], timeoutMs: number): Promise<(string | undefined)[]> {
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

const call = (to: string, data: string): RpcCall => ({
  method: "eth_call",
  params: [{ to, data }, "latest"],
});

/**
 * Reads what the chain can tell us about a token address.
 *
 * One batched round trip, then a second only when the address turns out to be a
 * proxy and its implementation's bytecode is the one worth scanning.
 */
export async function fetchChainFacts(chain: string, address: string): Promise<RpcSnapshot> {
  const urls = RPC_URLS[chain.toLowerCase()];
  if (!urls) return { status: "unavailable" };

  for (const url of urls) {
    try {
      const [code, name, symbol, decimals, supply, implSlot, adminSlot, owner, getOwner] =
        await batch(
          url,
          [
            { method: "eth_getCode", params: [address, "latest"] },
            call(address, SEL.name),
            call(address, SEL.symbol),
            call(address, SEL.decimals),
            call(address, SEL.totalSupply),
            { method: "eth_getStorageAt", params: [address, SLOT_IMPL, "latest"] },
            { method: "eth_getStorageAt", params: [address, SLOT_ADMIN, "latest"] },
            call(address, SEL.owner),
            call(address, SEL.getOwner),
          ],
          9000,
        );

      // eth_getCode is the one call that must answer; without it we know nothing.
      if (code === undefined) throw new Error("no answer to eth_getCode");

      const bytecode = strip(code);
      if (bytecode.length === 0) {
        // Real knowledge: nothing is deployed here.
        return { status: "ok", isContract: false };
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
            [{ method: "eth_getCode", params: [proxyImplementation, "latest"] }],
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
      const totalSupply =
        supplyRaw !== undefined && decimalsNum !== undefined
          ? Number(supplyRaw / 10n ** BigInt(decimalsNum))
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
      };
    } catch {
      // Try the next endpoint for this chain before giving up.
    }
  }
  return { status: "unavailable" };
}
