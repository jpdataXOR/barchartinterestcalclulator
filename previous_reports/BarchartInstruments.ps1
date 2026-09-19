# Get futures data and save to Excel with tabs
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
        
        # Extract root symbol
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

# Create Excel COM object
Write-Host "Creating Excel workbook..." -ForegroundColor Cyan
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $true
$excel.DisplayAlerts = $false
$workbook = $excel.Workbooks.Add()

# Remove default sheets except one
while ($workbook.Worksheets.Count -gt 1) {
    $workbook.Worksheets.Item($workbook.Worksheets.Count).Delete()
}

# Create main sheet
$mainSheet = $workbook.Worksheets.Item(1)
$mainSheet.Name = "All Futures"

# Write main data headers
$headers = @("Symbol", "Contract Name", "Last Price", "Change", "Open", "High", "Low", "Volume", "Trade Time", "Category")
for ($i = 0; $i -lt $headers.Count; $i++) {
    $mainSheet.Cells.Item(1, $i + 1) = $headers[$i]
    $mainSheet.Cells.Item(1, $i + 1).Font.Bold = $true
    $mainSheet.Cells.Item(1, $i + 1).Interior.Color = 15773696
}

# Write main data
$row = 2
foreach ($item in $allItems) {
    $mainSheet.Cells.Item($row, 1) = $item.Symbol
    $mainSheet.Cells.Item($row, 2) = $item.ContractName
    $mainSheet.Cells.Item($row, 3) = $item.LastPrice
    $mainSheet.Cells.Item($row, 4) = $item.PriceChange
    $mainSheet.Cells.Item($row, 5) = $item.OpenPrice
    $mainSheet.Cells.Item($row, 6) = $item.HighPrice
    $mainSheet.Cells.Item($row, 7) = $item.LowPrice
    $mainSheet.Cells.Item($row, 8) = $item.Volume
    $mainSheet.Cells.Item($row, 9) = $item.TradeTime
    $mainSheet.Cells.Item($row, 10) = $item.Category
    $row++
}

$mainSheet.UsedRange.EntireColumn.AutoFit() | Out-Null

# Array to store yield analysis
$yieldAnalysis = @()

# Now get detailed data for each instrument
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
        
        Write-Host "    URL: $instrumentUrl" -ForegroundColor DarkGray
        $instrumentResponse = Invoke-WebRequest -UseBasicParsing -Uri $instrumentUrl `
            -WebSession $session `
            -Headers @{
                "accept" = "application/json"
                "referer" = "https://www.barchart.com/futures/quotes/$rootSymbol*0/futures-prices"
                "x-xsrf-token" = $xsrfToken
            }
        
        $instrumentData = $instrumentResponse.Content | ConvertFrom-Json
        
        if ($instrumentData.data -and $instrumentData.data.Count -gt 0) {
            $newSheet = $workbook.Worksheets.Add([System.Reflection.Missing]::Value, $workbook.Worksheets.Item($workbook.Worksheets.Count))
            
            $sheetName = "$rootSymbol - $($instrumentInfo.Name)"
            if ($sheetName.Length -gt 31) {
                $sheetName = $sheetName.Substring(0, 31)
            }
            $sheetName = $sheetName -replace '[\[\]:*?/\\]', ''
            $newSheet.Name = $sheetName
            
            $detailHeaders = @("Symbol", "Contract", "Last Price", "Change", "Open", "High", "Low", "Previous", "Volume", "Open Interest", "Trade Time")
            for ($i = 0; $i -lt $detailHeaders.Count; $i++) {
                $newSheet.Cells.Item(1, $i + 1) = $detailHeaders[$i]
                $newSheet.Cells.Item(1, $i + 1).Font.Bold = $true
                $newSheet.Cells.Item(1, $i + 1).Interior.Color = 15773696
            }
            
            $detailRow = 2
            $contracts = @()
            
            foreach ($contract in $instrumentData.data) {
                $raw = $contract.raw
                $contracts += $raw
                
                $newSheet.Cells.Item($detailRow, 1) = $raw.symbol
                $newSheet.Cells.Item($detailRow, 2) = $raw.contractSymbol
                $newSheet.Cells.Item($detailRow, 3) = $raw.lastPrice
                $newSheet.Cells.Item($detailRow, 4) = $raw.priceChange
                $newSheet.Cells.Item($detailRow, 5) = $raw.openPrice
                $newSheet.Cells.Item($detailRow, 6) = $raw.highPrice
                $newSheet.Cells.Item($detailRow, 7) = $raw.lowPrice
                $newSheet.Cells.Item($detailRow, 8) = $raw.previousPrice
                $newSheet.Cells.Item($detailRow, 9) = $raw.volume
                $newSheet.Cells.Item($detailRow, 10) = $raw.openInterest
                $newSheet.Cells.Item($detailRow, 11) = $raw.tradeTime
                $detailRow++
            }
            
            $newSheet.UsedRange.EntireColumn.AutoFit() | Out-Null
            
            # Calculate yield
            if ($contracts.Count -ge 2) {
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
            }
            
            Write-Host "    Success: $($instrumentData.data.Count) contracts" -ForegroundColor Green
            $successCount++
        } else {
            Write-Host "    No data returned" -ForegroundColor Red
            $failCount++
        }
        
        Start-Sleep -Milliseconds 500
        
    } catch {
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
        $failCount++
    }
}

