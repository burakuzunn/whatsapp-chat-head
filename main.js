const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  globalShortcut,
  shell,
  Menu,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');
const { getLocalVersion, checkAndApplyUpdate } = require('./updater');

// Güncel Windows Chrome User-Agent (WhatsApp Web tarayıcı uyarısını engeller)
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BUBBLE_SIZE = 72;
const CHAT_WIDTH = 480;
const CHAT_HEIGHT = 700;
const PREVIEW_WIDTH = 260;
const PREVIEW_HEIGHT = 76;
const GAP = 10;

let bubbleWin = null;
let chatWin = null;
let selectorWin = null;
let previewWin = null;
let previewHideTimer = null;
let cachedChatList = [];
let isQuitting = false;
let isPinned = false;
let isMuted = false;
let lastUnreadCount = 0;
let ignoreBlurUntil = 0;
let hasInitializedChatState = false;
const prevChatStateMap = new Map();
let lastPreviewKey = '';
let lastPreviewTime = 0;

// Sürükleme durumu (Main Process)
let dragInterval = null;
let dragStartCursor = null;
let dragStartBounds = null;
let movedBeyondThreshold = false;

// Tek örnek (Single Instance) kilidi
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (bubbleWin) {
      if (!bubbleWin.isVisible()) bubbleWin.show();
      openChatNearBubble();
    }
  });
}

// Konum kaydetme / yükleme yardımcı fonksiyonları
function getConfigPath() {
  return path.join(app.getPath('userData'), 'bubble-config.json');
}

function loadSavedPosition() {
  try {
    const cfgPath = getConfigPath();
    if (fs.existsSync(cfgPath)) {
      const data = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (typeof data.x === 'number' && typeof data.y === 'number') {
        const display = screen.getDisplayNearestPoint({ x: data.x, y: data.y });
        const wa = display.workArea;
        const clampedX = Math.max(wa.x, Math.min(data.x, wa.x + wa.width - BUBBLE_SIZE));
        const clampedY = Math.max(wa.y, Math.min(data.y, wa.y + wa.height - BUBBLE_SIZE));
        return { x: clampedX, y: clampedY };
      }
    }
  } catch (_) {}

  // Varsayılan: Ultra-geniş (5120px) ekranlarda göz önünde olması için orta-sağ, normal ekranlarda sağ kenar
  const primary = screen.getPrimaryDisplay().workArea;
  const defaultX =
    primary.width > 3000
      ? primary.x + Math.round(primary.width * 0.65)
      : primary.x + primary.width - BUBBLE_SIZE - 24;
  return {
    x: defaultX,
    y: primary.y + Math.round(primary.height * 0.22)
  };
}

function saveBubblePosition() {
  if (!bubbleWin || bubbleWin.isDestroyed()) return;
  try {
    const b = bubbleWin.getBounds();
    fs.writeFileSync(getConfigPath(), JSON.stringify({ x: b.x, y: b.y }), 'utf-8');
  } catch (_) {}
}

function isCursorInsideWindow(win) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return (
    cursor.x >= b.x &&
    cursor.x <= b.x + b.width &&
    cursor.y >= b.y &&
    cursor.y <= b.y + b.height
  );
}

function stopBubbleBlink() {
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('stop-blink');
  }
}

function startBubbleBlink(tooltipText) {
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('trigger-pulse', tooltipText || 'Yeni mesaj');
  }
}

function positionPreviewWindow() {
  if (!bubbleWin || !previewWin || bubbleWin.isDestroyed() || previewWin.isDestroyed()) {
    return 'right';
  }
  const bubbleBounds = bubbleWin.getBounds();
  const bubbleCenter = {
    x: bubbleBounds.x + Math.round(BUBBLE_SIZE / 2),
    y: bubbleBounds.y + Math.round(BUBBLE_SIZE / 2)
  };
  const display = screen.getDisplayNearestPoint(bubbleCenter);
  const workArea = display.workArea;
  const screenMidX = workArea.x + workArea.width / 2;

  let targetX;
  let tailDirection;
  if (bubbleCenter.x >= screenMidX) {
    targetX = bubbleBounds.x - PREVIEW_WIDTH + 2;
    tailDirection = 'right';
  } else {
    targetX = bubbleBounds.x + BUBBLE_SIZE - 2;
    tailDirection = 'left';
  }

  targetX = Math.max(
    workArea.x + 4,
    Math.min(targetX, workArea.x + workArea.width - PREVIEW_WIDTH - 4)
  );
  const targetY = Math.max(
    workArea.y + 4,
    Math.min(bubbleBounds.y - 4, workArea.y + workArea.height - PREVIEW_HEIGHT - 4)
  );

  previewWin.setBounds({
    x: Math.round(targetX),
    y: Math.round(targetY),
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT
  });

  return tailDirection;
}

