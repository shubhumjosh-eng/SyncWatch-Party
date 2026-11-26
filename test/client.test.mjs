import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipRange,
  splitChatStamps,
  seekFraction,
  workerErrorText,
  clippingUnavailableMessage
} from '../public/js/shared.mjs';

test('clip ranges never run past the end of a short video', () => {
  assert.deepEqual(clipRange(20, 8, 100), { start: 16, end: 24 });
  assert.deepEqual(clipRange(95, 10, 100), { start: 91, end: 100 });
  assert.deepEqual(clipRange(140, 8, 100), { start: 96, end: 100 });
  assert.deepEqual(clipRange(10, 8, 5), { start: 1, end: 5 });
  assert.deepEqual(clipRange(2, 8, 5), { start: 0, end: 5 });
});

test('chat timestamps support long videos and ignore malformed stamps', () => {
  const parts = splitChatStamps('watch @1:23 then @123:45 and @2:3 okay');
  const stamps = parts.filter((part) => part.seconds !== null);
  assert.deepEqual(stamps, [
    { text: '@1:23', seconds: 83 },
    { text: '@123:45', seconds: 7425 }
  ]);
  assert.ok(parts.some((part) => part.text.includes('@2:3') && part.seconds === null));
});

test('seek values are clamped to a usable fraction', () => {
  assert.equal(seekFraction(500), 0.5);
  assert.equal(seekFraction(-20), 0);
  assert.equal(seekFraction(1400), 1);
  assert.equal(seekFraction('nope'), 0);
});

test('worker errors never expose an undefined message', () => {
  assert.equal(workerErrorText({}), 'the clipping worker could not start in this browser');
  assert.equal(workerErrorText(null), 'the clipping worker could not start in this browser');
  assert.equal(workerErrorText(new Error('module import failed')), 'module import failed');
  assert.match(
    clippingUnavailableMessage({}),
    /^Clipping is unavailable here \(the clipping worker could not start in this browser\)\./
  );
  assert.doesNotMatch(clippingUnavailableMessage({}), /undefined/);
});
