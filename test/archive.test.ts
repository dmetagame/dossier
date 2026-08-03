// The archive is what lets a buyer who lost the paid response get the same
// bytes back. Two properties matter most: it must never hand a report to
// someone who did not buy it, and it must never return the wrong buyer's report.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempArchive } from "./helpers";

// archive.ts resolves ARCHIVE_DIR on use, so a plain static import is enough
// and the env var can be set here.
import * as archive from "../src/dossier/archive";
type Archive = typeof archive;

const { dir, cleanup } = tempArchive();
process.env.ARCHIVE_DIR = dir;

beforeEach(() => {
  for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
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

describe("recovery by settlement transaction", () => {
  test("a linked transaction returns the exact record", () => {
    const id = archive.newId();
    archive.save(rec(id));
    archive.linkTransaction(id, "0xTX");
    assert.equal(archive.byTransaction("0xTX")?.deliverable, rec(id).deliverable);
  });

  test("lookup is case-insensitive", () => {
    const id = archive.newId();
    archive.save(rec(id));
    archive.linkTransaction(id, "0xAbCdEf");
    assert.ok(archive.byTransaction("0xabcdef"));
  });

  test("an unknown transaction returns null", () => {
    assert.equal(archive.byTransaction("0xnope"), null);
  });

  test("a record saved after the index was built is still found", () => {
    const first = archive.newId();
    archive.save(rec(first));
    archive.linkTransaction(first, "0xONE");
    archive.byTransaction("0xONE"); // forces the index to build
    const second = archive.newId();
    archive.save(rec(second));
    archive.linkTransaction(second, "0xTWO");
    assert.equal(archive.byTransaction("0xTWO")?.id, second);
  });

  test("a deleted record returns null rather than stale index data", () => {
    const id = archive.newId();
    archive.save(rec(id));
    archive.linkTransaction(id, "0xGONE");
    archive.byTransaction("0xGONE");
    unlinkSync(join(dir, `${id}.json`));
    assert.equal(archive.byTransaction("0xGONE"), null);
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
    archive.save(r);
    archive.linkTransaction(r.id, "0xLINKTEST");
    const back = archive.byTransaction("0xLINKTEST");
    assert.ok(back, "a linked record must still authenticate and be findable");
    assert.equal(back!.paymentTransaction, "0xLINKTEST");
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
