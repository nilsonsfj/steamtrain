/** A model id plus its human-readable label. */
export interface AgentModel {
  id: string;
  name: string;
  /**
   * Optional bucket label for picker UIs with large catalogs (e.g. Claude's
   * current/alias/1M-context/legacy split). Providers that don't set this
   * render as a flat list, as before.
   */
  group?: string;
}

/** Format a catalog entry for notices and lists. */
export function formatModelOption(model: AgentModel): string {
  return model.name === model.id ? model.id : `${model.name} (${model.id})`;
}
