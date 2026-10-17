// agent-reflex (MiMo Code) — post-edit syntax and bug-check helpers.
//
// Ported from the shell ports' scripts/check.sh. Provides findSyntaxErrors()
// (language parsers) and excerptAroundEdit() (context window around an edit),
// used by the tool_result handler after a file edit.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";

const CONTEXT_LINES = Number(process.env.AGENT_REFLEX_CONTEXT_LINES ?? "40");
const MAX_CHARS = Number(process.env.AGENT_REFLEX_MAX_CHARS ?? "8000");

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Command-line syntax checkers: (binary, args) with the file path appended.
const COMMAND_PARSERS: Record<string, [string, string[]]> = {
  ".sh": ["bash", ["-n"]],
  ".bash": ["bash", ["-n"]],
  ".zsh": ["zsh", ["-n"]],
  ".py": ["python3", ["-m", "py_compile"]],
  ".rb": ["ruby", ["-c"]],
  ".php": ["php", ["-l"]],
  ".pl": ["perl", ["-c"]],
  ".lua": ["luac", ["-p"]],
  ".go": ["gofmt", ["-e"]],
};

function runParser(command: string, args: string[], filePath: string): string[] | null {
  try {
    execFileSync(command, [...args, filePath], { stdio: ["ignore", "pipe", "pipe"] });
    return [];
  } catch (error: any) {
    if (error?.code === "ENOENT") return null; // parser not installed
    const output: string = String(error?.stderr ?? error?.stdout ?? error?.message ?? "");
    return output.trim().split("\n").slice(-5);
  }
}

// Returns syntax errors, [] when the file parses, or null when no parser covers it.
export function findSyntaxErrors(filePath: string): string[] | null {
  const ext = extname(filePath).toLowerCase();

  if (TS_EXTENSIONS.has(ext)) {
    // Prefer TypeScript's transpileModule when available; else node --check.
    // createRequire keeps the optional CJS dependency ("typescript") working in
    // ESM bundles too, where a bare require() is unavailable.
    let ts: any;
    try {
      const req = createRequire(import.meta.url);
      ts = req("typescript");
    } catch {
      try {
        execFileSync("node", ["--check", filePath], { stdio: ["ignore", "pipe", "pipe"] });
        return [];
      } catch (error: any) {
        const output: string = String(error?.stderr ?? error?.message ?? "");
        return output.trim().split("\n").slice(-5);
      }
    }
    try {
      const code = readFileSync(filePath, "utf8");
      const result = ts.transpileModule(code, { fileName: filePath, reportDiagnostics: true });
      const diagnostics: any[] = result.diagnostics ?? [];
      return diagnostics.map((d: any) => {
        const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
        if (d.file && d.start !== undefined) {
          const { line } = d.file.getLineAndCharacterOfPosition(d.start);
          return `line ${line + 1}: ${message}`;
        }
        return message;
      });
    } catch {
      return null;
    }
  }

  if (ext === ".json") {
    try {
      JSON.parse(readFileSync(filePath, "utf8"));
      return [];
    } catch (error: any) {
      return [String(error?.message ?? error)];
    }
  }

  const parser = COMMAND_PARSERS[ext];
  if (!parser) return null;
  const [command, args] = parser;
  return runParser(command, args, filePath);
}

// Lines around the edited text, or the file start when the edit cannot be located.
export function excerptAroundEdit(content: string, edited: string | undefined): string {
  const fallback = content.slice(0, MAX_CHARS);
  if (!edited) return fallback;

  const index = content.indexOf(edited);
  if (index === -1) return fallback;

  const lines = content.split("\n");
  const first = content.slice(0, index).split("\n").length - 1;
  const last = first + edited.split("\n").length - 1;
  const from = Math.max(0, first - CONTEXT_LINES);
  const to = Math.min(lines.length, last + CONTEXT_LINES + 1);

  return lines.slice(from, to).join("\n").slice(0, MAX_CHARS);
}

export { CONTEXT_LINES, MAX_CHARS };

// Reads a file's text, returning "" when unreadable.
export function readFileText(filePath: string): string {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  } catch {
    return "";
  }
}
