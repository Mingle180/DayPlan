/**
 * DayLight · Service Worker（仅推送，不缓存页面）
 *
 * 契约：docs/spec/19-notifications.md §4。
 * 刻意不做离线缓存：页面版本由 HTML 的 ?v= 缓存破坏控制，SW 不掺和。
 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch (e) {
    try {
      return { body: event.data ? event.data.text() : '' };
    } catch (e2) {
      return {};
    }
  }
}

self.addEventListener('push', function (event) {
  var data = parsePayload(event) || {};
  var title = typeof data.title === 'string' && data.title ? data.title : 'DayLight';
  var body = typeof data.body === 'string' && data.body ? data.body : '事项即将开始';
  var tag = typeof data.tag === 'string' && data.tag ? data.tag : 'dayplan-reminder';
  var url = typeof data.url === 'string' && data.url ? data.url : './';
  var date = typeof data.date === 'string' ? data.date : '';

  event.waitUntil(self.registration.showNotification(title, {
    body: body,
    tag: tag,
    renotify: true,
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/icon-192.png',
    data: { url: url, date: date }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var info = event.notification.data || {};
  var url = info.url || './';
  var date = info.date || '';

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i += 1) {
      var client = list[i];
      if (client && 'focus' in client) {
        if (date && client.postMessage) client.postMessage({ type: 'dayplan:open-date', date: date });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return null;
  }));
});

/* 订阅过期（浏览器换 endpoint）时通知已打开的页面重新订阅；页面没开时无能为力。 */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (client) {
      if (client && client.postMessage) client.postMessage({ type: 'dayplan:resubscribe' });
    });
    return null;
  }));
});
