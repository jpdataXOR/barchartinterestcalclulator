# Get futures data and generate HTML report
Write-Host "Getting session cookies..." -ForegroundColor Cyan

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

# Step 1: Visit the page to get fresh cookies
$url1 = "https://www.barchart.com/futures/major-commodities"
Write-Host "URL: $url1" -ForegroundColor DarkGray
$response1 = Invoke-WebRequest -UseBasicParsing -Uri $url1 -WebSession $session

# Extract XSRF-TOKEN
$xsrfCookie = $session.Cookies.GetCookies("https://www.barchart.com") | Where-Object { $_.Name -eq "XSRF-TOKEN" }
$xsrfToken = [uri]::UnescapeDataString($xsrfCookie.Value)

Write-Host "Calling main API..." -ForegroundColor Cyan

# Step 2: Call the main API
$url2 = "https://www.barchart.com/proxies/core-api/v1/quotes/get?lists=futures.category.us.all&fields=symbol%2CcontractName%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2Cvolume%2CtradeTime%2Ccategory%2ChasOptions%2CsymbolCode%2CsymbolType&limit=100&page=1&groupBy=category&raw=1"
Write-Host "URL: $url2" -ForegroundColor DarkGray
$response2 = Invoke-WebRequest -UseBasicParsing -Uri $url2 `
-WebSession $session `
-Headers @{
  "accept" = "application/json"
  "referer" = "https://www.barchart.com/futures/major-commodities"
  "x-xsrf-token" = $xsrfToken
}

$data = $response2.Content | ConvertFrom-Json

Write-Host "Processing main data..." -ForegroundColor Cyan

# Collect all main items
$allItems = @()
$instruments = @{}

foreach ($category in $data.data.PSObject.Properties) {
    foreach ($item in $category.Value) {
        $raw = $item.raw
        
        if ($raw.symbol -match '^([A-Z0-9]{2})') {
            $rootSymbol = $matches[1]
            if ($rootSymbol -ne 'FU' -and -not $instruments.ContainsKey($rootSymbol)) {
                $cleanName = $raw.contractName -replace '\s*\([^)]*\)', ''
                $instruments[$rootSymbol] = @{
                    Name = $cleanName
                    Category = $raw.category
                }
            }
        }
        
        $allItems += [PSCustomObject]@{
            Symbol = $raw.symbol
            ContractName = $raw.contractName
            LastPrice = $raw.lastPrice
            PriceChange = $raw.priceChange
            OpenPrice = $raw.openPrice
            HighPrice = $raw.highPrice
            LowPrice = $raw.lowPrice
            Volume = $raw.volume
            TradeTime = $raw.tradeTime
            Category = $raw.category
        }
    }
}

Write-Host "Found $($instruments.Count) unique instruments" -ForegroundColor Cyan

# Arrays to store data
$instrumentDetails = @{}
$yieldAnalysis = @()

# Fetch detailed data for each instrument
Write-Host "`nFetching detailed data for each instrument..." -ForegroundColor Cyan
$instrumentCount = 0
$successCount = 0
$failCount = 0

