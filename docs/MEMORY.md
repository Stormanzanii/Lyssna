# Memory measurements

Run this from the repository root while SpotiFlex is open:

```powershell
pwsh -NoProfile -File scripts/measure-memory.ps1
```

The script follows SpotiFlex's WebView2 child processes. It reports each
process's working set, private working set and committed private bytes.
`TotalPrivateWorkingSetMiB` counts resident private memory; `TotalPrivateMiB`
counts committed memory, including pages that are not resident. Summing full
working sets counts shared mappings more than once. These columns should not
be compared interchangeably. Process command lines are never printed.

An optional budget makes the command exit with status 2 when the resident
private total exceeds the specified MiB:

```powershell
pwsh -NoProfile -File scripts/measure-memory.ps1 -BudgetMiB 600
```

## First pass: 2026-10-21

The investigation used a 3840 by 2075 physical-pixel window, Liquid Glass,
the lyrics page and the right-side Canvas. Both videos retained their source
resolution. Rust's resident private footprint was about 25 to 29 MiB;
WebView2 rendering, graphics resources and caches accounted for most of the
remaining footprint. JavaScript heap usage alone did not explain the total.

Two internal changes preserve the existing layout and effects:

- Cover images use browser lazy loading and asynchronous decoding. All song
  data and rows remain available; artwork outside the browser's preload
  distance waits until scrolling brings it closer. A 300-row browser test
  verifies that fewer than 100 covers are requested initially and that the
  final cover loads after scrolling to it.
- Liquid Glass paints its three existing shade gradients together. This
  removes a redundant full-window overlay. A browser pixel comparison checks
  the result against the previous separate-overlay rendering; other ambience
  surfaces keep their original shade.

The shade-only foreground comparison did not establish a process RAM saving:
five samples were 372.8 to 379.6 MiB before and 375.7 to 382.3 MiB after.
Both maintained about 121 animation callbacks per second on the test display.
Fewer compositor layers should not be reported as an equivalent number of
megabytes saved.

Memory depends on window size, track artwork, video resolution, browsing
history and browser cache reclamation. This change does not promise a fixed
600 MB ceiling. Microsoft describes the browser, renderer and GPU process
roles in its [WebView2 process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model).
