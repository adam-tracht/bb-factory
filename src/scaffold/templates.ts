import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const manifestSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            template: z.string().trim().min(1),
            target: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export interface ProtocolTemplate {
  /** Repository-relative path the scaffold action writes inside the checkout. */
  readonly target: string;
  readonly content: string;
  readonly sha256: string;
}

/**
 * The bundled `templates/` directory sits at the package root. From source it
 * is `../../templates` relative to this module; from the bundled
 * `dist/server.js` it is `../templates`. Probe the candidate roots instead of
 * hardcoding either layout.
 */
function templatesRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "templates"),
    join(here, "..", "templates"),
    join(here, "..", "..", "templates"),
    join(here, "..", "..", "..", "templates"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "MANIFEST.json"))) return candidate;
  }
  throw new Error("could not locate the bundled factory protocol templates directory");
}

let cached: readonly ProtocolTemplate[] | null = null;

/**
 * Loads the manifest and every template it names, verifying each file's
 * recorded digest so a baseline template change must update MANIFEST.json
 * deliberately rather than drifting silently.
 */
export function loadProtocolTemplates(): readonly ProtocolTemplate[] {
  if (cached !== null) return cached;
  const root = templatesRoot();
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8")));
  const templates = manifest.files.map((entry) => {
    const content = readFileSync(join(root, entry.template), "utf8");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    if (sha256 !== entry.sha256) {
      throw new Error(`Template '${entry.template}' does not match its recorded digest in MANIFEST.json.`);
    }
    return { target: entry.target, content, sha256 };
  });
  cached = templates;
  return templates;
}