function hidePreviewBubble() {
  if (previewHideTimer) {
    clearTimeout(previewHideTimer);
    previewHideTimer = null;
  }
  if (previewWin && !previewWin.isDestroyed() && previewWin.isVisible()) {
    previewWin.hide();
  }
}

function showPreviewBubble(data) {
  if (!previewWin || previewWin.isDestroyed()) return;
  const tailDirection = positionPreviewWindow();
  previewWin.webContents.send('show-preview-data', {
    name: data.name || 'WhatsApp',
    body: data.body || 'Yeni mesaj',
    avatar: data.avatar || '',
    index: data.index,
    tailDirection
  });
  previewWin.showInactive();

  if (previewHideTimer) clearTimeout(previewHideTimer);
  previewHideTimer = setTimeout(() => {
    hidePreviewBubble();
  }, 6000);
}

function isTypingIndicatorText(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return false;
  return (
    s === 'yazıyor...' ||
    s === 'yazıyor' ||
    s.endsWith(' yazıyor...') ||
    s.endsWith(' yazıyor') ||
    s === 'typing...' ||
    s === 'typing' ||
    s.endsWith(' typing...') ||
    s.endsWith(' typing') ||
    s.includes('ses kaydediyor') ||
    s.includes('recording audio')
  );
}

function onNewIncomingMessage(data) {
  const name = String(data?.name || 'WhatsApp').trim();
  const body = String(data?.body || 'Yeni mesaj').trim();
  if (isTypingIndicatorText(body)) return;

  const key = `${name}::${body}`;
  const now = Date.now();
  if (key === lastPreviewKey && now - lastPreviewTime < 2000) {
    return;
  }
  lastPreviewKey = key;
  lastPreviewTime = now;

  // Eğer sohbet penceresi şu an açık ve odaktaysa yanıp sönmeye gerek yok, değilse yanıp sönsün
  const isActivelyLooking =
    chatWin && !chatWin.isDestroyed() && chatWin.isVisible() && chatWin.isFocused();
  if (!isActivelyLooking) {
    startBubbleBlink(`${name}: ${body}`);
  }
  showPreviewBubble({
    name,
    body,
    avatar: data?.avatar || '',
    index: data?.index
  });
}

// Harici Sohbet Seçim Kutusunu (selectorWin) ana sohbet penceresinin hemen yanına hizala
function positionSelectorWindow() {
  if (!chatWin || !selectorWin || chatWin.isDestroyed() || selectorWin.isDestroyed()) return;

  const chatBounds = chatWin.getBounds();
  const selBounds = selectorWin.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: chatBounds.x + Math.round(chatBounds.width / 2),
    y: chatBounds.y + Math.round(chatBounds.height / 2)
  });
  const wa = display.workArea;

  // Varsayılan olarak sohbet penceresinin SOLUNA aç, yer yoksa SAĞINA aç
  let targetX = chatBounds.x - selBounds.width - 8;
  if (targetX < wa.x + 6) {
    targetX = chatBounds.x + chatBounds.width + 8;
  }
  targetX = Math.max(wa.x + 6, Math.min(targetX, wa.x + wa.width - selBounds.width - 6));

  let targetY = chatBounds.y;
  targetY = Math.max(wa.y + 6, Math.min(targetY, wa.y + wa.height - selBounds.height - 6));

  selectorWin.setBounds({
    x: Math.round(targetX),
    y: Math.round(targetY),
    width: selBounds.width,
    height: selBounds.height
  });
}

