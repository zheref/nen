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
# the one launch line, which opens it through a UAC prompt. It asks ONCE for
# the service account's password. That password, and every registration
# token this script mints with gh, live only in this process: never echoed,
# never written to a file, and the transcript is stopped around the one
# config.cmd call that carries them.
#
# Exit codes: 0 every planned runner's service is Running; 1 anything else;
# 3 not elevated; 5 gh missing or not signed in; 6 the runner package failed
# its SHA-256 check (the file is deleted).

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
$Runners = @(
    @{ Name = 'NZ-NNR1'; Dir = 'C:\GithubRunners\nen-runners\Runner1' },
    @{ Name = 'NZ-NNR2'; Dir = 'C:\GithubRunners\nen-runners\Runner2' },
    @{ Name = 'NZ-NNR3'; Dir = 'C:\GithubRunners\nen-runners\Runner3' }
)

$WorkDir = Join-Path $ProjectDir '_jusshin'
$script:Registered = 0
$script:Skipped = 0
$script:Failed = 0
$script:Transcribing = $false
$script:LogPath = $null

function Close-Run {
    param([int]$Code)
    Write-Host ('jusshin: {0} registered, {1} skipped, {2} failed' -f $script:Registered, $script:Skipped, $script:Failed)
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

# Replace every secret in a line with ***. An empty secret replaces nothing.
function Hide-Secret {
    param([string]$Text, [string[]]$Secrets)
    foreach ($secret in $Secrets) {
        if (-not [string]::IsNullOrEmpty($secret)) { $Text = $Text.Replace($secret, '***') }
    }
    return $Text
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

    foreach ($dir in @($Root, $ProjectDir, $WorkDir)) {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    }
    $script:LogPath = Join-Path $WorkDir ('register-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
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

    $secure = $null
    if ($pending.Count -gt 0 -and $Account -ne '') {
        $secure = Read-Host -AsSecureString ('Password for {0} (asked once; never shown, never written)' -f $Identity)
    }

    $zip = Join-Path $WorkDir $ZipName
    if ($pending.Count -gt 0) {
        $have = $false
        if (Test-Path -LiteralPath $zip) { $have = ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -eq $Sha256) }
        if (-not $have) {
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
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
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

        $configArgs = @('--unattended', '--url', $RepoUrl, '--token', $token, '--name', $name, '--labels', $Labels, '--work', '_work', '--runasservice')
        if ($Account -ne '') { $configArgs += @('--windowslogonaccount', $Identity) }
        $plain = $null
        $bstr = [IntPtr]::Zero
        $lines = @()
        $code = 1
        # The transcript stops HERE: the argument list below carries the token and
        # the password. It restarts after, and config.cmd's output is replayed into
        # it with both replaced by ***.
        Stop-Log
        try {
            if ($Account -ne '') {
                $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
                $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
                $configArgs += @('--windowslogonpassword', $plain)
            }
            Push-Location -LiteralPath $dir
            $previous = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                $lines = @(& .\config.cmd @configArgs 2>&1 | ForEach-Object { Hide-Secret ([string]$_) @($token, $plain) })
                $code = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previous
                Pop-Location
            }
        } finally {
            if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
            $plain = $null
            $token = $null
            $configArgs = $null
            Start-Log
        }
        foreach ($line in $lines) { Write-Host ('  config: {0}' -f $line) }
        if ($code -ne 0) {
            Write-Host ('jusshin: config.cmd exited {0} for {1}.' -f $code, $name)
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
