# jusshin -- register self-hosted GitHub Actions runners as Windows services.
# rendered by nen 0.0.0-test runner script -- do not edit; re-run nen runner script
#
# target:   zheref/nen
# pool:     windows-x64 (self-hosted,Windows,X64)
# runners:  NZ-NNR1, NZ-NNR2, NZ-NNR3
# identity: .\lordzheref
# root:     C:\GithubRunners
# package:  actions-runner-win-x64-2.337.0.zip (runner 2.337.0)
#
# Windows PowerShell 5.1. Run it ELEVATED: 'nen runner script --json' prints
# the one launch line, which opens it through a UAC prompt. Keep this file
# OUTSIDE the runner root (e.g. %LOCALAPPDATA%\nen\jusshin\), where only you
# can change it before UAC. It asks ONCE for the service account's password.
# That password, and every registration token this script mints with gh,
# live only in this process: never on a command line (config.cmd reads them
# from ACTIONS_RUNNER_INPUT_* environment inputs), never echoed, never
# written to a file, and config.cmd's output is never replayed.
#
# The runner root is locked down FIRST: owner Administrators, inherited
# entries removed, SYSTEM and Administrators full control. The package lives
# in an admin-only _jusshin\pkg and is re-hashed before every extraction.
# The one summary line is also written to _jusshin\register-<ts>.summary.
#
# Exit codes: 0 every planned runner's service is Running; 1 anything else
# (a refused password included); 3 not elevated; 5 gh missing or not signed
# in; 6 the runner package failed its SHA-256 check (the file is deleted).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Target = 'zheref/nen'
$RepoUrl = 'https://github.com/zheref/nen'
$Labels = 'self-hosted,Windows,X64'
$Root = 'C:\GithubRunners'
$ProjectDir = 'C:\GithubRunners\nen-runners'
$Identity = '.\lordzheref'
$Account = 'lordzheref'
$DownloadUrl = 'https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip'
$ZipName = 'actions-runner-win-x64-2.337.0.zip'
$Sha256 = '1150692AFA94E71F872017E254EA55B6EECE1EECE3FE7E3A6D4C93D0A1B85CFC'
$ServicePrefix = 'actions.runner.zheref-nen.'
$PasswordRule = '& | < > ^ % " '' or a line break'
$Runners = @(
    @{ Name = 'NZ-NNR1'; Dir = 'C:\GithubRunners\nen-runners\Runner1' },
    @{ Name = 'NZ-NNR2'; Dir = 'C:\GithubRunners\nen-runners\Runner2' },
    @{ Name = 'NZ-NNR3'; Dir = 'C:\GithubRunners\nen-runners\Runner3' }
)

$WorkDir = Join-Path $ProjectDir '_jusshin'
$PkgDir = Join-Path $WorkDir 'pkg'
# Well-known SIDs, so the grants read the same in every display language.
$SystemSid = '*S-1-5-18'
$AdminsSid = '*S-1-5-32-544'
$script:Registered = 0
$script:Skipped = 0
$script:Failed = 0
$script:Listed = @()
$script:ListOk = $false
$script:ListRead = $false
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

# Why a password is refused, or $null. The rule: none of the characters
# cmd.exe or PowerShell read as syntax, and no leading or trailing whitespace
# (the runner trims an environment input). Checked BEFORE the first use.
function Test-Password {
    param([string]$Plain)
    if ([string]::IsNullOrEmpty($Plain)) { return 'it is empty' }
    if ($Plain -match '[&|<>^%"''\r\n]') { return 'it carries a refused character' }
    if ($Plain -cne $Plain.Trim()) { return 'it begins or ends with whitespace' }
    return $null
}

# Whether the package on disk is the one the plan names, hashed NOW.
function Test-Package {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Sha256)
}

# Why a folder configured as $Name is stale, or $null when it stands: its
# service is absent, or GitHub no longer lists its registration (#319).
function Get-StaleReason {
    param([string]$Name, [bool]$HasService, [string[]]$Listed)
    $reasons = @()
    if (-not $HasService) { $reasons += 'its service is absent' }
    # Case-sensitive, as the bash scripts' grep -Fx is: one listing, one verdict on every OS.
    if ($Listed -cnotcontains $Name) { $reasons += 'GitHub no longer lists its registration' }
    if ($reasons.Count -eq 0) { return $null }
    return ($reasons -join ' and ')
}

