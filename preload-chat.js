const { contextBridge, ipcRenderer, webFrame } = require('electron');

function notifyHost(channel, payload) {
  try {
    ipcRenderer.sendToHost(channel, payload);
  } catch (_) {}
}

if (!window.__waPreloadInitialized) {
  window.__waPreloadInitialized = true;

  const notificationUnreadMap = new Map();
  let lastSelectedChatName = '';

  contextBridge.exposeInMainWorld('__waBridge', {
    sendNotification: (payload) => {
      try {
        const sender = String(payload?.title || '').trim();
        if (sender) {
          const activeHeader = (
            document.querySelector('#main header span[dir="auto"]')?.textContent || ''
          ).trim();
          if (! document.hasFocus() || sender !== activeHeader) {
            notificationUnreadMap.set(sender, (notificationUnreadMap.get(sender) || 0) + 1);
          }
        }
      } catch (_) {}
      notifyHost('whatsapp-notification', payload);
      setTimeout(sendChatListUpdate, 150);
    },
    notificationClicked: () => notifyHost('notification-clicked')
  });

  // WhatsApp Web'in Notification API'sini Proxy ile sarmala
  const mainWorldHook = `
  (function() {
    if (window.__waNotificationHooked || !window.Notification) return;
    window.__waNotificationHooked = true;

    const OriginalNotification = window.Notification;
    window.Notification = new Proxy(OriginalNotification, {
      construct(target, args) {
        const title = args[0] || 'WhatsApp';
        const options = args[1] || {};
        try {
          if (window.__waBridge && typeof window.__waBridge.sendNotification === 'function') {
            window.__waBridge.sendNotification({
              title: String(title),
              body: String(options.body || ''),
              icon: String(options.icon || ''),
              tag: String(options.tag || ''),
              timestamp: Date.now()
            });
          }
        } catch (e) {}

        const instance = new target(...args);
        instance.addEventListener('click', function() {
          try {
            if (window.__waBridge && typeof window.__waBridge.notificationClicked === 'function') {
              window.__waBridge.notificationClicked();
            }
          } catch (e) {}
        });
        return instance;
      }
    });
  })();
  `;

  const avatarCache = new Map();

  function getAvatarDataUrl(imgEl) {
    if (!imgEl || !imgEl.src) return '';
    const src = imgEl.src;
    if (avatarCache.has(src)) {
      return avatarCache.get(src);
    }
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 56;
        canvas.height = 56;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0, 56, 56);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        if (dataUrl && dataUrl.startsWith('data:image')) {
          avatarCache.set(src, dataUrl);
          return dataUrl;
        }
      } catch (_) {}
    }

    if (src.startsWith('http') || src.startsWith('blob:')) {
      fetch(src)
        .then((r) => r.blob())
        .then((blob) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === 'string' && reader.result.startsWith('data:image')) {
              avatarCache.set(src, reader.result);
            }
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => {});
    }

    return src.startsWith('http') ? src : '';
  }

  function detectRowUnreadCount(row, rowRect, timeText) {
    let unread = 0;

    // 1. aria-label üzerinden okunmamış mesaj sayısını yakala (TR / EN)
    const ariaEls = row.querySelectorAll('[aria-label]');
    for (const el of ariaEls) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (
        label.includes('unread') ||
        label.includes('okunmamış') ||
        label.includes('okunmadı')
      ) {
        const m = label.match(/(\d+)/) || (el.textContent || '').match(/(\d+)/);
        if (m) {
          unread = parseInt(m[1], 10);
          break;
        } else {
          unread = 1;
        }
      }
    }

    // 2. Satırın sağ yarısında yer alan küçük sayı rozeti (span/div) kontrolü
    if (!unread) {
      const candidates = row.querySelectorAll('span, div');
      for (const el of candidates) {
        if (el.childElementCount === 0) {
          const txt = (el.textContent || '').trim();
          if (txt && txt !== timeText && /^\d{1,3}\+?$/.test(txt)) {
            const r = el.getBoundingClientRect();
            const inRightHalf = r.left >= rowRect.left + rowRect.width * 0.5;
            const isBadgeSize = r.width >= 12 && r.width <= 48 && r.height >= 12 && r.height <= 32;
            if (inRightHalf && isBadgeSize) {
              const cs = window.getComputedStyle(el);
              const pcs = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
              const bg = cs.backgroundColor || '';
              const pbg = pcs ? pcs.backgroundColor || '' : '';
              const hasBg =
                (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ||
                (pbg && pbg !== 'rgba(0, 0, 0, 0)' && pbg !== 'transparent');
              if (hasBg) {
                unread = parseInt(txt, 10) || 1;
                break;
              }
            }
          }
        }
      }
    }

    return unread;
  }

  // #pane-side içindeki tüm sohbet satırlarını oku ve mesaj sırasına (yukarıdan aşağıya) göre diz
  function scrapeChatList() {
    const paneSide = document.getElementById('pane-side');
    if (!paneSide) return [];

    // Sohbet listesinin her zaman en güncel mesajlardan (en üstten) başlamasını sağla
    if (paneSide.scrollTop !== 0) {
      paneSide.scrollTop = 0;
    }

    const activeHeaderTitle = (
      document.querySelector('#main header span[dir="auto"]')?.textContent || ''
    ).trim();

    if (activeHeaderTitle && document.hasFocus()) {
      notificationUnreadMap.delete(activeHeaderTitle);
    }

    const rawRows = Array.from(
      paneSide.querySelectorAll('[role="listitem"], [role="row"]')
    );

    // Mesajların WhatsApp'taki gerçek yukarıdan aşağıya (en yeniden en eskiye) sırasına göre sırala
    const sortedRows = rawRows
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return { row, top: rect.top, height: rect.height, rect };
      })
      .filter((item) => item.height > 20)
      .sort((a, b) => a.top - b.top);

    const results = [];
    const seenNames = new Set();

    sortedRows.forEach(({ row, rect: rowRect }, idx) => {
      try {
        const titleSpans = Array.from(
          row.querySelectorAll('span[dir="auto"][title], span[title]')
        );
        let name = '';
        for (const s of titleSpans) {
          const t = (s.getAttribute('title') || s.textContent || '').trim();
          if (t) {
            name = t;
            break;
          }
        }
        if (!name) {
          const autoSpan = row.querySelector('span[dir="auto"]');
          if (autoSpan) name = (autoSpan.textContent || '').trim();
        }
        if (!name || seenNames.has(name)) return;
        seenNames.add(name);

        row.setAttribute('data-wa-chat-id', String(idx));
        row.setAttribute('data-wa-chat-name', name);

        let preview = '';
        for (let i = 1; i < titleSpans.length; i++) {
          const t = (titleSpans[i].getAttribute('title') || titleSpans[i].textContent || '').trim();
          if (t && t !== name) {
            preview = t;
            break;
          }
        }
        if (!preview) {
          const allSpans = Array.from(row.querySelectorAll('span[dir="ltr"], span[dir="auto"]'));
          for (const s of allSpans) {
            const txt = (s.textContent || '').trim();
            if (txt && txt !== name && txt.length > 1) {
              preview = txt;
              break;
            }
          }
        }

        let time = '';
        const allLeafDivs = Array.from(row.querySelectorAll('div, span'));
        for (const el of allLeafDivs) {
          if (el.childElementCount === 0) {
            const txt = (el.textContent || '').trim();
            if (
              /^(\d{1,2}:\d{2}(\s?[AP]M)?|Yesterday|Dün|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/i.test(
                txt
              )
            ) {
              time = txt;
              break;
            }
          }
        }

        const domUnread = detectRowUnreadCount(row, rowRect, time);
        if (domUnread === 0 && activeHeaderTitle === name && document.hasFocus()) {
          notificationUnreadMap.delete(name);
        }
        const unread = Math.max(domUnread, notificationUnreadMap.get(name) || 0);

        const isRowSelected =
          row.getAttribute('aria-selected') === 'true' ||
          Boolean(row.querySelector('[aria-selected="true"]')) ||
          (activeHeaderTitle && name === activeHeaderTitle) ||
          (lastSelectedChatName && name === lastSelectedChatName);

        const imgEl = row.querySelector('img');
        const avatar = getAvatarDataUrl(imgEl);

        results.push({
          index: idx,
          name,
          preview,
          time,
          unread,
          avatar,
          active: Boolean(isRowSelected)
        });
      } catch (_) {}
    });

    return results;
  }

  function sendChatListUpdate() {
    const list = scrapeChatList();
    if (list.length > 0) {
      notifyHost('chat-list-updated', list);
    }
  }

  function clickChatRowWithNativeInput(row) {
    if (!row) return;

    const chatName = row.getAttribute('data-wa-chat-name') || 'unknown';
    lastSelectedChatName = chatName;
    notificationUnreadMap.delete(chatName);

    document
      .querySelectorAll('[data-wa-click-now]')
      .forEach((el) => el.removeAttribute('data-wa-click-now'));
    row.setAttribute('data-wa-click-now', '1');

    // Main World içinde React __reactProps$ / __reactFiber$ handler'larını doğrudan bul ve çağır
    webFrame
      .executeJavaScript(
        `
      (function() {
        const row = document.querySelector('[data-wa-click-now="1"]');
        if (!row) return 'no-row';
        const candidates = [row, ...Array.from(row.querySelectorAll('*'))];
        const triggered = [];

        for (const el of candidates) {
          const reactKey = Object.keys(el).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
          if (reactKey && el[reactKey]) {
            const props = el[reactKey];
            const fakeEvent = {
              bubbles: true,
              cancelable: true,
              defaultPrevented: false,
              button: 0,
              buttons: 1,
              isTrusted: true,
              preventDefault: function() {},
              stopPropagation: function() {},
              target: el,
              currentTarget: el,
              nativeEvent: new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 })
            };
            if (typeof props.onMouseDown === 'function') {
              try { props.onMouseDown(fakeEvent); triggered.push(el.tagName + '.onMouseDown'); } catch (e) {}
            }
            if (typeof props.onPointerDown === 'function') {
              try { props.onPointerDown(fakeEvent); triggered.push(el.tagName + '.onPointerDown'); } catch (e) {}
            }
            if (typeof props.onClick === 'function') {
              try { props.onClick(fakeEvent); triggered.push(el.tagName + '.onClick'); } catch (e) {}
            }
          }
        }
        return triggered.length;
      })();
    `
      )
      .then(() => {
        setTimeout(() => {
          sendChatListUpdate();
        }, 200);
      })
      .catch(() => {});
  }

  function selectChatByTarget(target) {
    const paneSide = document.getElementById('pane-side');
    if (!paneSide) return;

    scrapeChatList();

    let matchedRow = null;
    if (target && target.name) {
      const rows = Array.from(paneSide.querySelectorAll('[data-wa-chat-name]'));
      matchedRow = rows.find((r) => r.getAttribute('data-wa-chat-name') === target.name) || null;
    }

    if (!matchedRow && typeof target?.index === 'number') {
      matchedRow = paneSide.querySelector(`[data-wa-chat-id="${target.index}"]`);
    }

    if (matchedRow) {
      clickChatRowWithNativeInput(matchedRow);
    }
  }

  ipcRenderer.on('request-chat-list', () => {
    sendChatListUpdate();
  });

  ipcRenderer.on('pick-chat-in-webview', (_event, target) => {
    selectChatByTarget(target);
  });

  ipcRenderer.on('scroll-pane-side', () => {
    const paneSide = document.getElementById('pane-side');
    if (paneSide) {
      paneSide.scrollTop += 320;
      setTimeout(sendChatListUpdate, 250);
    }
  });

  let autoOpenedInitialChat = false;

  window.addEventListener('DOMContentLoaded', () => {
    webFrame.executeJavaScript(mainWorldHook).catch(() => {});

    setInterval(() => {
      const hasMain = Boolean(document.getElementById('main'));
      const paneSide = document.getElementById('pane-side');

      if (!hasMain && paneSide && !autoOpenedInitialChat) {
        const list = scrapeChatList();
        if (list.length > 0) {
          const firstRow = paneSide.querySelector('[data-wa-chat-id="0"]');
          if (firstRow) {
            autoOpenedInitialChat = true;
            clickChatRowWithNativeInput(firstRow);
          }
        }
      }

      sendChatListUpdate();
    }, 1000);
  });
}
