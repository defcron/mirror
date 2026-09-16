// Scans arbitrary chat text (a model reply, a user draft, a history entry)
// for things that are actually files/images rather than plain words: markdown
// image syntax, bare data: URIs (exactly what /api/convert/*/encode and
// /gpt-prompt hand back when a caller inlines them into a message), and
// plain http(s) links that end in a recognizable file extension. Detection
// only -- rendering lives in InlineMediaPreview.tsx.

export interface DetectedMedia {
  url: string;
  label: string;
  /** "image" gets an <img> thumbnail; "file" gets a download chip. */
  kind: "image" | "file";
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#]|$)/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((\S+?)\)/g;
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\((\S+?)\)/g;
const BARE_DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g;
const BARE_FILE_URL = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|bmp|avif|pdf|loaf|zip|gz|json|txt)(?:[?#]\S*)?/gi;

function isImageUrl(url: string): boolean {
  return url.startsWith("data:image/") || IMAGE_EXTENSIONS.test(url);
}

function filenameFromUrl(url: string, fallback: string): string {
  if (url.startsWith("data:")) return fallback;
  try {
    const path = new URL(url).pathname;
    const name = path.split("/").pop();
    return name || fallback;
  } catch {
    return fallback;
  }
}

/** Finds every image/file reference in `text`, de-duplicated by URL, in first-seen order. */
export function detectInlineMedia(text: string): DetectedMedia[] {
  if (!text) return [];
  const seen = new Set<string>();
  const results: DetectedMedia[] = [];
  const add = (url: string, label: string, kind: "image" | "file") => {
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ url, label, kind });
  };

  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    add(match[2], match[1] || filenameFromUrl(match[2], "image"), "image");
  }
  // A fresh, non-global copy for this .test() call: BARE_FILE_URL is `g`-flagged
  // and reused below in a `matchAll` over the same string, so testing against
  // the shared instance would leave its `lastIndex` non-zero and silently skip
  // matches in that later pass.
  const fileUrlPattern = new RegExp(BARE_FILE_URL.source, "i");
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const url = match[2];
    if (url.startsWith("data:") || fileUrlPattern.test(url) || IMAGE_EXTENSIONS.test(url)) {
      add(url, match[1] || filenameFromUrl(url, "file"), isImageUrl(url) ? "image" : "file");
    }
  }
  for (const match of text.matchAll(BARE_DATA_URI)) {
    add(match[0], filenameFromUrl(match[0], "data"), isImageUrl(match[0]) ? "image" : "file");
  }
  for (const match of text.matchAll(BARE_FILE_URL)) {
    add(match[0], filenameFromUrl(match[0], "file"), isImageUrl(match[0]) ? "image" : "file");
  }
  return results;
}
