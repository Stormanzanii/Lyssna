<#
.SYNOPSIS
Builds Lyssna from source and installs it for the current Windows user.

.DESCRIPTION
No target: update main from origin, then build and install the latest commit.
local:     build the current checkout, including uncommitted changes.
branch:    fetch that branch from origin and build its latest commit.
commit:    build a commit already available in this repository.

The original branch or commit is restored afterward, including on failure.
Nothing is pushed. The build is installed to
%LOCALAPPDATA%\Programs\Lyssna\lyssna.exe and started, unless
-NoLaunch is given. Credentials and application data are not touched.
#>
param(
    [Parameter(Position = 0, HelpMessage = 'Optional target: local, branch, or commit hash.')]
    [string]$Target,

    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Lyssna'
$installedExe = Join-Path $installDirectory 'lyssna.exe'
# Lyssna was SpotiFlex, installed here as spotiflex.exe.
$formerInstallDirectory = Join-Path $env:LOCALAPPDATA 'Programs\SpotiFlex'

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)

    $output = & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
    return $output
}

function Get-GitPosition {
    $branch = & git symbolic-ref --quiet --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $branch) {
        return [PSCustomObject]@{ Branch = $branch.Trim(); Commit = $null }
    }
    $commit = (Invoke-Git rev-parse --verify HEAD | Select-Object -First 1).Trim()
    return [PSCustomObject]@{ Branch = $null; Commit = $commit }
}

function Restore-GitPosition {
    param([Parameter(Mandatory)]$Position)

    if ($Position.Branch) {
        Invoke-Git switch --quiet $Position.Branch | Out-Null
    }
    else {
        Invoke-Git switch --quiet --detach $Position.Commit | Out-Null
    }
}

function Find-CMake {
    if ($env:CMAKE -and (Test-Path -LiteralPath $env:CMAKE)) {
        return $env:CMAKE
    }
    $onPath = Get-Command cmake -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }
    # Visual Studio's C++ workload ships CMake without putting it on PATH.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        return $null
    }
    foreach ($installation in @(& $vswhere -products * -property installationPath)) {
        $bundled = Join-Path $installation 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
        if (Test-Path -LiteralPath $bundled) {
            return $bundled
        }
    }
    return $null
}

function Assert-Prerequisites {
    foreach ($tool in 'git', 'node', 'npm', 'rustup', 'cargo') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Missing $tool. See the Windows build prerequisites in README.md."
        }
    }

    $cmake = Find-CMake
    if (-not $cmake) {
        throw 'Missing CMake. Install it or the Visual Studio C++ CMake tools.'
    }
    # The cmake crate reads CMAKE before searching PATH.
    $env:CMAKE = $cmake

    $nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
    if ($nodeMajor -lt 24) {
        throw 'Node.js 24 or later is required.'
    }

    # bindgen needs libclang. Use LIBCLANG_PATH when set, otherwise a standard
    # LLVM install or the copy the repository's diagnostics tooling downloads.
    if ($env:LIBCLANG_PATH) {
        if (-not (Test-Path -LiteralPath (Join-Path $env:LIBCLANG_PATH 'libclang.dll'))) {
            throw "LIBCLANG_PATH does not contain libclang.dll: $env:LIBCLANG_PATH"
        }
        return
    }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'LLVM\bin'),
        (Join-Path $repoRoot 'target\diagnostics\build-tools\clang\native')
    )
    $found = $candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'libclang.dll') } | Select-Object -First 1
    if (-not $found) {
        throw 'libclang.dll not found. Install LLVM or set LIBCLANG_PATH to the folder containing libclang.dll.'
    }
    $env:LIBCLANG_PATH = $found
}

function Get-RequiredRust {
    $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'Cargo.toml') -Raw
    if ($manifest -notmatch '(?m)^rust-version\s*=\s*"([^"]+)"') {
        throw 'Cargo.toml is missing rust-version.'
    }
    $version = $Matches[1]
    if ($version.Split('.').Count -eq 2) {
        $version = "$version.0"
    }
    return $version
}

