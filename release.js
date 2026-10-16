const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const REPO_OWNER = 'burakuzunn';
const REPO_NAME = 'whatsapp-chat-head';

function bumpPatch(ver) {
  const parts = String(ver || '1.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join('.');
}

function getGithubToken() {
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf-8'
    });
    const m = out.match(/^password=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function createGithubRelease(token, tagName, releaseTitle, releaseNotes) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      tag_name: tagName,
      target_commitish: 'main',
      name: releaseTitle,
      body: releaseNotes,
      draft: false,
      prerelease: false
    });

    const req = https.request(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases`,
      {
        method: 'POST',
        headers: {
          'User-Agent': 'WhatsApp-Chat-Head-Releaser/1.0',
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(text));
          } else {
            reject(new Error(`GitHub Release API HTTP ${res.statusCode}: ${text}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  const pkgPath = path.join(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  const firstArg = process.argv[2] || '';
  const isExplicitVersion = /^v?\d+\.\d+\.\d+$/.test(firstArg.trim());

  const nextVersion = isExplicitVersion
    ? firstArg.trim().replace(/^v/i, '')
    : bumpPatch(pkg.version);
  const tagName = `v${nextVersion}`;
  const noteArgs = isExplicitVersion ? process.argv.slice(3) : process.argv.slice(2);
  const notes = noteArgs.join(' ').trim() || `Otomatik güncelleme paketi (${tagName})`;

  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`==> Sürüm güncellendi: ${tagName}`);

  execSync('git add .', { stdio: 'inherit' });
  try {
    execSync(`git commit -m "release(${tagName}): ${notes}"`, { stdio: 'inherit' });
  } catch (_) {}
  execSync('git push origin main', { stdio: 'inherit' });

  const token = getGithubToken();
  if (!token) {
    console.log('==> Git push tamamlandı. GitHub Actions üzerinden Release otomatik oluşturulacak.');
    return;
  }

  try {
    const rel = await createGithubRelease(token, tagName, `Release ${tagName}`, notes);
    console.log(`==> GitHub Release anında yayınlandı: ${rel.html_url}`);
  } catch (err) {
    console.warn('==> GitHub API uyarısı (GitHub Actions devralacak):', err.message);
  }
})();
