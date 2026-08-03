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
import shutil
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


def scratch(case):
    """A temporary directory that is removed when the test ends.

    Five setUps called mkdtemp and none of them cleaned up, so every run left
    directories behind. On a box that has already had a full /tmp take out every
    shell command, a test suite that leaks on each run is not a cosmetic problem.
    """
    d = tempfile.mkdtemp(prefix="fw-test-")
    case.addCleanup(shutil.rmtree, d, True)
    return d


def read_json(path):
    """Read JSON without leaking the handle.

    `json.load(open(p))` leaves the file open until the garbage collector gets
    to it. Harmless in a short test run, and exactly the habit that later shows
    up in the watcher itself, which runs as a long-lived timer.
    """
    with open(path) as fh:
        return json.load(fh)


def write_json(path, obj):
    with open(path, "w") as fh:
        json.dump(obj, fh)


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


class TestSendsWhatTheServiceWrote(Harness):
    """The watcher pastes the delivery text; it no longer composes it.

    It used to build the buyer's message itself, and so did the AI session on
    the other fulfilment path, from the same JSON. Two authors, one buyer, and
    no way to tell which text a given buyer received. On 2026-08-03 the AI's
    version told a buyer "safe position size ~ $78,345" for a token the next
    line flagged as mintable with an unrenounced owner; the watcher's version
    said "heuristic size cap", which is what the report says.

    The words now live in src/dossier/message.ts and are asserted in
    test/delivery-message.test.ts, next to the code that writes them. What is
    left to test here is that the watcher changes nothing but the one line it
    is supposed to change.
    """

    SERVICE_TEXT = (
        "DOSSIER REPORT - UNI (ethereum)\n\nVERDICT: CAUTION | heuristic size cap $78,345\n\n"
        "ATTACHMENT_BLOCK\n\nYou owe nothing further for this report."
    )

    def deliver_and_capture(self, upload=None):
        sent = {}
        report = {
            "riskVerdict": {"verdict": "caution", "confidence": 0.4,
                            "maxSizeUsd": 78345, "reasons": ["Contract control risk."]},
            "token": {"symbol": "UNI", "chain": "ethereum", "priceUsd": 3.93},
            "sources": ["GoPlus"],
        }
        fw.fetch = lambda a, c, fmt, job=None: {
            "ok": True, "why": None, "status": 200, "recoveryCode": "deadbeef" * 4,
            "body": (json.dumps(report) if fmt == "json"
                     else self.SERVICE_TEXT if fmt == "message"
                     else "<html><body>report for %s</body></html>" % a),
        }
        fw.send_message = lambda job, buyer, text: (sent.__setitem__("text", text) or True)
        fw.jrun = lambda cmd, timeout=180: (
            upload if upload is not None else {"fileKey": "fk", "digest": "d", "salt": "s",
                                              "nonce": "n", "secret": "x", "filename": "f.html"})
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(
            stdout="", stderr="", returncode=0, failure=None)
        fw.deliver("0x" + "a" * 64, "4844", WBTC_ETH, "ethereum")
        return sent.get("text", "")

    def setUp(self):
        super().setUp()
        self._saved = {n: getattr(fw, n) for n in ("fetch", "jrun", "send_message")}
        self.addCleanup(lambda: [setattr(fw, n, v) for n, v in self._saved.items()])

    def test_every_line_the_service_wrote_survives_verbatim(self):
        text = self.deliver_and_capture()
        for line in self.SERVICE_TEXT.split("\n"):
            if line and line != "ATTACHMENT_BLOCK":
                self.assertIn(line, text, "the watcher must not rewrite %r" % line)

    def test_the_attachment_block_is_the_only_substitution(self):
        text = self.deliver_and_capture()
        self.assertNotIn("ATTACHMENT_BLOCK", text, "the marker must be replaced")
        self.assertIn("fileKey fk", text)
        self.assertIn("secret x", text)

    def test_a_failed_upload_says_so_rather_than_printing_a_dead_marker(self):
        text = self.deliver_and_capture(upload={})
        self.assertNotIn("ATTACHMENT_BLOCK", text)
        self.assertIn("could not be uploaded", text)
        # And the analysis still reaches the buyer, which is the point of
        # sending at all.
        self.assertIn("VERDICT: CAUTION", text)

    def test_an_empty_body_with_a_200_means_no_message(self):
        """The case a status check alone does not catch.

        A proxy, a truncated response or a bad deploy can return 200 with
        nothing in it. The status says the call succeeded, so only the emptiness
        of the text itself can stop a blank message reaching the buyer, or worse
        a locally invented one.
        """
        report = {"riskVerdict": {"verdict": "caution", "reasons": []},
                  "token": {"symbol": "UNI", "chain": "ethereum"}, "sources": []}
        fw.fetch = lambda a, c, fmt, job=None: (
            {"ok": True, "why": None, "status": 200, "body": json.dumps(report)}
            if fmt == "json" else
            {"ok": True, "why": None, "status": 200,
             "body": "<html><body>report for %s</body></html>" % a}
            if fmt == "html" else
            {"ok": True, "why": None, "status": 200, "body": "", "recoveryCode": None})
        sent = []
        fw.send_message = lambda job, buyer, text: (sent.append(text) or True)
        fw.jrun = lambda cmd, timeout=180: {"fileKey": "fk"}
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(
            stdout="", stderr="", returncode=0, failure=None)
        res = fw.deliver("0x" + "a" * 64, "4844", WBTC_ETH, "ethereum")
        self.assertEqual(res, fw.NOTHING_SENT)
        self.assertEqual(sent, [], "no text means nothing is sent, not something invented")


