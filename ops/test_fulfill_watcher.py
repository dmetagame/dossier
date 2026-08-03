"""Regression tests for the fulfilment watcher.

This file exists because every production incident this service has had came from
here, and none of them could have been caught: 593 lines that choose which asset
to report on and talk directly to buyers, with no tests at all.

Two of those incidents are pinned below as named cases:

  * 2026-08-02, wrong chain. A buyer asked for WBTC and got Base WBTC. DexScreener's
    search returns exactly one WBTC candidate above our liquidity floor, a small
    Base deployment, and omits Ethereum's entirely. TICKER_DOMINANCE only compares
    candidates with each other, so a lone result never tripped it.
  * 2026-08-02, payment demand. The delivery message told every buyer to "re-run
    your x402 task payment", including buyers whose payment had already settled.

Everything runs offline. The watcher reaches the outside world through exactly one
function, `run()`, so stubbing that gives deterministic tests with no network and
nothing to flake in CI.

    python3 -m unittest discover -s ops -p 'test_*.py'
"""

import importlib.util
import json
import os
import tempfile
import time
import types
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "fw", os.path.join(os.path.dirname(os.path.abspath(__file__)), "fulfill-watcher.py")
)
fw = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(fw)


def abi_string(s):
    """Encode a string the way a solidity `symbol()` returns one."""
    raw = s.encode("utf-8")
    return (
        "0x"
        + format(32, "064x")
        + format(len(raw), "064x")
        + raw.hex().ljust(64, "0")
    )


def rpc_reply(symbol):
    return types.SimpleNamespace(stdout=json.dumps({"result": abi_string(symbol)}), returncode=0)


def dex_reply(pairs):
    return types.SimpleNamespace(stdout=json.dumps({"pairs": pairs}), returncode=0)


def pair(chain, addr, symbol, liq):
    return {
        "chainId": chain,
        "baseToken": {"address": addr, "symbol": symbol},
        "liquidity": {"usd": liq},
    }


class StubbedRun:
    """Routes the watcher's only outbound call to canned answers.

    Anything not explicitly answered raises, so a test cannot pass by silently
    reaching a network the CI runner may or may not have.
    """

    def __init__(self, dex=None, symbols=None):
        self.dex = dex if dex is not None else []
        self.symbols = symbols or {}
        self.calls = []

    def __call__(self, cmd, timeout=180):
        joined = " ".join(str(c) for c in cmd)
        self.calls.append(joined)
        if "dexscreener" in joined:
            return dex_reply(self.dex)
        if "eth_call" in joined:
            to = json.loads(cmd[cmd.index("-d") + 1])["params"][0]["to"].lower()
            if to in self.symbols:
                return rpc_reply(self.symbols[to])
            return types.SimpleNamespace(stdout=json.dumps({"result": "0x"}), returncode=0)
        raise AssertionError("unstubbed outbound call: " + joined[:120])


class Harness(unittest.TestCase):
    def setUp(self):
        self._run = fw.run
        self.addCleanup(lambda: setattr(fw, "run", self._run))

    def stub(self, **kw):
        s = StubbedRun(**kw)
        fw.run = s
        return s


WBTC_ETH = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"
WBTC_BASE = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c"
USDT0_XL = "0x779ded0c9e1022225f8e0630b35a9b54be713736"


