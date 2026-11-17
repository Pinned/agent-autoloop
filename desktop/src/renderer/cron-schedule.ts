export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; days: number[] }
  | { kind: "monthly"; time: string; day: number }
  | { kind: "interval"; minutes: number };

// Only divisors of an hour make */N a uniform interval across hour boundaries.
export const minuteIntervals = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
export function encodeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    if (!minuteIntervals.includes(schedule.minutes)) throw new Error("请选择有效的分钟间隔");
    return schedule.minutes === 60 ? "0 * * * *" : `*/${schedule.minutes} * * * *`;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error("请选择有效的执行时间");
  const prefix = `${Number(match[2])} ${Number(match[1])}`;
  if (schedule.kind === "weekly") {
    if (!schedule.days.length || schedule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
      throw new Error("请至少选择一个星期");
    return `${prefix} * * ${[...new Set(schedule.days)].sort((a, b) => a - b).join(",")}`;
  }
  if (schedule.kind === "monthly") {
    if (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 31) throw new Error("请选择有效的日期");
    return `${prefix} ${schedule.day} * *`;
  }
  return `${prefix} * * *`;
}
export function decodeSchedule(cron: string): Schedule | null {
  // Exact canonical matching preserves all other expressions, including their original text.
  if (cron === "0 * * * *") return { kind: "interval", minutes: 60 };
  const interval = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (interval && minuteIntervals.includes(Number(interval[1])) && Number(interval[1]) !== 60)
    return { kind: "interval", minutes: Number(interval[1]) };
  const match = /^(\d+) (\d+) (\*|\d+) \* (\*|[0-6](?:,[0-6])*)$/.exec(cron);
  if (!match) return null;
  const [, minute, hour, day, week] = match;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  const schedule: Schedule =
    day !== "*" && week === "*"
      ? { kind: "monthly", time, day: Number(day) }
      : day === "*" && week !== "*"
        ? { kind: "weekly", time, days: week.split(",").map(Number) }
        : day === "*" && week === "*"
          ? { kind: "daily", time }
          : (null as never);
  if (!schedule) return null;
  try {
    return encodeSchedule(schedule) === cron ? schedule : null;
  } catch {
    return null;
  }
}
export function scheduleSummary(schedule: Schedule): string {
  const zone = "按中台设置的时区执行。";
  if (schedule.kind === "interval") return `每隔 ${schedule.minutes} 分钟执行；从整点起算。${zone}`;
  if (schedule.kind === "weekly") {
    const names = ["日", "一", "二", "三", "四", "五", "六"];
    return `每周${schedule.days.map((day) => names[day]).join("、")} ${schedule.time} 执行。${zone}`;
  }
  if (schedule.kind === "monthly")
    return `每月 ${schedule.day} 日 ${schedule.time} 执行。${schedule.day > 28 ? "没有该日期的月份会跳过。" : ""}${zone}`;
  return `每天 ${schedule.time} 执行。${zone}`;
}