foreach ($rootSymbol in ($instruments.Keys | Sort-Object)) {
    $instrumentCount++
    $instrumentInfo = $instruments[$rootSymbol]
    
    Write-Host "  [$instrumentCount/$($instruments.Count)] Fetching $rootSymbol - $($instrumentInfo.Name)..." -ForegroundColor Yellow
    
    try {
        $instrumentUrl = "https://www.barchart.com/proxies/core-api/v1/quotes/get?fields=symbol%2CcontractSymbol%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2CpreviousPrice%2Cvolume%2CopenInterest%2CtradeTime%2CsymbolCode%2CsymbolType%2ChasOptions&lists=futures.contractInRoot&root=$rootSymbol&meta=field.shortName%2Cfield.type%2Cfield.description%2Clists.lastUpdate&hasOptions=true&page=1&limit=100&raw=1"
        
        $instrumentResponse = Invoke-WebRequest -UseBasicParsing -Uri $instrumentUrl `
            -WebSession $session `
            -Headers @{
                "accept" = "application/json"
                "referer" = "https://www.barchart.com/futures/quotes/$rootSymbol*0/futures-prices"
                "x-xsrf-token" = $xsrfToken
            }
        
        $instrumentData = $instrumentResponse.Content | ConvertFrom-Json
        
        if ($instrumentData.data -and $instrumentData.data.Count -gt 0) {
            $contracts = @()
            
            foreach ($contract in $instrumentData.data) {
                $contracts += $contract.raw
            }
            
            $instrumentDetails[$rootSymbol] = @{
                Name = $instrumentInfo.Name
                Category = $instrumentInfo.Category
                Contracts = $contracts
            }
            
            # Calculate yield
            $tradeableContracts = $contracts | Where-Object { 
                $_.symbol -notmatch 'Y00$' -and $_.contractSymbol -notmatch '\(Cash\)'
            }
            
            if ($tradeableContracts.Count -ge 2) {
                $front = $tradeableContracts[0]
                $next = $tradeableContracts[1]
                
                $estimatedDays = 30
                
                if ($front.symbol -match '([FGHJKMNQUVXZ])(\d{2})$') {
                    $frontMonth = $matches[1]
                    $frontYear = $matches[2]
                    
                    if ($next.symbol -match '([FGHJKMNQUVXZ])(\d{2})$') {
                        $nextMonth = $matches[1]
                        $nextYear = $matches[2]
                        
                        $monthMap = @{
                            'F' = 1; 'G' = 2; 'H' = 3; 'J' = 4; 'K' = 5; 'M' = 6;
                            'N' = 7; 'Q' = 8; 'U' = 9; 'V' = 10; 'X' = 11; 'Z' = 12
                        }
                        
                        $frontMonthNum = $monthMap[$frontMonth]
                        $nextMonthNum = $monthMap[$nextMonth]
                        
                        $monthDiff = $nextMonthNum - $frontMonthNum
                        if ($nextYear -gt $frontYear) {
                            $monthDiff += 12
                        }
                        
                        if ($monthDiff -gt 0) {
                            $estimatedDays = $monthDiff * 30
                        }
                    }
                }
                
                $priceDiff = $next.lastPrice - $front.lastPrice
                $dailyBasis = if ($estimatedDays -gt 0) { $priceDiff / $estimatedDays } else { 0 }
                
                $curveType = if ($priceDiff -gt 0.0001) { "Contango" } 
                             elseif ($priceDiff -lt -0.0001) { "Backwardation" } 
                             else { "Flat" }
                
                $favoredSide = if ($priceDiff -gt 0.0001) { "SHORT" } 
                               elseif ($priceDiff -lt -0.0001) { "LONG" } 
                               else { "NEUTRAL" }
                
                $pointValue = switch ($instrumentInfo.Category) {
                    "Currencies" { 
                        switch -Wildcard ($rootSymbol) {
                            "J6" { 12500000 }
                            default { 100000 }
                        }
                    }
                    "Energies" { 
                        switch ($rootSymbol) {
                            "CL" { 1000 }
                            "NG" { 10000 }
                            "RB" { 42000 }
                            "HO" { 42000 }
                            default { 1000 }
                        }
                    }
                    "Metals" { 
                        switch ($rootSymbol) {
                            "GC" { 100 }
                            "SI" { 5000 }
                            "HG" { 25000 }
                            "PL" { 50 }
                            "PA" { 100 }
                            default { 100 }
                        }
                    }
                    "Grains" { 
                        switch ($rootSymbol) {
                            "ZC" { 50 }
                            "ZS" { 50 }
                            "ZW" { 50 }
                            "ZM" { 100 }
                            "ZL" { 600 }
                            default { 50 }
                        }
                    }
                    "Softs" {
                        switch ($rootSymbol) {
                            "CC" { 10 }
                            "CT" { 500 }
                            "KC" { 375 }
                            "SB" { 1120 }
                            "OJ" { 150 }
                            default { 100 }
                        }
                    }
                    "Indices" {
                        switch ($rootSymbol) {
                            "ES" { 50 }
                            "NQ" { 20 }
                            "YM" { 5 }
                            "RTY" { 50 }
                            default { 50 }
                        }
                    }
                    "Meats" {
                        switch ($rootSymbol) {
                            "LE" { 400 }
                            "GF" { 500 }
                            "HE" { 400 }
                            default { 400 }
                        }
                    }
                    default { 100 }
                }
                
                $dailyValue = [Math]::Abs($dailyBasis) * $pointValue
                $annualizedBasis = $dailyBasis * 365
                $annualizedPercent = if ($front.lastPrice -ne 0) { 
                    ($annualizedBasis / $front.lastPrice) * 100 
                } else { 0 }
                
                $yieldAnalysis += [PSCustomObject]@{
                    Instrument = $rootSymbol
                    Name = $instrumentInfo.Name
                    Category = $instrumentInfo.Category
                    FrontContract = $front.symbol
                    NextContract = $next.symbol
                    FrontPrice = $front.lastPrice
                    NextPrice = $next.lastPrice
                    PriceDiff = $priceDiff
                    DailyBasis = $dailyBasis
                    DailyValue = $dailyValue
                    AnnualizedBasis = $annualizedBasis
                    AnnualizedPercent = $annualizedPercent
                    CurveType = $curveType
                    FavoredSide = $favoredSide
                    EstDays = $estimatedDays
                    PointValue = $pointValue
                }
            }
            
            $successCount++
        } else {
            $failCount++
        }
        
        Start-Sleep -Milliseconds 500
        
    } catch {
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
        $failCount++
    }
}