class TestAskTiming(unittest.TestCase):
    """Grace before asking, then a nudge interval, driven with a controlled clock."""

    def setUp(self):
        self.state = os.path.join(scratch(self), "state.json")
        self._state_file, fw.STATE_FILE = fw.STATE_FILE, self.state
        self._saved = {n: getattr(fw, n) for n in
                       ("jrun", "has_deliverable", "resolve_token", "read_buyer_reply", "ask_for_token")}
        self.asks = []
        fw.jrun = lambda cmd, timeout=180: {"ok": True, "data": {"tasks": [{
            "jobId": "0xtest", "myAgentId": "7012", "myRole": "asp", "status": "accepted",
            "counterpartyAgentId": "4844", "title": "Quick due-diligence check"}]}}
        fw.has_deliverable = lambda job: False
        fw.resolve_token = lambda title: (None, None, [])
        fw.read_buyer_reply = lambda job, buyer, asked_at=0: (None, None)
        fw.ask_for_token = lambda job, buyer, title, alts=None: (self.asks.append(time.time()) or True)

    def tearDown(self):
        fw.STATE_FILE = self._state_file
        for n, v in self._saved.items():
            setattr(fw, n, v)

    def age(self, seconds):
        s = read_json(self.state)
        s["0xtest"]["first_seen"] = time.time() - seconds
        write_json(self.state, s)

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

        s = read_json(self.state)
        s["0xtest"]["asked_at"] = time.time() - (fw.REASK_SECONDS + 60)
        write_json(self.state, s)
        fw.main()
        self.assertEqual(len(self.asks), 2, "nudges once the interval has passed")

    def test_a_job_already_delivered_is_never_chased(self):
        fw.has_deliverable = lambda job: True
        self.age(fw.ASK_GRACE_SECONDS + 10) if os.path.exists(self.state) else None
        fw.main()
        self.assertEqual(len(self.asks), 0)


