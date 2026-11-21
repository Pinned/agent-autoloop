// One-shot helper run under the embedded Node 24 runtime for Feishu channel binding and testing.
import { sendTestCard, waitForUserOpenId } from "../plugins/feishu/channel.ts";

const RESULT_PREFIX = "CHANNEL_HELPER_RESULT:";
const writeResult = (payload: unknown) => {
  process.stdout.write(`\n${RESULT_PREFIX}${JSON.stringify(payload)}\n`);
};

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    action: "feishu-test" | "feishu-bind";
    appId: string;
    appSecret: string;
    user?: string;
    domain?: "feishu" | "lark";
    pairingCode?: string;
    timeoutMs?: number;
  };
  if (input.action === "feishu-test") {
    if (!input.user) throw new Error("请填写接收人 Open ID");
    const messageId = await sendTestCard({
      appId: input.appId,
      appSecret: input.appSecret,
      user: input.user,
      domain: input.domain,
    });
    writeResult({ ok: true, message: `测试卡片已发送（${messageId}）` });
    return;
  }
  if (input.action === "feishu-bind") {
    const bound = await waitForUserOpenId({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: input.domain,
      pairingCode: input.pairingCode,
      timeoutMs: input.timeoutMs ?? 60_000,
    });
    writeResult({ ok: true, openId: bound.openId, ...(bound.userName && { userName: bound.userName }) });
    return;
  }
  throw new Error("不支持的操作");
}

main().catch((error) => {
  writeResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
});
