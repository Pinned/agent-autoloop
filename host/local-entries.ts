// Pure production logic. Filesystem paths, runtime state and side effects belong to adapters.
import { InputError } from "../kernel/errors.ts";
import { TYPE_PATTERN } from "../protocol/rules.ts";

export type Entry = Record<string, unknown>;
const isObject = (value: unknown): value is Entry =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const takesLocal = (rule: unknown) => isObject(rule) && isObject(rule.when) && rule.when.source === "local";

export type LocalEntriesReaderOptions = {
  read(): string;
  parse(json: string): unknown;
  applied(): unknown;
};

export function createLocalEntriesReader(options: LocalEntriesReaderOptions): () => (Entry & { types: string[] })[] {
  function declaration(): { rules: Entry[]; effective: string } | null {
    try {
      const json = options.read();
      const effective = JSON.stringify(options.parse(json));
      if (effective !== JSON.stringify(options.applied())) return null;
      return { rules: (JSON.parse(json) as { rules: Entry[] }).rules, effective };
    } catch {
      return null;
    }
  }
  let snapshot = declaration();
  return () => {
    snapshot = declaration() ?? snapshot;
    if (!snapshot || snapshot.effective !== JSON.stringify(options.applied()))
      throw new InputError("无法读取已生效规则的原始声明，请先修复 rules.json");
    return snapshot.rules.filter(takesLocal).map((rule) => {
      const when = rule.when as { types: string[] };
      const entry: Entry & { types: string[] } = {
        name: rule.name,
        types: [...when.types],
        to: rule.to,
        cwd: rule.cwd,
      };
      for (const field of ["prompt", "skill", "parallel", "group", "tell", "emits"])
        if (rule[field] !== undefined)
          entry[field] = field === "emits" ? JSON.parse(JSON.stringify(rule[field])) : rule[field];
      return entry;
    });
  };
}

/** The unchanged HTTP entry checker: full reference validation happens on the merged file. */
export function checkedLocalEntry(given: unknown): Entry {
  if (!isObject(given)) throw new InputError("每个入口要是一个对象");
  const entry = given;
  for (const name of Object.keys(entry))
    if (!["name", "types", "to", "cwd", "prompt", "skill", "parallel", "group", "tell", "emits"].includes(name))
      throw new InputError(`入口有不认识的字段 ${name}`);
  const text = (name: string, optional = false) => {
    const value = entry[name];
    if (value === undefined || value === "") {
      if (optional) return undefined;
      throw new InputError(`入口缺少 ${name}`);
    }
    if (typeof value !== "string" || !value.trim()) throw new InputError(`入口的 ${name} 要是文字`);
    return value.trim();
  };
  const name = text("name")!;
  const types = entry.types;
  if (
    !Array.isArray(types) ||
    !types.length ||
    !types.every((type) => typeof type === "string" && TYPE_PATTERN.test(type))
  )
    throw new InputError(`入口「${name}」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配`);
  const parallel = entry.parallel;
  if (parallel !== undefined && (!Number.isInteger(parallel) || (parallel as number) <= 0))
    throw new InputError(`入口「${name}」的 parallel 要是正整数`);
  const tell = text("tell", true);
  if (tell !== undefined && !["always", "needed", "never"].includes(tell))
    throw new InputError(`入口「${name}」的 tell 只能是 always、needed、never`);
  let emits: Entry | undefined;
  if (entry.emits !== undefined) {
    const where = `入口「${name}」的 emits `;
    if (!isObject(entry.emits)) throw new InputError(`${where}要是一个对象`);
    const filter = entry.emits;
    for (const field of Object.keys(filter))
      if (!["source", "types"].includes(field)) throw new InputError(`${where}有不认识的字段 ${field}`);
    for (const field of ["source", "types"])
      if (filter[field] === undefined || filter[field] === "") throw new InputError(`${where}缺少 ${field}`);
    const source = typeof filter.source === "string" ? filter.source.trim() : "";
    if (!Array.isArray(filter.types) || !filter.types.every((word) => typeof word === "string" && word.trim()))
      throw new InputError(`入口「${name}」的 emits.types要是文字的列表`);
    const patterns = filter.types.map((word: string) => word.trim());
    if (source === "schedule" || !patterns.length || !patterns.every((type) => TYPE_PATTERN.test(type)))
      throw new InputError(`入口「${name}」的 emits 要是非保留来源和事件类型列表`);
    emits = { source, types: patterns };
  }
  return {
    name,
    types,
    to: text("to")!,
    cwd: text("cwd")!,
    ...(text("group", true) && { group: text("group", true) }),
    ...(tell !== undefined && { tell }),
    ...(emits !== undefined && { emits }),
    ...(text("prompt", true) && { prompt: text("prompt", true) }),
    ...(text("skill", true) && { skill: text("skill", true) }),
    ...(parallel !== undefined && { parallel: parallel as number }),
  };
}

export type LocalEntriesWriteIO = {
  read(): string;
  validate(json: string): unknown;
  write(json: string): void;
  rename(): void;
};

export function writeLocalEntriesWith(entries: Entry[], io: LocalEntriesWriteIO): void {
  const whole: unknown = JSON.parse(io.read());
  if (!isObject(whole)) throw new InputError("rules.json 不是一个对象");
  if (!Array.isArray(whole.rules) || !isObject(whole.sources))
    throw new InputError("rules.json 缺少 rules 或 sources，先把它修好再用网页改");
  const previous = whole.rules as Entry[];
  if (!("local" in whole.sources)) whole.sources = { ...whole.sources, local: { name: "本机" } };
  const replacements = entries.map((entry) => {
    const rule: Entry = {
      name: entry.name,
      when: { source: "local", types: entry.types },
      to: entry.to,
      cwd: entry.cwd,
    };
    for (const field of ["prompt", "skill", "parallel", "group", "tell", "emits"])
      if (entry[field] !== undefined) rule[field] = entry[field];
    return rule;
  });
  const lastLocal = previous.findLastIndex(takesLocal);
  let next = 0;
  whole.rules = previous.flatMap((rule, index) => {
    if (!takesLocal(rule)) return [rule];
    if (index === lastLocal) return replacements.slice(next);
    return next < replacements.length ? [replacements[next++]] : [];
  });
  if (lastLocal === -1) (whole.rules as Entry[]).push(...replacements);
  const json = `${JSON.stringify(whole, null, 2)}\n`;
  io.validate(json);
  io.write(json);
  io.rename();
}
