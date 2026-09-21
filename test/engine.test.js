'use strict';

const { suite, ok, eq, sleep } = require('./helpers');
const input = require('../src/main/input');
const { Engine } = require('../src/main/engine');
const { CommandSet } = require('../src/main/commands');
const { defaultProfile } = require('../src/main/profiles');

// Record input instead of sending it, so the test never touches the keyboard.
const sent = [];
input.keyDown = (k) => { sent.push(['down', k]); return true; };
input.keyUp = (k) => { sent.push(['up', k]); return true; };
input.mouseDown = (b) => { sent.push(['mdown', b]); return true; };
input.mouseUp = (b) => { sent.push(['mup', b]); return true; };
input.mouseMove = (x, y) => { sent.push(['move', Math.round(x), Math.round(y)]); return true; };
input.releaseAll = () => {};
let fakeTitle = 'Some Game';
input.foregroundTitle = () => fakeTitle;

const chat = (user, text, extra = {}) => ({
  platform: 'twitch', user, login: user.toLowerCase(), text,
  isMod: false, isBroadcaster: false, isSubscriber: false, ...extra,
});

module.exports = async function run() {
  suite('Command parsing');
  const set = new CommandSet(defaultProfile().commands);
  eq('exact name', set.parse('forward')?.command.id, 'forward');
  eq('alias', set.parse('w')?.command.id, 'forward');
  eq('case and spaces ignored', set.parse('  FORWARD  ')?.command.id, 'forward');
  eq('hold syntax', set.parse('forward 2')?.seconds, 2);
  eq('comma decimal', set.parse('forward 1,5')?.seconds, 1.5);
  eq('hold capped at maxHold', set.parse('forward 99')?.seconds, 3);
  eq('non-holdable ignores number', set.parse('jump 5')?.seconds, null);
  eq('unknown text', set.parse('hello there'), null);
  eq('empty', set.parse(''), null);
  ok('numeric command keeps its place', set.commands[15].id === '1');

  suite('Command validation');
  const bad = new CommandSet([
    { id: 'good', keys: ['w'] },
    { id: 'ghost', keys: ['not_a_key'] },
    { id: 'empty', type: 'key', keys: [] },
    { id: 'dupe', aliases: ['w'], keys: ['q'] },
    { id: 'dupe', keys: ['x'] },
  ]);
  const problems = bad.problems().map((p) => p.problem);
  ok('unknown key reported', problems.some((p) => p.startsWith('unknownKey:')));
  ok('missing key reported', problems.includes('noKey'));
  ok('duplicate word reported', problems.some((p) => p.startsWith('duplicate:')));
  eq('valid command produces no problem', new CommandSet([{ id: 'ok', keys: ['w'] }]).problems(), []);

  suite('Anarchy mode');
  const engine = new Engine({ ...defaultProfile(), messageRate: 0.05, maxQueue: 5 });
  engine.start();
  sent.length = 0;
  engine.handleMessage(chat('ana', 'jump'));
  eq('queued', engine.queue.length, 1);
  await sleep(200);
  eq('queue drained', engine.queue.length, 0);
  ok('key was pressed and released', sent.some((s) => s[0] === 'down' && s[1] === 'space'));
  await sleep(150);
  ok('key released after duration', sent.some((s) => s[0] === 'up' && s[1] === 'space'));

  for (let i = 0; i < 50; i += 1) engine.handleMessage(chat(`user${i}`, 'jump'));
  ok('queue never exceeds the cap', engine.queue.length <= 5, `(${engine.queue.length})`);
  engine.stop();

  suite('Moderator-only commands');
  const modEngine = new Engine({
    ...defaultProfile(),
    messageRate: 0.05,
    commands: [
      { id: 'jump', keys: ['space'], duration: 0.05 },
      { id: 'reset', keys: ['r'], duration: 0.05, modOnly: true },
    ],
  });
  modEngine.start();
  modEngine.handleMessage(chat('viewer', 'reset'));
  eq('viewer cannot run a mod command', modEngine.queue.length, 0);
  ok('block is shown in the feed', modEngine.feed[0]?.kind === 'blocked');
  modEngine.handleMessage(chat('modperson', 'reset', { isMod: true }));
  eq('moderator can run it', modEngine.queue.length, 1);
  modEngine.handleMessage(chat('streamer', 'reset', { isMod: true, isBroadcaster: true }));
  eq('broadcaster can run it', modEngine.queue.length, 2);
  modEngine.handleMessage(chat('viewer2', 'jump'));
  eq('normal commands still open to everyone', modEngine.queue.length, 3);
  modEngine.stop();

  suite('Per-viewer cooldown');
  const cooled = new Engine({ ...defaultProfile(), userCooldown: 5, messageRate: 5 });
  cooled.start();
  cooled.handleMessage(chat('spammer', 'jump'));
  cooled.handleMessage(chat('spammer', 'jump'));
  cooled.handleMessage(chat('spammer', 'jump'));
  cooled.handleMessage(chat('someone', 'jump'));
  eq('one per viewer inside the window', cooled.queue.length, 2);
  cooled.stop();

  suite('Democracy mode');
  const vote = new Engine({ ...defaultProfile(), mode: 'democracy', voteSeconds: 2 });
  vote.start();
  for (let i = 0; i < 5; i += 1) vote.handleMessage(chat(`voter${i}`, 'forward'));
  for (let i = 0; i < 2; i += 1) vote.handleMessage(chat(`other${i}`, 'jump'));
  vote.handleMessage(chat('voter0', 'jump'));
  const tally = Object.fromEntries(vote.voteTally().map((v) => [v.id, v.votes]));
  eq('votes counted', tally, { forward: 5, jump: 2 });
  ok('one vote per viewer per round', vote.votes.get('jump') === 2);
  await sleep(2300);
  eq('winner is the most voted', vote.lastWinner?.id, 'forward');
  ok('new round cleared the votes', vote.votes.size === 0);
  vote.stop();

  suite('Only-this-game guard');
  // Let the previous round's key release land before we start recording.
  await sleep(600);
  const guarded = new Engine({ ...defaultProfile(), targetWindow: 'Some Game', messageRate: 0.05 });
  guarded.start();
  fakeTitle = 'Some Game - Level 1';
  ok('runs when the game is focused', guarded.windowIsRight() === true);
  fakeTitle = 'Discord';
  ok('blocked when another window is focused', guarded.windowIsRight() === false);
  sent.length = 0;
  guarded.handleMessage(chat('ana', 'jump'));
  await sleep(200);
  eq('nothing was sent to the wrong window', sent.length, 0);
  fakeTitle = 'Some Game';
  guarded.stop();

  suite('Live reconfigure');
  const live = new Engine(defaultProfile());
  live.start();
  eq('starts in anarchy', live.mode, 'anarchy');
  live.reconfigure({ ...defaultProfile(), mode: 'democracy', voteSeconds: 3 });
  eq('switched to democracy', live.mode, 'democracy');
  ok('still running after the switch', live.running === true);
  live.reconfigure({ ...defaultProfile(), userCooldown: 9 });
  eq('setting applied without a restart', live.userCooldown, 9);
  ok('still running', live.running === true);
  live.stop();

  suite('Pause');
  const paused = new Engine({ ...defaultProfile(), messageRate: 0.05 });
  paused.start();
  paused.setPaused(true);
  paused.handleMessage(chat('ana', 'jump'));
  eq('input ignored while paused', paused.queue.length, 0);
  paused.setPaused(false);
  paused.handleMessage(chat('ana', 'jump'));
  eq('accepted again after resuming', paused.queue.length, 1);
  paused.stop();
};