// Sohbet penceresini ve dikey avatar sütununu baloncuğun bulunduğu monitöre ve konumuna göre akıllı hizala
function positionChatWindow() {
  if (!bubbleWin || !chatWin || bubbleWin.isDestroyed() || chatWin.isDestroyed()) return;

  const bubbleBounds = bubbleWin.getBounds();
  const chatBounds = chatWin.getBounds();

  const bubbleCenter = {
    x: bubbleBounds.x + Math.round(BUBBLE_SIZE / 2),
    y: bubbleBounds.y + Math.round(BUBBLE_SIZE / 2)
  };

  // Baloncuğun o an hangi monitörde olduğunu tespit et
  const display = screen.getDisplayNearestPoint(bubbleCenter);
  const workArea = display.workArea;
  const screenMidX = workArea.x + workArea.width / 2;

  let targetX;
  // Baloncuk ekranın sağ yarısındaysa -> sohbet penceresini SOLUNA aç
  if (bubbleCenter.x >= screenMidX) {
    targetX = bubbleBounds.x - chatBounds.width - GAP;
  } else {
    // Baloncuk ekranın sol yarısındaysa -> sohbet penceresini SAĞINA aç
    targetX = bubbleBounds.x + BUBBLE_SIZE + GAP;
  }

  // Yatay taşma koruması
  targetX = Math.max(
    workArea.x + 6,
    Math.min(targetX, workArea.x + workArea.width - chatBounds.width - 6)
  );

  // Dikey konum: baloncuğun hizasından başla ancak ekran üst/alt sınırlarından taşmasın
  let targetY = bubbleBounds.y;
  targetY = Math.max(
    workArea.y + 6,
    Math.min(targetY, workArea.y + workArea.height - chatBounds.height - 6)
  );

  chatWin.setBounds({
    x: Math.round(targetX),
    y: Math.round(targetY),
    width: chatBounds.width,
    height: chatBounds.height
  });

  // Baloncuk penceresini sohbet penceresinin boyu kadar aşağıya doğru uzat (avatar sütunu için)
  bubbleWin.setBounds({
    x: bubbleBounds.x,
    y: Math.round(targetY),
    width: BUBBLE_SIZE,
    height: chatBounds.height
  });

  if (selectorWin && !selectorWin.isDestroyed() && selectorWin.isVisible()) {
    positionSelectorWindow();
  }
}

function collapseBubbleToIcon() {
  if (!bubbleWin || bubbleWin.isDestroyed()) return;
  bubbleWin.webContents.send('set-expanded', false);
  const b = bubbleWin.getBounds();
  bubbleWin.setBounds({
    x: b.x,
    y: b.y,
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE
  });
}

function hideChatWindows() {
  if (selectorWin && !selectorWin.isDestroyed()) selectorWin.hide();
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('forward-viewing-state', false);
    chatWin.hide();
  }
  collapseBubbleToIcon();
}

function openChatNearBubble() {
  if (!chatWin || chatWin.isDestroyed()) return;
  stopBubbleBlink();
  hidePreviewBubble();
  positionChatWindow();
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('set-expanded', true);
    if (cachedChatList.length > 0) {
      bubbleWin.webContents.send('update-chat-list', cachedChatList);
    }
  }
  chatWin.show();
  chatWin.focus();
  chatWin.webContents.send('forward-viewing-state', true);
}

function toggleChat() {
  if (!chatWin || chatWin.isDestroyed()) return;

  if (chatWin.isVisible()) {
    hideChatWindows();
  } else {
    openChatNearBubble();
  }
}

function updateUnreadBadge(count) {
  const numericCount = Number(count) || 0;
  lastUnreadCount = numericCount;

  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('update-badge', numericCount);
    if (numericCount === 0) {
      stopBubbleBlink();
    }
  }
}

