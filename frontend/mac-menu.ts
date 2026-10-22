import { useEffect, useRef, useState } from "react";
import { Resource } from "@tauri-apps/api/core";
import {
  Menu,
  MenuItem,
  Submenu,
  type SubmenuOptions,
} from "@tauri-apps/api/menu";
import type { AppMenuGroup } from "./app-menu";
import { IS_MAC } from "./platform";

type Binding = { group: number; index: number; item: MenuItem };
const EDIT_ROLES = {
  Undo: "Undo",
  Redo: "Redo",
  Cut: "Cut",
  Copy: "Copy",
  Paste: "Paste",
  "Select all": "SelectAll",
} as const;

/** Keep the native menu connected to the same actions as the desktop menu. */
export function useMacMenu(
  groups: AppMenuGroup[],
  onError: (message: string) => void,
) {
  const current = useRef(groups);
  const report = useRef(onError);
  current.current = groups;
  report.current = onError;
  const [ready, setReady] = useState(false);
  const pending = useRef<Promise<Binding[]> | null>(null);
  const description = JSON.stringify(
    groups.map((group) =>
      group.items.map(({ label, disabled }) => [label, disabled]),
    ),
  );

  useEffect(() => {
    if (!IS_MAC) return;
    let cancelled = false;
    const resources: Resource[] = [];
    const own = <T extends Resource>(resource: T): T => {
      resources.push(resource);
      return resource;
    };
    const bindings: Binding[] = [];
    const action = async (group: number, index: number) => {
      const source = current.current[group].items[index];
      const item = own(
        await MenuItem.new({
          id: `spotiflex-${group}-${index}`,
          text: source.label,
          enabled: !source.disabled,
          // Space must remain available while typing a search or DJ request.
          accelerator:
            source.shortcut === "Space"
              ? undefined
              : source.shortcut === "Del"
                ? "Delete"
                : source.shortcut,
          action: () => {
            const source = current.current[group]?.items[index];
            if (!cancelled && source && !source.disabled) source.onSelect();
          },
        }),
      );
      bindings.push({ group, index, item });
      return item;
    };
    const build = async () => {
      const initial = current.current;
      const help = initial.findIndex((group) => group.label === "Help");
      const edit = initial.findIndex((group) => group.label === "Edit");
      const settings = initial[edit].items.findIndex(
        (item) => item.label === "Settings",
      );
      const appMenu = own(
        await Submenu.new({
          text: "SpotiFlex",
          items: [
            await action(help, 0),
            { item: "Separator" },
            await action(edit, settings),
            { item: "Separator" },
            { item: "Services" },
            { item: "Separator" },
            { item: "Hide" },
            { item: "HideOthers" },
            { item: "ShowAll" },
            { item: "Separator" },
            { item: "Quit", text: "Quit SpotiFlex" },
          ],
        }),
      );
      const submenus: Submenu[] = [appMenu];
      for (const [group, source] of initial.entries()) {
        const items: NonNullable<SubmenuOptions["items"]> = [];
        for (const [index, item] of source.items.entries()) {
          if (
            item.label === "Exit" ||
            item.label === "Settings" ||
            item.label === "About SpotiFlex"
          )
            continue;
          if (item.divider && items.length) items.push({ item: "Separator" });
          const role =
            source.label === "Edit"
              ? EDIT_ROLES[item.label as keyof typeof EDIT_ROLES]
              : undefined;
          items.push(role ? { item: role } : await action(group, index));
        }
        submenus.push(own(await Submenu.new({ text: source.label, items })));
      }
      const windows = own(
        await Submenu.new({
          text: "Window",
          items: [
            { item: "Minimize" },
            { item: "Maximize" },
            { item: "CloseWindow" },
            { item: "Separator" },
            { item: "BringAllToFront" },
          ],
        }),
      );
      submenus.splice(submenus.length - 1, 0, windows);
      const menu = own(await Menu.new({ items: submenus }));
      if (!cancelled) {
        await menu.setAsAppMenu();
        await windows.setAsWindowsMenuForNSApp();
        await submenus[submenus.length - 1].setAsHelpMenuForNSApp();
        if (!cancelled) setReady(true);
      }
      return bindings;
    };
    const result = build();
    pending.current = result;
    void result.catch(() => {
      if (!cancelled) report.current("Could not create the macOS menu.");
    });
    return () => {
      cancelled = true;
      const close = () =>
        Promise.allSettled(resources.reverse().map((item) => item.close()));
      void result.then(close, close);
    };
  }, []);

  useEffect(() => {
    if (!IS_MAC) return;
    void pending.current
      ?.then((bindings) =>
        Promise.all(
          bindings.flatMap(({ group, index, item }) => {
            const source = current.current[group].items[index];
            return [
              item.setText(source.label),
              item.setEnabled(!source.disabled),
            ];
          }),
        ),
      )
      .catch(() => report.current("Could not update the macOS menu."));
  }, [description]);

  return ready;
}
