import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveHermesHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

export function expandTildePath(rawPath: string, home: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(home, trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(home, trimmed);
}

function stripYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.indexOf('"', 1) > 0) ||
    (trimmed.startsWith("'") && trimmed.indexOf("'", 1) > 0)
  ) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    return trimmed.slice(1, end).trim();
  }
  const commentIdx = trimmed.indexOf(" #");
  return (commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed).trim();
}

export function parseExternalSkillDirsFromConfig(content: string): string[] {
  const dirs: string[] = [];
  let inSkillsSection = false;
  let inExternalDirsList = false;
  let externalDirsIndent = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      inSkillsSection = /^skills:\s*(?:#.*)?$/.test(trimmed);
      inExternalDirsList = false;
      continue;
    }
    if (!inSkillsSection) continue;

    if (inExternalDirsList) {
      const isSeqItem = trimmed === "-" || trimmed.startsWith("- ");
      if (indent >= externalDirsIndent && isSeqItem) {
        const item = stripYamlScalar(trimmed.slice(1));
        if (item) dirs.push(item);
        continue;
      }
      if (indent <= externalDirsIndent) {
        inExternalDirsList = false;
      }
    }

    const kvMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const rest = kvMatch[2].trim();
    if (key !== "external_dirs") continue;

    if (!rest || rest.startsWith("#")) {
      inExternalDirsList = true;
      externalDirsIndent = indent;
      continue;
    }

    const withoutComment =
      rest.startsWith("[") && rest.includes("]")
        ? rest.slice(0, rest.lastIndexOf("]") + 1)
        : stripYamlScalar(rest);
    if (withoutComment.startsWith("[") && withoutComment.endsWith("]")) {
      const inner = withoutComment.slice(1, -1);
      for (const part of inner.split(",")) {
        const item = stripYamlScalar(part);
        if (item) dirs.push(item);
      }
    } else if (withoutComment) {
      dirs.push(withoutComment);
    }
  }

  return dirs;
}

function formatLocationPrefix(dir: string, home: string): string {
  const rel = path.relative(home, dir);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join("/")}`;
  }
  return dir;
}

async function resolveHermesSkillRoots(
  config: Record<string, unknown>,
  home: string,
): Promise<Array<{ dir: string; locationPrefix: string }>> {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHermesHome = asString(env.HERMES_HOME);
  const hermesDir = configuredHermesHome
    ? expandTildePath(configuredHermesHome, home)
    : path.join(home, ".hermes");

  const rawDirs: string[] = [path.join(hermesDir, "skills")];

  // 1. Read skills.external_dirs from <hermesDir>/config.yaml if present
  try {
    const yamlText = await fs.readFile(path.join(hermesDir, "config.yaml"), "utf8");
    rawDirs.push(...parseExternalSkillDirsFromConfig(yamlText));
  } catch {
    // config.yaml missing or unreadable — fall back to defaults
  }

  // 2. Also honor config.skills.external_dirs if provided in adapterConfig
  if (typeof config.skills === "object" && config.skills !== null && !Array.isArray(config.skills)) {
    const ext = (config.skills as Record<string, unknown>).external_dirs;
    if (typeof ext === "string" && ext.trim()) {
      rawDirs.push(ext.trim());
    } else if (Array.isArray(ext)) {
      for (const item of ext) {
        if (typeof item === "string" && item.trim()) {
          rawDirs.push(item.trim());
        }
      }
    }
  }

  const seen = new Set<string>();
  const roots: Array<{ dir: string; locationPrefix: string }> = [];
  for (const raw of rawDirs) {
    const resolved = expandTildePath(raw, home);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push({
      dir: resolved,
      locationPrefix: formatLocationPrefix(resolved, home),
    });
  }
  return roots;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(
  skillsHome: string,
  locationPrefix = "~/.hermes/skills",
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name, locationPrefix));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(
            await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`, locationPrefix),
          );
        }
      }
    }
  } catch {
    // Skill directory doesn't exist — skip
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
  locationPrefix = "~/.hermes/skills",
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `${locationPrefix}/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const home = resolveHermesHome(config);
  const skillRoots = await resolveHermesSkillRoots(config, home);

  // 1. Scan Paperclip-managed skills (bundled with the adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/ and expanded skills.external_dirs
  const hermesByKey = new Map<string, AdapterSkillEntry>();
  for (const root of skillRoots) {
    const scanned = await scanHermesSkills(root.dir, root.locationPrefix);
    for (const entry of scanned) {
      if (!hermesByKey.has(entry.key)) {
        hermesByKey.set(entry.key, entry);
      }
    }
  }
  const hermesSkillEntries = Array.from(hermesByKey.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Paperclip skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: entry.required ? "paperclip_required" : "company_managed",
      originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
      required: Boolean(entry.required),
      requiredReason: entry.requiredReason ?? null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Paperclip already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail:
        "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Hermes manages its own skill loading — sync is a no-op.
  // Return the current snapshot so the UI stays in sync.
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
): string[] {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