Write-Host "`nGenerating HTML report..." -ForegroundColor Cyan

# Separate LONG and SHORT opportunities
# Corrected - sort by absolute value, highest first
$longOpportunities = $yieldAnalysis | Where-Object { $_.CurveType -eq "Backwardation" } | Sort-Object { [Math]::Abs($_.AnnualizedPercent) } -Descending
$shortOpportunities = $yieldAnalysis | Where-Object { $_.CurveType -eq "Contango" } | Sort-Object { [Math]::Abs($_.AnnualizedPercent) } -Descending


# Generate HTML
# Generate HTML
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$html = @"
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Futures Analysis Report - $timestamp</title>
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.datatables.net/1.13.4/js/jquery.dataTables.min.js"></script>
    <link rel="stylesheet" href="https://cdn.datatables.net/1.13.4/css/jquery.dataTables.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background-color: #fdf6e3; /* base03 */
            color: #657b83; /* base0 */
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background-color: #eee8d5; /* base2 */
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #268bd2 0%, #2aa198 100%); /* blue to cyan */
            color: #fdf6e3; /* base3 */
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.1);
        }
        
        .header .timestamp {
            opacity: 0.9;
            font-size: 1.1em;
            color: #eee8d5; /* base2 */
        }
        
        .stats {
            display: flex;
            justify-content: space-around;
            padding: 20px;
            background: #eee8d5; /* base2 */
            border-bottom: 2px solid #93a1a1; /* base1 */
        }
        
        .stat-box {
            text-align: center;
            padding: 15px;
        }
        
        .stat-box .number {
            font-size: 2em;
            font-weight: bold;
            color: #b58900; /* yellow */
        }
        
        .stat-box .label {
            color: #839496; /* base01 */
            margin-top: 5px;
        }
        
        .tabs {
            display: flex;
            background: #eee8d5; /* base2 */
            border-bottom: 2px solid #93a1a1; /* base1 */
            overflow-x: auto;
        }
        
        .tab {
            padding: 15px 25px;
            cursor: pointer;
            border: none;
            background: transparent;
            font-size: 1em;
            font-weight: 500;
            color: #657b83; /* base0 */
            transition: all 0.3s;
            white-space: nowrap;
            border-bottom: 3px solid transparent;
        }
        
        .tab:hover {
            background: #fdf6e3; /* base3 */
            color: #073642; /* base02 */
        }
        
        .tab.active {
            color: #d33682; /* magenta */
            border-bottom-color: #d33682; /* magenta */
        }
        
        .tab-content {
            display: none;
            padding: 30px;
            animation: fadeIn 0.3s;
            background-color: #fdf6e3; /* base3 */
        }
        
        .tab-content.active {
            display: block;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        
        table thead {
            background: #93a1a1; /* base1 */
            color: #002b36; /* base03 */
        }
        
        table th {
            padding: 12px;
            text-align: left;
            font-weight: 600;
        }
        
        table td {
            padding: 10px;
            border-bottom: 1px solid #eee8d5; /* base2 */
        }
        
        table tbody tr:hover {
            background: #eee8d5; /* base2 */
        }
        
        .positive {
            color: #859900; /* green */
            font-weight: bold;
        }
        
        .negative {
            color: #dc322f; /* red */
            font-weight: bold;
        }
        
        .badge {
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: 600;
            border: 1px solid;
        }
        
        .badge-contango {
            background-color: #fdf6e3;
            color: #b58900; /* yellow */
            border-color: #b58900;
        }
        
        .badge-backwardation {
            background-color: #fdf6e3;
            color: #268bd2; /* blue */
            border-color: #268bd2;
        }
        
        .badge-long {
            background-color: #fdf6e3;
            color: #859900; /* green */
            border-color: #859900;
        }
        
        .badge-short {
            background-color: #fdf6e3;
            color: #dc322f; /* red */
            border-color: #dc322f;
        }
        
        .summary-box {
            background: #eee8d5; /* base2 */
            padding: 20px;
            border-radius: 8px;
            margin-top: 20px;
            border: 1px solid #93a1a1; /* base1 */
        }
        
        .summary-box h3 {
            color: #cb4b16; /* orange */
            margin-bottom: 15px;
        }
        
        .summary-item {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #93a1a1; /* base1 */
        }
        
        .summary-item:last-child {
            border-bottom: none;
        }
        
        .highlight {
            background: #fff3cd !important; /* a light yellow highlight */
            font-weight: bold;
        }
        
        .dataTables_wrapper {
            padding: 0;
        }
        
        .dataTables_length, .dataTables_filter, .dataTables_info, .dataTables_paginate {
             margin-bottom: 20px;
        }

        .dataTables_filter input {
            padding: 8px;
            border: 1px solid #93a1a1; /* base1 */
            border-radius: 4px;
            margin-left: 10px;
            background-color: #fdf6e3;
            color: #657b83;
        }
        .dataTables_length select {
            padding: 5px;
            border: 1px solid #93a1a1; /* base1 */
            border-radius: 4px;
            background-color: #fdf6e3;
            color: #657b83;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Futures Analysis Report</h1>
            <div class="timestamp">Generated: $timestamp</div>
        </div>
        
        <div class="stats">
            <div class="stat-box">
                <div class="number">$($allItems.Count)</div>
                <div class="label">Total Contracts</div>
            </div>
            <div class="stat-box">
                <div class="number">$($instruments.Count)</div>
                <div class="label">Instruments</div>
            </div>
            <div class="stat-box">
                <div class="number">$($longOpportunities.Count)</div>
                <div class="label">LONG Opportunities</div>
            </div>
            <div class="stat-box">
                <div class="number">$($shortOpportunities.Count)</div>
                <div class="label">SHORT Opportunities</div>
            </div>
        </div>
        
        <div class="tabs">
            <button class="tab active" data-tab="overview">Overview</button>
            <button class="tab" data-tab="long">LONG Opportunities</button>
            <button class="tab" data-tab="short">SHORT Opportunities</button>
"@

# Add instrument tabs
foreach ($rootSymbol in ($instruments.Keys | Sort-Object)) {
    $instrumentInfo = $instruments[$rootSymbol]
    $html += "            <button class='tab' data-tab='inst-$rootSymbol'>$rootSymbol - $($instrumentInfo.Name)</button>`n"
}

$html += @"
        </div>
        
        <div id="overview" class="tab-content active">
            <h2>All Futures Overview</h2>
            <table id="overviewTable" class="display">
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Contract Name</th>
                        <th>Last Price</th>
                        <th>Change</th>
                        <th>Open</th>
                        <th>High</th>
                        <th>Low</th>
                        <th>Volume</th>
                        <th>Category</th>
                    </tr>
                </thead>
                <tbody>
"@

foreach ($item in $allItems) {
    $changeClass = if ($item.PriceChange -gt 0) { "positive" } elseif ($item.PriceChange -lt 0) { "negative" } else { "" }
    $html += @"
                    <tr>
                        <td><strong>$($item.Symbol)</strong></td>
                        <td>$($item.ContractName)</td>
                        <td>$($item.LastPrice)</td>
                        <td class='$changeClass'>$($item.PriceChange)</td>
                        <td>$($item.OpenPrice)</td>
                        <td>$($item.HighPrice)</td>
                        <td>$($item.LowPrice)</td>
                        <td>$($item.Volume)</td>
                        <td>$($item.Category)</td>
                    </tr>
"@
}

$html += @"
                </tbody>
            </table>
        </div>
        
        <div id="long" class="tab-content">
            <h2>LONG Opportunities (Backwardation)</h2>
            <p style="margin: 15px 0; color: #6c757d;">Markets in backwardation where going LONG is favored - sorted by highest annualized return %</p>
            
            <table id="longTable" class="display">
                <thead>
                    <tr>
                        <th>Instrument</th>
                        <th>Name</th>
                        <th>Category</th>
                        <th>Front</th>
                        <th>Next</th>
                        <th>Front Price</th>
                        <th>Next Price</th>
                        <th>Daily Value</th>
                        <th>Ann. %</th>
                        <th>Curve</th>
                        <th>Days</th>
                    </tr>
                </thead>
                <tbody>
"@

foreach ($item in $longOpportunities) {
    $highlightClass = if ([Math]::Abs($item.AnnualizedPercent) -gt 5) { "highlight" } else { "" }
    $html += @"
                    <tr class='$highlightClass'>
                        <td><strong>$($item.Instrument)</strong></td>
                        <td>$($item.Name)</td>
                        <td>$($item.Category)</td>
                        <td>$($item.FrontContract)</td>
                        <td>$($item.NextContract)</td>
                        <td>$([Math]::Round($item.FrontPrice, 4))</td>
                        <td>$([Math]::Round($item.NextPrice, 4))</td>
                        <td class='positive'>`$$([Math]::Round($item.DailyValue, 2))</td>
                        <td class='negative'><strong>$([Math]::Round($item.AnnualizedPercent, 2))%</strong></td>
                        <td><span class='badge badge-backwardation'>$($item.CurveType)</span></td>
                        <td>$($item.EstDays)</td>
                    </tr>
"@
}

if ($longOpportunities.Count -gt 0) {
    $avgDailyValueLong = ($longOpportunities | Measure-Object -Property DailyValue -Average).Average
    $avgAnnualizedPctLong = ($longOpportunities | Measure-Object -Property AnnualizedPercent -Average).Average
    
    $html += @"
                </tbody>
            </table>
            
            <div class="summary-box">
                <h3>Summary Statistics</h3>
                <div class="summary-item">
                    <span>Total Opportunities:</span>
                    <strong>$($longOpportunities.Count)</strong>
                </div>
                <div class="summary-item">
                    <span>Average Daily Value:</span>
                    <strong>`$$([Math]::Round($avgDailyValueLong, 2))</strong>
                </div>
                <div class="summary-item">
                    <span>Average Annualized %:</span>
                    <strong>$([Math]::Round($avgAnnualizedPctLong, 2))%</strong>
                </div>
            </div>
"@
} else {
    $html += @"
                </tbody>
            </table>
            <p style="margin-top: 20px; color: #6c757d;">No LONG opportunities found in current market conditions.</p>
"@
}

$html += @"
        </div>
        
        <div id="short" class="tab-content">
            <h2>SHORT Opportunities (Contango)</h2>
            <p style="margin: 15px 0; color: #6c757d;">Markets in contango where going SHORT is favored - sorted by highest annualized return %</p>
            
            <table id="shortTable" class="display">
                <thead>
                    <tr>
                        <th>Instrument</th>
                        <th>Name</th>
                        <th>Category</th>
                        <th>Front</th>
                        <th>Next</th>
                        <th>Front Price</th>
                        <th>Next Price</th>
                        <th>Daily Value</th>
                        <th>Ann. %</th>
                        <th>Curve</th>
                        <th>Days</th>
                    </tr>
                </thead>
                <tbody>
"@

foreach ($item in $shortOpportunities) {
    $highlightClass = if ([Math]::Abs($item.AnnualizedPercent) -gt 5) { "highlight" } else { "" }
    $html += @"
                    <tr class='$highlightClass'>
                        <td><strong>$($item.Instrument)</strong></td>
                        <td>$($item.Name)</td>
                        <td>$($item.Category)</td>
                        <td>$($item.FrontContract)</td>
                        <td>$($item.NextContract)</td>
                        <td>$([Math]::Round($item.FrontPrice, 4))</td>
                        <td>$([Math]::Round($item.NextPrice, 4))</td>
                        <td class='positive'>`$$([Math]::Round($item.DailyValue, 2))</td>
                        <td class='positive'><strong>$([Math]::Round($item.AnnualizedPercent, 2))%</strong></td>
                        <td><span class='badge badge-contango'>$($item.CurveType)</span></td>
                        <td>$($item.EstDays)</td>
                    </tr>
"@
}

if ($shortOpportunities.Count -gt 0) {
    $avgDailyValueShort = ($shortOpportunities | Measure-Object -Property DailyValue -Average).Average
    $avgAnnualizedPctShort = ($shortOpportunities | Measure-Object -Property AnnualizedPercent -Average).Average
    
    $html += @"
                </tbody>
            </table>
            
            <div class="summary-box">
                <h3>Summary Statistics</h3>
                <div class="summary-item">
                    <span>Total Opportunities:</span>
                    <strong>$($shortOpportunities.Count)</strong>
                </div>
                <div class="summary-item">
                    <span>Average Daily Value:</span>
                    <strong>`$$([Math]::Round($avgDailyValueShort, 2))</strong>
                </div>
                <div class="summary-item">
                    <span>Average Annualized %:</span>
                    <strong>$([Math]::Round($avgAnnualizedPctShort, 2))%</strong>
                </div>
            </div>
"@
} else {
    $html += @"
                </tbody>
            </table>
            <p style="margin-top: 20px; color: #6c757d;">No SHORT opportunities found in current market conditions.</p>
"@
}

$html += "</div>`n"

# Add instrument detail tabs
foreach ($rootSymbol in ($instruments.Keys | Sort-Object)) {
    if ($instrumentDetails.ContainsKey($rootSymbol)) {
        $details = $instrumentDetails[$rootSymbol]
        
        $html += @"
        <div id="inst-$rootSymbol" class="tab-content">
            <h2>$rootSymbol - $($details.Name)</h2>
            <p style="margin: 15px 0; color: #6c757d;">Category: <strong>$($details.Category)</strong></p>
            
            <table id="inst-${rootSymbol}-table" class="display">
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Contract</th>
                        <th>Last Price</th>
                        <th>Change</th>
                        <th>Open</th>
                        <th>High</th>
                        <th>Low</th>
                        <th>Previous</th>
                        <th>Volume</th>
                        <th>Open Interest</th>
                    </tr>
                </thead>
                <tbody>
"@
        
        foreach ($contract in $details.Contracts) {
            $changeClass = if ($contract.priceChange -gt 0) { "positive" } elseif ($contract.priceChange -lt 0) { "negative" } else { "" }
            $html += @"
                    <tr>
                        <td><strong>$($contract.symbol)</strong></td>
                        <td>$($contract.contractSymbol)</td>
                        <td>$($contract.lastPrice)</td>
                        <td class='$changeClass'>$($contract.priceChange)</td>
                        <td>$($contract.openPrice)</td>
                        <td>$($contract.highPrice)</td>
                        <td>$($contract.lowPrice)</td>
                        <td>$($contract.previousPrice)</td>
                        <td>$($contract.volume)</td>
                        <td>$($contract.openInterest)</td>
                    </tr>
"@
        }
        
        $html += @"
                </tbody>
            </table>
        </div>
"@
    }
}

$html += @"
    </div>
    
    <script>
        `$(document).ready(function() {
            // Initialize DataTables for all tables
            `$('table.display').DataTable({
                pageLength: 25,
                order: [[0, 'asc']],
                responsive: true
            });
            
            // Tab switching
            `$('.tab').click(function() {
                const tabId = `$(this).data('tab');
                
                `$('.tab').removeClass('active');
                `$('.tab-content').removeClass('active');
                
                `$(this).addClass('active');
                `$('#' + tabId).addClass('active');
            });
        });
    </script>
</body>
</html>
"@

# Save HTML file
$filename = "futures_report.html"
$fullPath = Join-Path (Get-Location) $filename
$html | Out-File -FilePath $fullPath -Encoding UTF8

Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "HTML REPORT GENERATED" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "File: $filename" -ForegroundColor Green
Write-Host "Success: $successCount" -ForegroundColor Green
Write-Host "Failed: $failCount" -ForegroundColor Red
Write-Host "LONG Opportunities: $($longOpportunities.Count)" -ForegroundColor Cyan
Write-Host "SHORT Opportunities: $($shortOpportunities.Count)" -ForegroundColor Cyan
Write-Host "Location: $fullPath" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan

# Open in browser
Start-Process $fullPath