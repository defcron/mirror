import { extname } from "node:path";

// Upload classification is based only on the supplied filename. Neither
// browser/data-URL Content-Type nor magic bytes determine the upload route.
const TYPES: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".jsonl": "application/x-ndjson",
  ".html": "text/html", ".htm": "text/html", ".xml": "application/xml",
  ".yaml": "application/yaml", ".yml": "application/yaml",
  ".pdf": "application/pdf", ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".avif": "image/avif", ".heic": "image/heic", ".heif": "image/heif",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4",
};

export function uploadMimeType(fileName: string): string {
  return TYPES[extname(fileName.trim()).toLowerCase()] ?? "application/octet-stream";
}
