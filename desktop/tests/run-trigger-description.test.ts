// Prevent divergent today/history descriptions, option-number answers and dropped supplementary text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runTriggerDescription } from "../src/renderer/run-trigger-description.ts";

test("shared description preserves choices, supplementary text, correction and truncation", () => {
  assert.equal(
    runTriggerDescription({
      triggers: {
        count: 2,
        truncated: true,
        items: [
          { eventId: 2, cardId: 1, kind: "card.answered", title: "怎么做", choice: "选项一", answer: "补充<script>" },
          { eventId: 3, cardId: 2, kind: "owner.memo", title: "", choice: "", answer: "更正原文" },
        ],
      },
    }),
    "本轮 2 条触发：回答「怎么做」：选项一；补充<script> · 更正：更正原文（资料已截断）",
  );
  assert.equal(
    runTriggerDescription({
      request: { taskId: 1, title: "需求", detail: "需求正文", availability: "recorded", truncated: false },
    }),
    "需求正文",
  );
  assert.equal(runTriggerDescription({}), "资料未记录");
});
