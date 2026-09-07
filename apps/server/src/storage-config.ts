import path from "node:path";

/** Resolve storage without opening the database or touching user data. */
export function resolveDataDirectory(projectRoot: string, configured?: string): string {
  return configured ?? path.join(projectRoot, ".data");
}
