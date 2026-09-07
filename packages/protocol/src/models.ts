import type { GizmoSummary, ModelDescriptor } from "./types.js";

/** Normalize the evolving gizmo/sidebar payload without depending on one response envelope. */
export function normalizeGizmos(raw: Record<string, unknown>): GizmoSummary[] {
  const candidates: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const object = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = value as Record<string, unknown>;
    const outer = object(item.gizmo);
    const nestedCore = object(outer?.gizmo);
    const core = nestedCore ?? (typeof item.id === "string" ? item : null);
    const display = object(core?.display);
    if (core && typeof core.id === "string" && display && typeof display.name === "string") {
      candidates.push({
        ...core,
        display_name: display.name,
        description: display.description,
        profile_picture_url: display.profile_picture_url,
        ...(nestedCore && Array.isArray(outer?.files) ? { files: outer.files } : {}),
      });
    } else if (
      core && typeof core.id === "string" && typeof core.display_name === "string" &&
      ("short_url" in core || "instructions" in core || "author" in core || "profile_picture_url" in core || "tools" in core)
    ) {
      candidates.push(core);
    }
    Object.values(item).forEach(visit);
  };
  visit(raw);

  const ids = new Set<string>();
  return candidates.flatMap((item): GizmoSummary[] => {
    const id = String(item.id);
    if (ids.has(id)) return [];
    ids.add(id);
    const files = Array.isArray(item.files) ? item.files.length : undefined;
    return [{
      id,
      name: String(item.display_name),
      ...(typeof item.short_url === "string" ? { shortUrl: item.short_url } : {}),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(typeof item.profile_picture_url === "string" ? { iconUrl: item.profile_picture_url } : {}),
      ...(files !== undefined ? { filesCount: files } : {}),
      raw: item,
    }];
  });
}

export function normalizeModels(raw: Record<string, unknown>): ModelDescriptor[] {
  const models = Array.isArray(raw.models) ? raw.models : [];
  const seen = new Set<string>();
  return models.flatMap((value): ModelDescriptor[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const model = value as Record<string, unknown>;
    if (typeof model.slug !== "string") return [];
    if (seen.has(model.slug)) return [];
    seen.add(model.slug);
    return [
      {
        id: model.slug,
        title:
          typeof model.title === "string" && model.title
            ? model.title
            : model.slug,
        ...(typeof model.description === "string"
          ? { description: model.description }
          : {}),
        ...(typeof model.max_tokens === "number"
          ? { maxTokens: model.max_tokens }
          : {}),
        ...(model.capabilities !== undefined
          ? { capabilities: model.capabilities }
          : {}),
        ...(model.enabled_tools !== undefined
          ? { enabledTools: model.enabled_tools }
          : {}),
        raw: model,
      },
    ];
  });
}
