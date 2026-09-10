export interface AssetLinks {
  url: string;
  downloadUrl: string;
  fileName: string;
  mimeType?: string;
  previewUnavailable?: boolean;
}

export function assetFileName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, "").trim() || "file";
}
