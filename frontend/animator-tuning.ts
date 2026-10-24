/** Animator presets and Custom tuning, reimplemented from the
 * pixels-spicy-lyrics fork (`src/utils/Lyrics/Animator/Tuning.ts`,
 * AGPL-3.0): the same parameters, ranges, defaults, value cleaning, saved
 * presets, Randomize and SLP1 share codes. Default plays upstream Spicy
 * Lyrics' animator unchanged; Custom rests unsung text at full size
 * and apply these values to the curves and springs. */

export type AnimatorPreset = "Default" | "Custom";
export type AnimatorDetail = "Basic" | "Advanced" | "Full" | "Full + Extras";
export const ANIMATOR_PRESETS: AnimatorPreset[] = ["Default", "Custom"];
export const ANIMATOR_DETAILS: AnimatorDetail[] = [
  "Basic",
  "Advanced",
  "Full",
  "Full + Extras",
];
export type AnimatorParameterId =
  | "wordPeakScale"
  | "letterPeakScale"
  | "verticalStrength"
  | "glowStrength"
  | "blurStrength"
  | "scaleFrequency"
  | "scaleDamping"
  | "verticalFrequency"
  | "verticalDamping"
  | "glowFrequency"
  | "glowDamping";
export interface AnimatorParameter {
  id: AnimatorParameterId;
  group: string;
  level: AnimatorDetail;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  /** Typed values may go past the slider, within these bounds. */
  typedMin: number;
  typedMax: number;
  unit?: string;
  defaultValue: number;
}
export const ANIMATOR_PARAMETERS: readonly AnimatorParameter[] = [
  {
    id: "wordPeakScale",
    group: "Words",
    level: "Basic",
    label: "Word peak scale",
    description: "Peak word scale during timing animation.",
    min: 0,
    max: 2,
    step: 0.005,
    typedMin: -100,
    typedMax: 100,
    defaultValue: 1.0505,
  },
  {
    id: "letterPeakScale",
    group: "Letters",
    level: "Basic",
    label: "Emphasis peak scale",
    description: "Peak emphasis-letter scale during timing animation.",
    min: 0,
    max: 2,
    step: 0.005,
    typedMin: -100,
    typedMax: 100,
    defaultValue: 1.175,
  },
  {
    id: "verticalStrength",
    group: "Motion",
    level: "Basic",
    label: "Vertical-motion strength",
    description:
      "Multiplies existing vertical curve output. 1 is current behavior.",
    min: 0,
    max: 3,
    step: 0.01,
    typedMin: -100,
    typedMax: 100,
    defaultValue: 1,
  },
  {
    id: "glowStrength",
    group: "Glow",
    level: "Basic",
    label: "Glow strength",
    description:
      "Multiplies existing glow curve output. 1 is current behavior.",
    min: 0,
    max: 3,
    step: 0.01,
    typedMin: -100,
    typedMax: 100,
    defaultValue: 1,
  },
  {
    id: "blurStrength",
    group: "Blur",
    level: "Basic",
    label: "Blur strength",
    description: "Multiplies existing blur output. 1 is current behavior.",
    min: 0,
    max: 3,
    step: 0.01,
    typedMin: -100,
    typedMax: 100,
    defaultValue: 1,
  },
  {
    id: "scaleFrequency",
    group: "Words",
    level: "Advanced",
    label: "Scale spring frequency",
    description: "Word and letter scale spring frequency.",
    min: 0.1,
    max: 10,
    step: 0.05,
    typedMin: 0.001,
    typedMax: 1000,
    unit: "Hz",
    defaultValue: 0.88,
  },
  {
    id: "scaleDamping",
    group: "Words",
    level: "Advanced",
    label: "Scale spring damping",
    description: "Word and letter scale spring damping ratio.",
    min: 0.05,
    max: 2,
    step: 0.01,
    typedMin: 0,
    typedMax: 100,
    defaultValue: 0.64,
  },
  {
    id: "verticalFrequency",
    group: "Motion",
    level: "Advanced",
    label: "Vertical spring frequency",
    description: "Vertical-motion spring frequency.",
    min: 0.1,
    max: 10,
    step: 0.05,
    typedMin: 0.001,
    typedMax: 1000,
    unit: "Hz",
    defaultValue: 1.45,
  },
  {
    id: "verticalDamping",
    group: "Motion",
    level: "Advanced",
    label: "Vertical spring damping",
    description: "Vertical-motion spring damping ratio.",
    min: 0.05,
    max: 2,
    step: 0.01,
    typedMin: 0,
    typedMax: 100,
    defaultValue: 0.4,
  },
  {
    id: "glowFrequency",
    group: "Glow",
    level: "Advanced",
    label: "Glow spring frequency",
    description: "Glow spring frequency.",
    min: 0.1,
    max: 10,
    step: 0.05,
    typedMin: 0.001,
    typedMax: 1000,
    unit: "Hz",
    defaultValue: 1.18,
  },
  {
    id: "glowDamping",
    group: "Glow",
    level: "Advanced",
    label: "Glow spring damping",
    description: "Glow spring damping ratio.",
    min: 0.05,
    max: 2,
    step: 0.01,
    typedMin: 0,
    typedMax: 100,
    defaultValue: 0.56,
  },
];
export type AnimatorValues = Record<AnimatorParameterId, number>;
export interface SavedAnimatorPreset {
  id: string;
  name: string;
  values: AnimatorValues;
}
/** What settings keep for the animator. */
export interface AnimatorSettings {
  preset?: AnimatorPreset;
  detail?: AnimatorDetail;
  custom?: Partial<AnimatorValues>;
  saved?: SavedAnimatorPreset[];
  selected?: string | null;
}
export const ANIMATOR_DEFAULTS = Object.freeze(
  Object.fromEntries(
    ANIMATOR_PARAMETERS.map((item) => [item.id, item.defaultValue]),
  ) as AnimatorValues,
);
/** Spikerko/spicy-lyrics main 2a14863f, kept apart from the editable
 * defaults as the fork does. */
