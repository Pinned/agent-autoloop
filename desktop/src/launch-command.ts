// The one command that starts the CLI hub. It is shown on the reconnect page and copied by the
// main process, so it lives in one place: a page that tells the user to run a command the docs do
// not name would be worse than no page at all. Pure data, safe for the sandboxed renderer bundle.
export const LAUNCH_COMMAND = "agent-autoloop up";