function createWindows() {
  const waSession = session.fromPartition('persist:whatsapp');
  waSession.setUserAgent(CHROME_UA);
  waSession.setPreloads([path.join(__dirname, 'preload-chat.js')]);

  // WhatsApp Web'in katı Content-Security-Policy (CSP) ve Trusted-Types başlıklarını kaldır
  waSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    for (const key of Object.keys(responseHeaders)) {
      const lower = key.toLowerCase();
      if (
        lower === 'content-security-policy' ||
        lower === 'content-security-policy-report-only'
      ) {
        delete responseHeaders[key];
      }
    }
    callback({ cancel: false, responseHeaders });
  });

  // Bildirim, medya vb. izinleri otomatik onayla ki WhatsApp bildirimleri sorunsuz tetiklesin
  waSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });
  waSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write'];
    return allowed.includes(permission);
  });

  const initialPos = loadSavedPosition();

  // 1. PENCERE: Yüzen Baloncuk + Dikey Sohbet Avatarları Penceresi (bubbleWin)
  bubbleWin = new BrowserWindow({
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    x: initialPos.x,
    y: initialPos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));

  // 2. PENCERE: WhatsApp Web Sohbet Penceresi (chatWin - Sadece aktif sohbet ekranı)
  chatWin = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 380,
    minHeight: 500,
    hasShadow: false,
    backgroundColor: '#111b21',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      spellcheck: true
    }
  });

  chatWin.setAlwaysOnTop(true, 'pop-up-menu');
  chatWin.loadFile(path.join(__dirname, 'chat.html'));

  // Sohbet penceresi yeniden boyutlandırıldığında avatar sütununun boyunu da eşitle
  chatWin.on('resize', () => {
    if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return;
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    const cb = chatWin.getBounds();
    const bb = bubbleWin.getBounds();
    if (bb.height !== cb.height) {
      bubbleWin.setBounds({
        x: bb.x,
        y: cb.y,
        width: BUBBLE_SIZE,
        height: cb.height
      });
    }
  });

  // 3. PENCERE: Harici Sohbet Seçim Kutusu (selectorWin - Üstteki butona basınca yanında açılır)
  selectorWin = new BrowserWindow({
    width: 320,
    height: 560,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 260,
    minHeight: 360,
    hasShadow: false,
    backgroundColor: '#111b21',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  selectorWin.setAlwaysOnTop(true, 'pop-up-menu');
  selectorWin.loadFile(path.join(__dirname, 'selector.html'));

  // 4. PENCERE: Yeni Mesaj Konuşma Balonu Önizlemesi (previewWin - WhatsApp ikonunun yanında çıkar)
  previewWin = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  previewWin.setAlwaysOnTop(true, 'screen-saver');
  previewWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  previewWin.loadFile(path.join(__dirname, 'preview.html'));

  chatWin.on('focus', () => {
    stopBubbleBlink();
    hidePreviewBubble();
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('forward-viewing-state', true);
    }
  });

  const handleAnyBlur = () => {
    if (isPinned) return;
    if (Date.now() < ignoreBlurUntil) return;

    setTimeout(() => {
      if (isPinned || Date.now() < ignoreBlurUntil) return;
      const inBubble = isCursorInsideWindow(bubbleWin) || (bubbleWin && bubbleWin.isFocused());
      const inChat = isCursorInsideWindow(chatWin) || (chatWin && chatWin.isFocused());
      const inSelector =
        isCursorInsideWindow(selectorWin) || (selectorWin && selectorWin.isFocused());
      const inPreview = isCursorInsideWindow(previewWin);

      if (inBubble || inChat || inSelector || inPreview) {
        return;
      }

      hideChatWindows();
    }, 120);
  };

  chatWin.on('blur', handleAnyBlur);
  selectorWin.on('blur', handleAnyBlur);
  bubbleWin.on('blur', handleAnyBlur);

  chatWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      hideChatWindows();
    }
  });

  selectorWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      selectorWin.hide();
    }
  });

  bubbleWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
    }
  });

  previewWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      previewWin.hide();
    }
  });
}

// Webview içindeki dış bağlantıları varsayılan tarayıcıda aç
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
      if (!url.includes('whatsapp.com')) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  }
});

// IPC: Sürükleme (Drag > 4px) ve Tıklama (Click <= 4px) Ayrımı
function stopDragLoop() {
  if (dragInterval) {
    clearInterval(dragInterval);
    dragInterval = null;
  }
}

