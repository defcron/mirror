import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { detectInlineMedia } from "../src/inline-media.js";
import { InlineMediaPreview } from "../src/InlineMediaPreview.js";

test.describe("web / inline media", () => {
  test.afterEach(cleanup);

  test("detects markdown images, linked files, data URIs and bare file URLs once in first-seen order", () => {
    const result = detectInlineMedia([
      "![cover](https://cdn.test/cover.PNG?size=small)",
      "[report](https://cdn.test/report.pdf#page=2)",
      "![data](data:image/png;base64,AAAA)",
      "data:application/octet-stream;base64,AQID",
      "https://cdn.test/report.pdf#page=2",
      "https://cdn.test/archive.tar.gz",
    ].join("\n"));
    assert.deepEqual(result, [
      { url: "https://cdn.test/cover.PNG?size=small", label: "cover", kind: "image" },
      { url: "data:image/png;base64,AAAA", label: "data", kind: "image" },
      { url: "https://cdn.test/report.pdf#page=2", label: "report", kind: "file" },
      { url: "data:application/octet-stream;base64,AQID", label: "data", kind: "file" },
      { url: "https://cdn.test/archive.tar.gz", label: "archive.tar.gz", kind: "file" },
    ]);
  });

  test("uses URL or fallback labels for empty markdown captions and ignores unrelated links", () => {
    assert.deepEqual(detectInlineMedia("![](https://cdn.test/path/photo.webp) [plain](https://example.test/page) ![](relative)"), [
      { url: "https://cdn.test/path/photo.webp", label: "photo.webp", kind: "image" },
      { url: "relative", label: "image", kind: "image" },
    ]);
    assert.deepEqual(detectInlineMedia(""), []);
    assert.deepEqual(detectInlineMedia("just text and https://example.test/without-extension"), []);
    assert.deepEqual(detectInlineMedia("![](https://cdn.test/) [](https://cdn.test/picture.png) [](https://cdn.test/readme.txt)"), [
      { url: "https://cdn.test/", label: "image", kind: "image" },
      { url: "https://cdn.test/picture.png", label: "picture.png", kind: "image" },
      { url: "https://cdn.test/readme.txt", label: "readme.txt", kind: "file" },
    ]);
  });

  test("renders nothing for text and renders image thumbnails plus downloadable file chips", () => {
    const { container, rerender } = render(React.createElement(InlineMediaPreview, { text: "ordinary words" }));
    assert.equal(container.firstChild, null);
    rerender(React.createElement(InlineMediaPreview, { text: "![art](https://cdn.test/art.gif) [archive](https://cdn.test/pack.loaf)" }));
    assert.ok(screen.getByRole("img", { name: "art" }));
    assert.equal(screen.getByRole("link", { name: "📄 archive" }).getAttribute("download"), "archive");
    assert.equal(screen.getByLabelText("Detected files and images").children.length, 2);
  });
});
