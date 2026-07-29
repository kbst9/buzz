import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const HASH_A = "a".repeat(64);
const INDEX_ID_A = "1".repeat(64);
const RETRACTION_ID = "2".repeat(64);

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
  kind?: number,
) {
  await expect
    .poll(async () => {
      return page.evaluate(
        ({ currentChannelName, kind: k }) => {
          return (
            (
              window as Window & {
                __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                  channelName: string;
                  kind?: number;
                }) => boolean;
              }
            ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
              channelName: currentChannelName,
              kind: k,
            }) ?? false
          );
        },
        { currentChannelName: channelName, kind },
      );
    })
    .toBe(true);
}

function emitIndexEntry(
  page: import("@playwright/test").Page,
  options: { name: string; id: string; hash: string },
) {
  return page.evaluate(({ name, id, hash }) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "random",
      content: name,
      kind: 1063,
      id,
      extraTags: [
        ["url", `https://relay.example/media/${hash}.pdf`],
        ["m", "application/pdf"],
        ["x", hash],
        ["size", "2048"],
        ["filename", name],
        ["e", "3".repeat(64)],
        ["shared_at", "1700000000"],
        ["uploader", "deadbeef".repeat(8)],
      ],
    });
  }, options);
}

test("channel Files drawer lists live index entries and honors retraction", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");

  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-files-trigger").click();

  const sheet = page.getByTestId("channel-files-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("files-empty")).toBeVisible();

  // Live append: the drawer's subscription must exist before emitting,
  // otherwise the mock relay silently drops the event.
  await waitForMockLiveSubscription(page, "random", 1063);
  await emitIndexEntry(page, {
    name: "report.pdf",
    id: INDEX_ID_A,
    hash: HASH_A,
  });

  const row = sheet.getByTestId("files-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("report.pdf");
  await expect(row).toContainText("2.0 KB");

  // Type filters: a PDF is a doc, not an image.
  await sheet.getByTestId("files-filter-image").click();
  await expect(sheet.getByTestId("files-row")).toHaveCount(0);
  await sheet.getByTestId("files-filter-doc").click();
  await expect(sheet.getByTestId("files-row")).toHaveCount(1);
  await sheet.getByTestId("files-filter-all").click();

  // Relay-signed kind-5 retraction (k=1063) removes the row live.
  await page.evaluate(
    ({ indexId, retractionId }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: "file index retraction",
        kind: 5,
        id: retractionId,
        extraTags: [
          ["e", indexId],
          ["k", "1063"],
        ],
      });
    },
    { indexId: INDEX_ID_A, retractionId: RETRACTION_ID },
  );
  await expect(sheet.getByTestId("files-empty")).toBeVisible();
});

test("community Files screen mounts channel queries only on expand", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");

  await page.getByTestId("open-files-view").click();
  await expect(page.getByTestId("community-files-channels")).toBeVisible();

  // Collapsed accordion: no files list (and therefore no channel-files
  // query) exists for the channel yet — the lazy mount is the privacy
  // boundary.
  await expect(page.getByTestId("files-list")).toHaveCount(0);

  await page.getByTestId("community-files-channel-random").click();
  await expect(page.getByTestId("files-list")).toBeVisible();
});