class TestOnlyDeliversWhatWasAsked(unittest.TestCase):
    """An accepted job with no recorded deliverable is not a buyer in trouble.

    On an x402 task the buyer replays the endpoint, gets the report inline, and
    nothing is ever recorded against the task. That is the resting state, so the
    old trigger fired on correctly-served buyers: one such push landed an
    unrequested Base WBTC report in a buyer's channel 34 seconds before their own
    correct report, and earned a 1-star review. Delivery now requires that the
    buyer asked.
    """

    def setUp(self):
        self.state = os.path.join(scratch(self), "state.json")
        self._state_file, fw.STATE_FILE = fw.STATE_FILE, self.state
        self._saved = {n: getattr(fw, n) for n in
                       ("jrun", "has_deliverable", "resolve_token", "read_buyer_reply",
                        "ask_for_token", "deliver")}
        self.delivered = []
        fw.jrun = lambda cmd, timeout=180: {"ok": True, "data": {"tasks": [{
            "jobId": "0xjob", "myAgentId": "7012", "myRole": "asp", "status": "accepted",
            "counterpartyAgentId": "4844", "title": "WBTC due-diligence report"}]}}
        fw.has_deliverable = lambda job: False
        fw.ask_for_token = lambda job, buyer, title, alts=None: True
        fw.deliver = lambda job, buyer, addr, chain, from_ticker=False, already_messaged=False: (
            self.delivered.append((job, addr, chain))
            or {"uploaded": True, "messaged": True, "recorded": True})

    def tearDown(self):
        fw.STATE_FILE = self._state_file
        for n, v in self._saved.items():
            setattr(fw, n, v)

    def test_a_title_we_can_resolve_is_never_pushed(self):
        """The regression that caused the incident."""
        fw.resolve_token = lambda title: (WBTC_ETH, "ethereum", [])
        fw.read_buyer_reply = lambda job, buyer, asked_at=0: (None, None)
        fw.main()
        self.assertEqual(self.delivered, [], "a report nobody asked for must not be sent")
        self.assertTrue(read_json(self.state)["0xjob"]["done"],
                        "and the job should not be reconsidered every tick")

    def test_a_token_the_buyer_supplied_is_delivered(self):
        """The flow that genuinely rescued a stalled buyer must survive."""
        fw.resolve_token = lambda title: (None, None, [])
        fw.read_buyer_reply = lambda job, buyer, asked_at=0: (WBTC_ETH, "ethereum")
        write_json(self.state, {"0xjob": {"asked": True, "asked_at": time.time(),
                             "first_seen": time.time() - 10_000}})
        fw.main()
        self.assertEqual(len(self.delivered), 1, "an answered question must still be fulfilled")
        self.assertEqual(self.delivered[0][1], WBTC_ETH)

    def test_an_unanswered_question_delivers_nothing(self):
        fw.resolve_token = lambda title: (None, None, [])
        fw.read_buyer_reply = lambda job, buyer, asked_at=0: (None, None)
        write_json(self.state, {"0xjob": {"asked": True, "asked_at": time.time(),
                             "first_seen": time.time() - 10_000}})
        fw.main()
        self.assertEqual(self.delivered, [])


