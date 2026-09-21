'use strict';

const { suite, ok, eq } = require('./helpers');
const { parseLine, parseTags, toChatMessage } = require('../src/main/chat/irc');
const { readMessages, extractJson } = require('../src/main/chat/youtube');

module.exports = async function run() {
  suite('Twitch IRC parsing');
  const line = '@badge-info=subscriber/7;badges=moderator/1,subscriber/6;color=#1E90FF;'
    + 'display-name=CoolMod;mod=1;user-type=mod '
    + ':coolmod!coolmod@coolmod.tmi.twitch.tv PRIVMSG #streamer :forward 2';
  const parsed = parseLine(line);
  eq('command', parsed.command, 'PRIVMSG');
  eq('channel', parsed.params[0], '#streamer');
  eq('text', parsed.trailing, 'forward 2');

  const msg = toChatMessage(parsed);
  eq('display name preferred', msg.user, 'CoolMod');
  eq('login kept for identity', msg.login, 'coolmod');
  eq('message text', msg.text, 'forward 2');
  ok('moderator detected', msg.isMod === true);
  ok('subscriber detected', msg.isSubscriber === true);
  ok('not flagged as broadcaster', msg.isBroadcaster === false);

  const plain = toChatMessage(parseLine(':viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #s :jump'));
  eq('untagged message still works', plain.user, 'viewer');
  ok('plain viewer is not a mod', plain.isMod === false);

  const owner = toChatMessage(parseLine(
    '@badges=broadcaster/1;mod=0 :streamer!streamer@streamer.tmi.twitch.tv PRIVMSG #s :reset',
  ));
  ok('broadcaster counts as a moderator', owner.isMod === true && owner.isBroadcaster === true);

  const colons = toChatMessage(parseLine(':a!a@a.tmi.twitch.tv PRIVMSG #s :look at this: http://x.dk/a:b'));
  eq('colons inside the message survive', colons.text, 'look at this: http://x.dk/a:b');

  suite('IRC tag escaping');
  const BS = String.fromCharCode(92); // a literal backslash, spelled out to keep it obvious
  const tags = parseTags(`display-name=Some${BS}sOne;msg=a${BS}:b;empty=`);
  eq('escaped space', tags['display-name'], 'Some One');
  eq('escaped semicolon', tags.msg, 'a;b');
  eq('empty value', tags.empty, '');
  // An escaped backslash must not be re-read as the start of the next escape.
  const tricky = parseTags(`a=x${BS}${BS}sy;b=${BS}${BS}`);
  eq('escaped backslash then a plain s', tricky.a, `x${BS}sy`);
  eq('lone escaped backslash', tricky.b, BS);

  suite('Malformed lines are ignored, not fatal');
  ok('empty line', parseLine('') !== undefined);
  eq('PING is not a message', toChatMessage(parseLine('PING :tmi.twitch.tv')), null);
  eq('join is not a message', toChatMessage(parseLine(':x!x@x JOIN #s')), null);
  eq('truncated tags', parseLine('@only-tags-no-space'), null);

  suite('YouTube chat parsing');
  const payload = {
    continuationContents: {
      liveChatContinuation: {
        actions: [
          {
            addChatItemAction: {
              item: {
                liveChatTextMessageRenderer: {
                  authorName: { simpleText: 'Viewer One' },
                  authorExternalChannelId: 'UC123',
                  message: { runs: [{ text: 'forward' }, { emoji: { shortcuts: [':smile:'] } }] },
                },
              },
            },
          },
          {
            addChatItemAction: {
              item: {
                liveChatTextMessageRenderer: {
                  authorName: { simpleText: 'The Owner' },
                  message: { runs: [{ text: 'reset' }] },
                  authorBadges: [{ liveChatAuthorBadgeRenderer: { icon: { iconType: 'OWNER' } } }],
                },
              },
            },
          },
          { addLiveChatTickerItemAction: { item: {} } },
        ],
        continuations: [{ timedContinuationData: { continuation: 'next-token', timeoutMs: 5000 } }],
      },
    },
  };
  const result = readMessages(payload);
  eq('two chat messages found', result.messages.length, 2);
  eq('text and emoji joined', result.messages[0].text, 'forward:smile:');
  eq('author name', result.messages[0].user, 'Viewer One');
  ok('plain viewer is not a mod', result.messages[0].isMod === false);
  ok('owner counts as a moderator', result.messages[1].isMod === true);
  ok('owner flagged as broadcaster', result.messages[1].isBroadcaster === true);
  eq('continuation token picked up', result.continuation, 'next-token');
  eq('poll interval picked up', result.timeoutMs, 5000);
  eq('platform tagged', result.messages[0].platform, 'youtube');

  const empty = readMessages({});
  eq('missing payload gives no messages', empty.messages, []);
  eq('and no continuation', empty.continuation, null);

  suite('YouTube page scraping');
  const html = 'junk var ytInitialData = {"a":{"b":[1,2]},"s":"has \\" quote and } brace"};</script> more';
  const data = extractJson(html, 'ytInitialData');
  eq('balanced braces respected', data.a.b, [1, 2]);
  eq('escaped quotes and braces inside strings survive', data.s, 'has " quote and } brace');
  eq('missing marker returns null', extractJson('nothing here', 'ytInitialData'), null);
};
