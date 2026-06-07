import { z } from "zod";

export interface SteamtrainSettings {
  /** Max prompt history entries kept per tab (default 100). */
  promptHistoryLimit?: number;
}

/** Schema for `~/.steamtrain/settings.json` — merged onto defaults. */
export const settingsFileSchema = z
  .object({
    promptHistoryLimit: z.number().int().positive().max(10_000).optional(),
  })
  .strict();

export type SettingsFile = z.infer<typeof settingsFileSchema>;
