import {
  API_PROVIDER_IDS,
  apiConfigScope,
  isApiProviderId,
  resolveApiInstances,
  upsertApi,
} from "../../apis";
import { isAllowedApiBaseUrl, isValidApiKeyEnvName } from "../../config";
import type { ApiConfigScope, ApiInstanceConfig } from "../../config/types";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../types";

const SCOPE_FLAGS = ["--global", "--project"] as const;

/** Strip `--global`/`-g`/`--project`/`-p` from args and return the requested scope. */
function extractScopeFlag(args: string[]): { args: string[]; scope?: ApiConfigScope } {
  const out: string[] = [];
  let scope: ApiConfigScope | undefined;
  for (const arg of args) {
    if (arg === "--global" || arg === "-g") scope = "user";
    else if (arg === "--project" || arg === "-p") scope = "project";
    else out.push(arg);
  }
  return { args: out, scope };
}

/** Extract `--key-env <env>` and `--model <model>` value flags from args. */
function extractValueFlags(args: string[]): {
  args: string[];
  apiKeyEnv?: string;
  defaultModel?: string;
  error?: string;
} {
  const out: string[] = [];
  let apiKeyEnv: string | undefined;
  let defaultModel: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--key-env" || arg === "--model") {
      const value = args[++i];
      if (!value) return { args: out, error: `${arg} requires a value` };
      if (arg === "--key-env") apiKeyEnv = value;
      else defaultModel = value;
    } else {
      out.push(arg);
    }
  }
  return { args: out, apiKeyEnv, defaultModel };
}

function scopeName(scope: ApiConfigScope): string {
  return scope === "user" ? "global" : "project";
}

/** Persist an apis array into the config file for `scope`. */
function saveApisInScope(
  ctx: SlashCommandContext,
  scope: ApiConfigScope,
  apis: ApiInstanceConfig[],
): { ok: boolean; error?: string; path?: string } {
  if (scope === "user") {
    if (!ctx.updateUserConfig || !ctx.userConfigPath) {
      return {
        ok: false,
        error: "global API config is unavailable (running with --config?); use --project",
      };
    }
    return { ...ctx.updateUserConfig({ apis }), path: ctx.userConfigPath };
  }
  if (!ctx.updateConfig || !ctx.configPath) {
    return { ok: false, error: "API config requires a writable project steamtrain.json" };
  }
  return { ...ctx.updateConfig({ apis }), path: ctx.configPath };
}

function errorNotice(text: string): SlashCommandResult {
  return { handled: true, clearInput: true, notices: [{ level: "error", text }] };
}

/**
 * Manage the API endpoint instances `llm` workflow steps call — the
 * direct-inference sibling of `/agent`. Same scope model (global by default,
 * `--project` for the shared `steamtrain.json`), same subcommands.
 */
