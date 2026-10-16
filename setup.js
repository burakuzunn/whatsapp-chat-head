const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, 'node_modules', 'electron', 'dist');
const electronExe = path.join(distDir, 'electron.exe');
const bubbleExe = path.join(distDir, 'whatsapp-bubble.exe');
const electronInstallScript = path.join(__dirname, 'node_modules', 'electron', 'install.js');

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

// 3. Masaüstüne "WhatsApp Bubble" kısayolu oluştur
if (process.platform === 'win32') {
  try {
    const vbsPath = path.join(__dirname, 'baslat.vbs');
    const iconPath = fs.existsSync(bubbleExe) ? bubbleExe : electronExe;
    const psCmd = `
      $WshShell = New-Object -ComObject WScript.Shell;
      $Desktop = [Environment]::GetFolderPath('Desktop');
      $Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop 'WhatsApp Bubble.lnk'));
      $Shortcut.TargetPath = 'wscript.exe';
      $Shortcut.Arguments = '"${vbsPath}"';
      $Shortcut.WorkingDirectory = '${__dirname}';
      if (Test-Path '${iconPath}') { $Shortcut.IconLocation = '${iconPath},0'; }
      $Shortcut.Save();
    `
      .replace(/\r?\n/g, ' ')
      .trim();

    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd.replace(/"/g, '\\"')}"`, {
      stdio: 'ignore'
    });
    console.log('[Kurulum] Masaüstüne "WhatsApp Bubble" kısayolu oluşturuldu.');
  } catch (_) {}
}
