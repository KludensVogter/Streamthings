'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { suite, ok, eq, sleep } = require('./helpers');
const input = require('../src/main/input');
const { Poll } = require('../src/main/poll');

// Never touch the real keyboard from a test.
input.keyDown = () => true;
input.keyUp = () => true;
input.mouseDown = () => true;
input.mouseUp = () => true;
input.mouseMove = () => true;
input.releaseAll = () => {};
input.foregroundTitle = () => 'Some Game';

const { Runner } = require('../src/main/runner');

const twoOptions = [{ key: '1', label: 'Go left' }, { key: '2', label: 'Go right' }];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'streamthings-poll-'));
}

module.exports = async function run() {
  suite('Starting a poll');
  const poll = new Poll();
  eq('starts idle', poll.status, 'idle');
  eq('one option is not a poll', poll.start({ question: 'x', options: [{ label: 'only' }] }).ok, false);
  eq('and says why', poll.start({ question: 'x', options: [] }).reason, 'needTwoOptions');
  eq('blank labels do not count', poll.start({
    question: 'x', options: [{ label: 'a' }, { label: '   ' }],
  }).ok, false);

  eq('two options is a poll', poll.start({
    question: 'What next?', options: twoOptions, durationSeconds: 0,
  }).ok, true);
  eq('status is open', poll.status, 'open');
  eq('question kept', poll.question, 'What next?');

  poll.start({ question: 'x', options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }] });
  eq('missing keys are numbered', poll.options.map((o) => o.key), ['1', '2', '3']);
  poll.start({ question: 'x', options: [{ key: 'A', label: 'Alpha' }, { key: 'a', label: 'Again' }, { key: 'b', label: 'Beta' }] });
  eq('duplicate keys are dropped, case-insensitively', poll.options.map((o) => o.key), ['a', 'b']);

  suite('Voting');
  poll.start({ question: 'What next?', options: twoOptions, durationSeconds: 0 });
  ok('a matching word is a vote', poll.offer('twitch:ana', '1') === true);
  ok('case and spaces ignored', poll.offer('twitch:bo', '  2  ') === true);
  ok('an unrelated message is not a vote', poll.offer('twitch:cy', 'hello') === false);
  ok('a command word that is not an option is not a vote', poll.offer('twitch:cy', 'forward') === false);
  eq('two people, two votes', poll.votes.size, 2);

  poll.offer('twitch:ana', '1');
  poll.offer('twitch:ana', '1');
  eq('voting twice does not count twice', poll.votes.size, 2);
  poll.offer('twitch:ana', '2');
  eq('changing your mind replaces the vote', poll.votes.size, 2);
  eq('and moves it', poll.results().map((r) => r.votes), [0, 2]);

  suite('Results');
  poll.start({ question: 'x', options: twoOptions, durationSeconds: 0 });
  for (let i = 0; i < 3; i += 1) poll.offer(`twitch:left${i}`, '1');
  poll.offer('twitch:right', '2');
  const results = poll.results();
  eq('counts', results.map((r) => r.votes), [3, 1]);
  eq('percentages', results.map((r) => r.percent), [75, 25]);
  eq('only the top option leads', results.map((r) => r.leading), [true, false]);
  eq('total', poll.state().totalVotes, 4);

  poll.start({ question: 'x', options: twoOptions, durationSeconds: 0 });
  poll.offer('twitch:a', '1');
  poll.offer('twitch:b', '2');
  eq('a tie marks both as leading', poll.results().map((r) => r.leading), [true, true]);

  poll.start({ question: 'x', options: twoOptions, durationSeconds: 0 });
  eq('with no votes nothing leads', poll.results().map((r) => r.leading), [false, false]);
  eq('and percentages are zero, not NaN', poll.results().map((r) => r.percent), [0, 0]);

  suite('Closing');
  poll.start({ question: 'x', options: twoOptions, durationSeconds: 0 });
  poll.offer('twitch:a', '1');
  poll.stop();
  eq('stop closes voting', poll.status, 'closed');
  ok('votes are kept for the result', poll.results()[0].votes === 1);
  ok('votes no longer count once closed', poll.offer('twitch:b', '2') === false);
  eq('and the tally is unchanged', poll.state().totalVotes, 1);
  poll.close();
  eq('close clears it', poll.status, 'idle');
  eq('question is gone', poll.question, '');
  poll.close();

  suite('Timed poll');
  const timed = new Poll();
  timed.start({ question: 'x', options: twoOptions, durationSeconds: 1 });
  ok('has a deadline', timed.state().remainingMs > 0);
  timed.offer('twitch:a', '1');
  await sleep(1300);
  eq('closes itself when time runs out', timed.status, 'closed');
  eq('result survives', timed.results()[0].votes, 1);
  timed.close();

  suite('Polls and the game are independent');
  const dir = tempDir();
  const runner = new Runner(dir);
  runner.settings.update({ twitchChannel: 'somechannel' });

  const fakeChat = new EventEmitter();
  fakeChat.start = () => {};
  fakeChat.stop = () => {};
  runner.addConnection(fakeChat, 'twitch');

  // Chat is playing the game and a poll is open at the same time.
  runner.enginePlaying = true;
  runner.engine.start();
  // "1" deliberately collides with a command; "banana" deliberately does not.
  runner.poll.start({
    question: 'Which way?',
    options: [{ key: '1', label: 'Left' }, { key: 'banana', label: 'Right' }],
    durationSeconds: 0,
  });

  const say = (user, text) => fakeChat.emit('message', {
    platform: 'twitch', user, login: user, text, isMod: false, isBroadcaster: false,
  });

  // "1" is both a poll option and a command in the default profile.
  ok('the default profile really does have a command called 1',
    runner.profile.commands.some((c) => c.id === '1'));
  say('ana', '1');
  eq('the vote was counted', runner.poll.state().totalVotes, 1);
  eq('and the game command still ran', runner.engine.queue.length, 1);

  say('bo', 'jump');
  eq('a pure command is not a vote', runner.poll.state().totalVotes, 1);
  eq('but still reaches the game', runner.engine.queue.length, 2);

  say('cy', 'banana');
  eq('a vote word that is not a command is counted', runner.poll.state().totalVotes, 2);
  eq('and queues nothing for the game', runner.engine.queue.length, 2);

  suite('A poll works without the game running');
  runner.stop();
  eq('game stopped', runner.running, false);
  ok('connection stays up because the poll still needs it', runner.connections.length > 0);
  say('dee', '1');
  eq('votes still land', runner.poll.state().totalVotes, 3);
  eq('but nothing is queued for the game', runner.engine.queue.length, 0);

  runner.closePoll();
  eq('closing the poll drops the connection too', runner.connections.length, 0);

  suite('Clash warning');
  const clashes = runner.pollClashes([{ key: '1' }, { key: 'banana' }, { key: 'w' }]);
  ok('reports a command id', clashes.includes('1'));
  ok('reports an alias', clashes.includes('w'));
  ok('leaves unrelated keys alone', !clashes.includes('banana'));

  await runner.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
};
