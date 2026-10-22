import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Suppress command arguments and output here: some contain signing passwords.
function prepare(command, args, operation, env = process.env) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not ${operation}.`);
  }
  return result.stdout;
}

function localSigningIdentity() {
  const directory = join(
    homedir(),
    "Library",
    "Application Support",
    "SpotiFlex",
    "build-signing",
  );
  const metadata = join(directory, "identity.json");
  const keychain = join(
    homedir(),
    "Library",
    "Keychains",
    "SpotiFlex-local-build.keychain-db",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  let identity;

  if (existsSync(metadata)) {
    chmodSync(metadata, 0o600);
    identity = JSON.parse(readFileSync(metadata, "utf8"));
    if (!existsSync(keychain)) {
      throw new Error(
        "Local signing keychain is missing. Restore it to preserve Keychain trust.",
      );
    }
  } else {
    if (existsSync(keychain)) {
      throw new Error(
        "Local signing metadata is missing. Restore it to preserve the existing identity.",
      );
    }
    const temporary = mkdtempSync(join(tmpdir(), "spotiflex-signing-"));
    chmodSync(temporary, 0o700);
    const password = randomBytes(32).toString("hex");
    const env = { ...process.env, SPOTIFLEX_CERT_PASSWORD: password };
    const config = join(temporary, "certificate.cnf");
    const certificate = join(temporary, "certificate.pem");
    const privateKey = join(temporary, "private-key.pem");
    const archive = join(temporary, "certificate.p12");
    let created = false;
    try {
      writeFileSync(
        config,
        `[req]
prompt = no
distinguished_name = subject
x509_extensions = code_signing
[subject]
CN = SpotiFlex Local Build
[code_signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`,
        { mode: 0o600 },
      );
      prepare(
        "/usr/bin/openssl",
        [
          "req",
          "-new",
          "-x509",
          "-newkey",
          "rsa:3072",
          "-sha256",
          "-nodes",
          "-days",
          "3650",
          "-config",
          config,
          "-keyout",
          privateKey,
          "-out",
          certificate,
        ],
        "create the local signing certificate",
      );
      prepare(
        "/usr/bin/openssl",
        [
          "pkcs12",
          "-export",
          "-inkey",
          privateKey,
          "-in",
          certificate,
          "-out",
          archive,
          "-passout",
          "env:SPOTIFLEX_CERT_PASSWORD",
        ],
        "prepare the local signing certificate",
        env,
      );
      const fingerprint = prepare(
        "/usr/bin/openssl",
        ["x509", "-in", certificate, "-noout", "-fingerprint", "-sha1"],
        "read the local signing identity",
      )
        .split("=")[1]
        ?.replaceAll(":", "")
        .trim();
      if (!fingerprint || !/^[A-Fa-f0-9]{40}$/.test(fingerprint)) {
        throw new Error(
          "Local signing certificate has an invalid fingerprint.",
        );
      }
      prepare(
        "/usr/bin/security",
        ["create-keychain", "-p", password, keychain],
        "create the local signing keychain",
      );
      created = true;
      prepare(
        "/usr/bin/security",
        ["unlock-keychain", "-p", password, keychain],
        "unlock the local signing keychain",
      );
      prepare(
        "/usr/bin/security",
        [
          "import",
          archive,
          "-k",
          keychain,
          "-P",
          password,
          "-T",
          "/usr/bin/codesign",
        ],
        "import the local signing certificate",
      );
      prepare(
        "/usr/bin/security",
        [
          "set-key-partition-list",
          "-S",
          "apple-tool:,apple:,codesign:",
          "-s",
          "-k",
          password,
          keychain,
        ],
        "authorize the local code signer",
      );
      identity = { fingerprint, password };
      writeFileSync(metadata, JSON.stringify(identity), {
        mode: 0o600,
        flag: "wx",
      });
      console.log(
        "Created a persistent local signing identity. Future builds reuse it.",
      );
    } catch (error) {
      if (created && !existsSync(metadata)) {
        spawnSync("/usr/bin/security", ["delete-keychain", keychain], {
          stdio: "ignore",
        });
      }
      throw error;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  if (
    !/^[A-Fa-f0-9]{40}$/.test(identity.fingerprint) ||
    typeof identity.password !== "string"
  ) {
    throw new Error("Local signing metadata is invalid.");
  }
  prepare(
    "/usr/bin/security",
    ["unlock-keychain", "-p", identity.password, keychain],
    "unlock the local signing keychain",
  );
  prepare(
    "/usr/bin/security",
    ["set-keychain-settings", "-lut", "3600", keychain],
    "configure the local signing keychain",
  );
  const keychains = prepare(
    "/usr/bin/security",
    ["list-keychains", "-d", "user"],
    "read the keychain search list",
  )
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (!keychains.includes(keychain)) {
    prepare(
      "/usr/bin/security",
      ["list-keychains", "-d", "user", "-s", ...keychains, keychain],
      "register the local signing keychain",
    );
  }
  return identity.fingerprint;
}

try {
  const env = { ...process.env };
  if (
    process.platform === "darwin" &&
    !env.CI &&
    !env.APPLE_SIGNING_IDENTITY &&
    !env.APPLE_CERTIFICATE &&
    env.SPOTIFLEX_ADHOC_SIGNING !== "1"
  ) {
    env.APPLE_SIGNING_IDENTITY = localSigningIdentity();
  }
  const cli = fileURLToPath(
    new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [cli, "build", ...process.argv.slice(2)],
    { stdio: "inherit", env },
  );
  child.on("error", () => {
    console.error("Could not start the desktop build. Run npm ci first.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Could not prepare the desktop build.",
  );
  process.exitCode = 1;
}
