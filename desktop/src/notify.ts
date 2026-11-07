import type { HubGlance } from "./hub-watcher.ts";

// System notifications live in the main process only; this module is pure decision
// logic so it can be tested without ever showing a real notification.
export type NotificationDraft = { title: string; body: string };

export type NotifierOptions = { seenMax?: number };

export function createNotifier(options: NotifierOptions = {}) {
  const seenMax = options.seenMax ?? 500;
  const seen = new Set<number>();
  return {
    // A glance that is not live changes nothing: the same cards survive a hub restart,
    // and a read that could not be trusted must not produce a second notice.
    push(glance: HubGlance): NotificationDraft[] {
      if (!glance.live) return [];
      const fresh = glance.asks.filter((ask) => !seen.has(ask.id));
      for (const ask of glance.asks) seen.add(ask.id);
      // The memory is bounded: forgetting the oldest seen card is at worst one duplicate notice.
      while (seen.size > seenMax) seen.delete(seen.values().next().value as number);
      if (fresh.length === 0) return [];
      if (fresh.length === 1) return [{ title: "新的待决策", body: fresh[0].title }];
      return [{ title: `${fresh.length} 条新的待决策`, body: `${fresh[0].title} 等 ${fresh.length} 条` }];
    },
  };
}