# The names GitHub lists for the repository's runners, read once into
# $script:Listed; $script:ListOk says whether the read succeeded.
function Read-ListedRunners {
    if ($script:ListRead) { return }
    $script:ListRead = $true
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $names = @(& gh api --paginate ('repos/{0}/actions/runners' -f $Target) --jq '.runners[].name' 2> $null)
        if ($LASTEXITCODE -eq 0) {
            $script:Listed = [string[]]$names
            $script:ListOk = $true
        }
    } finally {
        $ErrorActionPreference = $previous
    }
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
        Write-Host 'jusshin: run elevated -- this script registers Windows services and grants folder rights.'
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

    # Traverse rights for a local-account service: read-and-execute on the root
    # and the project folder, THIS FOLDER ONLY (no inheritance). config.cmd grants
    # the leaf Runner<N> folders itself. icacls /grant is idempotent.
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
                # Configured is not standing (#319): a failed service install leaves
                # .runner behind with no service, and a removed registration leaves
                # one GitHub no longer lists. Either is stale -- emptied and
                # re-registered, never counted as skipped.
                Read-ListedRunners
                if (-not $script:ListOk) {
                    Write-Host ('jusshin: could not list the runners of {0}, so {1} in {2} cannot be told live from stale -- left untouched (the gh user must be an admin of {0}).' -f $Target, $runner.Name, $runner.Dir)
                    $script:Failed++
                    continue
                }
                $serviceName = $ServicePrefix + $runner.Name
                $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
                $stale = Get-StaleReason $runner.Name ($null -ne $service) $script:Listed
                if ($null -eq $stale) {
                    Write-Host ('jusshin: {0} is already configured in {1} -- skipped.' -f $runner.Name, $runner.Dir)
                    $script:Skipped++
                    continue
                }
                Write-Host ('jusshin: {0} in {1} is stale ({2}) -- emptied and re-registered.' -f $runner.Name, $runner.Dir, $stale)
                if ($null -ne $service) {
                    # sc.exe delete only MARKS a running service: it must be stopped first,
                    # or its listener keeps the folder's files open and config.cmd meets
                    # a service still marked for deletion.
                    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
                    $state = (Get-Service -Name $serviceName -ErrorAction SilentlyContinue).Status
                    if ($null -ne $state -and $state -ne 'Stopped') {
                        Write-Host ('jusshin: {0} did not stop (it is {1}); {2} left untouched.' -f $serviceName, $state, $runner.Dir)
                        $script:Failed++
                        continue
                    }
                    $code = Invoke-Quiet 'sc.exe' @('delete', $serviceName)
                    if ($code -ne 0) {
                        Write-Host ('jusshin: sc.exe delete {0} failed (exit {1}); {2} left untouched.' -f $serviceName, $code, $runner.Dir)
                        $script:Failed++
                        continue
                    }
                }
                $pending += @{ Name = $runner.Name; Dir = $runner.Dir; Replace = ($script:Listed -ccontains $runner.Name) }
                continue
            }
            Write-Host ('jusshin: {0} holds a runner configured as {1}, not {2} -- left untouched.' -f $runner.Dir, $agent, $runner.Name)
            $script:Failed++
            continue
        }
        $pending += $runner
    }

    $secure = $null
    if ($pending.Count -gt 0 -and $Account -ne '') {
        $secure = Read-Host -AsSecureString ('Password for {0} (asked once; never shown, never written)' -f $Identity)
        $refusal = $null
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $refusal = Test-Password ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        if ($null -ne $refusal) {
            $secure.Dispose()
            Write-Host ('jusshin: the password for {0} is refused: {1}. The rule: a service-account password carries none of {2}, and no leading or trailing whitespace. Change the account''s password and re-run.' -f $Identity, $refusal, $PasswordRule)
            $script:Failed += $pending.Count
            Close-Run 1
        }
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
        # A pending folder holds no configured runner (.runner is absent) or a
        # stale one, so anything in it predates this run's lockdown: it is
        # emptied, never trusted.
        if (Test-Path -LiteralPath $dir) {
            # One folder a process still holds fails that runner alone, never the run.
            try {
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
            } catch {
                Write-Host ('jusshin: could not empty {0} for {1}: {2}' -f $dir, $name, $_.Exception.Message)
                $script:Failed++
                continue
            }
        }
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
        # re-parses & | < > ^ % in its arguments. The token and the password reach
        # the runner as ACTIONS_RUNNER_INPUT_TOKEN and
        # ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD, which actions/runner reads as
        # its --token and --windowslogonpassword inputs, masks, and removes from
        # its own environment. They exist in this process only for the call, and
        # config.cmd's output is DISCARDED: the log gets its exit code and a fixed
        # line, never a replay. The transcript is stopped around it all the same.
        $configArgs = @('--unattended', '--url', $RepoUrl, '--name', $name, '--labels', $Labels, '--work', '_work', '--runasservice')
        if ($Account -ne '') { $configArgs += @('--windowslogonaccount', $Identity) }
        # A stale runner GitHub still lists is replaced under its own name.
        if ($runner.Replace) { $configArgs += '--replace' }
        $bstr = [IntPtr]::Zero
        $code = 1
        Stop-Log
        try {
            $env:ACTIONS_RUNNER_INPUT_TOKEN = $token
            if ($Account -ne '') {
                $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
                $env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            }
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
            [Environment]::SetEnvironmentVariable('ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD', $null, 'Process')
            if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
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
    if ($null -ne $secure) { $secure.Dispose() }

    # Every planned runner's service must be Running -- skipped ones included;
    # a stopped one is started once (a service inherits PATH only at start).
    $down = 0
    foreach ($runner in $Runners) {
        $serviceName = $ServicePrefix + $runner.Name
        $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
        if ($null -eq $service) {
            Write-Host ('jusshin: no service {0}.' -f $serviceName)
            $down++
            continue
        }
        if ($service.Status -ne 'Running') {
            try {
                Start-Service -Name $serviceName
                $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
            } catch {
                Write-Host ('jusshin: {0} did not start: {1}' -f $serviceName, $_.Exception.Message)
            }
            $service = Get-Service -Name $serviceName
        }
        if ($service.Status -ne 'Running') {
            Write-Host ('jusshin: {0} is {1}.' -f $serviceName, $service.Status)
            $down++
        }
    }
    Get-Service -Name ($ServicePrefix + '*') -ErrorAction SilentlyContinue | Sort-Object Name | Format-Table -AutoSize Name, Status, StartType | Out-String -Width 200 | Write-Host

    if ($down -eq 0 -and $script:Failed -eq 0) { Close-Run 0 }
    Close-Run 1
} catch {
    Write-Host ('jusshin: stopped -- {0}' -f $_.Exception.Message)
    $script:Failed++
    Close-Run 1
}
