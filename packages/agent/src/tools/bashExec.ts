import { execFile } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface BashResult {
  terminal: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeBash(terminal: string, prompt: string): Promise<BashResult> {
  if (process.env.BASH_TOOL_ENABLED !== "true") {
    return {
      terminal,
      stdout: "",
      stderr: "La herramienta bash está desactivada. Establece BASH_TOOL_ENABLED=true para habilitarla.",
      exitCode: 1,
    };
  }

  let cwd = process.cwd();
  const envCwd = process.env.BASH_TOOL_CWD;
  if (envCwd) {
    try {
      const info = await stat(envCwd);
      if (!info.isDirectory()) throw new Error("not a directory");
      cwd = envCwd;
    } catch {
      return {
        terminal,
        stdout: "",
        stderr: `BASH_TOOL_CWD "${envCwd}" no existe o no es un directorio.`,
        exitCode: 1,
      };
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", prompt], {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { terminal, stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      terminal,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}