ipcMain.on('bubble-mousedown', () => {
  if (!bubbleWin || bubbleWin.isDestroyed()) return;
  stopBubbleBlink();
  hidePreviewBubble();
  dragStartCursor = screen.getCursorScreenPoint();
  dragStartBounds = bubbleWin.getBounds();
  movedBeyondThreshold = false;

  stopDragLoop();
  dragInterval = setInterval(() => {
    if (!dragStartCursor || !dragStartBounds || !bubbleWin || bubbleWin.isDestroyed()) return;
    const currentCursor = screen.getCursorScreenPoint();
    const dx = currentCursor.x - dragStartCursor.x;
    const dy = currentCursor.y - dragStartCursor.y;
    const distance = Math.hypot(dx, dy);

    if (distance > 4) {
      movedBeyondThreshold = true;
    }

    if (movedBeyondThreshold) {
      const newX = dragStartBounds.x + dx;
      const newY = dragStartBounds.y + dy;
      bubbleWin.setBounds({
        x: Math.round(newX),
        y: Math.round(newY),
        width: BUBBLE_SIZE,
        height: dragStartBounds.height
      });

      if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
        positionChatWindow();
      }
    }
  }, 16);
});

ipcMain.on('bubble-mousemove', () => {});

ipcMain.on('bubble-mouseup', () => {
  stopDragLoop();

  if (!movedBeyondThreshold) {
    toggleChat();
  } else {
    saveBubblePosition();
  }

  dragStartCursor = null;
  dragStartBounds = null;
  movedBeyondThreshold = false;
});

// IPC: Harici Sohbet Seçim Kutusunu (selectorWin) Aç/Kapat
ipcMain.on('toggle-selector-window', () => {
  if (!selectorWin || selectorWin.isDestroyed()) return;
  ignoreBlurUntil = Date.now() + 500;

  if (selectorWin.isVisible()) {
    selectorWin.hide();
    if (chatWin && !chatWin.isDestroyed()) chatWin.focus();
  } else {
    positionSelectorWindow();
    if (cachedChatList.length > 0) {
      selectorWin.webContents.send('update-chat-list', cachedChatList);
    }
    selectorWin.show();
    selectorWin.focus();
    selectorWin.webContents.send('focus-search');
  }
});

ipcMain.on('close-selector-window', () => {
  if (selectorWin && !selectorWin.isDestroyed()) {
    selectorWin.hide();
  }
  if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
    chatWin.focus();
  }
});

let titleUnreadCount = 0;

ipcMain.on('chat-list-from-webview', (_event, list) => {
  if (Array.isArray(list)) {
    // Sadece gerçek okunmamış mesaj sayısı arttığında sohbet balonu önizlemesi göster (yazıyor... durumunda gösterme)
    if (hasInitializedChatState) {
      for (const item of list) {
        const curUnread = Number(item.unread) || 0;
        const curPreview = String(item.preview || '').trim();
        const prev = prevChatStateMap.get(item.name);
        const prevUnread = prev ? prev.unread : 0;

        if (curUnread > prevUnread && !isTypingIndicatorText(curPreview)) {
          onNewIncomingMessage({
            name: item.name,
            body: curPreview || 'Yeni mesaj',
            avatar: item.avatar || '',
            index: item.index
          });
          break;
        }
      }
    }

    for (const item of list) {
      prevChatStateMap.set(item.name, {
        unread: Number(item.unread) || 0,
        preview: String(item.preview || '').trim()
      });
    }
    if (list.length > 0) {
      hasInitializedChatState = true;
    }

    cachedChatList = list;
    const listUnreadTotal = cachedChatList.reduce(
      (sum, item) => sum + (Number(item.unread) || 0),
      0
    );
    updateUnreadBadge(Math.max(titleUnreadCount, listUnreadTotal));

    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.webContents.send('update-chat-list', cachedChatList);
    }
    if (selectorWin && !selectorWin.isDestroyed()) {
      selectorWin.webContents.send('update-chat-list', cachedChatList);
    }
  }
});

ipcMain.on('selector-pick-chat', (_event, target) => {
  ignoreBlurUntil = Date.now() + 600;
  stopBubbleBlink();
  hidePreviewBubble();
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('forward-pick-chat', target);
    chatWin.focus();
  }
  if (selectorWin && !selectorWin.isDestroyed() && selectorWin.isVisible()) {
    selectorWin.hide();
  }
});

