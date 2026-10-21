import { expect, it } from "vitest";
import { libraryTree, type LibraryEntry } from "./library-tree";
import type { FolderRef, Playlist } from "./types";

const road: FolderRef = { id: "road", name: "Road" };
const night: FolderRef = { id: "night", name: "Night" };
const playlist = (id: string, folders: FolderRef[] = []): Playlist => ({
  id,
  name: id,
  images: [],
  owner: { id: "me" },
  collaborative: false,
  folders,
});
const outline = (entries: LibraryEntry[]): unknown[] =>
  entries.map((entry) =>
    entry.kind === "playlist"
      ? entry.playlist.id
      : { [entry.folder.name]: outline(entry.entries), count: entry.count },
  );

const library = [
  playlist("a", [road]),
  playlist("b", [road, night]),
  playlist("c", [road]),
  playlist("d"),
];

it("nests playlists into Spotify folders in library order", () => {
  expect(outline(libraryTree(library, library, []))).toEqual([
    { Road: ["a", { Night: ["b"], count: 1 }, "c"], count: 3 },
    "d",
  ]);
});

it("moves a folder up with its most recent playlist and keeps pins on top", () => {
  const recentFirst = [library[3], library[2], library[0], library[1]];
  expect(outline(libraryTree(recentFirst, library, []))).toEqual([
    "d",
    { Road: ["a", { Night: ["b"], count: 1 }, "c"], count: 3 },
  ]);
  const pinnedFirst = [library[1], library[3], library[0], library[2]];
  expect(outline(libraryTree(pinnedFirst, library, ["b"]))[0]).toBe("b");
});

it("shows empty folders under the pins and inside their parents", () => {
  const folders = [
    { ...road, parents: [] },
    { ...night, parents: ["road"] },
    { id: "new", name: "New", parents: [] },
    { id: "deep", name: "Deep", parents: ["road", "night"] },
  ];
  expect(
    outline(libraryTree([library[3], library[0]], library, ["d"], folders)),
  ).toEqual([
    "d",
    { New: [], count: 0 },
    { Road: ["a", { Night: ["b", { Deep: [], count: 0 }], count: 1 }, "c"], count: 3 },
  ]);
});