function Get-LyssnaProcesses([string]$Directory) {
    $prefix = "$([IO.Path]::GetFullPath($Directory).TrimEnd('\'))\"
    @(Get-CimInstance Win32_Process -Filter "Name = 'lyssna.exe' OR Name = 'spotiflex.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

# Whether something holds the file open, so it can't be replaced.
function Test-FileLocked([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    try {
        [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None').Dispose()
        return $false
    }
    catch {
        return $true
    }
}

# Swap the staged build in. Moving over an existing executable can fail
# ("Cannot create a file when that file already exists"), so the old one is
# renamed aside first, which Windows allows even while it runs, and put
# back if the new one can't take its place.
function Install-Executable([string]$Staged) {
    $previous = "$installedExe.old"
    Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
    $hadPrevious = Test-Path -LiteralPath $installedExe
    if ($hadPrevious) {
        Move-Item -LiteralPath $installedExe -Destination $previous -ErrorAction Stop
    }
    try {
        Move-Item -LiteralPath $Staged -Destination $installedExe -ErrorAction Stop
    }
    catch {
        if ($hadPrevious) {
            Move-Item -LiteralPath $previous -Destination $installedExe -ErrorAction SilentlyContinue
        }
        throw
    }
    Remove-PreviousExecutable
}

# Delete the exe the install replaced. A copy still closing holds it for a
# moment, so keep trying for a while.
function Remove-PreviousExecutable {
    $previous = "$installedExe.old"
    $deadline = (Get-Date).AddSeconds(15)
    while (Test-Path -LiteralPath $previous) {
        Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $previous)) {
            break
        }
        if ((Get-Date) -ge $deadline) {
            Write-Warning "Could not delete $previous yet; the next build removes it."
            break
        }
        Start-Sleep -Milliseconds 250
    }
}

function Stop-InstalledLyssna([string]$Directory = $installDirectory) {
    $processes = Get-LyssnaProcesses $Directory
    if ($processes.Count -eq 0) {
        return
    }

    # Ask Lyssna to quit first so it can save its state. Closing the
    # window alone only hides it to the tray when music keeps playing, so
    # `--quit` reaches the running copy and exits it fully; builds without it
    # still get the window close.
    foreach ($process in $processes) {
        $running = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($running) {
            Write-Host "Closing installed Lyssna (PID $($process.ProcessId))."
        }
    }
    $quitter = Start-Process -FilePath $processes[0].ExecutablePath -ArgumentList '--quit' -PassThru -ErrorAction SilentlyContinue
    if ($quitter) {
        [void]$quitter.WaitForExit(5000)
    }
    $deadline = (Get-Date).AddSeconds(3)
    do {
        if (-not @($processes | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })) {
            return
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    foreach ($process in $processes) {
        $running = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($running) {
            [void]$running.CloseMainWindow()
        }
    }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = @($processes | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
        if ($remaining.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    foreach ($process in $remaining) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}

if ($Target -in '-h', '--help', 'help') {
    Get-Help $PSCommandPath -Detailed
    return
}

Push-Location $repoRoot
$originalGitPosition = $null
$restoreGitPosition = $false
try {
    Assert-Prerequisites

    if ($Target -eq 'local') {
        Write-Host 'Building current checkout without Git changes.'
    }
    else {
        $changes = @(Invoke-Git status --porcelain=v1 --untracked-files=normal)
        if ($changes.Count -gt 0) {
            throw 'Commit or stash changes first, or use ./build.ps1 local.'
        }
        $originalGitPosition = Get-GitPosition
        $restoreGitPosition = $true

        if ([string]::IsNullOrWhiteSpace($Target)) {
            Write-Host 'Updating main from origin.'
            Invoke-Git switch --quiet main | Out-Null
            Invoke-Git pull --ff-only origin main | Out-Null
        }
        else {
            if ($Target.StartsWith('-')) {
                throw 'Unknown option. Run ./build.ps1 --help.'
            }
            & git check-ref-format "refs/heads/$Target" 2>$null | Out-Null
            $validBranch = $LASTEXITCODE -eq 0
            $onOrigin = $false
            if ($validBranch) {
                & git ls-remote --exit-code --heads origin "refs/heads/$Target" 2>$null | Out-Null
                $onOrigin = $LASTEXITCODE -eq 0
            }

            if ($onOrigin) {
                # On origin: build its latest commit.
                Invoke-Git fetch --no-tags origin "refs/heads/$Target" | Out-Null
                $commit = (Invoke-Git rev-parse --verify 'FETCH_HEAD^{commit}' | Select-Object -First 1).Trim()
            }
            else {
                # Only local: build the branch or commit as it is.
                $commit = & git rev-parse --verify --quiet --end-of-options "$Target^{commit}" 2>$null
                if ($LASTEXITCODE -ne 0 -or -not $commit) {
                    throw "'$Target' is not a branch on origin, a local branch or a commit."
                }
                $commit = ($commit | Select-Object -First 1).Trim()
            }
            Write-Host "Switching to $commit."
            Invoke-Git switch --quiet --detach $commit | Out-Null
        }
    }

    if (-not $env:RUSTUP_TOOLCHAIN) {
        $env:RUSTUP_TOOLCHAIN = Get-RequiredRust
    }
    & rustup run $env:RUSTUP_TOOLCHAIN rustc --version *> $null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Checked rustup toolchain install $env:RUSTUP_TOOLCHAIN --profile minimal --no-self-update
    }

    $shortCommit = (Invoke-Git rev-parse --short HEAD | Select-Object -First 1).Trim()
    Write-Host "Building $shortCommit with Rust $env:RUSTUP_TOOLCHAIN."
    Invoke-Checked npm ci --no-audit --no-fund
    Invoke-Checked npm run build
    # Marks the executable as a local build, so the updater never replaces
    # it with a release. Rebuild with this script to update.
    $env:LYSSNA_LOCAL_BUILD = '1'
    $builtExe = Join-Path $repoRoot 'target\release\lyssna.exe'
    $targetDirectory = Join-Path $repoRoot 'target'
    try {
        # A Lyssna started from target\ locks the executable Cargo
        # replaces. Close it first; if the build still fails on a locked
        # file, say so and try once more.
        Stop-InstalledLyssna $targetDirectory
        try {
            Invoke-Checked cargo build --release --locked --bin lyssna
        }
        catch {
            $holders = Get-LyssnaProcesses $targetDirectory
            if ($holders.Count -eq 0 -and -not (Test-FileLocked $builtExe)) {
                throw
            }
            Write-Warning "Build failed because Lyssna is open from $targetDirectory (PID $(@($holders.ProcessId) -join ', ')). Closing it and building again."
            Stop-InstalledLyssna $targetDirectory
            if (Test-FileLocked $builtExe) {
                throw "Build failed: $builtExe is still in use. Close Lyssna (check the system tray) and run the build again."
            }
            Invoke-Checked cargo build --release --locked --bin lyssna
        }
    }
    finally {
        Remove-Item Env:LYSSNA_LOCAL_BUILD -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $builtExe)) {
        throw "Build finished without $builtExe."
    }

    # Stage beside the install so the swap is a rename on the same volume.
    New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
    $staged = Join-Path $installDirectory ('.lyssna-' + [Guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $builtExe -Destination $staged
    try {
        Stop-InstalledLyssna
        Stop-InstalledLyssna $formerInstallDirectory
        try {
            Install-Executable $staged
        }
        catch {
            if (-not (Test-FileLocked $installedExe)) {
                throw
            }
            # Still open: a copy that ignored the close, or one just started.
            Write-Warning 'Install failed because Lyssna is still open. Closing it and installing again.'
            Stop-InstalledLyssna
            if (Test-FileLocked $installedExe) {
                throw "Install failed: $installedExe is still in use. Close Lyssna (check the system tray) and run the build again."
            }
            Install-Executable $staged
        }
    }
    finally {
        if (Test-Path -LiteralPath $staged) {
            Remove-Item -LiteralPath $staged -Force
        }
    }
    Write-Host "Installed $shortCommit to $installedExe"
    if (Test-Path -LiteralPath $formerInstallDirectory) {
        Remove-Item -LiteralPath $formerInstallDirectory -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $formerInstallDirectory)) {
            Write-Host "Removed the SpotiFlex install at $formerInstallDirectory."
        }
    }

    if (-not $NoLaunch) {
        Write-Host 'Starting Lyssna.'
        Start-Process -FilePath $installedExe -WorkingDirectory $installDirectory
    }
}
finally {
    try {
        if ($restoreGitPosition) {
            Restore-GitPosition $originalGitPosition
        }
    }
    finally {
        Pop-Location
    }
}
