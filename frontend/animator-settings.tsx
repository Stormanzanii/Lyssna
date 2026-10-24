import { Fragment, useEffect, useState } from "react";
import { X } from "lucide-react";
import { rpc } from "./bridge";
import { SettingRow } from "./setting-row";
import {
  ANIMATOR_DETAILS,
  ANIMATOR_PRESETS,
  animatorValues,
  choosePreset,
  cleanSavedPresets,
  deletePreset,
  importCode,
  loadPreset,
  presetOf,
  randomize,
  resetValues,
  savePreset,
  setValue,
  shareCode,
  visibleParameters,
  type AnimatorDetail,
  type AnimatorParameter,
  type AnimatorPreset,
  type AnimatorSettings,
} from "./animator-tuning";

// The webview refuses clipboard reads while its document lacks focus, so
// the app reads the clipboard natively.
const readClipboard = () =>
  rpc<string>("read_clipboard").catch(() => navigator.clipboard.readText());

const PRESET_HELP = "Default matches upstream. Custom stores live tuning.";

/** Spicy Lyrics' Animator Presets row, with Manage for Custom tuning. */
export function AnimatorPresetRow({
  animator = {},
  onChange,
  onManage,
}: {
  animator?: AnimatorSettings;
  onChange: (animator: AnimatorSettings) => void;
  onManage: () => void;
}) {
  const preset = presetOf(animator);
  return (
    <SettingRow
      label="Animator Presets"
      help={PRESET_HELP}
      keywords="animator preset default custom tuning spring"
    >
      <span className="animator-preset-control">
        <select
          className="settings-select"
          aria-label="Animator preset"
          value={preset}
          onChange={(event) =>
            onChange(
              choosePreset(animator, event.target.value as AnimatorPreset),
            )
          }
        >
          {ANIMATOR_PRESETS.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        {preset === "Custom" && (
          <button className="pill outline" onClick={onManage}>
            Manage
          </button>
        )}
      </span>
    </SettingRow>
  );
}

function ValueSlider({
  parameter,
  value,
  onChange,
}: {
  parameter: AnimatorParameter;
  value: number;
  onChange: (value: number) => void;
}) {
  const [typed, setTyped] = useState(String(value));
  useEffect(() => setTyped(String(value)), [value]);
  const commit = () => {
    const number = Number(typed);
    if (typed.trim() && Number.isFinite(number)) onChange(number);
    else setTyped(String(value));
  };
  return (
    <span className="animator-slider">
      <input
        type="range"
        aria-label={parameter.label}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        value={Math.min(parameter.max, Math.max(parameter.min, value))}
        style={{
          ["--range" as string]: `${
            ((Math.min(parameter.max, Math.max(parameter.min, value)) -
              parameter.min) /
              (parameter.max - parameter.min)) *
            100
          }%`,
        }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        className="number-field"
        aria-label={`${parameter.label} value`}
        inputMode="decimal"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {parameter.unit && (
        <span className="animator-unit">{parameter.unit}</span>
      )}
      <button
        className="pill outline"
        title={`Reset to ${parameter.defaultValue}`}
        disabled={value === parameter.defaultValue}
        onClick={() => onChange(parameter.defaultValue)}
      >
        Reset
      </button>
    </span>
  );
}

/** The fork's Animator Behavior panel: saved presets, share codes, detail
 * level and live Custom tuning. */
export function AnimatorBehavior({
  animator = {},
  onChange,
  onBack,
}: {
  animator?: AnimatorSettings;
  onChange: (animator: AnimatorSettings) => void;
  onBack: () => void;
}) {
  const detail = ANIMATOR_DETAILS.includes(animator.detail as AnimatorDetail)
    ? animator.detail!
    : "Basic";
  const values = animatorValues(animator);
  const presets = cleanSavedPresets(animator.saved);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [presetToLoad, setPresetToLoad] = useState(animator.selected ?? "");
  useEffect(
    () => setPresetToLoad(animator.selected ?? ""),
    [animator.selected],
  );
  const visible = visibleParameters(detail);
  const groups = [...new Set(visible.map((parameter) => parameter.group))];
  const shared =
    presets.find((preset) => preset.id === presetToLoad) ??
    presets.find((preset) => preset.id === animator.selected);
  const importFrom = (code: string) => {
    const result = importCode(animator, code.trim());
    onChange(result.settings);
    setMessage(`Imported ${result.name}.`);
  };
  return (
    <div className="animator-behavior">
      <div className="animator-toolbar">
        <button className="pill outline" onClick={onBack}>
          Back
        </button>
        <button
          className="pill outline"
          onClick={() =>
            onChange(
              randomize(
                animator,
                visible.map((parameter) => parameter.id),
              ),
            )
          }
        >
          Randomize
        </button>
      </div>
      <h3 className="animator-heading">Presets</h3>
      <SettingRow
        label="Saved preset"
        help="Loading a preset copies it into working Custom tuning."
      >
        <span className="animator-preset-control">
          <select
            className="settings-select"
            aria-label="Saved preset"
            value={presetToLoad}
            disabled={!presets.length}
            onChange={(event) => setPresetToLoad(event.target.value)}
          >
            <option value="">
              {presets.length ? "Choose…" : "None saved"}
            </option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          <button
            className="pill outline"
            disabled={!presetToLoad}
            onClick={() => onChange(loadPreset(animator, presetToLoad))}
          >
            Load
          </button>
        </span>
      </SettingRow>
      <div className="animator-preset-actions">
        <input
          className="number-field animator-name"
          value={name}
          maxLength={80}
          placeholder="Preset name"
          aria-label="Preset name"
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="pill outline"
          disabled={!name.trim()}
          onClick={() => {
            onChange(savePreset(animator, name));
            setName("");
          }}
        >
          Save
        </button>
        <button
          className="pill outline"
          disabled={!presetToLoad}
          onClick={() => {
            onChange(deletePreset(animator, presetToLoad));
            setPresetToLoad("");
          }}
        >
          Delete Current
        </button>
        <button
          className="pill outline"
          onClick={() => {
            const code = shareCode(
              shared?.name ?? name,
              shared?.values ?? animator.custom,
            );
            navigator.clipboard
              .writeText(code)
              .then(() => setMessage("Preset copied to clipboard."))
              .catch(() => setMessage("Could not copy preset."));
          }}
        >
          Share
        </button>
        <button
          className="pill outline"
          onClick={() => {
            // A code typed into the name box imports without the clipboard.
            if (/^SLA?P1:/.test(name.trim())) {
              try {
                importFrom(name);
                setName("");
              } catch (error) {
                setMessage((error as Error).message);
              }
              return;
            }
            readClipboard()
              .then((code) => {
                if (!code.trim())
                  throw new Error("Clipboard has no preset code.");
                importFrom(code);
              })
              .catch((error) =>
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "Could not import preset.",
                ),
              );
          }}
        >
          Import
        </button>
      </div>
      {message && (
        <p className="setting-help animator-message" role="status">
          {message}
        </p>
      )}
      <h3 className="animator-heading">Animator Behavior</h3>
      <SettingRow
        label="Detail level"
        help="Levels add controls; changing level never changes saved values."
      >
        <select
          className="settings-select"
          aria-label="Detail level"
          value={detail}
          onChange={(event) =>
            onChange({
              ...animator,
              detail: event.target.value as AnimatorDetail,
            })
          }
        >
          {ANIMATOR_DETAILS.map((level) => (
            <option key={level}>{level}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label="Reset all to Default"
        help="Resets saved Custom tuning only."
      >
        <button
          className="pill outline"
          onClick={() => onChange(resetValues(animator))}
        >
          Reset all
        </button>
      </SettingRow>
      {groups.map((group) => (
        <Fragment key={group}>
          <h3 className="animator-heading">{group}</h3>
          {visible
            .filter((parameter) => parameter.group === group)
            .map((parameter) => (
              <SettingRow
                key={parameter.id}
                label={parameter.label}
                help={parameter.description}
                stacked
              >
                <ValueSlider
                  parameter={parameter}
                  value={values[parameter.id]}
                  onChange={(value) =>
                    onChange(setValue(animator, parameter.id, value))
                  }
                />
              </SettingRow>
            ))}
        </Fragment>
      ))}
      {(detail === "Full" || detail === "Full + Extras") && (
        <p className="setting-help">
          More Full controls will appear as renderer options are made
          configurable.
        </p>
      )}
    </div>
  );
}

/** Custom tuning floating over full screen lyrics, as the fork's Manage
 * opens it: the lyrics keep playing beside it so each change shows live.
 * Escape closes the panel without leaving full screen. */
export function AnimatorPanel({
  animator,
  onChange,
  onBack,
  onClose,
}: {
  animator?: AnimatorSettings;
  onChange: (animator: AnimatorSettings) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);
  return (
    <aside
      className="animator-panel lyrics-settings"
      role="dialog"
      aria-label="Animator Behavior"
    >
      <header className="animator-panel-header">
        <h2>Animator Behavior</h2>
        <button
          className="icon-button"
          title="Close Animator Behavior"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="animator-panel-body lyrics-settings-group">
        <AnimatorBehavior
          animator={animator}
          onChange={onChange}
          onBack={onBack}
        />
      </div>
    </aside>
  );
}
