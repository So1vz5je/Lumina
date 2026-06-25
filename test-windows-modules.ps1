# Windows Module Test Script
# Test each PowerShell command to verify JSON output

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Windows Local Analysis Module Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$results = @()

function Test-Module {
    param(
        [string]$Name,
        [string]$Command,
        [string]$Description
    )

    Write-Host "Testing: $Name - $Description" -ForegroundColor Yellow
    Write-Host "Command: $Command" -ForegroundColor Gray

    try {
        $output = Invoke-Expression $Command 2>&1

        if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq $null) {
            # Try to parse JSON
            try {
                $json = $output | ConvertFrom-Json
                Write-Host "SUCCESS - Valid JSON output, records: $(if ($json -is [array]) { $json.Count } else { 1 })" -ForegroundColor Green
                $script:results += [PSCustomObject]@{
                    Module = $Name
                    Status = "Success"
                    Records = $(if ($json -is [array]) { $json.Count } else { 1 })
                    Error = ""
                }
            } catch {
                Write-Host "SUCCESS - But output is not JSON" -ForegroundColor Yellow
                Write-Host "  First 100 chars: $($output.ToString().Substring(0, [Math]::Min(100, $output.ToString().Length)))" -ForegroundColor Gray
                $script:results += [PSCustomObject]@{
                    Module = $Name
                    Status = "Non-JSON"
                    Records = 0
                    Error = "Output is not JSON"
                }
            }
        } else {
            Write-Host "FAILED - Command error" -ForegroundColor Red
            Write-Host "  Error: $output" -ForegroundColor Red
            $script:results += [PSCustomObject]@{
                Module = $Name
                Status = "Failed"
                Records = 0
                Error = $output.ToString().Substring(0, [Math]::Min(200, $output.ToString().Length))
            }
        }
    } catch {
        Write-Host "FAILED - $($_.Exception.Message)" -ForegroundColor Red
        $script:results += [PSCustomObject]@{
            Module = $Name
            Status = "Exception"
            Records = 0
            Error = $_.Exception.Message
        }
    }

    Write-Host ""
}

# Test core modules
Test-Module "user_list" `
    'Get-LocalUser | Select-Object Name,Enabled,Description,LastLogon | ConvertTo-Json -Compress' `
    "Local users"

Test-Module "service_list" `
    'Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress' `
    "System services"

Test-Module "logged_users" `
    'quser 2>$null | ConvertTo-Json -Compress' `
    "Logged users"

Test-Module "startup" `
    'Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ConvertTo-Json -Compress' `
    "Startup items"

Test-Module "process_list" `
    'Get-Process | Select-Object Id,Name,CPU,WorkingSet,Path -First 50 | ConvertTo-Json -Compress' `
    "Process list"

Test-Module "network_conn" `
    'Get-NetTCPConnection | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess -First 50 | ConvertTo-Json -Compress' `
    "Network connections"

Test-Module "listen_ports" `
    'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,State,OwningProcess | ConvertTo-Json -Compress' `
    "Listening ports"

Test-Module "disk_info" `
    'Get-Volume | Select-Object DriveLetter,FileSystemLabel,Size,SizeRemaining | ConvertTo-Json -Compress' `
    "Disk info"

Test-Module "env_vars" `
    'Get-ChildItem Env: | Select-Object Name,Value | ConvertTo-Json -Compress' `
    "Environment variables"

Test-Module "installed_software" `
    '@(Get-ItemProperty "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" | Select-Object DisplayName,DisplayVersion,Publisher,InstallDate -First 50) | ConvertTo-Json -Compress' `
    "Installed software"

Test-Module "win_defender" `
    'Get-MpComputerStatus | ConvertTo-Json -Compress' `
    "Windows Defender"

Test-Module "dns_config" `
    'Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses } | Select-Object InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress' `
    "DNS config"

Test-Module "hosts_file" `
    'Get-Content C:\Windows\System32\drivers\etc\hosts' `
    "Hosts file"

Test-Module "cron" `
    'Get-ScheduledTask | Where-Object {$_.State -ne "Disabled"} | Select-Object TaskName,State,TaskPath -First 50 | ConvertTo-Json -Compress' `
    "Scheduled tasks"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
$results | Format-Table -AutoSize

$successCount = ($results | Where-Object { $_.Status -eq "Success" }).Count
$totalCount = $results.Count
Write-Host "Success: $successCount / $totalCount" -ForegroundColor $(if ($successCount -eq $totalCount) { "Green" } else { "Yellow" })

# Export results
$results | ConvertTo-Json -Depth 4 | Out-File -FilePath ".\windows-module-test-results.json" -Encoding UTF8
Write-Host "Results saved to: windows-module-test-results.json" -ForegroundColor Gray