class TestNeverUploadsSomethingElse(unittest.TestCase):
    """An error page must not reach a buyer as their paid report.

    fetch() returned only stdout, so a transient 404, 503, payment error or JSON
    error body was written to disk and uploaded as dossier-*.html. The JSON
    pre-check did not protect it: the HTML is a second, independent request and
    can observe a different upstream state.
    """

    def setUp(self):
        self._saved = {n: getattr(fw, n) for n in ("fetch", "jrun", "run", "send_message")}
        self.sent = []
        self.uploaded = []
        fw.jrun = lambda cmd, timeout=180: (self.uploaded.append(cmd) or {})
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(stdout="", returncode=0, failure=None)
        fw.send_message = lambda job, buyer, text: (self.sent.append(text) or True)

    def tearDown(self):
        for n, v in self._saved.items():
            setattr(fw, n, v)

    REPORT = {
        "riskVerdict": {"verdict": "caution", "confidence": 0.5, "maxSizeUsd": 1, "reasons": []},
        "token": {"symbol": "WBTC", "chain": "ethereum"},
        "sources": ["GoPlus"],
    }

    def _deliver(self, html_result):
        fw.fetch = lambda a, c, fmt, job=None: (
            {"ok": True, "why": None, "status": 200, "body": json.dumps(self.REPORT)}
            if fmt == "json" else html_result
        )
        return fw.deliver("0x" + "a" * 64, "4844", WBTC_ETH, "ethereum")

    def test_a_failed_html_request_uploads_nothing(self):
        # The body here would pass every other check: it is HTML and it names the
        # token. Only the status makes it unusable, which is the point — a proxy
        # or cache can return a plausible-looking page with a 5xx, and the status
        # is the only thing that says so.
        plausible = "<html><body>report for %s</body></html>" % WBTC_ETH
        ok = self._deliver({"ok": False, "why": "http:503", "status": 503, "body": plausible})
        self.assertEqual(ok, fw.NOTHING_SENT)
        self.assertEqual(self.uploaded, [], "nothing may be uploaded when the report never arrived")
        self.assertEqual(self.sent, [], "and the buyer must not be told it was")

    def test_an_error_page_returned_with_200_is_refused(self):
        ok = self._deliver({"ok": True, "why": None, "status": 200,
                            "body": '{"error":"payment layer temporarily unavailable"}'})
        self.assertEqual(ok, fw.NOTHING_SENT)
        self.assertEqual(self.uploaded, [])

    def test_a_report_about_a_different_token_is_refused(self):
        other = "<html><body>report for 0x" + "b" * 40 + "</body></html>"
        ok = self._deliver({"ok": True, "why": None, "status": 200, "body": other})
        self.assertEqual(ok, fw.NOTHING_SENT)
        self.assertEqual(self.uploaded, [])

    def test_a_real_report_is_delivered(self):
        good = "<html><body>report for %s</body></html>" % WBTC_ETH
        ok = self._deliver({"ok": True, "why": None, "status": 200, "body": good})
        self.assertEqual(ok, {"uploaded": False, "messaged": True, "recorded": True})
        self.assertEqual(len(self.uploaded), 1)

    def test_the_temporary_file_does_not_survive(self):
        good = "<html><body>report for %s</body></html>" % WBTC_ETH
        paths = []
        fw.jrun = lambda cmd, timeout=180: (paths.append(cmd[cmd.index("--file-path") + 1]) or {})
        self._deliver({"ok": True, "why": None, "status": 200, "body": good})
        self.assertEqual(len(paths), 1)
        self.assertFalse(os.path.exists(paths[0]), "the report must not be left on disk")
        # The old path was /tmp/dossier-<symbol>-<first 10 of job>.html: a file
        # sitting directly in a shared directory under a name anyone could work
        # out, and therefore pre-create as a symlink. What matters is that it now
        # lives inside a private directory nobody can predict, not the prefix.
        parent = os.path.dirname(paths[0])
        self.assertNotEqual(parent, tempfile.gettempdir(),
                            "the report must not sit directly in the shared temp directory")
        self.assertFalse(os.path.exists(parent), "the private directory must be removed too")
        self.assertNotIn(WBTC_ETH[:10], paths[0], "the name must not be derived from the job")


class TestNotKnowingIsNotNo(unittest.TestCase):
    """has_deliverable read a substring of stdout, so an auth failure, a timeout
    or a schema change all read as "no deliverable" and the watcher acted on it.
    """

    def setUp(self):
        self._run = fw.run
        self.addCleanup(lambda: setattr(fw, "run", self._run))

    def test_a_failed_lookup_is_unknown_not_absent(self):
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(
            stdout="", returncode=1, failure="exit:1")
        self.assertIsNone(fw.has_deliverable("0xjob"))

    def test_unreadable_output_is_unknown(self):
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(
            stdout="not json at all", returncode=0, failure=None)
        self.assertIsNone(fw.has_deliverable("0xjob"))

    def test_an_empty_list_really_is_absent(self):
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(
            stdout=json.dumps({"ok": True, "data": {"deliverables": []}}), returncode=0, failure=None)
        self.assertIs(fw.has_deliverable("0xjob"), False)

    def test_a_populated_list_is_present(self):
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(
            stdout=json.dumps({"ok": True, "data": {"deliverables": [{"originalName": "r.html"}]}}),
            returncode=0, failure=None)
        self.assertIs(fw.has_deliverable("0xjob"), True)