class TestTokenResolution(Harness):
    def test_wbtc_resolves_to_ethereum_not_base(self):
        """The 2026-08-02 wrong-chain incident, pinned.

        DexScreener offers only the Base deployment. Before the canonical table
        that was delivered as the answer, because a single candidate never
        reaches the dominance comparison.
        """
        self.stub(
            dex=[pair("base", WBTC_BASE, "WBTC", 627_630)],
            symbols={WBTC_ETH.lower(): "WBTC"},
        )
        addr, chain, alts = fw.resolve_token("WBTC due-diligence report")
        self.assertEqual(addr.lower(), WBTC_ETH.lower())
        self.assertEqual(chain, "ethereum")
        self.assertEqual(alts, [])

    def test_canonical_table_is_verified_against_the_chain(self):
        """A wrong row must fail closed, not ship a confident wrong report."""
        self.stub(symbols={WBTC_ETH.lower(): "LINK"})  # chain disagrees
        addr, chain = fw.canonical_lookup("WBTC")
        self.assertIsNone(addr)
        self.assertIsNone(chain)

    def test_explicit_address_in_the_title_always_wins(self):
        self.stub()
        addr, chain, _ = fw.resolve_token("Report on 0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82")
        self.assertEqual(addr, "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82")

    def test_an_ambiguous_ticker_asks_rather_than_guesses(self):
        """Two comparable deployments must produce a question, not a coin flip."""
        s = self.stub(dex=[
            pair("ethereum", "0x" + "1" * 40, "MOON", 4_000_000),
            pair("bsc", "0x" + "2" * 40, "MOON", 3_000_000),
        ])
        addr, chain, alts = fw.resolve_token("Due-diligence on MOON")
        self.assertIsNone(addr)
        self.assertGreaterEqual(len(alts), 2)

    def test_a_dominant_deployment_resolves_without_asking(self):
        self.stub(dex=[
            pair("ethereum", "0x" + "1" * 40, "MOON", 40_000_000),
            pair("bsc", "0x" + "2" * 40, "MOON", 100_000),
        ])
        addr, chain, alts = fw.resolve_token("Due-diligence on MOON")
        self.assertEqual(chain, "ethereum")
        self.assertEqual(alts, [])

    def test_dust_liquidity_is_not_a_candidate(self):
        self.stub(dex=[pair("bsc", "0x" + "3" * 40, "MOON", 500)])
        addr, _, alts = fw.resolve_token("Due-diligence on MOON")
        self.assertIsNone(addr)
        self.assertEqual(alts, [])

    def test_xlayer_fallback_only_after_a_successful_search(self):
        """An outage must never be read as 'this ticker trades nowhere'.

        If it were, a DexScreener failure would resolve tickers to X Layer
        contracts for buyers who meant another chain entirely.
        """
        self.stub(dex=[], symbols={USDT0_XL: "USD₮0"})
        addr, chain, _ = fw.resolve_token("Due-diligence report on USDT0")
        self.assertEqual(addr, USDT0_XL)
        self.assertEqual(chain, "xlayer")

        def dead(cmd, timeout=180):
            if "dexscreener" in " ".join(str(c) for c in cmd):
                return types.SimpleNamespace(stdout="", returncode=7)
            return rpc_reply("USD₮0")

        fw.run = dead
        addr, _, _ = fw.resolve_token("Due-diligence report on USDT0")
        self.assertIsNone(addr, "a search outage must not resolve to X Layer")

    def test_unresolvable_ticker_resolves_to_nothing(self):
        self.stub(dex=[])
        addr, _, alts = fw.resolve_token("Due-diligence on a nonexistent")
        self.assertIsNone(addr)
        self.assertEqual(alts, [])


class TestSymbolFolding(unittest.TestCase):
    def test_unicode_ticker_folds_to_its_ascii_spelling(self):
        self.assertEqual(fw.norm_sym("USD₮0"), fw.norm_sym("usdt0"))
        self.assertEqual(fw.norm_sym("USD₮0"), "usdt0")

    def test_decodes_both_string_shapes_a_token_may_return(self):
        self.assertEqual(fw.decode_abi_string(abi_string("WBTC")), "WBTC")
        b32 = "0x" + b"DAI".hex().ljust(64, "0")  # older tokens return bytes32
        self.assertEqual(fw.decode_abi_string(b32), "DAI")

    def test_malformed_returns_decode_to_nothing_rather_than_throwing(self):
        for bad in (None, "", "0x", "0xnothex", "0x" + "f" * 10):
            self.assertIsNone(fw.decode_abi_string(bad), repr(bad))


