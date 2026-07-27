// The archive is a convenience, never a dependency. If its directory cannot be
// written — a read-only filesystem, a bad path — deliveries must still succeed;
// only recovery is lost. This needs its own file because the directory is
// resolved per call now, but a bad directory is sticky, so it gets its own file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as archive from "../src/dossier/archive";

process.env.ARCHIVE_DIR = "/dev/null/dossier-archive";

describe("unwritable archive directory", () => {
  test("saving degrades to a no-op instead of throwing", () => {
    assert.doesNotThrow(() =>
      archive.save({
        id: archive.newId(),
        paramsSha256: "a".repeat(64),
        request: {},
        contentType: "text/html",
        deliverable: "report",
        deliveredAt: new Date().toISOString(),
      }),
    );
  });

  test("lookups return null rather than crashing", () => {
    assert.equal(archive.byTransaction("0xanything"), null);
    assert.equal(archive.byJobId("0x" + "b".repeat(64)), null);
  });
});
