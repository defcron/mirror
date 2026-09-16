import { useMemo } from "react";
import { detectInlineMedia } from "./inline-media.js";

/** Renders thumbnails/download chips for every image/file reference found in `text`. Renders nothing when there's nothing to show. */
export function InlineMediaPreview({ text }: { text: string }) {
  // Streaming output calls this on every chunk with the whole accumulated
  // string so far; re-scanning from scratch each time (four regex passes,
  // one of them over arbitrarily long base64 runs) would be quadratic in the
  // response length without this memo.
  const media = useMemo(() => detectInlineMedia(text), [text]);
  if (!media.length) return null;
  return (
    <div className="inline-media-preview" aria-label="Detected files and images">
      {media.map((item, index) =>
        item.kind === "image" ? (
          <a
            className="inline-media-thumb"
            key={index}
            href={item.url}
            target="_blank"
            rel="noreferrer"
            title={item.label}
          >
            <img src={item.url} alt={item.label} loading="lazy" />
          </a>
        ) : (
          <a className="inline-media-file" key={index} href={item.url} download={item.label} target="_blank" rel="noreferrer">
            📄 {item.label}
          </a>
        ),
      )}
    </div>
  );
}