class TestBuyerFacingMessage(Harness):
    """The delivery text a buyer actually receives.

    The 2026-08-02 payment-demand incident lived here, in text that shipped to
    everyone while being true for almost nobody.
    """

    def deliver_and_capture(self):
        sent = {}
        report = {
            "riskVerdict": {
                "verdict": "caution",
                "confidence": 0.4,
                "maxSizeUsd": 1234,
                "reasons": ["Contract control risk: upgradeable proxy."],
            },
            "token": {"symbol": "WBTC", "chain": "ethereum", "priceUsd": 1.0},
            "sources": ["GoPlus", "ethereum RPC"],
        }
        fw.fetch = lambda a, c, fmt, job=None: (
            json.dumps(report) if fmt == "json" else "<html>report</html>"
        )
        fw.jrun = lambda cmd, timeout=180: {}
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(stdout="", returncode=0)

        def capture(job, buyer, text):
            sent["text"] = text
            return True

        fw.send_message = capture
        for name in ("fetch", "jrun", "send_message"):
            self.addCleanup(lambda n=name, v=getattr(fw, name): setattr(fw, n, v))

        tmp = tempfile.mkdtemp()
        cwd = os.getcwd()
        os.chdir(tmp)
        self.addCleanup(os.chdir, cwd)
        fw.deliver("0x" + "a" * 64, "4844", WBTC_ETH, "ethereum")
        return sent["text"]

    def test_never_asks_the_buyer_for_money(self):
        text = self.deliver_and_capture().lower()
        for phrase in (
            "re-run your x402 task payment",
            "re-run the task payment",
            "pay again",
            "second payment",
            "send payment",
        ):
            self.assertNotIn(phrase, text, "a delivery message must never demand payment")

    def test_says_plainly_that_nothing_is_owed(self):
        self.assertIn("owe nothing further", self.deliver_and_capture().lower())

    def test_recovery_instructions_carry_the_second_factor(self):
        """A bare job id stopped being proof of purchase on 2026-08-02.

        If this message still told buyers to recover with the job id alone, it
        would be handing them a call that now returns 400.
        """
        text = self.deliver_and_capture()
        self.assertIn("/recovery", text)
        self.assertIn("originalBody", text)
        self.assertIn(WBTC_ETH, text)

    def test_states_the_verdict_and_the_contract_it_applies_to(self):
        text = self.deliver_and_capture()
        self.assertIn("CAUTION", text)
        self.assertIn(WBTC_ETH, text)


class TestAskTiming(unittest.TestCase):
    """Grace before asking, then a nudge interval, driven with a controlled clock."""

    def setUp(self):
        self.state = os.path.join(tempfile.mkdtemp(), "state.json")
        self._state_file, fw.STATE_FILE = fw.STATE_FILE, self.state
        self._saved = {n: getattr(fw, n) for n in
                       ("jrun", "has_deliverable", "resolve_token", "read_buyer_reply", "ask_for_token")}
        self.asks = []
        fw.jrun = lambda cmd, timeout=180: {"ok": True, "data": {"tasks": [{
            "jobId": "0xtest", "myAgentId": "7012", "myRole": "asp", "status": "accepted",
            "counterpartyAgentId": "4844", "title": "Quick due-diligence check"}]}}
        fw.has_deliverable = lambda job: False
        fw.resolve_token = lambda title: (None, None, [])
        fw.read_buyer_reply = lambda job, buyer: (None, None)
        fw.ask_for_token = lambda job, buyer, title, alts=None: (self.asks.append(time.time()) or True)

    def tearDown(self):
        fw.STATE_FILE = self._state_file
        for n, v in self._saved.items():
            setattr(fw, n, v)

    def age(self, seconds):
        s = json.load(open(self.state))
        s["0xtest"]["first_seen"] = time.time() - seconds
        json.dump(s, open(self.state, "w"))

    def test_holds_then_asks_once_then_nudges_on_an_interval(self):
        fw.main()
        self.assertEqual(len(self.asks), 0, "a freshly seen job is held, not asked")

        self.age(fw.ASK_GRACE_SECONDS - 30)
        fw.main()
        self.assertEqual(len(self.asks), 0, "still inside the grace window")

        self.age(fw.ASK_GRACE_SECONDS + 10)
        fw.main()
        self.assertEqual(len(self.asks), 1, "asks once past the grace window")

        fw.main()
        self.assertEqual(len(self.asks), 1, "does not re-ask every tick")

        s = json.load(open(self.state))
        s["0xtest"]["asked_at"] = time.time() - (fw.REASK_SECONDS + 60)
        json.dump(s, open(self.state, "w"))
        fw.main()
        self.assertEqual(len(self.asks), 2, "nudges once the interval has passed")

    def test_a_job_already_delivered_is_never_chased(self):
        fw.has_deliverable = lambda job: True
        self.age(fw.ASK_GRACE_SECONDS + 10) if os.path.exists(self.state) else None
        fw.main()
        self.assertEqual(len(self.asks), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