# Create Yield Analysis sheets - separate for LONG and SHORT
if ($yieldAnalysis.Count -gt 0) {
    Write-Host "`nCreating Yield Analysis sheets..." -ForegroundColor Cyan
    
    # Separate into LONG and SHORT opportunities
    $longOpportunities = $yieldAnalysis | Where-Object { $_.CurveType -eq "Backwardation" }
    $shortOpportunities = $yieldAnalysis | Where-Object { $_.CurveType -eq "Contango" }
    
    Write-Host "  Long opportunities (Backwardation): $($longOpportunities.Count)" -ForegroundColor Cyan
    Write-Host "  Short opportunities (Contango): $($shortOpportunities.Count)" -ForegroundColor Cyan
    
    # Create LONG OPPORTUNITIES sheet
    if ($longOpportunities.Count -gt 0) {
        $longSheet = $workbook.Worksheets.Add([System.Reflection.Missing]::Value, $workbook.Worksheets.Item($workbook.Worksheets.Count))
        $longSheet.Name = "LONG Opportunities"
        
        $yieldHeaders = @("Instrument", "Name", "Category", "Front Contract", "Next Contract", "Front Price", "Next Price", "Price Diff", "Daily Basis", "Daily Value", "Annualized Basis", "Annualized Pct", "Curve Type", "Favored Side", "Est Days", "Point Value")
        for ($i = 0; $i -lt $yieldHeaders.Count; $i++) {
            $longSheet.Cells.Item(1, $i + 1) = $yieldHeaders[$i]
            $longSheet.Cells.Item(1, $i + 1).Font.Bold = $true
            $longSheet.Cells.Item(1, $i + 1).Interior.Color = 13434828  # Light blue for LONG
        }
        
        # Sort by absolute Annualized Percent
        $sortedLong = $longOpportunities | Sort-Object { [Math]::Abs($_.AnnualizedPercent) } -Descending
        
        $longRow = 2
        foreach ($item in $sortedLong) {
            $longSheet.Cells.Item($longRow, 1) = $item.Instrument
            $longSheet.Cells.Item($longRow, 2) = $item.Name
            $longSheet.Cells.Item($longRow, 3) = $item.Category
            $longSheet.Cells.Item($longRow, 4) = $item.FrontContract
            $longSheet.Cells.Item($longRow, 5) = $item.NextContract
            $longSheet.Cells.Item($longRow, 6) = $item.FrontPrice
            $longSheet.Cells.Item($longRow, 7) = $item.NextPrice
            $longSheet.Cells.Item($longRow, 8) = [Math]::Round($item.PriceDiff, 6)
            $longSheet.Cells.Item($longRow, 9) = [Math]::Round($item.DailyBasis, 8)
            $longSheet.Cells.Item($longRow, 10) = [Math]::Round($item.DailyValue, 2)
            $longSheet.Cells.Item($longRow, 11) = [Math]::Round($item.AnnualizedBasis, 4)
            $longSheet.Cells.Item($longRow, 12) = [Math]::Round($item.AnnualizedPercent, 4)
            $longSheet.Cells.Item($longRow, 13) = $item.CurveType
            $longSheet.Cells.Item($longRow, 14) = $item.FavoredSide
            $longSheet.Cells.Item($longRow, 15) = $item.EstDays
            $longSheet.Cells.Item($longRow, 16) = $item.PointValue
            
            # Highlight high percentage opportunities
            if ([Math]::Abs($item.AnnualizedPercent) -gt 5) {
                $longSheet.Cells.Item($longRow, 12).Font.Bold = $true
                $longSheet.Cells.Item($longRow, 12).Font.Color = 255  # Red
            }
            
            $longRow++
        }
        
        $longSheet.UsedRange.EntireColumn.AutoFit() | Out-Null
        
        # Add summary for LONG
        $summaryRow = $longRow + 2
        $longSheet.Cells.Item($summaryRow, 1) = "LONG SUMMARY"
        $longSheet.Cells.Item($summaryRow, 1).Font.Bold = $true
        $longSheet.Cells.Item($summaryRow, 1).Interior.Color = 12632256
        
        $avgDailyValueLong = ($sortedLong | Measure-Object -Property DailyValue -Average).Average
        $avgAnnualizedPctLong = ($sortedLong | Measure-Object -Property AnnualizedPercent -Average).Average
        
        $longSheet.Cells.Item($summaryRow + 1, 1) = "Total Opportunities:"
        $longSheet.Cells.Item($summaryRow + 1, 2) = $longOpportunities.Count
        $longSheet.Cells.Item($summaryRow + 2, 1) = "Avg Daily Value:"
        $longSheet.Cells.Item($summaryRow + 2, 2) = [Math]::Round($avgDailyValueLong, 2)
        $longSheet.Cells.Item($summaryRow + 3, 1) = "Avg Annualized %:"
        $longSheet.Cells.Item($summaryRow + 3, 2) = [Math]::Round($avgAnnualizedPctLong, 2)
        
        Write-Host "  Created LONG Opportunities sheet" -ForegroundColor Green
    }
    
    # Create SHORT OPPORTUNITIES sheet
    if ($shortOpportunities.Count -gt 0) {
        $shortSheet = $workbook.Worksheets.Add([System.Reflection.Missing]::Value, $workbook.Worksheets.Item($workbook.Worksheets.Count))
        $shortSheet.Name = "SHORT Opportunities"
        
        $yieldHeaders = @("Instrument", "Name", "Category", "Front Contract", "Next Contract", "Front Price", "Next Price", "Price Diff", "Daily Basis", "Daily Value", "Annualized Basis", "Annualized Pct", "Curve Type", "Favored Side", "Est Days", "Point Value")
        for ($i = 0; $i -lt $yieldHeaders.Count; $i++) {
            $shortSheet.Cells.Item(1, $i + 1) = $yieldHeaders[$i]
            $shortSheet.Cells.Item(1, $i + 1).Font.Bold = $true
            $shortSheet.Cells.Item(1, $i + 1).Interior.Color = 13434879  # Light orange for SHORT
        }
        
        # Sort by absolute Annualized Percent
        $sortedShort = $shortOpportunities | Sort-Object { [Math]::Abs($_.AnnualizedPercent) } -Descending
        
        $shortRow = 2
        foreach ($item in $sortedShort) {
            $shortSheet.Cells.Item($shortRow, 1) = $item.Instrument
            $shortSheet.Cells.Item($shortRow, 2) = $item.Name
            $shortSheet.Cells.Item($shortRow, 3) = $item.Category
            $shortSheet.Cells.Item($shortRow, 4) = $item.FrontContract
            $shortSheet.Cells.Item($shortRow, 5) = $item.NextContract
            $shortSheet.Cells.Item($shortRow, 6) = $item.FrontPrice
            $shortSheet.Cells.Item($shortRow, 7) = $item.NextPrice
            $shortSheet.Cells.Item($shortRow, 8) = [Math]::Round($item.PriceDiff, 6)
            $shortSheet.Cells.Item($shortRow, 9) = [Math]::Round($item.DailyBasis, 8)
            $shortSheet.Cells.Item($shortRow, 10) = [Math]::Round($item.DailyValue, 2)
            $shortSheet.Cells.Item($shortRow, 11) = [Math]::Round($item.AnnualizedBasis, 4)
            $shortSheet.Cells.Item($shortRow, 12) = [Math]::Round($item.AnnualizedPercent, 4)
            $shortSheet.Cells.Item($shortRow, 13) = $item.CurveType
            $shortSheet.Cells.Item($shortRow, 14) = $item.FavoredSide
            $shortSheet.Cells.Item($shortRow, 15) = $item.EstDays
            $shortSheet.Cells.Item($shortRow, 16) = $item.PointValue
            
            # Highlight high percentage opportunities
            if ([Math]::Abs($item.AnnualizedPercent) -gt 5) {
                $shortSheet.Cells.Item($shortRow, 12).Font.Bold = $true
                $shortSheet.Cells.Item($shortRow, 12).Font.Color = 255  # Red
            }
            
            $shortRow++
        }
        
        $shortSheet.UsedRange.EntireColumn.AutoFit() | Out-Null
        
        # Add summary for SHORT
        $summaryRow = $shortRow + 2
        $shortSheet.Cells.Item($summaryRow, 1) = "SHORT SUMMARY"
        $shortSheet.Cells.Item($summaryRow, 1).Font.Bold = $true
        $shortSheet.Cells.Item($summaryRow, 1).Interior.Color = 12632256
        
        $avgDailyValueShort = ($sortedShort | Measure-Object -Property DailyValue -Average).Average
        $avgAnnualizedPctShort = ($sortedShort | Measure-Object -Property AnnualizedPercent -Average).Average
        
        $shortSheet.Cells.Item($summaryRow + 1, 1) = "Total Opportunities:"
        $shortSheet.Cells.Item($summaryRow + 1, 2) = $shortOpportunities.Count
        $shortSheet.Cells.Item($summaryRow + 2, 1) = "Avg Daily Value:"
        $shortSheet.Cells.Item($summaryRow + 2, 2) = [Math]::Round($avgDailyValueShort, 2)
        $shortSheet.Cells.Item($summaryRow + 3, 1) = "Avg Annualized %:"
        $shortSheet.Cells.Item($summaryRow + 3, 2) = [Math]::Round($avgAnnualizedPctShort, 2)
        
        Write-Host "  Created SHORT Opportunities sheet" -ForegroundColor Green
    }
    
    Write-Host "Yield analysis completed: $($yieldAnalysis.Count) instruments" -ForegroundColor Green
}

# Save workbook
$filename = "futures_data.xlsx"
$fullPath = Join-Path (Get-Location) $filename
$workbook.SaveAs($fullPath)

Write-Host "`n======================================" -ForegroundColor Cyan
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "File: $filename" -ForegroundColor Green
Write-Host "Success: $successCount" -ForegroundColor Green
Write-Host "Failed: $failCount" -ForegroundColor Red
Write-Host "Yield Analysis: $($yieldAnalysis.Count)" -ForegroundColor Cyan
Write-Host "Location: $fullPath" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Cyan