class TestStateFailsClosed(unittest.TestCase):
    """A corrupt state file made the watcher forget every done, asked and
    first_seen record at once, silently, and re-ask every open job."""

    def setUp(self):
        self.d = scratch(self)
        self._sf, fw.STATE_FILE = fw.STATE_FILE, os.path.join(self.d, "state.json")
        self.addCleanup(lambda: setattr(fw, "STATE_FILE", self._sf))

    def test_a_missing_file_is_a_fresh_start(self):
        self.assertEqual(fw.load_state(), {})

    def test_a_corrupt_file_refuses_rather_than_forgetting(self):
        with open(fw.STATE_FILE, "w") as fh:
            fh.write("{not json")
        with self.assertRaises(fw.StateUnreadable):
            fw.load_state()

    def test_the_wrong_shape_is_also_refused(self):
        with open(fw.STATE_FILE, "w") as fh:
            fh.write("[]")
        with self.assertRaises(fw.StateUnreadable):
            fw.load_state()

    def test_a_round_trip_survives(self):
        fw.save_state({"0xjob": {"done": True}})
        self.assertEqual(fw.load_state(), {"0xjob": {"done": True}})


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestChainQualifiersAreObeyed(Harness):
    """"WBTC on Base" resolved to Ethereum.

    The buyer named the chain in the only field they get, and every stage of
    resolution ignored it: the canonical table answered on the ticker alone, the
    DexScreener search ranked across all chains, and an explicit address was
    handed on with chain=None for the service to auto-detect.
    """

    def test_a_named_chain_beats_the_canonical_table(self):
        self.stub(
            dex=[pair("base", WBTC_BASE, "WBTC", 627_630),
                 pair("ethereum", WBTC_ETH, "WBTC", 900_000_000)],
            symbols={WBTC_ETH.lower(): "WBTC"},
        )
        addr, chain, alts = fw.resolve_token("WBTC on Base due-diligence report")
        self.assertEqual(addr.lower(), WBTC_BASE.lower())
        self.assertEqual(chain, "base")

    def test_without_a_qualifier_the_canonical_deployment_still_wins(self):
        """The wrong-chain fix must not be undone by the qualifier support."""
        self.stub(
            dex=[pair("base", WBTC_BASE, "WBTC", 627_630)],
            symbols={WBTC_ETH.lower(): "WBTC"},
        )
        addr, chain, _ = fw.resolve_token("WBTC due-diligence report")
        self.assertEqual(addr.lower(), WBTC_ETH.lower())
        self.assertEqual(chain, "ethereum")

    def test_a_named_chain_is_carried_with_an_explicit_address(self):
        addr, chain, _ = fw.resolve_token("please analyse %s on arbitrum" % WBTC_ETH)
        self.assertEqual(addr, WBTC_ETH)
        self.assertEqual(chain, "arbitrum",
                         "an address the buyer qualified must not be re-detected")

    def test_the_xlayer_fallback_does_not_fire_for_another_chain(self):
        """The fallback exists for tickers DexScreener has never heard of.

        A buyer who says "on base" has told us where to look; answering with an
        X Layer contract is the same wrong-asset failure in a new place.
        """
        self.stub(dex=[])
        addr, chain, _ = fw.resolve_token("OKB on base")
        self.assertIsNone(addr)

    def test_chain_words_only_count_as_qualifiers(self):
        for title in ("report for BASEDCOIN", "database token audit",
                      "coinbase listing check", "Due diligence on WBTC"):
            self.assertIsNone(fw.chain_in_title(title), title)


