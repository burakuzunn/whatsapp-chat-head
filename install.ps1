$ErrorActionPreference = "Stop"
Write-Host "==> WhatsApp Chat Head (Masaustu Yuzen Baloncuk) Kuruluyor..." -ForegroundColor Green

# 1. Node.js kontrolu (yoksa winget ile otomatik kur)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "==> Node.js bulunamadi, winget ile otomatik kuruluyor..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

$installDir = Join-Path $HOME "whatsapp-chat-head"
$repoUrl = "https://github.com/burakuzunn/whatsapp-chat-head.git"
$zipUrl = "https://github.com/burakuzunn/whatsapp-chat-head/archive/refs/heads/main.zip"

# 2. Projeyi indir (git varsa git clone, yoksa ZIP indir)
if (Test-Path $installDir) {
    Write-Host "==> Mevcut klasor guncelleniyor: $installDir" -ForegroundColor Cyan
    if (Test-Path (Join-Path $installDir ".git")) {
        Push-Location $installDir
        git pull origin main 2>$null
        Pop-Location
    }
} else {
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Host "==> Git ile klonlaniyor..." -ForegroundColor Cyan
        git clone $repoUrl $installDir
    } else {
        Write-Host "==> ZIP arsivi indiriliyor..." -ForegroundColor Cyan
        $tmpZip = Join-Path $env:TEMP "whatsapp-chat-head.zip"
        $tmpExtract = Join-Path $env:TEMP "whatsapp-chat-head-extract"
        Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip
        if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }
        Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
        $innerFolder = Get-ChildItem $tmpExtract | Select-Object -First 1
        Move-Item $innerFolder.FullName $installDir
        Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    }
}

# 3. Bagimliliklari kur ve Masaustu kisayolunu olustur
Push-Location $installDir
Write-Host "==> Bagimliliklar yukleniyor (npm install)..." -ForegroundColor Cyan
npm install
Pop-Location

# 4. Uygulamayi baslat
$vbs = Join-Path $installDir "baslat.vbs"
Write-Host "==> Kurulum tamamlandi! WhatsApp Bubble baslatiliyor (Kisayol: Alt + W)..." -ForegroundColor Green
Start-Process "wscript.exe" -ArgumentList "`"$vbs`""
