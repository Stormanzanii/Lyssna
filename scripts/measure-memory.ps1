param([double]$BudgetMiB = 0)
$processRows = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(spotiflex.*|msedgewebview2)\.exe$' })
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($row in $processRows) { if ($row.Name -like 'spotiflex*') { [void]$ids.Add([uint32]$row.ProcessId) } }
do {
    $added = $false
    foreach ($row in $processRows) { if ($ids.Contains([uint32]$row.ParentProcessId) -and $ids.Add([uint32]$row.ProcessId)) { $added = $true } }
} while ($added)
$privateSets = @{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $privateSets[[uint32]$_.IDProcess] = [double]$_.WorkingSetPrivate }
$memoryRows = @(foreach ($row in $processRows) {
    if (!$ids.Contains([uint32]$row.ProcessId)) { continue }
    $appProcess = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if (!$appProcess) { continue }
    $kind = if ($row.Name -like 'spotiflex*') { 'native' } elseif ($row.CommandLine -match '--type=([^ ]+)') { $matches[1] } else { 'browser' }
    [pscustomobject]@{
        Id = $appProcess.Id
        Kind = $kind
        WorkingSetMiB = [math]::Round($appProcess.WorkingSet64 / 1MB, 1)
        PrivateWorkingSetMiB = [math]::Round($privateSets[[uint32]$appProcess.Id] / 1MB, 1)
        PrivateMiB = [math]::Round($appProcess.PrivateMemorySize64 / 1MB, 1)
    }
})
if (!$memoryRows.Count) { throw 'SpotiFlex is not running' }
$total = [math]::Round(($memoryRows | Measure-Object PrivateWorkingSetMiB -Sum).Sum, 1)
[pscustomobject]@{
    Timestamp = [DateTime]::UtcNow.ToString('o')
    Processes = $memoryRows
    TotalWorkingSetMiB = [math]::Round(($memoryRows | Measure-Object WorkingSetMiB -Sum).Sum, 1)
    TotalPrivateWorkingSetMiB = $total
    TotalPrivateMiB = [math]::Round(($memoryRows | Measure-Object PrivateMiB -Sum).Sum, 1)
    OverBudget = $BudgetMiB -gt 0 -and $total -gt $BudgetMiB
} | ConvertTo-Json -Depth 4 -Compress
if ($BudgetMiB -gt 0 -and $total -gt $BudgetMiB) { exit 2 }
