const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, 'node_modules', 'electron', 'dist');
const electronExe = path.join(distDir, 'electron.exe');
const bubbleExe = path.join(distDir, 'whatsapp-bubble.exe');
const electronInstallScript = path.join(__dirname, 'node_modules', 'electron', 'install.js');

function ensureBinary() {
  // 1. Electron binary indirilmemişse otomatik indir
  if (!fs.existsSync(electronExe) && fs.existsSync(electronInstallScript)) {
    console.log('[Kurulum] Electron ikili dosyaları indiriliyor...');
    try {
      execSync(`node "${electronInstallScript}"`, { stdio: 'inherit' });
    } catch (err) {
      console.warn('[Kurulum] Electron indirme uyarısı:', err.message);
    }
  }

  // 2. whatsapp-bubble.exe hardlink / kopyasını oluştur
  if (fs.existsSync(electronExe) && !fs.existsSync(bubbleExe)) {
    try {
      fs.linkSync(electronExe, bubbleExe);
    } catch (_) {
      try {
        fs.copyFileSync(electronExe, bubbleExe);
      } catch (_) {}
    }
  }
}

function ensureDesktopAndStartupShortcuts(enableAutoStart = true) {
  if (process.platform !== 'win32') return;

  try {
    const vbsPath = path.join(__dirname, 'baslat.vbs');
    const customIco = path.join(__dirname, 'whatsapp.ico');
    const fallbackExe = fs.existsSync(bubbleExe) ? bubbleExe : electronExe;
    const iconLocation = fs.existsSync(customIco) ? `${customIco},0` : `${fallbackExe},0`;

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$WshShell = New-Object -ComObject WScript.Shell

# 1. Masaüstü Kısayolu (WhatsApp.lnk)
$Desktop = [Environment]::GetFolderPath('Desktop')
$OldDesktopLnk = Join-Path $Desktop 'WhatsApp Bubble.lnk'
if (Test-Path $OldDesktopLnk) { Remove-Item $OldDesktopLnk -Force }

$DesktopLnk = Join-Path $Desktop 'WhatsApp.lnk'
$Shortcut = $WshShell.CreateShortcut($DesktopLnk)
$Shortcut.TargetPath = 'wscript.exe'
$Shortcut.Arguments = '"${vbsPath}"'
$Shortcut.WorkingDirectory = '${__dirname}'
$Shortcut.Description = 'WhatsApp Sohbet Baloncuğu'
$Shortcut.IconLocation = '${iconLocation}'
$Shortcut.Save()

# 2. Windows Başlangıç (Startup) Kısayolu ve Kayıt Defteri (Auto-Start)
$StartupDir = [Environment]::GetFolderPath('Startup')
$StartupLnk = Join-Path $StartupDir 'WhatsApp.lnk'
$RunRegPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

if (${enableAutoStart ? '$true' : '$false'}) {
  $StShortcut = $WshShell.CreateShortcut($StartupLnk)
  $StShortcut.TargetPath = 'wscript.exe'
  $StShortcut.Arguments = '"${vbsPath}"'
  $StShortcut.WorkingDirectory = '${__dirname}'
  $StShortcut.Description = 'WhatsApp Sohbet Baloncuğu Otomatik Başlatıcı'
  $StShortcut.IconLocation = '${iconLocation}'
  $StShortcut.Save()

  Set-ItemProperty -Path $RunRegPath -Name 'WhatsAppChatHead' -Value ('wscript.exe "' + '${vbsPath}' + '"')
} else {
  if (Test-Path $StartupLnk) { Remove-Item $StartupLnk -Force }
  Remove-ItemProperty -Path $RunRegPath -Name 'WhatsAppChatHead' -ErrorAction SilentlyContinue
}
`;

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (_) {}
}

if (require.main === module) {
  ensureBinary();
  ensureDesktopAndStartupShortcuts(true);
  console.log('[Kurulum] Masaüstü WhatsApp ikonu ve otomatik başlatma ayarlandı.');
}

module.exports = {
  ensureBinary,
  ensureDesktopAndStartupShortcuts
};
