import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type Vault, type VaultIO, VAULTS, availableVaults } from "./vaults.ts";

const SECRET = "sk-super-secret-value";
const dir = mkdtempSync(join(tmpdir(), "claude-launcher-vaults-"));

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  command: string;
  stdin?: string;
}

function harness(answers: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const runs: Recorded[] = [];
  const io: VaultIO = {
    secret: SECRET,
    env,
    ask: () => answers.shift() ?? "",
    run: (command, stdin) => {
      runs.push({ command, ...(stdin !== undefined && { stdin }) });
    },
  };
  return { io, runs };
}

function vault(binary: string): Vault {
  const found = VAULTS.find((entry) => entry.binary === binary);
  assert.ok(found !== undefined, `expected a ${binary} vault`);
  return found;
}

describe("pass", () => {
  it("stores under a default item and reads it back", () => {
    const { io, runs } = harness();
    const key = vault("pass").store("deepseek", io);

    assert.deepEqual(runs, [{ command: "pass insert -m -f deepseek/api-key", stdin: SECRET }]);
    assert.deepEqual(key, { command: "pass show deepseek/api-key" });
  });

  it("honours a different item", () => {
    const { io, runs } = harness(["work/deepseek"]);
    const key = vault("pass").store("deepseek", io);

    assert.equal(runs[0]?.command, "pass insert -m -f work/deepseek");
    assert.deepEqual(key, { command: "pass show work/deepseek" });
  });

  it("quotes an item that needs it", () => {
    const { io, runs } = harness(["my keys/deepseek"]);
    const key = vault("pass").store("deepseek", io);

    assert.equal(runs[0]?.command, "pass insert -m -f 'my keys/deepseek'");
    assert.deepEqual(key, { command: "pass show 'my keys/deepseek'" });
  });
});

describe("1Password", () => {
  it("creates an API Credential item and reads it by op:// path", () => {
    const { io, runs } = harness();
    const key = vault("op").store("deepseek", io);

    assert.equal(
      runs[0]?.command,
      'read -r k; op item create --category="API Credential" --title=deepseek --vault=Private credential="$k"',
    );
    assert.deepEqual(key, { command: "op read op://Private/deepseek/credential" });
  });

  it("takes a vault and item name", () => {
    const { io, runs } = harness(["Work", "DeepSeek key"]);
    const key = vault("op").store("deepseek", io);

    assert.equal(
      runs[0]?.command,
      "read -r k; op item create --category=\"API Credential\" --title='DeepSeek key' --vault=Work credential=\"$k\"",
    );
    assert.deepEqual(key, { command: "op read 'op://Work/DeepSeek key/credential'" });
  });
});

describe("macOS keychain", () => {
  it("adds a generic password and reads it back with -w", () => {
    const { io, runs } = harness([], { USER: "dmon" });
    const key = vault("security").store("deepseek", io);

    assert.equal(
      runs[0]?.command,
      'read -r k; security add-generic-password -a dmon -s claude-launcher/deepseek -w "$k" -U',
    );
    assert.deepEqual(key, { command: "security find-generic-password -a dmon -s claude-launcher/deepseek -w" });
  });

  it("takes an account and service", () => {
    const { io, runs } = harness(["daniel", "mimo/key"]);
    const key = vault("security").store("mimo", io);

    assert.equal(
      runs[0]?.command,
      'read -r k; security add-generic-password -a daniel -s mimo/key -w "$k" -U',
    );
    assert.deepEqual(key, { command: "security find-generic-password -a daniel -s mimo/key -w" });
  });
});

describe("secret-tool", () => {
  it("stores against provider attributes and looks them up again", () => {
    const { io, runs } = harness();
    const key = vault("secret-tool").store("mimo-payg", io);

    assert.deepEqual(runs, [
      { command: "secret-tool store --label='claude-launcher mimo-payg' service mimo-payg key api-key", stdin: SECRET },
    ]);
    assert.deepEqual(key, { command: "secret-tool lookup service mimo-payg key api-key" });
  });
});

describe("every vault", () => {
  it("delivers the secret on stdin, never in the command text", () => {
    for (const entry of VAULTS) {
      const { io, runs } = harness();
      entry.store("deepseek", io);

      assert.equal(runs.length, 1, `${entry.binary} should run exactly one command`);
      assert.equal(runs[0]?.stdin, SECRET, `${entry.binary} should pass the secret on stdin`);
      assert.ok(
        !runs[0]!.command.includes(SECRET),
        `${entry.binary} put the secret in the command text, where argv is world readable`,
      );
    }
  });

  it("returns a read command and never a literal secret", () => {
    for (const entry of VAULTS) {
      const { io } = harness();
      const key = entry.store("deepseek", io);

      assert.equal(key.value, undefined, `${entry.binary} should not ask for the secret to be written in the clear`);
      assert.ok(key.command !== undefined && key.command !== "");
      assert.ok(!key.command!.includes(SECRET));
    }
  });
});

describe("availableVaults", () => {
  it("offers only what is installed", () => {
    const bin = join(dir, "bin");
    writeFileSync(join(dir, "op"), "", { mode: 0o755 });

    assert.deepEqual(
      availableVaults({ PATH: `${dir}:${bin}` }).map((entry) => entry.binary),
      ["op"],
    );
  });

  it("ignores a file that is present but not executable", () => {
    const notExecutable = join(dir, "security");
    writeFileSync(notExecutable, "", { mode: 0o644 });
    chmodSync(notExecutable, 0o644);

    assert.deepEqual(availableVaults({ PATH: dir }).map((entry) => entry.binary), ["op"]);
  });

  it("offers nothing when the path is empty", () => {
    assert.deepEqual(availableVaults({}), []);
  });
});
