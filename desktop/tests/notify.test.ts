// The notification decision logic runs without any real notification ever being shown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotifier } from "../src/notify.ts";
import type { HubGlance } from "../src/hub-watcher.ts";

const glance = (asks: { id: number; title: string }[], live = true): HubGlance => ({
  live,
  attention: live ? asks.length : 0,
  asks,
  runs: [],
});

test("a fresh ask card becomes one notification; the same card never notifies again", () => {
  const notifier = createNotifier();
  assert.deepEqual(notifier.push(glance([{ id: 1, title: "发布需要决定" }])), [
    { title: "新的待决策", body: "发布需要决定" },
  ]);
  assert.deepEqual(notifier.push(glance([{ id: 1, title: "发布需要决定" }])), []);
  // A card that joins one already seen notifies for itself alone.
  assert.deepEqual(
    notifier.push(
      glance([
        { id: 1, title: "发布需要决定" },
        { id: 2, title: "另一个决定" },
      ]),
    ),
    [{ title: "新的待决策", body: "另一个决定" }],
  );
});

test("a glance that is not live changes nothing and never re-notifies surviving cards", () => {
  const notifier = createNotifier();
  assert.equal(notifier.push(glance([{ id: 1, title: "发布需要决定" }])).length, 1);
  // A dropped stream, a stopped hub or an untrustworthy read is not a second chance.
  assert.deepEqual(notifier.push(glance([{ id: 1, title: "发布需要决定" }], false)), []);
  assert.deepEqual(notifier.push(glance([{ id: 1, title: "发布需要决定" }])), []);
});

test("several fresh cards merge into one draft naming the first", () => {
  const notifier = createNotifier();
  assert.deepEqual(
    notifier.push(
      glance([
        { id: 1, title: "发布需要决定" },
        { id: 2, title: "另一个决定" },
        { id: 3, title: "第三件事" },
      ]),
    ),
    [{ title: "3 条新的待决策", body: "发布需要决定 等 3 条" }],
  );
});

test("the seen memory is bounded; forgetting the oldest card is at worst one duplicate", () => {
  const notifier = createNotifier({ seenMax: 2 });
  assert.equal(notifier.push(glance([{ id: 1, title: "一" }])).length, 1);
  assert.equal(notifier.push(glance([{ id: 2, title: "二" }])).length, 1);
  // id 1 is now the oldest and falls out; seeing it again costs one duplicate notice, no more.
  assert.equal(notifier.push(glance([{ id: 3, title: "三" }])).length, 1);
  assert.deepEqual(
    notifier.push(
      glance([
        { id: 1, title: "一" },
        { id: 2, title: "二" },
        { id: 3, title: "三" },
      ]),
    ),
    [{ title: "新的待决策", body: "一" }],
  );
});
