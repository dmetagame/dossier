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
ASK_GRACE_SECONDS = 900
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
    for w in cands:
        r = run(["curl", "-s", "--max-time", "15",
                 "https://api.dexscreener.com/latest/dex/search?q=" + w])
        try:
            pairs = json.loads(r.stdout).get("pairs") or []
        except Exception:
            continue
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
    L.append("VERDICT: %s | confidence %s | safe position size up to $%s" % (
        str(v.get("verdict")).upper(), v.get("confidence"),
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
    L.append("LOST THIS REPORT? Re-fetch the exact copy sent to you, free:")
    L.append('  POST %s/recovery  body {"jobId":"%s"}' % (ENDPOINT, job))
    L.append("")
    L.append("OR fetch it yourself (x402 replay):")
    L.append('  POST %s  body {"tokenAddress":"%s"%s}' % (
        ENDPOINT, addr, (',"chain":"%s"' % tok.get("chain")) if tok.get("chain") else ""))

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

        # If the title was unusable we asked the buyer; a job is never closed on
        # the question alone, so their answer is picked up on a later tick.
        if not addr and st.get("asked"):
            addr, chain = read_buyer_reply(job, buyer)
            if addr:
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
                # Re-ask at most once a day rather than every two minutes.
                if time.time() - st.get("asked_at", 0) > 86400:
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
