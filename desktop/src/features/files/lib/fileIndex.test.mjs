import assert from "node:assert/strict";
import test from "node:test";

// Real implementations — the runner strips TS types via test-loader.mjs.
import {
  fileTypeClass,
  formatFileSize,
  parseFileIndexEvent,
  retractedFileIndexIds,
  sortFileEntries,
} from "./fileIndex.ts";

const HASH = "a".repeat(64);

function indexEvent(overrides = {}) {
  return {
    id: "idx1",
    pubkey: "relaypk",
    created_at: 1_700_000_500,
    kind: 1063,
    content: "report.pdf",
    sig: "",
    tags: [
      ["url", `https://r.example/media/${HASH}.pdf`],
      ["m", "application/pdf"],
      ["x", HASH],
      ["size", "2048"],
      ["h", "chan-1"],
      ["e", "msg-1"],
      ["shared_at", "1700000000"],
      ["uploader", "userpk"],
    ],
    ...overrides,
  };
}

test("parses a full index event", () => {
  const entry = parseFileIndexEvent(indexEvent());
  assert.equal(entry.name, "report.pdf");
  assert.equal(entry.typeClass, "doc");
  assert.equal(entry.sizeBytes, 2048);
  assert.equal(entry.sharedAt, 1_700_000_000);
  assert.equal(entry.messageId, "msg-1");
  assert.equal(entry.channelId, "chan-1");
  assert.equal(entry.uploader, "userpk");
});

test("nameless entries fall back to the URL tail", () => {
  const entry = parseFileIndexEvent(indexEvent({ content: "" }));
  assert.equal(entry.name, `${HASH}.pdf`);
});

test("missing shared_at falls back to created_at", () => {
  const base = indexEvent({ content: "x.png" });
  base.tags = base.tags.filter((t) => t[0] !== "shared_at");
  assert.equal(parseFileIndexEvent(base).sharedAt, 1_700_000_500);
});

test("rejects wrong kinds and malformed entries", () => {
  assert.equal(parseFileIndexEvent(indexEvent({ kind: 9 })), null);
  const missingUrl = indexEvent();
  missingUrl.tags = missingUrl.tags.filter((t) => t[0] !== "url");
  assert.equal(parseFileIndexEvent(missingUrl), null);
});

test("retraction ids require the k=1063 marker", () => {
  const deletion = {
    id: "del1",
    pubkey: "relaypk",
    created_at: 0,
    kind: 5,
    content: "file index retraction",
    sig: "",
    tags: [
      ["e", "idx1"],
      ["e", "idx2"],
      ["k", "1063"],
      ["h", "chan-1"],
    ],
  };
  assert.deepEqual(retractedFileIndexIds(deletion), ["idx1", "idx2"]);
  const plain = { ...deletion, tags: [["e", "idx1"]] };
  assert.deepEqual(retractedFileIndexIds(plain), []);
  assert.deepEqual(retractedFileIndexIds({ ...deletion, kind: 9 }), []);
});

test("sorts newest share first with id tiebreak", () => {
  const a = parseFileIndexEvent(indexEvent({ id: "b" }));
  const older = indexEvent({ id: "a" });
  older.tags = older.tags.map((t) =>
    t[0] === "shared_at" ? ["shared_at", "1600000000"] : t,
  );
  const b = parseFileIndexEvent(older);
  const same = parseFileIndexEvent(indexEvent({ id: "a" }));
  assert.deepEqual(
    sortFileEntries([b, a, same]).map((e) => e.id),
    ["a", "b", "a"],
  );
});

test("type classes and sizes format", () => {
  assert.equal(fileTypeClass("image/png"), "image");
  assert.equal(fileTypeClass("video/mp4"), "video");
  assert.equal(fileTypeClass("audio/flac"), "audio");
  assert.equal(fileTypeClass("text/csv"), "doc");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2.0 KB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatFileSize(null), "");
});
