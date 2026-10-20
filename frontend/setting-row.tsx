import { createContext, useContext, type ReactNode } from "react";

/** Current settings search text; rows that do not match it are hidden. */
export const SettingsQuery = createContext("");

export function matchesSetting(
  query: string,
  ...texts: (string | undefined)[]
) {
  const needle = query.trim().toLowerCase();
  return !needle || texts.some((text) => text?.toLowerCase().includes(needle));
}

export function SettingRow({
  label,
  help,
  keywords,
  stacked = false,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  keywords?: string;
  stacked?: boolean;
  children?: ReactNode;
}) {
  const query = useContext(SettingsQuery);
  const text = [label, help].filter(
    (part): part is string => typeof part === "string",
  );
  if (!matchesSetting(query, ...text, keywords)) return null;
  return (
    <div className={`setting-row ${stacked ? "stacked" : ""}`}>
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {help && <p className="setting-help">{help}</p>}
      </div>
      {children !== undefined && (
        <div className="setting-control">{children}</div>
      )}
    </div>
  );
}
