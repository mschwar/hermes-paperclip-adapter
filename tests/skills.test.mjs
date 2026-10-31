import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  expandTildePath,
  listHermesSkills,
  parseExternalSkillDirsFromConfig,
} from "../dist/server/skills.js";

test("parseExternalSkillDirsFromConfig supports inline and block YAML lists", () => {
  const inline = [
    "model:",
    "  default: gpt-5",
    "skills:",
    "  external_dirs: [~/.hermes/shared-skills/skills, '/opt/fleet/skills'] # comment",
  ].join("\n");
  assert.deepEqual(parseExternalSkillDirsFromConfig(inline), [
    "~/.hermes/shared-skills/skills",
    "/opt/fleet/skills",
  ]);

  const block = [
    "skills:",
    "  external_dirs:",
    "    - ~/.hermes/shared-skills/skills # shared corpus",
    '    - "~/extra-skills"',
    "  create_dir: ~/.hermes/shared-skills/skills",
    "plugins:",
    "  enabled:",
    "    - hermes-fleet-substrate",
  ].join("\n");
  assert.deepEqual(parseExternalSkillDirsFromConfig(block), [
    "~/.hermes/shared-skills/skills",
    "~/extra-skills",
  ]);
});

test("expandTildePath expands ~ against configured home", () => {
  assert.equal(expandTildePath("~", "/tmp/fakehome"), "/tmp/fakehome");
  assert.equal(
    expandTildePath("~/.hermes/shared-skills/skills", "/tmp/fakehome"),
    path.join("/tmp/fakehome", ".hermes/shared-skills/skills"),
  );
  assert.equal(expandTildePath("/abs/skills", "/tmp/fakehome"), "/abs/skills");
});

test("listHermesSkills expands ~ on skills.external_dirs and discovers categorized skills", async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-skills-test-"));
  try {
    const hermesDir = path.join(tmpHome, ".hermes");
    const localSkillDir = path.join(hermesDir, "skills", "local-cat", "local-only");
    const sharedSkillDir = path.join(
      hermesDir,
      "shared-skills",
      "skills",
      "homelab",
      "homelab-work-spec-landing",
    );
    await fs.mkdir(localSkillDir, { recursive: true });
    await fs.mkdir(sharedSkillDir, { recursive: true });

    await fs.writeFile(
      path.join(localSkillDir, "SKILL.md"),
      "---\nname: local-only\ndescription: Local skill\n---\n# Local\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(sharedSkillDir, "SKILL.md"),
      "---\nname: homelab-work-spec-landing\ndescription: Fleet skill\n---\n# Landing\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      "skills:\n  external_dirs: [~/.hermes/shared-skills/skills]\n",
      "utf8",
    );

    const snapshot = await listHermesSkills({
      config: { env: { HOME: tmpHome } },
    });

    const byKey = new Map(snapshot.entries.map((e) => [e.key, e]));
    assert.ok(byKey.has("local-only"));
    assert.ok(byKey.has("homelab-work-spec-landing"));
    assert.equal(
      byKey.get("homelab-work-spec-landing").locationLabel,
      "~/.hermes/shared-skills/skills/homelab/homelab-work-spec-landing",
    );
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