class TestRepliesMustActuallyBeReplies(unittest.TestCase):
    """A reply is bound to who sent it and to when.

    Neither was checked. Our own messages were excluded by searching their text
    for our markers, which a buyer quoting the question back defeated in one
    direction, and which an attacker echoing our wording defeated in the other.
    Nothing at all constrained the time, so an address mentioned in an earlier
    unrelated turn counted as an answer to a question asked afterwards.
    """

    OURS = "inbox-dossier"
    THEM = "inbox-buyer"

    def setUp(self):
        self._run = fw.run
        self.addCleanup(lambda: setattr(fw, "run", self._run))

    def history(self, rows):
        fw.run = lambda cmd, timeout=180: types.SimpleNamespace(
            stdout=json.dumps(rows), stderr="", returncode=0, failure=None)

    def msg(self, inbox, text, at):
        return {"id": "m", "senderInboxId": inbox, "content": text,
                "sentAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(at)) + "Z"}

    def ask(self, at):
        return self.msg(self.OURS, fw.ASK_MARKER + " which token?", at)

    def test_a_fresh_buyer_reply_is_accepted(self):
        asked = time.time() - 100
        self.history([self.ask(asked),
                      self.msg(self.THEM, "use %s on base please" % WBTC_ETH, asked + 30)])
        addr, chain = fw.read_buyer_reply("0xjob", "4844", asked)
        self.assertEqual(addr, WBTC_ETH)
        self.assertEqual(chain, "base")

    def test_our_own_question_is_never_read_back_as_an_answer(self):
        """The re-ask nudge is newer than asked_at, so only the sender rejects it.

        Dating it at asked_at would let the freshness check do the work and the
        sender check could be removed without any test noticing.
        """
        asked = time.time() - 100
        self.history([
            self.ask(asked),
            self.msg(self.OURS, fw.ASK_MARKER + " still waiting; e.g. %s" % WBTC_ETH,
                     asked + 60),
        ])
        self.assertEqual(fw.read_buyer_reply("0xjob", "4844", asked), (None, None))

    def test_an_address_from_before_the_question_is_not_an_answer(self):
        asked = time.time() - 100
        self.history([self.msg(self.THEM, "earlier chat about %s" % WBTC_ETH, asked - 5000),
                      self.ask(asked)])
        self.assertEqual(fw.read_buyer_reply("0xjob", "4844", asked), (None, None))

    def test_a_buyer_quoting_our_question_still_gets_an_answer(self):
        """The converse bug. Matching on text discarded this reply with the quote."""
        asked = time.time() - 100
        quoted = 'you asked "%s which token?" - it is %s' % (fw.ASK_MARKER, WBTC_ETH)
        self.history([self.ask(asked), self.msg(self.THEM, quoted, asked + 30)])
        addr, _ = fw.read_buyer_reply("0xjob", "4844", asked)
        self.assertEqual(addr, WBTC_ETH)

    def test_an_untimed_message_is_not_trusted(self):
        asked = time.time() - 100
        row = self.msg(self.THEM, "use %s" % WBTC_ETH, asked + 30)
        row["sentAt"] = "not a date"
        self.history([self.ask(asked), row])
        self.assertEqual(fw.read_buyer_reply("0xjob", "4844", asked), (None, None))

    def test_a_history_that_never_identifies_us_yields_nothing(self):
        """If we cannot tell which inbox is ours, we cannot tell a reply from an echo."""
        asked = time.time() - 100
        self.history([self.msg(self.THEM, "use %s" % WBTC_ETH, asked + 30)])
        self.assertEqual(fw.read_buyer_reply("0xjob", "4844", asked), (None, None))


class TestDeliveryIsStaged(unittest.TestCase):
    """Delivery is three steps and used to be reported as one.

    `deliver()` returned the result of the message send alone, so a job was
    closed as done when the upload had produced no fileKey and when the
    deliverable was never registered — the two things OKX review looks for. The
    single bool also meant the only possible retry was the whole delivery, which
    would send the buyer a second copy of a report they already had.
    """

    REPORT = TestNeverUploadsSomethingElse.REPORT
    GOOD = "<html><body>report for %s</body></html>" % WBTC_ETH

    def setUp(self):
        self._saved = {n: getattr(fw, n) for n in
                       ("fetch", "jrun", "run", "send_message", "STATE_FILE",
                        "has_deliverable", "resolve_token", "read_buyer_reply")}
        self.state = os.path.join(scratch(self), "state.json")
        fw.STATE_FILE = self.state
        self.sent = []
        self.saves = []
        self.save_ok = True
        fw.fetch = lambda a, c, fmt, job=None: {
            "ok": True, "why": None, "status": 200,
            "body": json.dumps(self.REPORT) if fmt == "json" else self.GOOD}
        fw.jrun = lambda cmd, timeout=180: {"fileKey": "fk"}
        fw.send_message = lambda job, buyer, text: (self.sent.append(text) or True)
        fw.run = self._run_stub

    def _run_stub(self, cmd, timeout=180):
        joined = " ".join(str(c) for c in cmd)
        if "task-deliverable-save" in joined:
            path = cmd[cmd.index("--file") + 1]
            self.saves.append(path)
            # The registration reads the file. It used to be called after the
            # temp directory had already been removed, so it could never succeed.
            assert os.path.exists(path), "task-deliverable-save got a path that is gone"
            if not self.save_ok:
                return types.SimpleNamespace(stdout="", stderr="backend 500",
                                             returncode=1, failure="exit:1")
        return types.SimpleNamespace(stdout="", stderr="", returncode=0, failure=None)

    def tearDown(self):
        for n, v in self._saved.items():
            setattr(fw, n, v)

    def test_the_registration_can_still_read_the_report(self):
        res = fw.deliver("0x" + "a" * 64, "4844", WBTC_ETH, "ethereum")
        self.assertEqual(len(self.saves), 1)
        self.assertEqual(res, {"uploaded": True, "messaged": True, "recorded": True})

    def test_a_failed_registration_does_not_close_the_job(self):
        self.save_ok = False
        res = fw.deliver("0x" + "a" * 64, "4844", WBTC_ETH, "ethereum")
        self.assertTrue(res["messaged"])
        self.assertFalse(res["recorded"])

    def _tick(self):
        fw.jrun = lambda cmd, timeout=180: (
            {"fileKey": "fk"} if "file" in cmd else
            {"ok": True, "data": {"tasks": [{
                "jobId": "0xjob", "myAgentId": "7012", "myRole": "asp",
                "status": "accepted", "counterpartyAgentId": "4844",
                "title": "WBTC report"}]}})
        fw.has_deliverable = lambda job: False
        fw.resolve_token = lambda title: (None, None, [])
        fw.read_buyer_reply = lambda job, buyer, asked_at=0: (WBTC_ETH, "ethereum")
        with open(self.state, "w") as fh:
            json.dump(self.seed, fh)
        fw.main()
        with open(self.state) as fh:
            return json.load(fh)["0xjob"]

    def test_a_served_buyer_is_not_messaged_twice_by_the_retry(self):
        self.save_ok = False
        self.seed = {"0xjob": {"asked": True, "asked_at": time.time() - 100,
                               "first_seen": time.time() - 10_000}}
        st = self._tick()
        self.assertEqual(len(self.sent), 1)
        self.assertNotIn("done", st, "the job stays open while the record is missing")
        self.assertIn("served_at", st)

        # Second tick: the record is retried, the buyer is not written to again.
        self.seed = {"0xjob": st}
        st2 = self._tick()
        self.assertEqual(len(self.sent), 1, "the buyer must not receive a duplicate report")
        self.assertEqual(len(self.saves), 2, "but the registration is retried")
        self.assertTrue(st2["done"], "and a second failure closes it rather than looping")
