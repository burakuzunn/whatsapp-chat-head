---
trigger: always_on
description: Her kod değişikliğinden sonra otomatik olarak GitHub Release yayınla (Zero-Touch Auto Release)
---

# Otomatik Sürüm ve GitHub Release Kuralı (Zero-Touch Deployment)

Bu projede kullanıcı hiçbir manuel git veya release komutu çalıştırmamalıdır.

1. Projede herhangi bir kod, tasarım veya özellik değişikliği yaptığında, işin biter bitmez **kullanıcıdan komut beklemeden** doğrudan:
   ```powershell
   node release.js "<değişiklik özeti>"
   ```
   komutunu çalıştır.
2. `node release.js` komutu otomatik olarak:
   - `package.json` içindeki `version` numarasını bir üst sürüme (`patch`) yükseltir,
   - Tüm değişiklikleri `git add .` ve `git commit` ile kaydeder,
   - `git push origin main` ile GitHub'a gönderir,
   - GitHub REST API üzerinden anında yeni **GitHub Release** (`vX.Y.Z`) yayınlar.
3. Böylece bağlı olan tüm istemciler (`updater.js` sayesinde) hiçbir müdahale olmadan kendilerini otomatik olarak yeni sürüme günceller.
