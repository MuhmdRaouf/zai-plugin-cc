/**
 * The two GLM tiers. The worker runs on Claude Code's own aliases (`sonnet`/`haiku`) mapped to GLM through
 * ANTHROPIC_DEFAULT_*_MODEL, because raw GLM ids make Claude Code log `unrecognized_model` (live probe 2026-10-06).
 */
export type ModelTier = "glm" | "flash";

export interface ModelSpec {
  readonly tier: ModelTier;
  /** Z.ai model id. */
  readonly zaiId: "glm-5.3" | "glm-5.3-flash";
  /** Claude Code alias passed to `--model`. */
  readonly alias: "sonnet" | "haiku";
}

export const MODELS: Readonly<Record<ModelTier, ModelSpec>> = {
  glm: { tier: "glm", zaiId: "glm-5.3", alias: "sonnet" },
  flash: { tier: "flash", zaiId: "glm-5.3-flash", alias: "haiku" },
};

export const ALIAS_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: MODELS.glm.zaiId,
  ANTHROPIC_DEFAULT_SONNET_MODEL: MODELS.glm.zaiId,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: MODELS.flash.zaiId,
};