ipcMain.on('preview-bubble-clicked', (_event, target) => {
  ignoreBlurUntil = Date.now() + 800;
  stopBubbleBlink();
  hidePreviewBubble();
  openChatNearBubble();
  if (target && (target.name || typeof target.index === 'number')) {
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.webContents.send('forward-pick-chat', target);
    }
  }
});

ipcMain.on('selector-scroll-more', () => {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('forward-scroll-more');
  }
});

// IPC: WhatsApp Bildirimlerini Dinleme
ipcMain.on('whatsapp-notification', (_event, payload) => {
  const sender = payload?.title || 'WhatsApp';
  const body = payload?.body || 'Yeni mesaj';
  const matched = cachedChatList.find((c) => c.name === sender);

  onNewIncomingMessage({
    name: sender,
    body,
    avatar: matched?.avatar || '',
    index: matched?.index
  });
});

ipcMain.on('notification-clicked', () => {
  stopBubbleBlink();
  hidePreviewBubble();
  openChatNearBubble();
});

ipcMain.on('unread-count-updated', (_event, count) => {
  titleUnreadCount = Number(count) || 0;
  const listUnreadTotal = cachedChatList.reduce(
    (sum, item) => sum + (Number(item.unread) || 0),
    0
  );
  updateUnreadBadge(Math.max(titleUnreadCount, listUnreadTotal));
});

ipcMain.on('toggle-pin-from-chat', () => {
  isPinned = !isPinned;
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('update-pin-state', isPinned);
  }
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('pin-state-changed', isPinned);
  }
});

ipcMain.on('hide-chat-from-toolbar', () => {
  hideChatWindows();
});

function triggerUpdateCheck() {
  checkAndApplyUpdate({ app }).catch(() => {});
}

// IPC: Sağ Tık Menüsü (Context Menu)
ipcMain.on('bubble-contextmenu', () => {
  const menu = Menu.buildFromTemplate([
    {
      label: chatWin && chatWin.isVisible() ? 'Sohbeti Gizle (Alt+W)' : 'Sohbeti Aç (Alt+W)',
      click: () => toggleChat()
    },
    { type: 'separator' },
    {
      label: '📌 Sohbeti Sabitle (Otomatik Gizlemeyi Kapat)',
      type: 'checkbox',
      checked: isPinned,
      click: (menuItem) => {
        isPinned = menuItem.checked;
        if (bubbleWin && !bubbleWin.isDestroyed()) {
          bubbleWin.webContents.send('update-pin-state', isPinned);
        }
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.send('pin-state-changed', isPinned);
        }
      }
    },
    {
      label: '🔇 Bildirim Seslerini Sustur',
      type: 'checkbox',
      checked: isMuted,
      click: (menuItem) => {
        isMuted = menuItem.checked;
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.setAudioMuted(isMuted);
        }
      }
    },
    { type: 'separator' },
    {
      label: '🔄 WhatsApp Web Yenile',
      click: () => {
        if (chatWin && !chatWin.isDestroyed()) {
          chatWin.webContents.reload();
        }
      }
    },
    {
      label: '❌ Çıkış',
      click: () => {
        isQuitting = true;
        stopDragLoop();
        app.quit();
      }
    }
  ]);

  menu.popup({ window: bubbleWin });
});

app.whenReady().then(() => {
  createWindows();

  // Başlangıçta baloncuğun hemen yanında sohbet penceresini ve dikey avatar sütununu açarak göster
  ignoreBlurUntil = Date.now() + 3000;
  setTimeout(() => {
    openChatNearBubble();
  }, 400);

  // Sessiz Otomatik Güncelleme Kontrolü: Başlangıçta (3 sn sonra) ve her 2 dakikada bir
  setTimeout(() => triggerUpdateCheck(), 3000);
  setInterval(() => triggerUpdateCheck(), 2 * 60 * 1000);

  // Global Kısayol: Alt + W ile her yerden hızlıca aç/kapat
  globalShortcut.register('Alt+W', () => {
    ignoreBlurUntil = Date.now() + 600;
    toggleChat();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopDragLoop();
  saveBubblePosition();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