export const UPSTREAM_ANIMATOR_VALUES: Readonly<AnimatorValues> = Object.freeze(
  {
    wordPeakScale: 1.0505,
    letterPeakScale: 1.175,
    verticalStrength: 1,
    glowStrength: 1,
    blurStrength: 1,
    scaleFrequency: 0.88,
    scaleDamping: 0.64,
    verticalFrequency: 1.45,
    verticalDamping: 0.4,
    glowFrequency: 1.18,
    glowDamping: 0.56,
  },
);
const parameter = (id: AnimatorParameterId) =>
  ANIMATOR_PARAMETERS.find((entry) => entry.id === id)!;
/** Clamps a typed value to its bounds at four decimals. */
export function animatorValue(id: AnimatorParameterId, value: unknown) {
  const item = parameter(id);
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(
        Math.min(item.typedMax, Math.max(item.typedMin, value)) * 10_000,
      ) / 10_000
    : item.defaultValue;
}
/** Known, finite values only. */
export function cleanAnimatorValues(input: unknown): Partial<AnimatorValues> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    ANIMATOR_PARAMETERS.flatMap((item) => {
      const value = (input as Record<string, unknown>)[item.id];
      return typeof value === "number" && Number.isFinite(value)
        ? [[item.id, animatorValue(item.id, value)]]
        : [];
    }),
  ) as Partial<AnimatorValues>;
}
export function cleanSavedPresets(input: unknown): SavedAnimatorPreset[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((preset) =>
    preset &&
    typeof preset === "object" &&
    typeof preset.id === "string" &&
    typeof preset.name === "string"
      ? [
          {
            id: preset.id,
            name: preset.name,
            values: {
              ...ANIMATOR_DEFAULTS,
              ...cleanAnimatorValues(preset.values),
            },
          },
        ]
      : [],
  );
}
export const presetOf = (settings: AnimatorSettings = {}): AnimatorPreset =>
  ANIMATOR_PRESETS.includes(settings.preset as AnimatorPreset)
    ? settings.preset!
    : "Default";
