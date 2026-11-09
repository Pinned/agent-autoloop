// What this machine is in the system: config.json, private to its owner. On a machine that runs everything it has all
// of these; a machine that only does work has the hub's address and a worker's key.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";
import { installPrivateFile } from "./private-file-io.ts";

export type ChannelConfig = { use?: string; key: string; [option: string]: unknown };
export type Config = {
  url: string;
  hub?: { listen: string; publicUrl?: string };
  worker?: { name: string; key: string; capacity?: number; unreachable?: string[] };
  channels?: Record<string, ChannelConfig>;
  source?: { name: string; key: string };
  owner?: string;
};

export const CONFIG_FILE = path.join(HOME, "config.json");

export function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) throw new Error("还没装好：先运行 agent-autoloop init");
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
}

export function writeConfig(config: Config) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  installPrivateFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}
