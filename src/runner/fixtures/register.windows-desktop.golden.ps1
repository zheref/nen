# jusshin -- register self-hosted GitHub Actions runners as logon tasks in a desktop session.
# rendered by nen 0.0.0-test runner script -- do not edit; re-run nen runner script
#
# target:   zheref/nen
# pool:     windows-x64-desktop (self-hosted,Windows,X64,desktop)
# runners:  NZ-NNR1
# identity: .\kwidesktop
# root:     C:\GithubRunners
# package:  actions-runner-win-x64-2.337.0.zip (runner 2.337.0)
#
# Windows PowerShell 5.1. Run it ELEVATED: 'nen runner script --json' prints
# the one launch line, which opens it through a UAC prompt. Keep this file
# OUTSIDE the runner root (e.g. %LOCALAPPDATA%\nen\jusshin\), where only you
# can change it before UAC.
#
# INTERACTIVE, NOT A SERVICE. Each runner is configured without --runasservice
# and started by a Scheduled Task at the identity's logon, in its desktop
# session (interactive token: no password is asked, none is stored). A runner
# is online only while that identity is signed in (or auto-logged on -- this
# script never configures that), and every job it takes runs with that
# account's profile and credentials. Every registration token this script
# mints with gh lives only in this process: never on a command line
# (config.cmd reads it from ACTIONS_RUNNER_INPUT_TOKEN), never echoed, never
# written to a file, and config.cmd's output is never replayed.
#
# The runner root is locked down FIRST: owner Administrators, inherited
# entries removed, SYSTEM and Administrators full control. The package lives
# in an admin-only _jusshin\pkg and is re-hashed before every extraction.
# The identity gets Modify on its own Runner<N> folders only.
# The one summary line is also written to _jusshin\register-<ts>.summary.
#
# Exit codes: 0 every planned runner's logon task is registered, and running
# wherever the identity is signed in; 1 anything else (an identity that is
# not a local account included); 3 not elevated; 5 gh missing or not signed
# in; 6 the runner package failed its SHA-256 check (the file is deleted).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Target = 'zheref/nen'
$RepoUrl = 'https://github.com/zheref/nen'
$Labels = 'self-hosted,Windows,X64,desktop'
$Root = 'C:\GithubRunners'
$ProjectDir = 'C:\GithubRunners\nen-runners'
$Identity = '.\kwidesktop'
$Account = 'kwidesktop'
$DownloadUrl = 'https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip'
$ZipName = 'actions-runner-win-x64-2.337.0.zip'
$Sha256 = '1150692AFA94E71F872017E254EA55B6EECE1EECE3FE7E3A6D4C93D0A1B85CFC'
$TaskPrefix = 'actions.runner.zheref-nen.'
$Runners = @(
    @{ Name = 'NZ-NNR1'; Dir = 'C:\GithubRunners\nen-runners\Runner1' }
)

$WorkDir = Join-Path $ProjectDir '_jusshin'
$PkgDir = Join-Path $WorkDir 'pkg'
# Well-known SIDs, so the grants read the same in every display language.
$SystemSid = '*S-1-5-18'
$AdminsSid = '*S-1-5-32-544'
$script:Registered = 0
$script:Skipped = 0
$script:Failed = 0
$script:Transcribing = $false
$script:Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:LogPath = $null
$script:SummaryPath = $null

function Close-Run {
    param([int]$Code)
    $summary = 'jusshin: {0} registered, {1} skipped, {2} failed' -f $script:Registered, $script:Skipped, $script:Failed
    Write-Host $summary
    # The summary file carries that ONE line and nothing else: it is what the
    # caller reads. The transcript is the maintainer's.
    if ($null -ne $script:SummaryPath) {
        try {
            Set-Content -LiteralPath $script:SummaryPath -Value $summary -Encoding Ascii
        } catch {
            Write-Host ('jusshin: could not write {0}.' -f $script:SummaryPath)
        }
    }
    if ($script:Transcribing) {
        Stop-Transcript | Out-Null
        $script:Transcribing = $false
    }
    # Keep the elevated window open on a failure, so its lines can be read.
    if ($Code -ne 0 -and $Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive) {
        Read-Host 'press Enter to close' | Out-Null
    }
    exit $Code
}

# A native command, its output discarded, its exit code returned.
function Invoke-Quiet {
    param([string]$FilePath, [string[]]$ArgumentList)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @ArgumentList *> $null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

# One icacls call; any failure stops the run before the root is used.
function Invoke-Icacls {
    param([string[]]$ArgumentList)
    $code = Invoke-Quiet 'icacls' $ArgumentList
    if ($code -ne 0) {
        Write-Host ('jusshin: icacls {0} failed (exit {1}); the runner root is not locked down, so nothing is downloaded or run.' -f ($ArgumentList -join ' '), $code)
        Close-Run 1
    }
}

# Whether the package on disk is the one the plan names, hashed NOW.
function Test-Package {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Sha256)
}