export const apiCommand: SlashCommand = {
  name: "api",
  description: "List, add, enable, or disable llm-step API endpoints",
  usage:
    "/api list · /api enable|disable <id> [--global|--project] · /api add <id> <anthropic|openai> [baseUrl] [--key-env <env>] [--model <model>] [--global|--project]",
  execute(rawArgs, ctx) {
    const { args: withoutScope, scope: scopeArg } = extractScopeFlag(rawArgs);
    const flags = extractValueFlags(withoutScope);
    if (flags.error) return errorNotice(flags.error);
    const args = flags.args;
    const configuredApis = resolveApiInstances(ctx.config, { includeDisabled: true });
    const layers = { userApis: ctx.userApis, projectApis: ctx.projectApis };
    // Global is the primary scope for API definitions; fall back to the
    // project file only when no global file can be written (custom --config).
    const defaultScope: ApiConfigScope = ctx.updateUserConfig ? "user" : "project";

    if (args.length === 0 || args[0] === "list") {
      const text = configuredApis
        .map((api) => {
          const state = api.enabled ? "enabled" : "disabled";
          const scope = apiConfigScope(api.id, layers);
          const scopeNote = scope ? ` ${scopeName(scope)}` : "";
          const provider = api.provider === api.id ? "" : ` provider=${api.provider}`;
          const key = ` key=${api.apiKeyEnv}${process.env[api.apiKeyEnv] ? "" : " (unset)"}`;
          const baseUrl = api.baseUrl ? ` baseUrl=${api.baseUrl}` : "";
          return `${api.id} (${state}${scopeNote}${provider}${key}${baseUrl})`;
        })
        .join(", ");
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `apis: ${text}` }],
      };
    }

    if (args[0] === "enable" || args[0] === "disable") {
      const id = args[1];
      if (!id) {
        return errorNotice(`usage: /api ${args[0]} <id> [--global|--project]`);
      }
      const existing = configuredApis.find((api) => api.id === id);
      if (!existing) {
        return errorNotice(`unknown api '${id}'`);
      }
      // Write to the scope that configures the instance; built-ins default to global.
      const scope = scopeArg ?? apiConfigScope(id, layers) ?? defaultScope;
      const rawList = scope === "user" ? layers.userApis : layers.projectApis;
      // When a flag forces a scope the instance is not configured in, copy the
      // entry from its owning scope so baseUrl/apiKeyEnv/defaultModel/pricing
      // are not silently dropped by the new (shadowing) entry.
      const raw =
        rawList?.find((api) => api.id === id) ??
        (scope === "user" ? layers.projectApis : layers.userApis)?.find((api) => api.id === id) ??
        ctx.config?.apis?.find((api) => api.id === id);
      const enabled = args[0] === "enable";
      const entry: ApiInstanceConfig = raw
        ? { ...raw, enabled }
        : { id, provider: existing.provider, enabled };
      const result = saveApisInScope(ctx, scope, upsertApi(rawList, entry));
      if (!result.ok) {
        return errorNotice(result.error ?? "failed to save config");
      }
      const shadowed =
        scope === "user" && apiConfigScope(id, layers) === "project"
          ? " (note: shadowed by a project entry in steamtrain.json)"
          : "";
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `${id} ${args[0]}d in ${result.path}${shadowed}` }],
      };
    }

    if (args[0] === "add") {
      const [id, provider, baseUrl] = [args[1], args[2], args[3]];
      if (!id || !provider || !isApiProviderId(provider)) {
        return errorNotice(
          `usage: /api add <id> <${API_PROVIDER_IDS.join("|")}> [baseUrl] [--key-env <env>] [--model <model>] [--global|--project]`,
        );
      }
      const scope = scopeArg ?? defaultScope;
      const rawList = scope === "user" ? layers.userApis : layers.projectApis;
      if (baseUrl && !isAllowedApiBaseUrl(baseUrl)) {
        return errorNotice(`baseUrl must be an http or https URL (got '${baseUrl}')`);
      }
      if (flags.apiKeyEnv && !isValidApiKeyEnvName(flags.apiKeyEnv)) {
        return errorNotice("apiKeyEnv must be an uppercase env var name (e.g. ANTHROPIC_API_KEY)");
      }
      const entry: ApiInstanceConfig = {
        id,
        provider,
        enabled: true,
        ...(baseUrl ? { baseUrl } : {}),
        ...(flags.apiKeyEnv ? { apiKeyEnv: flags.apiKeyEnv } : {}),
        ...(flags.defaultModel ? { defaultModel: flags.defaultModel } : {}),
      };
      const result = saveApisInScope(ctx, scope, upsertApi(rawList, entry));
      if (!result.ok) {
        return errorNotice(result.error ?? "failed to save config");
      }
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `${id} added (${scopeName(scope)}) in ${result.path}` }],
      };
    }

    return errorNotice(`unknown /api subcommand '${args[0]}' — try list, enable, disable, or add`);
  },
  complete(args, ctx) {
    if (args[0] === "enable" || args[0] === "disable") {
      if (args.length === 2) {
        return resolveApiInstances(ctx.config, { includeDisabled: true }).map((api) => api.id);
      }
      if (args.length === 3) return SCOPE_FLAGS;
      return [];
    }
    if (args[0] === "add") {
      if (args.length === 3) return API_PROVIDER_IDS;
      if (args.length >= 4) return ["--key-env", "--model", ...SCOPE_FLAGS];
      return [];
    }
    if (args.length === 1) return ["list", "enable", "disable", "add"];
    return [];
  },
};
