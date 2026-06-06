/** A model id plus its human-readable label. */
export interface AgentModel {
  id: string;
  name: string;
}

/** Format a catalog entry for notices and lists. */
export function formatModelOption(model: AgentModel): string {
  return model.name === model.id ? model.id : `${model.name} (${model.id})`;
}