/** The values the animator plays. */
export function animatorValues(
  settings: AnimatorSettings = {},
): AnimatorValues {
  const preset = presetOf(settings);
  return preset === "Default"
    ? { ...UPSTREAM_ANIMATOR_VALUES }
    : {
        ...ANIMATOR_DEFAULTS,
        ...(preset === "Custom" ? cleanAnimatorValues(settings.custom) : {}),
      };
}
/** Unsung text rests at 0.95 under Default, full size otherwise. */
export const idleScale = (settings: AnimatorSettings = {}) =>
  presetOf(settings) === "Default" ? 0.95 : 1;

/** Choosing Custom the first time copies the values playing now. */
export function choosePreset(
  settings: AnimatorSettings,
  preset: AnimatorPreset,
): AnimatorSettings {
  const custom =
    preset === "Custom" && !Object.keys(settings.custom ?? {}).length
      ? animatorValues(settings)
      : settings.custom;
  return { ...settings, preset, custom };
}
/** Editing a value switches to Custom. */
export function setValue(
  settings: AnimatorSettings,
  id: AnimatorParameterId,
  value: number,
): AnimatorSettings {
  const base =
    presetOf(settings) === "Custom"
      ? settings
      : choosePreset(settings, "Custom");
  return {
    ...base,
    preset: "Custom",
    custom: { ...base.custom, [id]: animatorValue(id, value) },
  };
}
export const resetValues = (settings: AnimatorSettings): AnimatorSettings => ({
  ...settings,
  custom: { ...ANIMATOR_DEFAULTS },
});
/** The saved-preset list's built-in entry: upstream values. */
export const DEFAULT_PRESET_ID = "default";
export function loadPreset(
  settings: AnimatorSettings,
  id: string,
): AnimatorSettings {
  if (id === DEFAULT_PRESET_ID)
    return {
      ...settings,
      preset: "Custom",
      custom: { ...ANIMATOR_DEFAULTS },
      selected: id,
    };
  const preset = cleanSavedPresets(settings.saved).find(
    (item) => item.id === id,
  );
  if (!preset) return settings;
  return {
    ...settings,
    preset: "Custom",
    custom: { ...ANIMATOR_DEFAULTS, ...cleanAnimatorValues(preset.values) },
    selected: id,
  };
}
const newId = () =>
  `animator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** Saves Custom tuning under a name; a matching name is overwritten. */
export function savePreset(
  settings: AnimatorSettings,
  name: string,
): AnimatorSettings {
  const trimmed = name.trim();
  if (!trimmed) return settings;
  const presets = cleanSavedPresets(settings.saved);
  const existing = presets.find(
    (item) => item.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  const values = {
    ...ANIMATOR_DEFAULTS,
    ...cleanAnimatorValues(settings.custom),
  };
  const id = existing?.id ?? newId();
  return {
    ...settings,
    saved: existing
      ? presets.map((item) =>
          item.id === id ? { id, name: trimmed, values } : item,
        )
      : [...presets, { id, name: trimmed, values }],
    selected: id,
  };
}
export function deletePreset(
  settings: AnimatorSettings,
  id: string,
): AnimatorSettings {
  return {
    ...settings,
    saved: cleanSavedPresets(settings.saved).filter((item) => item.id !== id),
    selected: settings.selected === id ? null : settings.selected,
  };
}
const SHARE_PREFIX = "SLP1:";
const LEGACY_SHARE_PREFIX = "SLAP1:";
const decodeBase64Url = (value: string) =>
  new TextDecoder().decode(
    Uint8Array.from(
      atob(
        value.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (value.length % 4)) % 4),
      ),
      (char) => char.charCodeAt(0),
    ),
  );
/** The fork's share code: `SLP1:<name>|v1,v2,…` in parameter order. */
export function shareCode(name: string, source: unknown): string {
  const values = { ...ANIMATOR_DEFAULTS, ...cleanAnimatorValues(source) };
  return `${SHARE_PREFIX}${encodeURIComponent(name.trim() || "Shared Preset")}|${ANIMATOR_PARAMETERS.map(({ id }) => values[id]).join(",")}`;
}
/** Imports a share code as a new saved preset and loads it. */
export function importCode(
  settings: AnimatorSettings,
  code: string,
): { settings: AnimatorSettings; name: string } {
  if (code.length > 65_536) throw new Error("Preset code is too large.");
  let input: { name?: unknown; values?: unknown };
  if (code.startsWith(SHARE_PREFIX)) {
    const separator = code.indexOf("|", SHARE_PREFIX.length);
    if (separator < 0) throw new Error("Preset code is invalid or damaged.");
    let name: string;
    try {
      name = decodeURIComponent(code.slice(SHARE_PREFIX.length, separator));
    } catch {
      throw new Error("Preset code is invalid or damaged.");
    }
    const raw = code.slice(separator + 1).split(",");
    if (raw.length !== ANIMATOR_PARAMETERS.length)
      throw new Error("Preset code has missing animator values.");
    const numbers = raw.map(Number);
    if (
      raw.some(
        (value, index) => !value.trim() || !Number.isFinite(numbers[index]),
      )
    )
      throw new Error("Preset code has invalid animator values.");
    input = {
      name,
      values: Object.fromEntries(
        ANIMATOR_PARAMETERS.map(({ id }, index) => [id, numbers[index]]),
      ),
    };
  } else if (code.startsWith(LEGACY_SHARE_PREFIX)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        decodeBase64Url(code.slice(LEGACY_SHARE_PREFIX.length)),
      );
    } catch {
      throw new Error("Preset code is invalid or damaged.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Preset code has no preset data.");
    input = parsed as typeof input;
  } else throw new Error("Not a Spicy Lyrics animator preset.");
  const values = cleanAnimatorValues(input.values);
  if (!Object.keys(values).length)
    throw new Error("Preset has no recognized animator values.");
  const baseName =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim().slice(0, 80)
      : "Imported Preset";
  const saved = cleanSavedPresets(settings.saved);
  const taken = new Set(saved.map((preset) => preset.name.toLocaleLowerCase()));
  let name = baseName,
    suffix = 2;
  while (taken.has(name.toLocaleLowerCase()))
    name = `${baseName} (${suffix++})`;
  const preset = {
    id: newId(),
    name,
    values: { ...ANIMATOR_DEFAULTS, ...values },
  };
  return {
    name,
    settings: {
      ...settings,
      preset: "Custom",
      custom: preset.values,
      saved: [...saved, preset],
      selected: preset.id,
    },
  };
}
/** Random slider steps for the shown parameters, as the fork's Randomize. */
export function randomize(
  settings: AnimatorSettings,
  ids: AnimatorParameterId[],
  random = Math.random,
): AnimatorSettings {
  const next = {
    ...ANIMATOR_DEFAULTS,
    ...cleanAnimatorValues(settings.custom),
  };
  for (const id of ids) {
    const item = parameter(id);
    const steps = Math.round((item.max - item.min) / item.step);
    next[id] =
      Math.round(
        (item.min + Math.floor(random() * (steps + 1)) * item.step) * 100,
      ) / 100;
  }
  return { ...settings, preset: "Custom", custom: next, selected: null };
}
/** Parameters shown at a detail level. */
export const visibleParameters = (detail: AnimatorDetail = "Basic") =>
  ANIMATOR_PARAMETERS.filter(
    (item) =>
      ANIMATOR_DETAILS.indexOf(item.level) <=
      Math.max(0, ANIMATOR_DETAILS.indexOf(detail)),
  );
