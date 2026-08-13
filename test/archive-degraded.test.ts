// A paid delivery must be recoverable. If its directory cannot be written — a
// read-only filesystem, a bad path — save reports failure so the route can
// refuse delivery before settlement. This needs its own file because the directory is
// resolved per call now, but a bad directory is sticky, so it gets its own file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as archive from "../src/dossier/archive";

process.env.ARCHIVE_DIR = "/dev/null/dossier-archive";

describe("unwritable archive directory", () => {
  test("saving reports failure instead of throwing", () => {
    assert.equal(
      archive.save({
        id: archive.newId(),
        paramsSha256: "a".repeat(64),
        request: {},
        contentType: "text/html",
        deliverable: "report",
        deliveredAt: new Date().toISOString(),
      }),
      false,
    );
  });

  test("lookups return null rather than crashing", () => {
    assert.equal(archive.byTransaction("0xanything"), null);
    assert.equal(archive.byJobId("0x" + "b".repeat(64)), null);
  });
});