function Start-Log {
    Start-Transcript -Path $script:LogPath -Append | Out-Null
    $script:Transcribing = $true
}

function Stop-Log {
    if ($script:Transcribing) {
        Stop-Transcript | Out-Null
        $script:Transcribing = $false
    }
}

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host 'jusshin: run elevated -- this script registers Scheduled Tasks for another account and grants folder rights.'
        Close-Run 3
    }

    # LOCK THE ROOT DOWN before anything is downloaded, extracted or run from it.
    # A root an unelevated session created inherits 'Authenticated Users: Modify'
    # from the drive: any signed-in principal -- the pool's own service account
    # included -- could swap the package or config.cmd under this process. The
    # root: owner Administrators, inherited entries removed, SYSTEM and
    # Administrators full control inherited by everything below (explicit grants
    # other projects' accounts hold on it are kept). The project folders: owner
    # Administrators, their own explicit entries reset. The package folder: no
    # inheritance at all. You (the elevated user) may READ _jusshin, where the
    # transcript and the summary file land.
    $Me = '*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Path $Root | Out-Null }
    Invoke-Icacls @($Root, '/setowner', $AdminsSid)
    Invoke-Icacls @($Root, '/inheritance:r', '/grant:r', ($SystemSid + ':(OI)(CI)F'), ($AdminsSid + ':(OI)(CI)F'))
    foreach ($dir in @($ProjectDir, $WorkDir, $PkgDir)) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        Invoke-Icacls @($dir, '/setowner', $AdminsSid)
        Invoke-Icacls @($dir, '/reset')
    }
    Invoke-Icacls @($PkgDir, '/inheritance:r', '/grant:r', ($SystemSid + ':(OI)(CI)F'), ($AdminsSid + ':(OI)(CI)F'))
    Invoke-Icacls @($WorkDir, '/grant', ($Me + ':(OI)(CI)RX'))
    Write-Host ('jusshin: {0} locked down (owner Administrators; SYSTEM and Administrators full control; no inherited entries).' -f $Root)

    $script:LogPath = Join-Path $WorkDir ('register-{0}.log' -f $script:Stamp)
    $script:SummaryPath = Join-Path $WorkDir ('register-{0}.summary' -f $script:Stamp)
    Start-Log
    Write-Host ('jusshin: {0} runner(s) for {1}; transcript {2}' -f $Runners.Count, $Target, $script:LogPath)

    if ($null -eq (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host 'jusshin: gh is not on PATH for this elevated shell. Install the GitHub CLI machine-wide and re-run.'
        Close-Run 5
    }
    if ((Invoke-Quiet 'gh' @('auth', 'status')) -ne 0) {
        Write-Host "jusshin: 'gh auth status' failed in this elevated shell. Run 'gh auth login' as this user and re-run."
        Close-Run 5
    }

    # The logon task belongs to a LOCAL account on this host: one that does not
    # exist could never sign in, so its task would never fire.
    $localUser = $null
    try { $localUser = Get-LocalUser -Name $Account -ErrorAction Stop } catch { $localUser = $null }
    if ($null -eq $localUser -or -not $localUser.Enabled) {
        Write-Host ('jusshin: {0} is not an enabled local account on {1}; an interactive runner starts at that account''s logon. Create it (or name another with nen runner plan --service-account) and re-run.' -f $Identity, $env:COMPUTERNAME)
        Close-Run 1
    }
    $TaskUser = '{0}\{1}' -f $env:COMPUTERNAME, $Account

    # Traverse rights for the identity: read-and-execute on the root and the
    # project folder, THIS FOLDER ONLY (no inheritance). The leaf Runner<N>
    # folders are granted below, before each logon task. icacls /grant is
    # idempotent.
    if ($Account -ne '') {
        foreach ($dir in @($Root, $ProjectDir)) {
            $code = Invoke-Quiet 'icacls' @($dir, '/grant', ('{0}:(RX)' -f $Account))
            if ($code -ne 0) {
                Write-Host ('jusshin: icacls could not grant {0} read-and-execute on {1} (exit {2}).' -f $Account, $dir, $code)
                Close-Run 1
            }
            Write-Host ('jusshin: {0} may traverse {1} (RX, this folder only).' -f $Account, $dir)
        }
    }

    $pending = @()
    foreach ($runner in $Runners) {
        $marker = Join-Path $runner.Dir '.runner'
        if (Test-Path -LiteralPath $marker) {
            $agent = $null
            try { $agent = (Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).agentName } catch { $agent = $null }
            if ($agent -eq $runner.Name) {
                Write-Host ('jusshin: {0} is already configured in {1} -- skipped.' -f $runner.Name, $runner.Dir)
                $script:Skipped++
                continue
            }
            Write-Host ('jusshin: {0} holds a runner configured as {1}, not {2} -- left untouched.' -f $runner.Dir, $agent, $runner.Name)
            $script:Failed++
            continue
        }
        $pending += $runner
    }

    $zip = Join-Path $PkgDir $ZipName
    if ($pending.Count -gt 0) {
        if (-not (Test-Package $zip)) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Write-Host ('jusshin: downloading {0}' -f $ZipName)
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $zip -UseBasicParsing
            $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
            if ($actual -ne $Sha256) {
                Remove-Item -LiteralPath $zip -Force
                Write-Host ('jusshin: {0} failed its SHA-256 check (expected {1}, got {2}) -- deleted.' -f $ZipName, $Sha256, $actual)
                Close-Run 6
            }
        }
        Write-Host ('jusshin: {0} verified (sha256 {1}).' -f $ZipName, $Sha256)
    }

    foreach ($runner in $pending) {
        $name = $runner.Name
        $dir = $runner.Dir
        Write-Host ('jusshin: registering {0} in {1}' -f $name, $dir)
        # A pending folder holds no configured runner (.runner is absent), so
        # anything in it predates this run's lockdown: it is emptied, never trusted.
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
        New-Item -ItemType Directory -Path $dir | Out-Null
        # Re-hashed immediately before EVERY extraction, not only after the download.
        if (-not (Test-Package $zip)) {
            Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
            Write-Host ('jusshin: {0} no longer matches sha256 {1} -- deleted; nothing extracted into {2}.' -f $ZipName, $Sha256, $dir)
            Close-Run 6
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force

        # A fresh registration token, minted NOW (it lives about an hour), into a
        # variable that is never printed.
        $token = $null
        $mint = 1
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $token = [string](& gh api -X POST ('repos/{0}/actions/runners/registration-token' -f $Target) --jq .token 2> $null)
            $mint = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previous
        }
        if ($mint -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
            Write-Host ('jusshin: could not mint a registration token for {0} (gh exit {1}); the gh user must be an admin of {2}.' -f $name, $mint, $Target)
            $token = $null
            $script:Failed++
            continue
        }

        # NO SECRET ON THE COMMAND LINE: config.cmd is a batch file, and cmd.exe
        # re-parses & | < > ^ % in its arguments. The token reaches the runner as
        # ACTIONS_RUNNER_INPUT_TOKEN, which actions/runner reads as its --token
        # input, masks, and removes from its own environment. It exists in this
        # process only for the call, and config.cmd's output is DISCARDED: the log
        # gets its exit code and a fixed line, never a replay. NO --runasservice:
        # this runner is started by a logon task, in a desktop session.
        $configArgs = @('--unattended', '--url', $RepoUrl, '--name', $name, '--labels', $Labels, '--work', '_work')
        $code = 1
        Stop-Log
        try {
            $env:ACTIONS_RUNNER_INPUT_TOKEN = $token
            Push-Location -LiteralPath $dir
            $previous = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & .\config.cmd @configArgs *> $null
                $code = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previous
                Pop-Location
            }
        } finally {
            [Environment]::SetEnvironmentVariable('ACTIONS_RUNNER_INPUT_TOKEN', $null, 'Process')
            $token = $null
            $configArgs = $null
            Start-Log
        }
        if ($code -ne 0) {
            Write-Host ('jusshin: config.cmd exited {0} for {1}; its own (masked) log is under {2}\_diag.' -f $code, $name, $dir)
            $script:Failed++
            continue
        }
        $script:Registered++
    }

    # run.cmd runs AS the identity and writes _diag, _work and its own updates
    # into its folder: Modify there, on that folder only. icacls /grant and
    # Register-ScheduledTask -Force are both idempotent.
    if ($env:USERNAME -eq $Account) {
        Write-Host ('jusshin: WARNING -- {0} is the account running this script: every job these runners take runs in your own desktop session, with your profile and credentials.' -f $Identity)
    }
    # Signed in = owns an explorer.exe on this host. A query that fails is said
    # out loud: the tasks are then registered but not started.
    $signedIn = $false
    $probed = $true
    try {
        $owners = Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe'" | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName GetOwner }
        $signedIn = @($owners | Where-Object { $_.User -eq $Account -and $_.Domain -eq $env:COMPUTERNAME }).Count -gt 0
    } catch {
        $probed = $false
        Write-Host ('jusshin: could not tell whether {0} is signed in ({1}); the logon tasks are registered but not started.' -f $Identity, $_.Exception.Message)
    }
    $down = 0
    $waiting = 0
    foreach ($runner in $Runners) {
        $taskName = $TaskPrefix + $runner.Name
        if (-not (Test-Path -LiteralPath (Join-Path $runner.Dir '.runner'))) {
            Write-Host ('jusshin: {0} is not configured in {1}; no logon task registered for it.' -f $runner.Name, $runner.Dir)
            $down++
            continue
        }
        # A folder an earlier service-mode run configured is still a service: a
        # logon task beside it would be a second listener for one runner.
        if ($null -ne (Get-Service -Name $taskName -ErrorAction SilentlyContinue)) {
            Write-Host ('jusshin: {0} is installed as the service {1}; no logon task registered. Remove that runner (config.cmd remove) and re-run.' -f $runner.Name, $taskName)
            $down++
            continue
        }
        # Reset the folder to the locked root's inherited baseline FIRST, so an
        # account an earlier run granted (a different identity) keeps no access
        # to run.cmd, _work or the runner's credentials. Then grant this one.
        $code = Invoke-Quiet 'icacls' @($runner.Dir, '/reset', '/T', '/C', '/Q')
        if ($code -ne 0) {
            Write-Host ('jusshin: icacls could not reset {0} to the root''s baseline (exit {1}); no logon task registered.' -f $runner.Dir, $code)
            $down++
            continue
        }
        $code = Invoke-Quiet 'icacls' @($runner.Dir, '/grant', ('{0}:(OI)(CI)M' -f $Account))
        if ($code -ne 0) {
            Write-Host ('jusshin: icacls could not grant {0} Modify on {1} (exit {2}); no logon task registered.' -f $Account, $runner.Dir, $code)
            $down++
            continue
        }
        try {
            # Interactive token: the task runs only in the identity's own desktop
            # session, so no password is asked or stored. No time limit; restarted
            # every minute (up to 255 times) when the task ends in failure -- a
            # sign-out is not a failure; one instance at a time; priority 4, normal
            # (the default 7 is below normal, and every job would inherit it).
            $action = New-ScheduledTaskAction -Execute (Join-Path $runner.Dir 'run.cmd') -WorkingDirectory $runner.Dir
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
            $principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 255 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Priority 4 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
            Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ('GitHub Actions runner {0} for {1}, in {2}''s desktop session. Rendered by nen runner script.' -f $runner.Name, $Target, $Identity) -Force | Out-Null
        } catch {
            Write-Host ('jusshin: could not register the logon task {0}: {1}' -f $taskName, $_.Exception.Message)
            $down++
            continue
        }
        Write-Host ('jusshin: {0} registered (at logon of {1}, {2} Modify on {3}).' -f $taskName, $TaskUser, $Account, $runner.Dir)
        if (-not $signedIn) {
            $waiting++
            continue
        }
        if ((Get-ScheduledTask -TaskName $taskName -TaskPath '\').State -ne 'Running') {
            try {
                Start-ScheduledTask -TaskName $taskName -TaskPath '\'
            } catch {
                Write-Host ('jusshin: {0} did not start: {1}' -f $taskName, $_.Exception.Message)
            }
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $deadline -and (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State -ne 'Running') { Start-Sleep -Seconds 2 }
        }
        $state = (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State
        if ($state -ne 'Running') {
            Write-Host ('jusshin: {0} is {1} although {2} is signed in.' -f $taskName, $state, $Account)
            $down++
        }
    }
    Get-ScheduledTask -TaskPath '\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ($TaskPrefix + '*') } | Sort-Object TaskName | Format-Table -AutoSize TaskName, State | Out-String -Width 200 | Write-Host
    if ($waiting -gt 0 -and $probed) {
        Write-Host ('jusshin: {0} is not signed in, so {1} logon task(s) wait: the runners come online when {0} signs in to the desktop (or is auto-logged on; this script never configures that). A UI job needs that session active and unlocked, and the run.cmd console window open.' -f $Identity, $waiting)
    }

    if ($down -eq 0 -and $script:Failed -eq 0) { Close-Run 0 }
    Close-Run 1
} catch {
    Write-Host ('jusshin: stopped -- {0}' -f $_.Exception.Message)
    $script:Failed++
    Close-Run 1
}
