#!/usr/bin/env python3
"""Deterministic ASP fulfilment watcher for Dossier (agent 7012).

Why this exists: incoming marketplace jobs were dispatched to an AI session that
could fail for reasons unrelated to the job (expired provider credentials, API
errors), leaving a paid buyer with nothing. Delivering a dossier needs no model:
resolve the token, call our own service, push the result into the job channel.
This runs on a timer, is idempotent, and has no LLM or OAuth dependency.

Per job with role=asp, agent 7012, status=accepted and no ASP deliverable yet:
  1. resolve the token (0x address in the title, else symbol via DexScreener)
  2. fetch the report through the internal-key bypass
  3. upload it to the job file channel
  4. send a self-contained A2A message (analysis inline + retrieval details)
  5. save a local deliverable record
If the token cannot be resolved, ask the buyer once over A2A instead.
"""
import json, os, re, subprocess, sys, time

ASP = "7012"
ENDPOINT = "https://dossier.rouma.xyz/dossier"
HOME = os.path.expanduser("~")
KEY_FILE = os.path.join(HOME, ".okx-agent-task", "internal-key.txt")
STATE_FILE = os.path.join(HOME, ".okx-agent-task", "fulfill-watcher-state.json")
# How long to let the buyer's own paid replay land before messaging them.
#
# This guards a real race: the replay runs seconds after the task is created, and
# a buyer it served needs no message from us. The log shows it earning its keep,
# with several jobs entering the hold and never needing to be asked.
#
# It was 900s, which at a 120s tick meant a buyer who genuinely needed a question
# waited about eight ticks to be asked anything. 240s still covers the race twice
# over, since a replay lands in seconds, not minutes. When it does misfire the
# message opens by telling an already-served buyer to ignore it.
ASK_GRACE_SECONDS = 240
# How long before nudging a buyer who never answered. Repeating the same question
# every tick would be spam; leaving it a full day meant a stalled job sat idle
# through a working day. Four nudges a day on a job the buyer is waiting on is
# the balance.
REASK_SECONDS = 21600
ONCHAINOS = os.path.join(HOME, ".local", "bin", "onchainos")
OKXA2A = os.path.join(HOME, ".npm-global", "bin", "okx-a2a")
SUPPORTED_CHAINS = {"ethereum", "bsc", "base", "arbitrum", "polygon", "xlayer"}
# How far ahead the deepest token must be before a bare ticker is treated as
# naming it unambiguously. Below this, we ask the buyer which token they mean.
TICKER_DOMINANCE = 10.0
STOPWORDS = {
    "due", "diligence", "on", "for", "the", "a", "an", "check", "quick", "risk",
    "report", "before", "i", "buy", "token", "analysis", "please", "of", "my",
}
# Canonical X Layer contracts, keyed by the ticker a buyer would actually type.
#
# Why this exists: resolve_token() resolves tickers through DexScreener, whose
# X Layer coverage is thin. USD₮0 — this chain's settlement stablecoin, and the
# asset we are paid in — has no DexScreener market at all, so a buyer who wrote
# "USDT0" rather than an address got "I could not identify the token" and waited.
# That happened to a real buyer on 2026-07-28.
#
# Consulted only after DexScreener has answered and found nothing, never when it
# errored, so it can neither override a resolution that already works nor fire
# blindly during a DexScreener outage.
# Canonical mainnet deployments for majors, keyed by ticker.
#
# Why this exists: on 2026-08-02 a buyer asked for a WBTC report and received one
# on Base WBTC instead of Ethereum's. DexScreener's search for "WBTC" returns
# exactly one candidate above our liquidity floor — Base, at ~$0.6M — and omits
# Ethereum's entirely, despite it being orders of magnitude deeper. TICKER_DOMINANCE
# only compares candidates against each other, so with a single result it never
# fires and the wrong asset went out with full confidence. That earned a 1-star
# review, and it was deserved.
#
# The lesson is that one search result is not evidence of unambiguity: absence
# from DexScreener is not absence from the chain. For a bare major ticker, the
# canonical mainnet deployment is what a buyer means unless they say otherwise,
# so it is resolved from here rather than from whatever the search happens to
# surface. Every address is checked against symbol() on its own chain before use.
CANONICAL_TOKENS = {
    "wbtc": ("ethereum", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"),
    "weth": ("ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    "usdc": ("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    "usdt": ("ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    "dai":  ("ethereum", "0x6B175474E89094C44Da98b954EedeAC495271d0F"),
    "link": ("ethereum", "0x514910771AF9Ca656af840dff83E8264EcF986CA"),
    "uni":  ("ethereum", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"),
    "aave": ("ethereum", "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9"),
}
CHAIN_RPC = {
    "ethereum": "https://ethereum-rpc.publicnode.com",
    "bsc": "https://bsc-rpc.publicnode.com",
    "base": "https://base-rpc.publicnode.com",
    "arbitrum": "https://arbitrum-one-rpc.publicnode.com",
    "polygon": "https://polygon-bor-rpc.publicnode.com",
    "xlayer": "https://rpc.xlayer.tech",
}
XLAYER_RPC = os.environ.get("XLAYER_RPC", "https://rpc.xlayer.tech")
XLAYER_TOKENS = {
    "usdt0": "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    "wokb":  "0xe538905cf8410324e03a5a23c1c177a474d59b2b",
    "okb":   "0xe538905cf8410324e03a5a23c1c177a474d59b2b",
    "usdc":  "0x74b7f16337b8972027f6196a17a631ac6de26d22",
    "weth":  "0x5a77f1443d16ee5761d310e38b62f77f726bc71c",
    "wbtc":  "0xea034fb02eb1808c2cc3adbc15f447b93cbe08e1",
    "dai":   "0xc5015b9d9161dca7e18e32f6f25c4ad850731fd4",
}


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def run(cmd, timeout=180):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 1, "", "timeout")


def jrun(cmd, timeout=180):
    r = run(cmd, timeout)
    m = re.search(r"\{.*\}", r.stdout, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def load_state():
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {}


def save_state(s):
    tmp = STATE_FILE + ".tmp"
    json.dump(s, open(tmp, "w"))
    os.replace(tmp, STATE_FILE)


def fmt_price(n):
    """Plain decimal, never scientific notation."""
    if n is None:
        return "n/a"
    try:
        f = float(n)
    except Exception:
        return str(n)
    if f == 0:
        return "0"
    if abs(f) >= 1:
        return format(round(f, 6), ",")
    d = ("%.18f" % f).split(".")[1]
    lead = len(d) - len(d.lstrip("0"))
    return "0." + d[: lead + 4].rstrip("0")


def money(n):
    try:
        return format(int(float(n)), ",")
    except Exception:
        return "n/a"


def norm_sym(s):
    """Fold a ticker to a comparable key, so 'USD₮0' and 'usdt0' are one token."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("₮", "t"))


def decode_abi_string(hexs):
    """Decode an ABI-encoded string return, tolerating bytes32-style symbols."""
    if not hexs or hexs == "0x":
        return None
    try:
        raw = bytes.fromhex(hexs[2:])
    except ValueError:
        return None
    if len(raw) == 32:                     # older tokens return a padded bytes32
        return raw.rstrip(b"\0").decode("utf-8", "replace") or None
    if len(raw) < 64:
        return None
    length = int.from_bytes(raw[32:64], "big")
    if length > len(raw) - 64:
        return None
    return raw[64:64 + length].decode("utf-8", "replace")


def symbol_on_chain(chain, addr):
    """Read symbol() for a token, on its own chain. None if it cannot be read."""
    rpc = CHAIN_RPC.get(chain)
    if not rpc:
        return None
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": addr, "data": "0x95d89b41"}, "latest"]})
    r = run(["curl", "-s", "--max-time", "15", "-X", "POST", rpc,
             "-H", "content-type: application/json", "-d", body])
    try:
        return decode_abi_string(json.loads(r.stdout).get("result"))
    except Exception:
        return None


def canonical_lookup(word):
    """Resolve a major ticker to its canonical mainnet deployment, chain-verified.

    Fails closed exactly like xlayer_lookup: if the chain does not agree that the
    address carries this symbol, we return nothing and fall through to asking,
    rather than shipping a confident report on an asset nobody asked about.
    """
    hit = CANONICAL_TOKENS.get(norm_sym(word))
    if not hit:
        return None, None
    chain, addr = hit
    onchain = symbol_on_chain(chain, addr)
    if norm_sym(onchain) != norm_sym(word):
        log("  canonical table maps %s to %s on %s but the chain reports %r; not guessing"
            % (word, addr, chain, onchain))
        return None, None
    return addr, chain


def xlayer_lookup(word):
    """Resolve a ticker to a canonical X Layer contract, verified against chain.

    The table is never trusted on its own: symbol() is read from the contract and
    must fold to the ticker that was asked for. A wrong or stale entry therefore
    fails closed — we go back to asking the buyer — rather than producing a
    confident report on the wrong asset, which is this service's worst failure.
    """
    addr = XLAYER_TOKENS.get(norm_sym(word))
    if not addr:
        return None, None
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": addr, "data": "0x95d89b41"}, "latest"]})
    r = run(["curl", "-s", "--max-time", "15", "-X", "POST", XLAYER_RPC,
             "-H", "content-type: application/json", "-d", body])
    try:
        onchain = decode_abi_string(json.loads(r.stdout).get("result"))
    except Exception:
        return None, None
    if norm_sym(onchain) != norm_sym(word):
        log("  xlayer table maps %s to %s but the chain reports %r; not guessing"
            % (word, addr, onchain))
        return None, None
    return addr, "xlayer"


def resolve_token(title):
    """0x address in the title wins; otherwise resolve a symbol via DexScreener.

    Only EVM chains this service supports are eligible: an unfiltered search
    ranks by liquidity across every chain and would resolve PEPE or CAKE to
    their Solana listings, which we cannot analyse.

    Returns (address, chain, alternatives). A non-empty `alternatives` means the
    ticker matched several distinct tokens and the buyer must say which one:
    delivering a confident verdict on the wrong asset is worse than asking.
    """
    m = re.search(r"0x[a-fA-F0-9]{40}", title or "")
    if m:
        return m.group(0), None, []
    words = [w.strip(".,:;!?()[]'\"") for w in (title or "").split()]
    cands = [w for w in words if w and w.lower() not in STOPWORDS and len(w) <= 12]
    # Majors resolve from the canonical table first, before DexScreener gets a
    # say. Its search is not exhaustive: for WBTC it returns only a small Base
    # deployment and omits Ethereum's entirely, and a lone result never trips the
    # dominance check, so the search alone will confidently hand back the wrong
    # chain. A named major means the canonical deployment unless the buyer says
    # otherwise, and they can always say otherwise with an explicit address.
    for w in cands:
        addr, chain = canonical_lookup(w)
        if addr:
            log("  %s resolved to its canonical %s deployment %s" % (w, chain, addr))
            return addr, chain, []
    # Whether DexScreener actually answered. An outage must not be mistaken for
    # "this ticker trades nowhere", or the X Layer fallback below would fire for
    # tickers whose real home is another chain.
    searched_ok = False
    for w in cands:
        r = run(["curl", "-s", "--max-time", "15",
                 "https://api.dexscreener.com/latest/dex/search?q=" + w])
        try:
            pairs = json.loads(r.stdout).get("pairs") or []
        except Exception:
            continue
        searched_ok = True
        # Aggregate per token, not per pool. Comparing single pools ranked a
        # 3M-dollar impostor pool above Uniswap's UNI, whose depth is spread
        # across many pairs, and delivered a report on the wrong asset.
        totals = {}
        for p in pairs:
            base = p.get("baseToken") or {}
            addr = base.get("address") or ""
            chain = (p.get("chainId") or "").lower()
            if chain not in SUPPORTED_CHAINS:
                continue
            if not re.fullmatch(r"0x[a-fA-F0-9]{40}", addr):
                continue
            if (base.get("symbol") or "").lower() != w.lower():
                continue
            key = (chain, addr)
            totals[key] = totals.get(key, 0.0) + float((p.get("liquidity") or {}).get("usd") or 0)
        ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
        ranked = [(k, v) for k, v in ranked if v > 10000]
        if not ranked:
            continue
        (chain, addr), liq = ranked[0]
        # A ticker is not an identifier. Anyone can deploy "UNI"; picking the
        # bigger one and reporting on it with confidence is the worst failure
        # this service can have, so an unclear winner is referred back to the
        # buyer rather than guessed at.
        if len(ranked) > 1 and liq < ranked[1][1] * TICKER_DOMINANCE:
            alts = [{"chain": c, "address": a, "liquidityUsd": int(v)} for (c, a), v in ranked[:4]]
            log("  ticker %s is ambiguous across %d tokens; asking rather than guessing" % (w, len(ranked)))
            return None, None, alts
        return addr, chain, []
    # DexScreener answered and knows nothing that trades under this ticker. That
    # is the normal shape for an X Layer-native asset, so check our own chain
    # before falling back to asking the buyer a question they should not need.
    if searched_ok:
        for w in cands:
            addr, chain = xlayer_lookup(w)
            if addr:
                log("  %s is not on DexScreener; resolved to the canonical"
                    " X Layer contract %s" % (w, addr))
                return addr, chain, []
    return None, None, []


def fetch(addr, chain, fmt, job=None):
    key = open(KEY_FILE).read().strip()
    body = {"tokenAddress": addr, "format": fmt}
    if chain:
        body["chain"] = chain
    cmd = ["curl", "-s", "-X", "POST", ENDPOINT,
           "-H", "x-internal-key: " + key,
           "-H", "content-type: application/json"]
    # Only the copy the buyer actually receives carries the job id, so recovery
    # returns the report that was sent rather than the JSON we fetch first to
    # decide whether there is a report worth sending at all.
    if job:
        cmd += ["-H", "x-job-id: " + job]
    cmd += ["-d", json.dumps(body)]
    return run(cmd, timeout=120).stdout


def has_deliverable(job):
    r = run([ONCHAINOS, "agent", "task-deliverable-list", "--job-id", job, "--role", "asp"])
    return "originalName" in r.stdout


def send_message(job, buyer, text):
    run([OKXA2A, "session", "create", "--job-id", job,
         "--my-agent-id", ASP, "--to-agent-id", str(buyer), "--json"])
    key = "job:%s:my:%s:to:%s" % (job, ASP, buyer)
    r = jrun([OKXA2A, "xmtp-send", "--session-key", key, "--message", text, "--json"])
    return bool(r and r.get("ok"))


# Marks messages this watcher sent, so replies can be told apart from our own
# traffic when we re-read the thread.
ASK_MARKER = "[dossier:need-token]"
OURS = ("DOSSIER REPORT", ASK_MARKER)


def read_buyer_reply(job, buyer):
    """Look for a token the buyer supplied in reply to our question.

    Returns (address, chain) or (None, None). Only messages we did not send are
    considered, so our own question text can never be read back as an answer.
    """
    r = run([OKXA2A, "session", "history", "--job-id", job,
             "--toAgentId", str(buyer), "--limit", "30", "--json"])
    try:
        msgs = json.loads(r.stdout)
    except Exception:
        return None, None
    if not isinstance(msgs, list):
        return None, None
    for m in reversed(msgs):
        raw = m.get("content") or ""
        try:
            text = json.loads(raw).get("content") or ""
        except Exception:
            text = raw
        if any(mark in text for mark in OURS):
            continue
        hit = re.search(r"0x[a-fA-F0-9]{40}", text)
        if hit:
            chain = None
            for c in SUPPORTED_CHAINS:
                if re.search(r"\b%s\b" % c, text, re.I):
                    chain = c
                    break
            return hit.group(0), chain
    return None, None


def ask_for_token(job, buyer, title, alts=None):
    # A buyer whose own x402 replay already succeeded has their report and needs
    # nothing from us; we cannot see that from the ASP side, so the message must
    # say so plainly rather than imply the order failed.
    if alts:
        # Naming the candidates turns "which token?" into a one-word answer, and
        # shows the buyer why a ticker alone was not enough to act on.
        listing = "\n".join(
            "  %s on %s  (liquidity $%s)" % (a["address"], a["chain"], money(a["liquidityUsd"]))
            for a in alts)
        why = ("more than one token trades under that ticker and I will not guess "
               "which one you meant:\n%s\nReply with the contract address you want" % listing)
    else:
        why = ("the token was not visible to me from the job title: reply with the contract "
               "address (0x...)")
    return send_message(job, buyer, (
        "%s Regarding: %s. If you already received your report in the paid response, "
        "this message needs no action — please ignore it. If you have not, it is because "
        "%s and optionally the chain (ethereum, bsc, base, arbitrum, polygon, "
        "xlayer), and the full report will be delivered within two minutes. You can also "
        "fetch it yourself at any time with POST %s and body "
        '{"tokenAddress":"0x..."}.' % (ASK_MARKER, title, why, ENDPOINT)))


def deliver(job, buyer, addr, chain, from_ticker=False):
    raw = fetch(addr, chain, "json")
    try:
        data = json.loads(raw)
    except Exception:
        log("  service did not return JSON; aborting this job")
        return False
    if "riskVerdict" not in data:
        log("  service error:", raw[:160])
        return False

    html = fetch(addr, chain, "html", job)
    sym = (data.get("token") or {}).get("symbol") or "token"
    safe_sym = re.sub(r"[^A-Za-z0-9_-]", "", str(sym)) or "token"
    path = "/tmp/dossier-%s-%s.html" % (safe_sym, job[:10])
    open(path, "w").write(html)

    up = jrun([OKXA2A, "file", "upload", "--file-path", path, "--agent-id", ASP,
               "--job-id", job, "--filename", "dossier-%s.html" % safe_sym,
               "--mime-type", "text/html"], timeout=240) or {}

    v = data["riskVerdict"]
    tok = data.get("token") or {}
    L = []
    L.append("DOSSIER REPORT - %s (%s)" % (sym, tok.get("chain")))
    L.append("")
    # Wording matches the report itself. "safe" is not a claim a 1%-of-deepest-
    # pool rule of thumb supports, and the buyer is holding the document that
    # calls it a heuristic.
    L.append("VERDICT: %s | data coverage %s | heuristic size cap $%s" % (
        str(v.get("verdict")).upper(),
        ("%d%%" % round(float(v.get("confidence") or 0) * 100)),
        money(v.get("maxSizeUsd")) if v.get("maxSizeUsd") is not None else "n/a"))
    L.append("")
    L.append("KEY FINDINGS:")
    for r_ in v.get("reasons", []):
        L.append("  - " + r_)
    L.append("")
    L.append("SNAPSHOT: price $%s | liquidity $%s | 24h volume $%s | holders %s" % (
        fmt_price(tok.get("priceUsd")), money(tok.get("liquidityUsd")),
        money(tok.get("volume24hUsd")),
        money(tok.get("holderCount")) if tok.get("holderCount") else "n/a"))
    L.append("CONTRACT: %s" % addr)
    if from_ticker:
        # The buyer named a ticker, not an address. Say so, so a mismatch is
        # caught by the person who knows which token they meant.
        L.append("  (resolved from the ticker in the job title, by far the deepest"
                 " token trading under it. If you meant a different contract,"
                 " reply with its address and I will re-run this.)")
    L.append("SOURCES: %s" % ", ".join(data.get("sources") or []))
    L.append("")
    if up.get("fileKey"):
        L.append("FULL HTML REPORT (encrypted attachment in this job's file channel):")
        for k in ("fileKey", "digest", "salt", "nonce", "secret", "filename"):
            L.append("  %s %s" % (k, up.get(k)))
        L.append("  retrieve with: okx-a2a file download --file-key <fileKey> "
                 "--agent-id <yourAgentId> --digest <digest> --salt <salt> "
                 "--nonce <nonce> --secret <secret>")
        L.append("")
    # The job id alone no longer recovers a report, because job ids are publicly
    # enumerable and were letting anyone read reports they had not paid for. It
    # now has to be paired with the request itself, which the buyer has: it is
    # printed two lines up in this same message.
    L.append("LOST THIS REPORT? Re-fetch the exact copy sent to you, free:")
    # Quote the request as it was actually sent, not the chain the report went on
    # to resolve. The archive indexes both forms now, but printing a body we
    # never sent was how this command came to return 403 on its own instructions.
    L.append('  POST %s/recovery  body {"jobId":"%s",' % (ENDPOINT, job))
    L.append('    "originalBody":{"tokenAddress":"%s"%s}}' % (
        addr, (',"chain":"%s"' % chain) if chain else ""))
    L.append("")
    # NOTHING HERE MAY ASK A BUYER FOR MONEY.
    #
    # This block used to say "TO CLOSE THIS TASK: re-run your x402 task payment".
    # It was written for one stalled buyer whose replay had failed, but it sat
    # unconditionally in the delivery message, so every buyer received it —
    # including buyers who had already paid successfully. For them the claim was
    # simply false, and an automated message demanding a second payment is
    # indistinguishable from a scam. It earned a 3-star review on 2026-08-02
    # saying exactly that, and it deserved to.
    #
    # The watcher cannot tell from here whether a given buyer's payment settled,
    # so it must not assert anything about their payment state. A stuck task is a
    # small problem; looking like a fraud is not. Anyone genuinely stuck is
    # handled case by case, by a human, off this path.
    L.append("You owe nothing further for this report. This message never asks")
    L.append("for payment.")
    L.append("")
    L.append("Endpoint, if you want the document outside the task: POST %s" % ENDPOINT)

    ok = send_message(job, buyer, "\n".join(L))
    run([ONCHAINOS, "agent", "task-deliverable-save", "--job-id", job, "--role", "asp",
         "--file", path, "--title", "Due-diligence dossier: %s" % sym,
         "--short-id", job[:6] + "-" + job[-4:]])
    log("  delivered %s verdict=%s message_ok=%s" % (sym, v.get("verdict"), ok))
    return ok


def main():
    state = load_state()
    data = jrun([ONCHAINOS, "agent", "active-tasks"])
    if not data or not data.get("ok"):
        log("could not list tasks; will retry next tick")
        return
    tasks = (data.get("data") or {}).get("tasks") or []
    # "complete" means the buyer released funds, which only happens after they
    # have what they paid for — never chase those. Only "accepted" jobs, where
    # we cannot see whether the buyer's own replay succeeded, are candidates.
    #
    # And "cannot see" is the whole problem. An accepted job with no recorded
    # deliverable was read as a buyer in trouble; it is nothing of the sort. On
    # an x402 task the buyer replays the endpoint, receives the report inline,
    # and no deliverable is ever recorded against the task. That is the normal
    # resting state, confirmed by a buyer on 2026-08-03, so the condition matches
    # correctly-served buyers just as readily as stranded ones. Delivery is now
    # gated on the buyer having asked us, further down.
    todo = [t for t in tasks
            if str(t.get("myAgentId")) == ASP
            and t.get("myRole") == "asp"
            and t.get("status") == "accepted"]
    log("tasks=%d candidates=%d" % (len(tasks), len(todo)))
    for t in todo:
        job = t["jobId"]
        st = state.get(job, {})
        if st.get("done"):
            continue
        if has_deliverable(job):
            state[job] = {"done": True, "why": "already had deliverable"}
            save_state(state)
            continue

        buyer = t.get("counterpartyAgentId")
        title = t.get("title") or ""
        addr, chain, alts = resolve_token(title)
        # Whether this address is something the buyer handed us, or something we
        # worked out on their behalf. Only the first justifies sending anything.
        from_buyer = False

        # If the title was unusable we asked the buyer; a job is never closed on
        # the question alone, so their answer is picked up on a later tick.
        if not addr and st.get("asked"):
            addr, chain = read_buyer_reply(job, buyer)
            if addr:
                from_buyer = True
                log("  buyer supplied token", addr[:12], "chain", chain)

        if not addr:
            # Give the buyer's own x402 replay time to land before asking for
            # anything: a served buyer needs no message from us, and an
            # unnecessary "I could not identify the token" reads as a failure.
            first_seen = st.get("first_seen")
            if not first_seen:
                state[job] = {**st, "first_seen": time.time()}
                save_state(state)
                log("  no token in title; holding %ds for the buyer's own replay" % ASK_GRACE_SECONDS)
                continue
            if time.time() - first_seen < ASK_GRACE_SECONDS:
                continue
            if st.get("asked"):
                # Nudge on an interval rather than every tick.
                if time.time() - st.get("asked_at", 0) > REASK_SECONDS:
                    ask_for_token(job, buyer, title, alts)
                    state[job] = {**st, "asked": True, "asked_at": time.time()}
                    save_state(state)
                continue
            log("fulfilling", job[:12],
                "| ambiguous ticker, asking buyer" if alts else "| no token in title, asking buyer")
            if ask_for_token(job, buyer, title, alts):
                state[job] = {**st, "asked": True, "asked_at": time.time()}
                save_state(state)
            continue

        # We can resolve this title, but nobody asked us to. Pushing it anyway is
        # what produced an unrequested Base WBTC report in a buyer's channel 34
        # seconds before their own correct paid report arrived, and with it a
        # 1-star review. Ten such pushes exist in the archive; exactly one of them
        # was a buyer who actually needed rescuing, and that buyer had asked.
        #
        # A buyer whose paid call fails is not stranded by this. The endpoint
        # answers that same request with a 400 naming the missing field and two
        # worked examples, which reaches their automation at the moment of
        # failure. That is a better rescue channel than an unsolicited push,
        # which arrives with no context and cannot be told apart from a scam.
        if not from_buyer:
            log("  resolved from the title, but the buyer never asked; not sending")
            state[job] = {"done": True, "why": "not requested by the buyer"}
            save_state(state)
            continue

        log("fulfilling", job[:12], "|", title)
        try:
            # Re-check immediately before sending: another path (an AI session)
            # may have delivered since the top of this loop.
            if has_deliverable(job):
                state[job] = {"done": True, "why": "delivered by another path"}
                save_state(state)
                continue
            ok = deliver(job, buyer, addr, chain, from_ticker=not re.search(r'0x[a-fA-F0-9]{40}', title or ''))
        except Exception as e:
            log("  error:", repr(e)[:200])
            ok = False
        if ok:
            state[job] = {"done": True, "at": time.time()}
            save_state(state)


if __name__ == "__main__":
    main()
