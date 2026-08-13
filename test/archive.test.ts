// The archive is what lets a buyer who lost the paid response get the same
// bytes back. Two properties matter most: it must never hand a report to
// someone who did not buy it, and it must never return the wrong buyer's report.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tempArchive } from "./helpers";

// archive.ts resolves ARCHIVE_DIR on use, so a plain static import is enough
// and the env var can be set here.
import * as archive from "../src/dossier/archive";
import * as replay from "../src/payment-replay";
import { archiveRecordMac } from "../src/dossier/archive-format";
type Archive = typeof archive;

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;

beforeEach(() => {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  archive.resetIndex();
});
after(() => cleanup());

const rec = (id: string, over: Partial<Parameters<Archive["save"]>[0]> = {}) => ({
  id,
  paramsSha256: "f".repeat(64),
  request: { tokenAddress: "0xabc" },
  contentType: "text/html",
  deliverable: `report-${id.slice(0, 6)}`,
  deliveredAt: new Date().toISOString(),
  ...over,
});

function replayFingerprint(
  requirements: replay.ReplayRequirements,
  unique: string,
): string {
  const semanticRequirements = {
    ...requirements,
    maxTimeoutSeconds: 300,
    extra: { name: "Archive Test Token", version: "1" },
  };
  const nonce = createHash("sha256").update(unique).digest("hex");
  return replay.fingerprintPayment(
    {
      x402Version: 2,
      accepted: semanticRequirements,
      payload: {
        signature: "0x" + "11".repeat(65),
        authorization: {
          from: "0x" + "10".repeat(20),
          to: requirements.payTo,
          value: requirements.amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${nonce}`,
        },
      },
    },
    semanticRequirements,
  )!;
}

describe("recovery by settlement transaction", () => {
  test("a linked transaction returns the exact record", () => {
    const id = archive.newId();
    const tx = "0x" + "01".repeat(32);
    archive.save(rec(id));
    archive.linkTransaction(id, tx);
    assert.equal(archive.byTransaction(tx)?.deliverable, rec(id).deliverable);
  });

  test("lookup is case-insensitive", () => {
    const id = archive.newId();
    const tx = `0x${"Ab".repeat(32)}`;
    archive.save(rec(id));
    archive.linkTransaction(id, tx);
    assert.ok(archive.byTransaction(tx.toLowerCase()));
  });

  test("an unknown transaction returns null", () => {
    assert.equal(archive.byTransaction("0x" + "fe".repeat(32)), null);
  });

  test("a record saved after the index was built is still found", () => {
    const first = archive.newId();
    const firstTx = "0x" + "02".repeat(32);
    archive.save(rec(first));
    archive.linkTransaction(first, firstTx);
    archive.byTransaction(firstTx); // forces the index to build
    const second = archive.newId();
    const secondTx = "0x" + "03".repeat(32);
    archive.save(rec(second));
    archive.linkTransaction(second, secondTx);
    assert.equal(archive.byTransaction(secondTx)?.id, second);
  });

  test("a deleted record returns null rather than stale index data", () => {
    const id = archive.newId();
    const tx = "0x" + "04".repeat(32);
    archive.save(rec(id));
    archive.linkTransaction(id, tx);
    archive.byTransaction(tx);
    unlinkSync(join(dir, `${id}.json`));
    assert.equal(archive.byTransaction(tx), null);
  });

  test("transaction links and lookups reject surrounding whitespace", () => {
    const id = archive.newId();
    const tx = "0x" + "05".repeat(32);
    archive.save(rec(id));

    assert.equal(archive.linkTransaction(id, ` ${tx}`).kind, "record_conflict");
    assert.equal(archive.linkTransaction(id, `${tx}\n`).kind, "record_conflict");
    assert.equal(archive.byTransaction(` ${tx}`), null);
    assert.equal(archive.byTransaction(`${tx}\n`), null);
    assert.equal(archive.byId(id)?.paymentTransaction, undefined);
  });

  test("a confirmed settlement is explicit and idempotent", () => {
    const id = archive.newId();
    const tx = "0x" + "11".repeat(32);
    const settlement = {
      status: "confirmed" as const,
      transaction: tx,
      network: "eip155:196",
      amount: "10000",
      payer: "0x" + "22".repeat(20),
    };
    archive.save(rec(id));

    assert.equal(archive.linkConfirmedSettlement(id, settlement).kind, "linked");
    assert.equal(
      archive.linkConfirmedSettlement(id, settlement).kind,
      "already_linked",
      "a settlement callback may be replayed safely",
    );
    assert.deepEqual(archive.byTransaction(tx)?.settlement, settlement);
  });

  test("a published claim repairs a crash before record enrichment", () => {
    const id = archive.newId();
    const tx = "0x" + "12".repeat(32);
    const original = rec(id);
    const settlement = {
      status: "confirmed" as const,
      transaction: tx,
      network: "eip155:196",
      payer: "0x" + "34".repeat(20),
    };
    archive.save(original);
    assert.equal(archive.linkConfirmedSettlement(id, settlement).kind, "linked");

    // The claim is published before the record is enriched. Restoring the
    // staged bytes models a worker dying at exactly that boundary.
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(original));
    archive.resetIndex();
    assert.equal(archive.byId(id)?.settlement, undefined);
    assert.deepEqual(archive.settledById(id)?.settlement, settlement);
  });

  test("a legacy transaction link can be upgraded to explicit confirmation", () => {
    const id = archive.newId();
    const tx = "0x" + "66".repeat(32);
    const settlement = {
      status: "confirmed" as const,
      transaction: tx,
      network: "eip155:196",
    };
    archive.save(rec(id));
    assert.equal(archive.linkTransaction(id, tx).kind, "linked");
    assert.equal(archive.linkConfirmedSettlement(id, settlement).kind, "already_linked");
    assert.deepEqual(archive.byTransaction(tx)?.settlement, settlement);
  });

  test("a report's confirmed transaction cannot be overwritten", () => {
    const id = archive.newId();
    const first = "0x" + "33".repeat(32);
    const second = "0x" + "44".repeat(32);
    archive.save(rec(id));
    assert.equal(
      archive.linkConfirmedSettlement(id, {
        status: "confirmed",
        transaction: first,
        network: "eip155:196",
      }).kind,
      "linked",
    );
    assert.equal(
      archive.linkConfirmedSettlement(id, {
        status: "confirmed",
        transaction: second,
        network: "eip155:196",
      }).kind,
      "record_conflict",
    );
    assert.equal(archive.byTransaction(first)?.id, id);
    assert.equal(archive.byTransaction(second), null);
  });

  test("one confirmed transaction cannot be assigned to two reports", () => {
    const tx = "0x" + "55".repeat(32);
    const first = archive.newId();
    const second = archive.newId();
    archive.save(rec(first));
    archive.save(rec(second));
    assert.equal(
      archive.linkConfirmedSettlement(first, {
        status: "confirmed",
        transaction: tx,
        network: "eip155:196",
      }).kind,
      "linked",
    );
    assert.equal(
      archive.linkConfirmedSettlement(second, {
        status: "confirmed",
        transaction: tx,
        network: "eip155:196",
      }).kind,
      "transaction_conflict",
    );
    assert.equal(archive.byTransaction(tx)?.id, first);
  });

  test("a legacy owner conflict is upgraded with authoritative settlement metadata", () => {
    const tx = "0x" + "56".repeat(32);
    const first = archive.newId();
    const second = archive.newId();
    const settlement = {
      status: "confirmed" as const,
      transaction: tx,
      network: "eip155:196",
      payer: "0x" + "78".repeat(20),
    };
    archive.save(rec(first));
    archive.save(rec(second));
    assert.equal(archive.linkTransaction(first, tx).kind, "linked");
    const conflict = archive.linkConfirmedSettlement(second, settlement);
    assert.equal(conflict.kind, "transaction_conflict");
    assert.equal(conflict.kind === "transaction_conflict" && conflict.owner.id, first);
    assert.deepEqual(archive.byTransaction(tx)?.settlement, settlement);
  });

  test("an undelivered orphan can be discarded, but a linked record cannot", () => {
    const orphan = archive.newId();
    archive.save(rec(orphan));
    assert.equal(archive.discard(orphan), true);
    assert.equal(archive.byId(orphan), null);

    const linked = archive.newId();
    const tx = "0x" + "77".repeat(32);
    archive.save(rec(linked));
    archive.linkConfirmedSettlement(linked, {
      status: "confirmed",
      transaction: tx,
      network: "eip155:196",
    });
    assert.equal(archive.discard(linked), false);
    assert.equal(archive.byTransaction(tx)?.id, linked);
  });

  test("a replay hold protects a staged report from destructive cleanup", () => {
    const id = archive.newId();
    archive.save(rec(id));
    writeFileSync(
      join(dir, `.report-${id.toLowerCase()}.replay-hold`),
      JSON.stringify({ protected: true }),
    );
    assert.equal(archive.discard(id), false);
    assert.equal(archive.byId(id)?.id, id);
  });

  test("attaching a recovery code does not invalidate an existing transaction claim", () => {
    const id = archive.newId();
    const tx = "0x" + "88".repeat(32);
    const jobId = "0x" + "aa".repeat(32);
    archive.save(rec(id, { jobId }));
    assert.equal(
      archive.linkConfirmedSettlement(id, {
        status: "confirmed",
        transaction: tx,
        network: "eip155:196",
      }).kind,
      "linked",
    );
    assert.ok(archive.attachRecoveryCode(jobId));
    assert.equal(
      archive.byTransaction(tx)?.id,
      id,
      "mutable recovery metadata is outside the immutable ownership digest",
    );
  });

  test("a stale crash lock is reclaimed instead of causing a permanent outage", () => {
    const id = archive.newId();
    const tx = "0x" + "99".repeat(32);
    archive.save(rec(id));
    const lock = join(dir, `.transaction-${createHash("sha256").update(tx).digest("hex")}.lock`);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      join(lock, "owner"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 1, token: "dead-worker-token" }),
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(lock, "owner"), old, old);
    utimesSync(lock, old, old);

    assert.equal(
      archive.linkConfirmedSettlement(id, {
        status: "confirmed",
        transaction: tx,
        network: "eip155:196",
      }).kind,
      "linked",
    );
  });
});

describe("recovery by marketplace job", () => {
  const JOB = "0x" + "a".repeat(64);

  test("a job id returns the delivery made for it", () => {
    const id = archive.newId();
    archive.save(rec(id, { jobId: JOB }));
    assert.equal(archive.byJobId(JOB)?.id, id);
  });

  test("a malformed job id is rejected without scanning", () => {
    assert.equal(archive.byJobId("not-a-job"), null);
    assert.equal(archive.byJobId("../../etc/passwd"), null);
  });

  test("re-delivering supersedes the earlier copy", async () => {
    const older = archive.newId();
    archive.save(rec(older, { jobId: JOB, deliverable: "first", deliveredAt: "2026-01-01T00:00:00.000Z" }));
    const newer = archive.newId();
    archive.save(rec(newer, { jobId: JOB, deliverable: "second", deliveredAt: "2026-01-02T00:00:00.000Z" }));
    assert.equal(archive.byJobId(JOB)?.deliverable, "second");
    archive.resetIndex();
    assert.equal(archive.byJobId(JOB)?.deliverable, "second", "and after a cold rebuild");
  });
});

describe("it cannot be used to obtain a report without buying one", () => {
  test("the params hash alone identifies a record but is not accepted as proof by the route", () => {
    // byHash exists for the secondary check; the HTTP layer requires a
    // transaction or a job id. See test/http.test.ts.
    const id = archive.newId();
    const hash = archive.paramsHash({ tokenAddress: "0xabc" });
    archive.save(rec(id, { paramsSha256: hash }));
    assert.equal(archive.byHash(hash)?.id, id);
    assert.equal(archive.byHash("nonsense"), null);
  });

  test("filenames from a caller are never trusted", () => {
    writeFileSync(join(dir, "secret.json"), JSON.stringify(rec("secret")));
    // Traversal and odd shapes resolve to nothing rather than reading a path.
    assert.equal(archive.byJobId("../secret"), null);
    assert.equal(archive.byTransaction("../secret"), null);
  });
});

describe("params hashing", () => {
  test("format is excluded, so proof matches whether or not it was sent", () => {
    const a = archive.paramsHash({ tokenAddress: "0xABC", chain: "BSC", format: "html" });
    const b = archive.paramsHash({ tokenAddress: "0xabc", chain: "bsc" });
    assert.equal(a, b);
  });

  test("a different token hashes differently", () => {
    assert.notEqual(
      archive.paramsHash({ tokenAddress: "0xabc" }),
      archive.paramsHash({ tokenAddress: "0xdef" }),
    );
  });
});

describe("durability", () => {
  test("every saved record is its own file, so buyers cannot evict each other", () => {
    const ids = [archive.newId(), archive.newId(), archive.newId()];
    for (const id of ids) archive.save(rec(id, { paramsSha256: "c".repeat(64) })); // same request
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 3);
  });

  test("the bounded readiness token changes for record, replay, hold, and claim mutations", () => {
    const previousArchiveKey = process.env.ARCHIVE_MAC_KEY;
    const previousRequired = process.env.ARCHIVE_MAC_REQUIRED;
    const previousReplayKey = process.env.PAYMENT_REPLAY_KEY;
    process.env.ARCHIVE_MAC_KEY = "readiness-version-archive-key";
    process.env.ARCHIVE_MAC_REQUIRED = "1";
    process.env.PAYMENT_REPLAY_KEY = "readiness-version-replay-key";
    const nextVersion = (previous: string): string => {
      const current = archive.readinessVersionForTests();
      assert.match(current ?? "", /^[a-f0-9]{64}$/);
      assert.notEqual(current, previous);
      return current!;
    };
    try {
      let version = archive.readinessVersionForTests();
      assert.match(version ?? "", /^[a-f0-9]{64}$/);

      const id = archive.newId();
      assert.equal(archive.save(rec(id)), true);
      version = nextVersion(version!);

      const requirements: replay.ReplayRequirements = {
        scheme: "exact",
        network: "eip155:196",
        amount: "10000",
        asset: `0x${"01".repeat(20)}`,
        payTo: `0x${"02".repeat(20)}`,
      };
      const fingerprint = replayFingerprint(requirements, "readiness-version");
      const begun = replay.begin(
        fingerprint,
        { paramsSha256: "a".repeat(64), contentType: "text/html" },
        requirements,
      );
      assert.equal(begun.kind, "created");
      if (begun.kind !== "created") return;
      version = nextVersion(version!);

      assert.equal(replay.attachReport(fingerprint, begun.attemptToken, id), true);
      version = nextVersion(version!);

      assert.equal(
        archive.linkConfirmedSettlement(id, {
          status: "confirmed",
          transaction: `0x${"33".repeat(32)}`,
          network: requirements.network,
          amount: requirements.amount,
        }).kind,
        "linked",
      );
      nextVersion(version!);
    } finally {
      if (previousArchiveKey === undefined) delete process.env.ARCHIVE_MAC_KEY;
      else process.env.ARCHIVE_MAC_KEY = previousArchiveKey;
      if (previousRequired === undefined) delete process.env.ARCHIVE_MAC_REQUIRED;
      else process.env.ARCHIVE_MAC_REQUIRED = previousRequired;
      if (previousReplayKey === undefined) delete process.env.PAYMENT_REPLAY_KEY;
      else process.env.PAYMENT_REPLAY_KEY = previousReplayKey;
    }
  });
});

// Records were trusted because the file mode said 0600. That says who may write,
// not what was written: anything able to write into ARCHIVE_DIR could repoint a
// settlement transaction at a different report, swap the delivered bytes, or
// fabricate a record, and recovery would serve the result as the document that
// buyer paid for. The report's own attestation says nothing about which
// transaction or job it belongs to, so it cannot help here.
describe("archive records are authenticated, not just permissioned", () => {
  const withKey = <T>(fn: () => T): T => {
    const prev = process.env.ARCHIVE_MAC_KEY;
    process.env.ARCHIVE_MAC_KEY = "44".repeat(32);
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.ARCHIVE_MAC_KEY; else process.env.ARCHIVE_MAC_KEY = prev;
    }
  };
  const rec = (over: Partial<archive.ArchiveRecord> = {}): archive.ArchiveRecord => ({
    id: archive.newId(),
    paramsSha256: archive.paramsHash({ tokenAddress: "0xabc" }),
    request: { tokenAddress: "0xabc" },
    contentType: "text/html",
    deliverable: "<html>the report</html>",
    deliveredAt: new Date().toISOString(),
    ...over,
  });

  test("a saved record carries a MAC", () => withKey(() => {
    const r = rec();
    archive.save(r);
    const back = archive.byHash(r.paramsSha256);
    assert.ok(back?.mac, "a record written with a key must be authenticated");
  }));

  test("swapping the delivered bytes makes the record unreadable", () => withKey(() => {
    const r = rec();
    archive.save(r);
    const stored = archive.byHash(r.paramsSha256)!;
    const forged = { ...stored, deliverable: "<html>a different report</html>" };
    assert.equal(archive.macValid(forged), false, "altered content must not authenticate");
  }));

  test("repointing the settlement transaction is caught", () => withKey(() => {
    const r = rec();
    archive.save(r);
    const stored = archive.byHash(r.paramsSha256)!;
    assert.equal(archive.macValid({ ...stored, paymentTransaction: "0xsomeoneelses" }), false);
  }));

  test("a fabricated record with no MAC of ours does not pass", () => withKey(() => {
    assert.equal(archive.macValid({ ...rec(), mac: "0".repeat(64) }), false);
  }));

  test("linking a transaction keeps the record readable", () => withKey(() => {
    // The transaction is covered by the MAC, so it has to be recomputed on
    // link. Leaving it stale would strand the buyer who just paid.
    const r = rec();
    const tx = "0x" + "06".repeat(32);
    archive.save(r);
    archive.linkTransaction(r.id, tx);
    const back = archive.byTransaction(tx);
    assert.ok(back, "a linked record must still authenticate and be findable");
    assert.equal(back!.paymentTransaction, tx);
  }));

  test("padded transaction metadata is neither saved nor served", () => withKey(() => {
    const tx = "0x" + "07".repeat(32);
    const paddedPayment = rec({ paymentTransaction: ` ${tx}` });
    assert.equal(archive.save(paddedPayment), false);
    assert.equal(archive.byId(paddedPayment.id), null);

    const authenticatedPadded = {
      ...paddedPayment,
      mac: archiveRecordMac(paddedPayment, process.env.ARCHIVE_MAC_KEY)!,
    };
    writeFileSync(
      join(dir, `${authenticatedPadded.id}.json`),
      JSON.stringify(authenticatedPadded),
    );
    archive.resetIndex();
    assert.equal(archive.byId(authenticatedPadded.id), null);
    assert.equal(archive.byTransaction(tx), null);
    assert.equal(
      archive.byHash(authenticatedPadded.paramsSha256),
      null,
      "request-hash lookup must not serve a record with split transaction identity",
    );

    const paddedSettlement = rec({
      paymentTransaction: tx,
      settlement: {
        status: "confirmed",
        transaction: `${tx} `,
        network: "eip155:196",
      },
    });
    assert.equal(archive.save(paddedSettlement), false);
    assert.equal(archive.byId(paddedSettlement.id), null);
  }));

  test("attaching a recovery code keeps the record readable", () => withKey(() => {
    // Same shape as linkTransaction: the code hash is covered by the MAC, so it
    // has to be recomputed on attach. A stale MAC makes the record fail
    // authentication on the next read, which would strand the buyer whose
    // message just told them to recover with that very code.
    const jobId = "0x" + "ab".repeat(32);
    const r = rec({ jobId });
    archive.save(r);
    const code = archive.attachRecoveryCode(jobId);
    assert.ok(code, "there is a delivered report to attach to");
    const back = archive.byJobId(jobId);
    assert.ok(back, "an attached record must still authenticate and be findable");
    assert.ok(archive.recoveryCodeMatches(back!, code!), "and the code must verify against it");
    assert.equal(back!.deliverable, r.deliverable, "the document is unchanged");
  }));

  test("attaching to a job with nothing delivered mints nothing", () => withKey(() => {
    assert.equal(archive.attachRecoveryCode("0x" + "cd".repeat(32)), null);
  }));

  test("a deploy with no key still reads its own records", () => {
    // Refusing to serve a legitimately paid report over a missing local key
    // would be the worse failure.
    const prev = process.env.ARCHIVE_MAC_KEY, prevS = process.env.SIGNING_KEY;
    delete process.env.ARCHIVE_MAC_KEY; delete process.env.SIGNING_KEY;
    try {
      const r = rec();
      archive.save(r);
      assert.ok(archive.byHash(r.paramsSha256), "no key must not mean no recovery");
    } finally {
      if (prev) process.env.ARCHIVE_MAC_KEY = prev;
      if (prevS) process.env.SIGNING_KEY = prevS;
    }
  });

  test("strict mode without a key refuses readiness and unsigned writes", () => {
    const prevKey = process.env.ARCHIVE_MAC_KEY;
    const prevRequired = process.env.ARCHIVE_MAC_REQUIRED;
    delete process.env.ARCHIVE_MAC_KEY;
    process.env.ARCHIVE_MAC_REQUIRED = "1";
    try {
      const r = rec();
      assert.equal(archive.ready(), false);
      assert.equal(archive.save(r), false);
      assert.equal(archive.macValid(r), false);
    } finally {
      if (prevKey === undefined) delete process.env.ARCHIVE_MAC_KEY;
      else process.env.ARCHIVE_MAC_KEY = prevKey;
      if (prevRequired === undefined) delete process.env.ARCHIVE_MAC_REQUIRED;
      else process.env.ARCHIVE_MAC_REQUIRED = prevRequired;
    }
  });

  test("invalid strict-mode values fail readiness instead of silently disabling it", () => {
    const prev = process.env.ARCHIVE_MAC_REQUIRED;
    process.env.ARCHIVE_MAC_REQUIRED = "true";
    try {
      const status = archive.readiness();
      assert.equal(status.ready, false);
      assert.equal(status.mode, "invalid");
    } finally {
      if (prev === undefined) delete process.env.ARCHIVE_MAC_REQUIRED;
      else process.env.ARCHIVE_MAC_REQUIRED = prev;
    }
  });

  test("readiness rejects a group- or world-accessible archive root", () => {
    const previous = statSync(dir).mode & 0o777;
    try {
      chmodSync(dir, 0o777);
      const status = archive.readiness();
      assert.equal(status.ready, false);
      assert.match(status.reason ?? "", /directory.*group- or world-accessible/);
    } finally {
      chmodSync(dir, previous);
    }
  });

  test("strict readiness scans existing records before paid traffic is enabled", () => withKey(() => {
    const prev = process.env.ARCHIVE_MAC_REQUIRED;
    process.env.ARCHIVE_MAC_REQUIRED = "1";
    try {
      const legacyHash = "a".repeat(64);
      writeFileSync(
        join(dir, `${legacyHash}.json`),
        JSON.stringify({
          paramsSha256: legacyHash,
          request: { tokenAddress: "0xlegacy" },
          contentType: "text/html",
          deliverable: "legacy report",
          deliveredAt: new Date().toISOString(),
        }),
      );
      const legacyStatus = archive.readiness();
      assert.equal(legacyStatus.ready, false, "legacy v1 data blocks strict mode");
      assert.match(legacyStatus.reason ?? "", /cold-archive migration/);

      unlinkSync(join(dir, `${legacyHash}.json`));
      const id = archive.newId();
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec({ id })));
      assert.equal(archive.readiness().ready, false, "unsigned legacy data blocks strict mode");

      unlinkSync(join(dir, `${id}.json`));
      writeFileSync(join(dir, "not-json.json"), "{");
      assert.equal(archive.readiness().ready, false, "malformed records block strict mode");
    } finally {
      if (prev === undefined) delete process.env.ARCHIVE_MAC_REQUIRED;
      else process.env.ARCHIVE_MAC_REQUIRED = prev;
    }
  }));

  test("readiness rejects malformed or dangling replay holds", () => withKey(() => {
    const previousReplay = process.env.PAYMENT_REPLAY_KEY;
    process.env.PAYMENT_REPLAY_KEY = "archive-readiness-hold-key";
    const id = archive.newId();
    try {
      archive.save(rec({ id }));
      const holdPath = join(dir, `.report-${id.toLowerCase()}.replay-hold`);
      writeFileSync(holdPath, "{");
      assert.match(archive.readiness().reason ?? "", /malformed replay hold/);

      writeFileSync(
        holdPath,
        JSON.stringify({
          v: 1,
          reportId: id,
          fingerprint: "a".repeat(64),
          attemptToken: "b".repeat(32),
          mac: "c".repeat(64),
        }),
      );
      assert.match(archive.readiness().reason ?? "", /invalid replay hold/);
    } finally {
      if (previousReplay === undefined) delete process.env.PAYMENT_REPLAY_KEY;
      else process.env.PAYMENT_REPLAY_KEY = previousReplay;
    }
  }));

  test("readiness rejects a bad hold MAC separately from a mismatched replay owner", () => withKey(() => {
    const previousReplay = process.env.PAYMENT_REPLAY_KEY;
    process.env.PAYMENT_REPLAY_KEY = "archive-readiness-hold-key";
    const first = archive.newId();
    const second = archive.newId();
    try {
      archive.save(rec({ id: first }));
      archive.save(rec({ id: second }));
      const replayRequirements = {
        scheme: "exact",
        network: "eip155:196",
        amount: "10000",
        asset: "0x" + "01".repeat(20),
        payTo: "0x" + "02".repeat(20),
      };
      const fingerprint = replayFingerprint(replayRequirements, "archive-hold-01");
      const begun = replay.begin(
        fingerprint,
        { paramsSha256: "a".repeat(64), contentType: "text/html" },
        replayRequirements,
      );
      assert.equal(begun.kind, "created");
      if (begun.kind !== "created") return;
      assert.equal(replay.attachReport(fingerprint, begun.attemptToken, first), true);

      const firstHold = join(dir, `.report-${first.toLowerCase()}.replay-hold`);
      const validHold = JSON.parse(readFileSync(firstHold, "utf8"));
      writeFileSync(firstHold, JSON.stringify({ ...validHold, mac: "0".repeat(64) }));
      assert.match(archive.readiness().reason ?? "", /invalid replay hold/);

      // Keep the original authenticated bytes, but index them under another
      // report. The MAC remains valid while the replay state still names first.
      writeFileSync(firstHold, JSON.stringify(validHold));
      const mismatchedHold = join(dir, `.report-${second.toLowerCase()}.replay-hold`);
      renameSync(firstHold, mismatchedHold);
      assert.match(archive.readiness().reason ?? "", /invalid replay hold/);
    } finally {
      if (previousReplay === undefined) delete process.env.PAYMENT_REPLAY_KEY;
      else process.env.PAYMENT_REPLAY_KEY = previousReplay;
    }
  }));

  test("readiness validates replay holds after collecting their records", () => withKey(() => {
    const previousReplay = process.env.PAYMENT_REPLAY_KEY;
    process.env.PAYMENT_REPLAY_KEY = "archive-readiness-order-key";
    const id = archive.newId();
    try {
      archive.save(rec({ id }));
      const replayRequirements = {
        scheme: "exact",
        network: "eip155:196",
        amount: "10000",
        asset: "0x" + "03".repeat(20),
        payTo: "0x" + "04".repeat(20),
      };
      const fingerprint = replayFingerprint(replayRequirements, "archive-hold-02");
      const begun = replay.begin(
        fingerprint,
        { paramsSha256: "b".repeat(64), contentType: "text/html" },
        replayRequirements,
      );
      assert.equal(begun.kind, "created");
      if (begun.kind !== "created") return;
      assert.equal(replay.attachReport(fingerprint, begun.attemptToken, id), true);

      const recordPath = join(dir, `${id}.json`);
      const recordBody = readFileSync(recordPath, "utf8");
      unlinkSync(recordPath);
      writeFileSync(recordPath, recordBody);
      assert.equal(
        archive.readiness().ready,
        true,
        "a hold created before its record directory entry must not depend on readdir order",
      );
    } finally {
      if (previousReplay === undefined) delete process.env.PAYMENT_REPLAY_KEY;
      else process.env.PAYMENT_REPLAY_KEY = previousReplay;
    }
  }));

  test("a confirmed replay-state crash residue does not disable paid readiness", () => withKey(() => {
    const previousReplay = process.env.PAYMENT_REPLAY_KEY;
    process.env.PAYMENT_REPLAY_KEY = "archive-confirmed-hold-key";
    const id = archive.newId();
    try {
      archive.save(rec({ id }));
      const requirements = {
        scheme: "exact",
        network: "eip155:196",
        amount: "10000",
        asset: "0x" + "05".repeat(20),
        payTo: "0x" + "06".repeat(20),
      };
      const fingerprint = replayFingerprint(requirements, "archive-hold-03");
      const begun = replay.begin(
        fingerprint,
        { paramsSha256: "c".repeat(64), contentType: "text/html" },
        requirements,
      );
      assert.equal(begun.kind, "created");
      if (begun.kind !== "created") return;
      assert.equal(replay.attachReport(fingerprint, begun.attemptToken, id), true);
      const holdPath = join(dir, `.report-${id.toLowerCase()}.replay-hold`);
      const holdBody = readFileSync(holdPath, "utf8");
      const settlement = {
        status: "confirmed" as const,
        transaction: "0x" + "71".repeat(32),
        network: "eip155:196",
      };
      assert.equal(archive.linkConfirmedSettlement(id, settlement).kind, "linked");
      assert.equal(
        replay.finalize(fingerprint, begun.attemptToken, id, settlement),
        true,
      );
      assert.equal(existsSync(holdPath), false);

      // Model the process dying after the confirmed state fsync and before the
      // redundant hold unlink became durable.
      writeFileSync(holdPath, holdBody);
      assert.equal(replay.begin(fingerprint, { paramsSha256: "c".repeat(64), contentType: "text/html" }, requirements).kind, "confirmed");
      assert.equal(archive.readiness().ready, true);
    } finally {
      if (previousReplay === undefined) delete process.env.PAYMENT_REPLAY_KEY;
      else process.env.PAYMENT_REPLAY_KEY = previousReplay;
    }
  }));

  test("migration readiness is explicit about unsigned records", () => withKey(() => {
    const prev = process.env.ARCHIVE_MAC_REQUIRED;
    delete process.env.ARCHIVE_MAC_REQUIRED;
    try {
      const id = archive.newId();
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec({ id })));
      const status = archive.readiness();
      assert.equal(status.ready, true);
      assert.equal(status.mode, "migration");
      assert.equal(status.unsignedRecords, 1);
    } finally {
      if (prev === undefined) delete process.env.ARCHIVE_MAC_REQUIRED;
      else process.env.ARCHIVE_MAC_REQUIRED = prev;
    }
  }));
});

// The point of the MAC is that a tampered file on disk is never served. Checking
// macValid() in isolation does not prove the read path consults it.
describe("a tampered record on disk is not served", () => {
  const KEY = "55".repeat(32);
  test("rewriting the delivered bytes makes the record disappear", () => {
    const jobId = `0x${"9".repeat(64)}`;
    const prev = process.env.ARCHIVE_MAC_KEY;
    process.env.ARCHIVE_MAC_KEY = KEY;
    try {
      const r: archive.ArchiveRecord = {
        id: archive.newId(),
        paramsSha256: archive.paramsHash({ tokenAddress: "0xtamper" }),
        request: { tokenAddress: "0xtamper" },
        contentType: "text/html",
        deliverable: "<html>the report they paid for</html>",
        deliveredAt: new Date().toISOString(),
        jobId,
      };
      archive.save(r);
      assert.ok(archive.byHash(r.paramsSha256), "it should be readable before tampering");
      assert.ok(archive.byJobId(jobId), "and findable by job id");

      // Exactly what an attacker with write access to ARCHIVE_DIR would do:
      // swap the document, leave the MAC alone.
      const path = join(dir, `${r.id}.json`);
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      onDisk.deliverable = "<html>a report they never bought</html>";
      writeFileSync(path, JSON.stringify(onDisk));

      archive.resetIndex?.();
      // Both read paths have to refuse it. byHash scans the directory; the
      // keyed lookups go through the index and read the file by name. Guarding
      // one and not the other would leave the second serving whatever was
      // written into ARCHIVE_DIR.
      assert.equal(
        archive.byHash(r.paramsSha256),
        null,
        "the scanning read path served a record that failed authentication",
      );
      assert.equal(
        archive.byJobId(jobId),
        null,
        "the indexed read path served a record that failed authentication",
      );
    } finally {
      if (prev === undefined) delete process.env.ARCHIVE_MAC_KEY;
      else process.env.ARCHIVE_MAC_KEY = prev;
    }
  });
});
