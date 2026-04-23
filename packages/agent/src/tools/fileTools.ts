import { readFile, writeFile, open, mkdir, rename } from "node:fs/promises";
import { resolve, normalize, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const MAX_LINES = 2000;
const MAX_BYTES = 1_000_000;

export interface FileOk<T extends Record<string, unknown> = Record<string, unknown>> {
  ok: true;
  tool: string;
  path: string;
  [key: string]: unknown;
}

export interface FileError {
  ok: false;
  tool: string;
  path: string;
  error: { code: string; message: string };
}

export type FileResult = FileOk | FileError;

function getRoot(): string | null {
  return process.env.FILE_TOOLS_ROOT ?? null;
}

export function resolveSafePath(userPath: string): { resolved: string } | { error: FileError["error"] } {
  const root = getRoot();
  if (!root) {
    return { error: { code: "DISABLED", message: "FILE_TOOLS_ROOT no está configurado. Establece la variable de entorno para habilitar las herramientas de archivos." } };
  }

  const normalizedRoot = normalize(resolve(root));

  if (userPath.startsWith("/")) {
    return { error: { code: "ABSOLUTE_PATH", message: "Las rutas absolutas no están permitidas. Usa una ruta relativa dentro del workspace." } };
  }

  const resolved = normalize(join(normalizedRoot, userPath));

  if (!resolved.startsWith(normalizedRoot + "/") && resolved !== normalizedRoot) {
    return { error: { code: "PATH_TRAVERSAL", message: "La ruta está fuera del workspace raíz permitido." } };
  }

  return { resolved };
}

export async function executeReadFile(args: {
  path: string;
  offset?: number;
  limit?: number;
}): Promise<FileResult> {
  const tool = "read_file";
  const safe = resolveSafePath(args.path);

  if ("error" in safe) {
    return { ok: false, tool, path: args.path, error: safe.error };
  }

  const { resolved } = safe;

  let raw: Buffer;
  try {
    raw = await readFile(resolved);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, tool, path: resolved, error: { code: "NOT_FOUND", message: `Archivo no encontrado: ${args.path}` } };
    if (e.code === "EISDIR") return { ok: false, tool, path: resolved, error: { code: "IS_DIRECTORY", message: "La ruta apunta a un directorio, no a un archivo." } };
    return { ok: false, tool, path: resolved, error: { code: "READ_ERROR", message: String(err) } };
  }

  if (raw.byteLength > MAX_BYTES) {
    return { ok: false, tool, path: resolved, error: { code: "FILE_TOO_LARGE", message: `El archivo supera el límite de ${MAX_BYTES} bytes.` } };
  }

  const lines = raw.toString("utf8").split("\n");
  const totalLines = lines.length;

  const startLine = args.offset ?? 1;
  if (startLine < 1) {
    return { ok: false, tool, path: resolved, error: { code: "INVALID_OFFSET", message: "offset debe ser >= 1 (1-based)." } };
  }

  const maxLines = args.limit ?? MAX_LINES;
  const sliced = lines.slice(startLine - 1, startLine - 1 + maxLines);
  const endLine = Math.min(startLine - 1 + sliced.length, totalLines);

  return {
    ok: true,
    tool,
    path: resolved,
    content: sliced.join("\n"),
    startLine,
    endLine,
    totalLines,
  };
}

export async function executeWriteFile(args: {
  path: string;
  content: string;
}): Promise<FileResult> {
  const tool = "write_file";
  const safe = resolveSafePath(args.path);

  if ("error" in safe) {
    return { ok: false, tool, path: args.path, error: safe.error };
  }

  const { resolved } = safe;

  // Fail if file already exists
  try {
    const fh = await open(resolved, "wx");
    await fh.close();
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return { ok: false, tool, path: resolved, error: { code: "FILE_EXISTS", message: "El archivo ya existe. Usa `edit_file` para modificarlo." } };
    }
    if (e.code === "ENOENT") {
      // Parent dir missing — create it
      try {
        await mkdir(dirname(resolved), { recursive: true });
        const fh2 = await open(resolved, "wx");
        await fh2.close();
      } catch (mkErr) {
        return { ok: false, tool, path: resolved, error: { code: "MKDIR_ERROR", message: String(mkErr) } };
      }
    } else {
      return { ok: false, tool, path: resolved, error: { code: "OPEN_ERROR", message: String(err) } };
    }
  }

  const bytes = Buffer.from(args.content, "utf8");
  try {
    await writeFile(resolved, bytes);
  } catch (err) {
    return { ok: false, tool, path: resolved, error: { code: "WRITE_ERROR", message: String(err) } };
  }

  return { ok: true, tool, path: resolved, bytesWritten: bytes.byteLength };
}

export async function executeEditFile(args: {
  path: string;
  old_string: string;
  new_string: string;
}): Promise<FileResult> {
  const tool = "edit_file";
  const safe = resolveSafePath(args.path);

  if ("error" in safe) {
    return { ok: false, tool, path: args.path, error: safe.error };
  }

  const { resolved } = safe;

  let content: string;
  try {
    content = await readFile(resolved, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, tool, path: resolved, error: { code: "NOT_FOUND", message: `Archivo no encontrado: ${args.path}` } };
    if (e.code === "EISDIR") return { ok: false, tool, path: resolved, error: { code: "IS_DIRECTORY", message: "La ruta apunta a un directorio." } };
    return { ok: false, tool, path: resolved, error: { code: "READ_ERROR", message: String(err) } };
  }

  // Count occurrences
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(args.old_string, idx)) !== -1) {
    count++;
    idx += args.old_string.length;
  }

  if (count === 0) {
    return { ok: false, tool, path: resolved, error: { code: "NO_MATCH", message: "old_string no se encontró en el archivo. Revisa el texto exacto incluyendo espacios y saltos de línea." } };
  }
  if (count > 1) {
    return { ok: false, tool, path: resolved, error: { code: "AMBIGUOUS_MATCH", message: `old_string se encontró ${count} veces. Proporciona más contexto para que sea único.` } };
  }

  const updated = content.replace(args.old_string, args.new_string);

  // Atomic write: write to temp file then rename
  const tmp = join(tmpdir(), `file-edit-${randomBytes(8).toString("hex")}`);
  try {
    await writeFile(tmp, updated, "utf8");
    await rename(tmp, resolved);
  } catch (err) {
    return { ok: false, tool, path: resolved, error: { code: "WRITE_ERROR", message: String(err) } };
  }

  return { ok: true, tool, path: resolved, replacements: 1 };
}
