import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c } from "./utils.js";
import { install, uninstall, status, doctor } from "./commands/install.js";

const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;

function printHelp(): void {
  console.log(`
${c.bold("dotmask")} v${VERSION} — transparent AI secret masking

${c.bold("USAGE")}
  dotmask <command> [flags]
  dm <command> [flags]

${c.bold("COMMANDS")}
  ${c.cyan("install")}    Set up dotmask proxy                ${c.dim("[--port <n>]")}
  ${c.cyan("uninstall")}  Remove dotmask proxy
  ${c.cyan("status")}     Show proxy status
  ${c.cyan("doctor")}     Diagnose configuration issues

${c.bold("HOW IT WORKS")}
  dotmask runs a local HTTPS proxy that intercepts all traffic
  from Claude Code (and other AI tools) to AI API endpoints.

  Before your prompt leaves your machine:
    • API keys, tokens, passwords are replaced with fake tokens
    • Fake tokens preserve format (same prefix, same length)
    • Your app still works — nothing changes locally

  ${c.bold("Supported APIs:")}
    ${c.green("✓")}  api.anthropic.com   (Claude)
    ${c.green("✓")}  api.openai.com      (OpenAI / ChatGPT)
    ${c.green("✓")}  openrouter.ai       (OpenRouter)

${c.bold("QUICK START")}
  ${c.cyan("1.")} npm install -g dotmask
  ${c.cyan("2.")} dotmask install          ${c.dim("# macOS will ask to trust the proxy cert")}
  ${c.cyan("3.")} Restart Claude Code — done
`);
}

async function main(): Promise<number> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "install":
      install(args);
      return 0;

    case "uninstall":
      uninstall(args);
      return 0;

    case "status":
      status();
      return 0;

    case "doctor":
      doctor();
      return 0;

    case "-v":
    case "--version":
      console.log(VERSION);
      return 0;

    case "-h":
    case "--help":
    case "help":
    case undefined:
      printHelp();
      return 0;

    default:
      console.error(`unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
