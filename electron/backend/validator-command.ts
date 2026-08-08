export const VALIDATOR_RUNTIME_ENV = "PR_ATLAS_VALIDATOR_RUNTIME";

/** Builds the shell command used by read-only providers to run Atlas's bundled Node runtime. */
export function buildBundledValidatorCommand(
  validatorFile: string,
  platform: NodeJS.Platform = process.platform,
  launcherFile?: string,
): string {
  if (platform === "win32")
    return `cmd.exe /d /s /c ${launcherFile ?? validatorFile.replace(/\.mjs$/, ".cmd")}`;
  return `ELECTRON_RUN_AS_NODE=1 "$${VALIDATOR_RUNTIME_ENV}" ${quotePosix(validatorFile)}`;
}

export function validatorLauncherName(kind: "map" | "reduce"): string {
  return kind === "map" ? "run-map-validator.cmd" : "run-reduce-validator.cmd";
}

/** The fixed launcher is invoked through cmd.exe, so Git Bash and PowerShell inherit its stdin. */
export function buildWindowsValidatorLauncher(validatorFile: string): string {
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"%${VALIDATOR_RUNTIME_ENV}%" ${quoteWindows(validatorFile)}`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteWindows(value: string): string { return `"${value.replace(/\^/g, "^^").replace(/%/g, "%%").replace(/[&|<>()]/g, (character) => `^${character}`).replace(/"/g, '""')}"`; }
