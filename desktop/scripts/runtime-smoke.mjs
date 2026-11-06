// Real-network smoke is separate from unit tests; only checkRuntime owns download and isolation.
import { checkRuntime } from "./runtime.mjs";
console.log(JSON.stringify(await checkRuntime(), null, 2));
