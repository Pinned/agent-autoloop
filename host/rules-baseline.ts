// Pure declaration boundary; disk and runtime adapters supply all observations and effects.
import { createHash } from "node:crypto";
import { Conflict, InputError } from "../kernel/errors.ts";
import type { Fact, View } from "../kernel/evolve.ts";
import type { Rules } from "../kernel/rules.ts";
import { RulesError } from "../protocol/rules.ts";

export type RulesBaseline = { rulesSeq: number; declarationHash?: string; effective: Rules };
export type RulesDeclaration = { declarationHash: string; effective: Rules; raw: { rules: Record<string, unknown>[] } };
export type RulesParser = (text: string) => Rules;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function parseRulesDeclaration(text: string, parse: RulesParser): RulesDeclaration {
  const effective = parse(text);
  const raw = JSON.parse(text);
  return { raw, effective, declarationHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex") };
}

export function decorateRulesFacts(facts: Fact[], hash: string): Fact[] {
  return facts.map((fact) =>
    fact.type === "rules" ? { ...fact, meta: { ...fact.meta, declarationHash: hash } } : fact,
  );
}

export function appliedRulesBaseline(view: View, readFact: (seq: number) => Fact | undefined): RulesBaseline {
  const config = view.get("config", "rules");
  const rulesSeq = config?.version ?? 0;
  const fact = rulesSeq ? readFact(rulesSeq) : undefined;
  const hash = fact?.type === "rules" && fact.seq === rulesSeq ? fact.meta?.declarationHash : undefined;
  return {
    rulesSeq,
    effective: config?.value,
    ...(typeof hash === "string" && hash.length === 64 && /^[a-f0-9]{64}$/.test(hash) ? { declarationHash: hash } : {}),
  };
}

export function sameRulesBaseline(a: RulesBaseline, b: RulesBaseline): boolean {
  return a.rulesSeq === b.rulesSeq && a.declarationHash === b.declarationHash && same(a.effective, b.effective);
}

export function matchesRulesDeclaration(declaration: RulesDeclaration, applied: RulesBaseline): boolean {
  return (
    !!applied.declarationHash &&
    declaration.declarationHash === applied.declarationHash &&
    same(declaration.effective, applied.effective)
  );
}

// Returning undefined rather than void rejects async callbacks at the adapter's type boundary.
export function runSynchronousHook(hook: () => undefined): undefined {
  const result: unknown = hook();
  if (result !== undefined) throw new InputError("规则保存回调必须同步完成");
}

export function createRulesLoader(options: {
  stat(file: string): number;
  read(file: string): string;
  parse: RulesParser;
  applied(): RulesBaseline;
  hasBroken(): boolean;
  apply(declaration: RulesDeclaration): undefined;
}) {
  let loaded: { file: string; mtime: number } | undefined;
  return (file: string, force = false): { changed: boolean; problem?: string } => {
    const mtime = options.stat(file);
    if (!force && loaded?.file === file && loaded.mtime === mtime) return { changed: false };
    try {
      const declaration = parseRulesDeclaration(options.read(file), options.parse);
      if (!matchesRulesDeclaration(declaration, options.applied()) || options.hasBroken())
        runSynchronousHook(() => options.apply(declaration));
      loaded = { file, mtime };
      return { changed: true };
    } catch (error) {
      if (error instanceof RulesError) return { changed: false, problem: error.message };
      throw error;
    }
  };
}

export function assertRulesBaseline(
  text: string,
  rulesSeq: number,
  applied: RulesBaseline,
  parse: RulesParser,
): undefined {
  const conflict = () => new Conflict("规则已变化，请重新读取后再保存");
  if (rulesSeq !== applied.rulesSeq || !applied.declarationHash) throw conflict();
  let declaration: RulesDeclaration;
  try {
    declaration = parseRulesDeclaration(text, parse);
  } catch {
    throw conflict();
  }
  if (!matchesRulesDeclaration(declaration, applied)) throw conflict();
}
