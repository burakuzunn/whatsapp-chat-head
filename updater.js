const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'burakuzunn';
const REPO_NAME = 'whatsapp-chat-head';

const CORE_FILES = [
  'main.js',
  'preload-chat.js',
  'updater.js',
  'release.js',
  'bubble.html',
  'chat.html',
  'selector.html',
  'setup.js',
  'baslat.vbs',
  'kur-ve-baslat.bat',
  'install.ps1',
  'README.md',
  'package.json'
];

function cleanVersion(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '');
}

function compareVersions(v1, v2) {
  const a = cleanVersion(v1)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const b = cleanVersion(v2)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function getLocalVersion() {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return cleanVersion(pkg.version || '1.0.0');
  } catch (_) {
    return '1.0.0';
  }
}

function httpsGet(url, isJson = false) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'WhatsApp-Chat-Head-Updater/1.0',
          Accept: isJson ? 'application/vnd.github+json' : '*/*',
          'Cache-Control': 'no-cache'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpsGet(res.headers.location, isJson).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (isJson) {
            try {
              resolve(JSON.parse(buf.toString('utf-8')));
            } catch (e) {
              reject(e);
            }
          } else {
            resolve(buf);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

async function getLatestRemoteReleaseInfo() {
  // 1. Önce GitHub Releases (/releases/latest) kontrol et
  try {
    const release = await httpsGet(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      true
    );
    if (release && release.tag_name) {
      return {
        version: cleanVersion(release.tag_name),
        ref: release.tag_name,
        notes: release.name || release.body || ''
      };
    }
  } catch (_) {}

  // 2. Fallback: main dalındaki package.json sürümünü kontrol et
  try {
    const rawPkgBuf = await httpsGet(
      `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/package.json?t=${Date.now()}`,
      false
    );
    const remotePkg = JSON.parse(rawPkgBuf.toString('utf-8'));
    if (remotePkg && remotePkg.version) {
      return {
        version: cleanVersion(remotePkg.version),
        ref: 'main',
        notes: ''
      };
    }
  } catch (_) {}

  return null;
}

async function getFilesToUpdate(ref) {
  try {
    const treeData = await httpsGet(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      true
    );
    if (treeData && Array.isArray(treeData.tree)) {
      const blobs = treeData.tree
        .filter((item) => item.type === 'blob' && item.path && !item.path.startsWith('.git'))
        .map((item) => item.path);
      if (blobs.length > 0) return blobs;
    }
  } catch (_) {}
  return CORE_FILES;
}

let isUpdating = false;

async function checkAndApplyUpdate({ app, onStatus } = {}) {
  if (isUpdating) return { updated: false, reason: 'already-updating' };
  isUpdating = true;

  try {
    const localVersion = getLocalVersion();
    const remote = await getLatestRemoteReleaseInfo();

    if (!remote || !remote.version) {
      isUpdating = false;
      return { updated: false, localVersion, reason: 'no-remote-info' };
    }

    if (compareVersions(remote.version, localVersion) <= 0) {
      isUpdating = false;
      return { updated: false, localVersion, remoteVersion: remote.version, reason: 'up-to-date' };
    }

    if (typeof onStatus === 'function') {
      onStatus(`Yeni sürüm bulundu (v${remote.version}), otomatik güncelleniyor...`);
    }

    const files = await getFilesToUpdate(remote.ref);

    for (const relPath of files) {
      try {
        const fileUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${encodeURIComponent(remote.ref)}/${relPath}?t=${Date.now()}`;
        const buf = await httpsGet(fileUrl, false);
        const targetPath = path.join(__dirname, relPath);
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, buf);
      } catch (_) {}
    }

    // Yerel package.json sürümünü yeni release etiketiyle eşitle (tekrar döngüye girmemesi için)
    try {
      const pkgPath = path.join(__dirname, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        pkg.version = remote.version;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      }
    } catch (_) {}

    if (typeof onStatus === 'function') {
      onStatus(`v${remote.version} güncellendi! Yeniden başlatılıyor...`);
    }

    if (app) {
      setTimeout(() => {
        app.relaunch({ args: process.argv.slice(1) });
        app.exit(0);
      }, 800);
    }

    isUpdating = false;
    return { updated: true, localVersion, remoteVersion: remote.version };
  } catch (err) {
    isUpdating = false;
    return { updated: false, error: err.message };
  }
}

module.exports = {
  getLocalVersion,
  checkAndApplyUpdate
};
