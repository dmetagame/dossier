// The archive is what lets a buyer who lost the paid response get the same
// bytes back. Two properties matter most: it must never hand a report to
// someone who did not buy it, and it must never return the wrong buyer's report.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, readdirSync } from "node:fs";
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
