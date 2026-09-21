'use strict';

const { EventEmitter } = require('events');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Reads a YouTube live chat without an API key.
 *
 * YouTube's own web player talks to an internal endpoint ("innertube") to poll
 * chat. We bootstrap the same way the watch page does: load the live chat
 * page, lift the API key and the first continuation token out of it, then poll.
 *
 * This is an internal endpoint, so YouTube can change it without notice. Every
 * step fails softly and reports a reason the UI can show.
 */

function extractJson(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = html.indexOf('{', at);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Accepts a video id, any YouTube URL, an @handle or a channel id. */
async function resolveVideoId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('emptyChannel');

  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  const urlMatch = raw.match(/[?&]v=([A-Za-z0-9_-]{11})/)
    || raw.match(/youtu\.be\/([A-Za-z0-9_-]{11})/)
    || raw.match(/\/live\/([A-Za-z0-9_-]{11})/);
  if (urlMatch) return urlMatch[1];

  let liveUrl;
  if (/^https?:\/\//i.test(raw)) {
    liveUrl = raw.replace(/\/+$/, '') + '/live';
  } else if (raw.startsWith('@')) {
    liveUrl = `https://www.youtube.com/${raw}/live`;
  } else if (/^UC[A-Za-z0-9_-]{22}$/.test(raw)) {
    liveUrl = `https://www.youtube.com/channel/${raw}/live`;
  } else {
    liveUrl = `https://www.youtube.com/@${raw}/live`;
  }

  const res = await fetch(liveUrl, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error('channelNotFound');
  const html = await res.text();

  const canonical = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/);
  if (canonical) return canonical[1];
  const embedded = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
  if (embedded) return embedded[1];
  throw new Error('notLive');
}

async function bootstrap(videoId) {
  const res = await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error('chatUnavailable');
  const html = await res.text();

  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  if (!keyMatch) throw new Error('chatUnavailable');

  const data = extractJson(html, 'ytInitialData');
  const continuations = data?.contents?.liveChatRenderer?.continuations || [];
  let token = null;
  for (const cont of continuations) {
    token = cont.invalidationContinuationData?.continuation
      || cont.timedContinuationData?.continuation
      || cont.reloadContinuationData?.continuation
      || null;
    if (token) break;
  }
  if (!token) throw new Error('notLive');

  return {
    apiKey: keyMatch[1],
    clientVersion: versionMatch ? versionMatch[1] : '2.20240101.00.00',
    continuation: token,
  };
}

function readMessages(payload) {
  const chat = payload?.continuationContents?.liveChatContinuation;
  if (!chat) return { messages: [], continuation: null, timeoutMs: 3000 };

  const messages = [];
  for (const action of chat.actions || []) {
    const item = action.addChatItemAction?.item?.liveChatTextMessageRenderer;
    if (!item) continue;

    const text = (item.message?.runs || [])
      .map((run) => run.text || run.emoji?.shortcuts?.[0] || '')
      .join('')
      .trim();
    if (!text) continue;

    const badges = (item.authorBadges || [])
      .map((b) => b.liveChatAuthorBadgeRenderer?.icon?.iconType)
      .filter(Boolean);
    const isBroadcaster = badges.includes('OWNER');

    messages.push({
      platform: 'youtube',
      user: item.authorName?.simpleText || 'viewer',
      login: item.authorExternalChannelId || '',
      text,
      isMod: badges.includes('MODERATOR') || isBroadcaster,
      isBroadcaster,
      isSubscriber: badges.includes('SPONSOR') || badges.includes('MEMBER'),
    });
  }

  let continuation = null;
  let timeoutMs = 3000;
  for (const cont of chat.continuations || []) {
    const data = cont.invalidationContinuationData || cont.timedContinuationData
      || cont.reloadContinuationData;
    if (data?.continuation) {
      continuation = data.continuation;
      if (data.timeoutMs) timeoutMs = data.timeoutMs;
      break;
    }
  }

  return { messages, continuation, timeoutMs };
}

class YouTubeChat extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.running = false;
    this.connected = false;
    this.timer = null;
    this.session = null;
    this.firstPoll = true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.firstPoll = true;
    this.begin();
  }

  async begin() {
    if (!this.running) return;
    try {
      const videoId = await resolveVideoId(this.channel);
      this.session = await bootstrap(videoId);
      if (!this.running) return;
      this.connected = true;
      this.emit('status', { connected: true, videoId });
      this.poll();
    } catch (err) {
      if (!this.running) return;
      this.connected = false;
      this.emit('status', { connected: false, error: err.message });
      this.timer = setTimeout(() => this.begin(), 15000);
    }
  }

  async poll() {
    if (!this.running || !this.session) return;
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.session.apiKey}&prettyPrint=false`,
        {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: this.session.clientVersion } },
            continuation: this.session.continuation,
          }),
        },
      );
      if (!res.ok) throw new Error(`http${res.status}`);
      const payload = await res.json();
      if (!this.running) return;

      const { messages, continuation, timeoutMs } = readMessages(payload);

      // The first poll replays chat backlog; skip it so the game does not get
      // a burst of commands typed before the streamer pressed Start.
      if (!this.firstPoll) {
        for (const message of messages) this.emit('message', message);
      }
      this.firstPoll = false;

      if (!continuation) throw new Error('streamEnded');
      this.session.continuation = continuation;
      this.timer = setTimeout(() => this.poll(), Math.max(1000, Math.min(timeoutMs, 10000)));
    } catch (err) {
      if (!this.running) return;
      this.connected = false;
      this.emit('status', { connected: false, error: err.message });
      this.session = null;
      this.timer = setTimeout(() => this.begin(), 15000);
    }
  }

  stop() {
    this.running = false;
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.session = null;
  }
}

module.exports = { YouTubeChat, resolveVideoId, bootstrap, readMessages, extractJson };
