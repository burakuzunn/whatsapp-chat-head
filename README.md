# 💬 WhatsApp Chat Head (Windows Yüzen Sohbet Baloncuğu)

Windows masaüstünde tüm pencerelerin üzerinde duran, tıkladığınızda altında **mesaj sırasına göre yuvarlak sohbet avatarlarını** (ve üzerlerinde okunmamış bildirim sayılarını) açan, yan tarafında ise **sadece aktif sohbet ekranını** gösteren hafif WhatsApp masaüstü uygulaması.

---

## ⚡ Tek Komutla Kurulum (Tak - Çalıştır)

PowerShell'i açıp aşağıdaki **tek satırlık komutu** yapıştırıp `Enter`'a basın. Kurulumu otomatik yapar, masaüstüne kısayol ekler ve uygulamayı başlatır:

```powershell
irm https://raw.githubusercontent.com/burakuzunn/whatsapp-chat-head/main/install.ps1 | iex
```

---

## 🤖 Sıfır Müdahale (Zero-Touch) Otomatik Yayınlama & Güncelleme Sistemi

Bu projede hem **sürüm yayınlama (Release)** hem de **istemci güncelleme (Auto-Update)** süreçleri tamamen otomatiktir:

1. **Otomatik Sürüm Yayınlama (`.agents/rules/auto-release.md` & `release.js`):**
   - Yapay zeka asistanı projede herhangi bir kod veya tasarım değişikliği yaptığı anda, kullanıcıdan hiçbir komut beklemeden otomatik olarak `node release.js` çalıştırır.
   - `release.js` otomatik olarak `package.json` sürümünü (`patch`) artırır, `git commit` + `git push origin main` yapar ve GitHub REST API üzerinden anında yeni **GitHub Release** (`v1.0.x`) oluşturur.
   - Ek olarak `.github/workflows/auto-release.yml` (GitHub Actions) sayesinde `main` dalına yapılan her push işlemi sunucu tarafında da kontrol edilerek Release oluşturulması garanti altına alınır.
2. **İstemci Tarafında Otomatik Güncelleme (`updater.js`):**
   - Uygulama açılışta (3. saniyede) ve arka planda **her 2 dakikada bir** GitHub'daki son **Release** sürümünü kontrol eder.
   - Yeni sürüm tespit edildiğinde Electron'u baştan indirmeden yalnızca değişen kaynak dosyaları (~50 KB) saniyeler içinde indirip günceller ve **WhatsApp oturumunu kapatmadan kendini otomatik olarak yeniden başlatır**.
   - İstenirse WhatsApp baloncuğuna sağ tıklayıp **⬆️ Güncellemeleri Kontrol Et** seçeneğiyle anlık kontrol de yapılabilir.

---

## 🛠️ Git ile Manuel Kurulum

```bash
git clone https://github.com/burakuzunn/whatsapp-chat-head.git
cd whatsapp-chat-head
npm install
npm run silent
```

Veya klasör içindeki **`kur-ve-baslat.bat`** dosyasına çift tıklamanız yeterlidir.

---

## ✨ Özellikler & Kısayollar

- **Dikey Sohbet Avatarları:** WhatsApp ikonuna tıkladığınızda sohbet penceresinin boyutu kadar aşağıya doğru son mesaj sırasına göre kişi/grup fotoğrafları sıralanır.
- **Canlı Bildirim Rozetleri:** Okunmamış mesaj sayısı hem ana WhatsApp ikonunda hem de ilgili kişinin fotoğrafının üzerinde kırmızı rozet olarak görünür.
- **Sadece Sohbet Ekranı:** Pencere içinde sol liste kalabalığı olmadan `%100` sadece aktif konuşma ekranı yer alır.
- **👥 Sohbet Seç Kutusu:** Üst bardaki **Sohbet Seç** butonuyla harici arama kutusunu açıp istediğiniz kişiyi arayabilirsiniz.
- **`Alt + W` Global Kısayolu:** Hangi uygulamada olursanız olun `Alt + W` ile sohbeti anında açıp gizleyebilirsiniz.
- **👁️ Gizlilik Modu & 📌 Sabitleme:** Üst bardan mesajları bulanıklaştırabilir veya pencereyi ekrana sabitleyebilirsiniz.
