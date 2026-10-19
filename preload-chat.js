const { contextBridge, ipcRenderer, webFrame } = require('electron');

function notifyHost(channel, payload) {
  try {
    ipcRenderer.sendToHost(channel, payload);
  } catch (_) {}
}

if (!window.__waPreloadInitialized) {
  window.__waPreloadInitialized = true;

  const notificationUnreadMap = new Map();
  const lastRealPreviewMap = new Map();
  let lastSelectedChatName = '';
  let isHostWindowViewing = false;

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

  contextBridge.exposeInMainWorld('__waBridge', {
    sendNotification: (payload) => {
      if (isTypingIndicatorText(payload?.body)) return;
      try {
        const sender = String(payload?.title || '').trim();
        if (sender) {
          const activeHeader = (
            document.querySelector('#main header span[dir="auto"]')?.textContent || ''
          ).trim();
          if ((!document.hasFocus() && !isHostWindowViewing) || sender !== activeHeader) {
            const prev = notificationUnreadMap.get(sender)?.count || 0;
            notificationUnreadMap.set(sender, { count: prev + 1, time: Date.now() });
          }
        }
      } catch (_) {}
      notifyHost('whatsapp-notification', payload);
      setTimeout(sendChatListUpdate, 150);
    },
    notificationClicked: () => notifyHost('notification-clicked'),
    fileDialogOpening: () => notifyHost('file-dialog-opening')
  });

  // WhatsApp Web'in Notification API'sini ve dosya seçici (<input type="file">) tetikleyicisini sarmala
  const mainWorldHook = `
  (function() {
    if (!window.__waFilePickerHooked) {
      window.__waFilePickerHooked = true;
      const origInputClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function(...args) {
        try {
          if (this && this.type === 'file' && window.__waBridge && typeof window.__waBridge.fileDialogOpening === 'function') {
            window.__waBridge.fileDialogOpening();
          }
        } catch (e) {}
        return origInputClick.apply(this, args);
      };

      if (typeof window.showOpenFilePicker === 'function') {
        const origPicker = window.showOpenFilePicker;
        window.showOpenFilePicker = function(...args) {
          try {
            if (window.__waBridge && typeof window.__waBridge.fileDialogOpening === 'function') {
              window.__waBridge.fileDialogOpening();
            }
          } catch (e) {}
          return origPicker.apply(this, args);
        };
      }
    }

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

  function tagLayoutContainers() {
    try {
      const side = document.getElementById('side');
      const main = document.getElementById('main');
      const sideCol = side ? side.parentElement : null;
      const mainCol = main ? main.parentElement : null;

      if (sideCol && sideCol.getAttribute('data-wa-side-col') !== '1') {
        sideCol.setAttribute('data-wa-side-col', '1');
      }
      if (mainCol && mainCol.getAttribute('data-wa-main-col') !== '1') {
        mainCol.setAttribute('data-wa-main-col', '1');
      }

      const layoutRoot = (mainCol && mainCol.parentElement) || (sideCol && sideCol.parentElement);
      if (layoutRoot) {
        const children = layoutRoot.children;
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child === mainCol || child === sideCol) continue;
          const w = child.offsetWidth;
          if (w > 0 && w <= 84 && child.querySelector('header, button, [role="button"]')) {
            if (child.getAttribute('data-wa-nav-col') !== '1') {
              child.setAttribute('data-wa-nav-col', '1');
            }
          } else if (
            !mainCol ||
            Boolean(child.compareDocumentPosition(mainCol) & Node.DOCUMENT_POSITION_FOLLOWING)
          ) {
            if (child.getAttribute('data-wa-left-drawer') !== '1') {
              child.setAttribute('data-wa-left-drawer', '1');
            }
          }
        }
      }
    } catch (_) {}
  }

  function detectRowUnreadCount(row) {
    let unread = 0;
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
    return unread;
  }

  // #pane-side içindeki tüm sohbet satırlarını oku ve mesaj sırasına (yukarıdan aşağıya) göre diz
  function scrapeChatList() {
    tagLayoutContainers();
    const paneSide = document.getElementById('pane-side');
    if (!paneSide) return [];

    const activeHeaderTitle = (
      document.querySelector('#main header span[dir="auto"]')?.textContent || ''
    ).trim();

    if (activeHeaderTitle && (document.hasFocus() || isHostWindowViewing)) {
      notificationUnreadMap.delete(activeHeaderTitle);
    }

    const rawRows = Array.from(
      paneSide.querySelectorAll('[role="listitem"], [role="row"]')
    );

    // Mesajların WhatsApp'taki gerçek yukarıdan aşağıya (en yeniden en eskiye) sırasına göre sırala
    const sortedRows = rawRows
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return { row, top: rect.top, height: rect.height };
      })
      .filter((item) => item.height > 20)
      .sort((a, b) => a.top - b.top);

    const results = [];
    const seenNames = new Set();

    sortedRows.forEach(({ row }, idx) => {
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
          if (t && t !== name && !isTypingIndicatorText(t)) {
            preview = t;
            break;
          }
        }
        if (!preview) {
          const allSpans = row.querySelectorAll('span[dir="ltr"], span[dir="auto"]');
          for (const s of allSpans) {
            const txt = (s.textContent || '').trim();
            if (txt && txt !== name && txt.length > 1 && !isTypingIndicatorText(txt)) {
              preview = txt;
              break;
            }
          }
        }
        if (preview) {
          lastRealPreviewMap.set(name, preview);
        } else {
          preview = lastRealPreviewMap.get(name) || '';
        }

        let time = '';
        const allLeafSpans = row.querySelectorAll('span, div');
        for (const el of allLeafSpans) {
          if (el.childElementCount === 0) {
            const txt = (el.textContent || '').trim();
            if (
              txt.length <= 12 &&
              /^(\d{1,2}:\d{2}(\s?[AP]M)?|Yesterday|Dün|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/i.test(
                txt
              )
            ) {
              time = txt;
              break;
            }
          }
        }

        const domUnread = detectRowUnreadCount(row);
        const notifEntry = notificationUnreadMap.get(name);
        if (domUnread > 0) {
          notificationUnreadMap.delete(name);
        } else if (notifEntry) {
          if (activeHeaderTitle === name && (document.hasFocus() || isHostWindowViewing)) {
            notificationUnreadMap.delete(name);
          } else if (activeHeaderTitle !== name && Date.now() - notifEntry.time > 2500) {
            notificationUnreadMap.delete(name);
          }
        }
        const unread = Math.max(domUnread, notificationUnreadMap.get(name)?.count || 0);

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

  let lastSentSignature = '';

  function sendChatListUpdate(force = false) {
    const list = scrapeChatList();
    if (list.length === 0) return;

    const sig = list
      .map(
        (c) =>
          `${c.name}\t${c.preview}\t${c.time}\t${c.unread}\t${c.active ? 1 : 0}\t${
            c.avatar ? c.avatar.length : 0
          }`
      )
      .join('\n');

    if (!force && sig === lastSentSignature) {
      return;
    }
    lastSentSignature = sig;
    notifyHost('chat-list-updated', list);
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

  function focusActiveComposer() {
    try {
      const active = document.activeElement;
      if (
        active &&
        (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      ) {
        return;
      }
      const footerComposer = document.querySelector('#main footer [contenteditable="true"]');
      const allVisibleEditables = Array.from(
        document.querySelectorAll('[contenteditable="true"]')
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= 0;
      });
      const target =
        allVisibleEditables.find((el) => !el.closest('#side') && el !== footerComposer) ||
        footerComposer;
      if (target) {
        target.focus();
      }
    } catch (_) {}
  }

  let isSidePanelOpen = false;
  let headerBeforeSidePanel = '';

  function setSidePanelMode(open) {
    isSidePanelOpen = Boolean(open);
    tagLayoutContainers();
    document.documentElement.classList.toggle('wa-show-side-panel', isSidePanelOpen);
    notifyHost('side-panel-state', isSidePanelOpen);
    if (isSidePanelOpen) {
      headerBeforeSidePanel = (
        document.querySelector('#main header span[dir="auto"]')?.textContent || ''
      ).trim();
    } else {
      setTimeout(() => {
        focusActiveComposer();
        sendChatListUpdate(true);
      }, 100);
    }
  }

  function openSidePanelAndSearch() {
    setSidePanelMode(true);
    setTimeout(() => {
      try {
        const backBtn = document.querySelector(
          '[data-wa-left-drawer="1"] [data-icon="back"], [data-wa-left-drawer="1"] [aria-label="Geri"], [data-wa-left-drawer="1"] [aria-label="Back"]'
        );
        if (backBtn) {
          const clickable = backBtn.closest('button, [role="button"]') || backBtn;
          clickable.click();
        }
        const searchEditable =
          document.querySelector('#side [contenteditable="true"]') ||
          document.querySelector('#side input[type="text"]') ||
          document.querySelector('#side [role="textbox"]');
        if (searchEditable) {
          searchEditable.focus();
        } else {
          const searchBtn = document.querySelector(
            '#side [data-icon="search"], #side [aria-label*="Ara"], #side [aria-label*="Search"]'
          );
          if (searchBtn) {
            (searchBtn.closest('button, [role="button"]') || searchBtn).click();
            setTimeout(() => {
              const box = document.querySelector(
                '#side [contenteditable="true"], #side [role="textbox"]'
              );
              if (box) box.focus();
            }, 80);
          }
        }
      } catch (_) {}
    }, 60);
  }

  function openSidePanelAndNewChat() {
    setSidePanelMode(true);
    setTimeout(() => {
      try {
        const selectors = [
          '[data-icon="new-chat-outline"]',
          '[data-icon="new-chat"]',
          '[title*="Yeni sohbet" i]',
          '[aria-label*="Yeni sohbet" i]',
          '[title*="New chat" i]',
          '[aria-label*="New chat" i]',
          'header [data-tab="2"]'
        ];
        let btn = null;
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            btn = el.closest('button, [role="button"]') || el;
            break;
          }
        }
        if (btn) {
          btn.click();
        }
        setTimeout(() => {
          tagLayoutContainers();
          const editables = Array.from(
            document.querySelectorAll('[contenteditable="true"], [role="textbox"]')
          ).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.left >= 0 && !el.closest('#main');
          });
          const drawerSearch = editables.find((el) => !el.closest('#side')) || editables[0];
          if (drawerSearch) {
            drawerSearch.focus();
          }
        }, 180);
      } catch (_) {}
    }, 60);
  }

  ipcRenderer.on('request-chat-list', () => {
    sendChatListUpdate(true);
  });

  ipcRenderer.on('toggle-side-panel', () => {
    if (isSidePanelOpen) {
      setSidePanelMode(false);
    } else {
      openSidePanelAndSearch();
    }
  });

  ipcRenderer.on('open-side-search', () => {
    openSidePanelAndSearch();
  });

  ipcRenderer.on('open-new-chat', () => {
    openSidePanelAndNewChat();
  });

  ipcRenderer.on('close-side-panel', () => {
    setSidePanelMode(false);
  });

  ipcRenderer.on('prepare-paste-in-webview', () => {
    focusActiveComposer();
  });

  ipcRenderer.on('ensure-chat-selected', () => {
    const hasMain = Boolean(document.getElementById('main'));
    const paneSide = document.getElementById('pane-side');
    if (!hasMain && paneSide) {
      scrapeChatList();
      const firstRow = paneSide.querySelector('[data-wa-chat-id="0"]');
      if (firstRow) {
        clickChatRowWithNativeInput(firstRow);
      }
    }
  });

  ipcRenderer.on('host-viewing-state', (_event, viewing) => {
    isHostWindowViewing = Boolean(viewing);
    if (isHostWindowViewing) {
      const activeHeader = (
        document.querySelector('#main header span[dir="auto"]')?.textContent || ''
      ).trim();
      if (activeHeader) {
        notificationUnreadMap.delete(activeHeader);
      }
      sendChatListUpdate();
    }
  });

  ipcRenderer.on('pick-chat-in-webview', (_event, target) => {
    setSidePanelMode(false);
    selectChatByTarget(target);
  });

  ipcRenderer.on('scroll-pane-side', () => {
    const paneSide = document.getElementById('pane-side');
    if (paneSide) {
      paneSide.scrollTop += 320;
      setTimeout(() => sendChatListUpdate(true), 250);
    }
  });

  // Arama veya Yeni Sohbet ekranından bir kişi/sohbet seçildiğinde odak #main'e geçer; otomatik olarak sohbet ekranına dön
  window.addEventListener(
    'focusin',
    (e) => {
      if (
        isSidePanelOpen &&
        e.target &&
        typeof e.target.closest === 'function' &&
        e.target.closest('#main')
      ) {
        setSidePanelMode(false);
      }
    },
    true
  );

  // Kullanıcı webview içinde etkileşimde bulunduğunda (fare, klavye, kaydırma) 15 sn hareketsizlik sayacını sıfırla
  let lastActivityReportedAt = 0;
  function reportUserActivity() {
    const now = Date.now();
    if (now - lastActivityReportedAt < 800) return;
    lastActivityReportedAt = now;
    notifyHost('user-activity');
  }

  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'].forEach((evtName) => {
    window.addEventListener(evtName, reportUserActivity, { capture: true, passive: true });
  });

  // Ctrl+V ile ekran görüntüsü / metin yapıştırılırken odak mesaj kutusunda değilse otomatik odakla
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'v') {
        if (!isSidePanelOpen) {
          focusActiveComposer();
        }
      }
    },
    true
  );

  // Dosya seçici (<input type="file">) açıldığında pencerenin kapanmasını engelle
  // ve sol listeden (#pane-side) bir sohbete tıklandığında otomatik olarak sohbet görünümüne geç
  window.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!target) return;
      if (
        (target.tagName === 'INPUT' && target.type === 'file') ||
        (typeof target.closest === 'function' && target.closest('input[type="file"]'))
      ) {
        notifyHost('file-dialog-opening');
        return;
      }

      if (isSidePanelOpen && typeof target.closest === 'function') {
        const clickedPaneRow = target.closest('#pane-side [role="listitem"], #pane-side [role="row"]');
        if (clickedPaneRow) {
          setTimeout(() => {
            if (document.getElementById('main')) {
              setSidePanelMode(false);
            }
          }, 180);
        }
      }
    },
    true
  );

  window.addEventListener(
    'change',
    (e) => {
      if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
        notifyHost('file-dialog-closed');
      }
    },
    true
  );

  window.addEventListener(
    'cancel',
    (e) => {
      if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
        notifyHost('file-dialog-closed');
      }
    },
    true
  );

  let lastLoggedState = null;

  window.addEventListener('DOMContentLoaded', () => {
    webFrame.executeJavaScript(mainWorldHook).catch(() => {});

    setInterval(() => {
      tagLayoutContainers();
      const isLogged = Boolean(document.getElementById('pane-side') || document.getElementById('side'));
      if (isLogged !== lastLoggedState) {
        lastLoggedState = isLogged;
        notifyHost('wa-login-state', isLogged);
      }
      if (isSidePanelOpen) {
        const curHeader = (
          document.querySelector('#main header span[dir="auto"]')?.textContent || ''
        ).trim();
        if (curHeader && curHeader !== headerBeforeSidePanel) {
          setSidePanelMode(false);
        }
      }
      sendChatListUpdate(false);
    }, 1500);
  });
}
