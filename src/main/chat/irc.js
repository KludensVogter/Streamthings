'use strict';

/**
 * Just enough IRCv3 to read Twitch chat.
 *
 * A tagged Twitch line looks like:
 *   @badges=moderator/1;mod=1;display-name=Someone :someone!someone@someone.tmi.twitch.tv PRIVMSG #chan :hello
 */

const TAG_ESCAPES = { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' };

function parseTags(raw) {
  const tags = {};
  for (const pair of raw.split(';')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    // One pass, so an escaped backslash cannot be re-read as the start of
    // the next escape sequence.
    tags[key] = value.replace(/\\(.)/g, (_match, ch) => (
      TAG_ESCAPES[ch] !== undefined ? TAG_ESCAPES[ch] : ch
    ));
  }
  return tags;
}

function parseLine(line) {
  let rest = line;
  let tags = {};
  let prefix = '';

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }

  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  // The trailing parameter is everything after " :" and may itself contain colons.
  let trailing = null;
  const trailingAt = rest.indexOf(' :');
  if (rest.startsWith(':')) {
    trailing = rest.slice(1);
    rest = '';
  } else if (trailingAt !== -1) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }

  const parts = rest.split(' ').filter(Boolean);
  const command = parts.shift() || '';
  if (trailing !== null) parts.push(trailing);

  return { tags, prefix, command, params: parts, trailing };
}

/** Turns a parsed PRIVMSG into the shape the engine consumes. */
function toChatMessage(parsed) {
  if (!parsed || parsed.command !== 'PRIVMSG') return null;
  const nick = parsed.prefix.split('!')[0];
  const text = parsed.trailing;
  if (!nick || text === null || text === undefined) return null;

  const badges = parsed.tags.badges || '';
  const isBroadcaster = /(^|,)broadcaster\//.test(badges);
  const isMod = parsed.tags.mod === '1'
    || parsed.tags['user-type'] === 'mod'
    || /(^|,)moderator\//.test(badges)
    || isBroadcaster;

  return {
    platform: 'twitch',
    user: parsed.tags['display-name'] || nick,
    login: nick,
    text: text.replace(/[\r\n]/g, '').trim(),
    isMod,
    isBroadcaster,
    isSubscriber: /(^|,)(subscriber|founder)\//.test(badges),
  };
}

module.exports = { parseTags, parseLine, toChatMessage };
