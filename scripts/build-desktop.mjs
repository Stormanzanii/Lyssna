import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const support = join(homedir(), "Library", "Application Support");
  const directory = join(support, "Lyssna", "build-signing");
  const metadata = join(directory, "identity.json");
  const keychains = join(homedir(), "Library", "Keychains");
  const keychain = join(keychains, "Lyssna-local-build.keychain-db");
  // Builds from before the rename keep their identity, so Keychain trust survives.
  const legacyDirectory = join(support, "SpotiFlex", "build-signing");
  const legacyMetadata = join(legacyDirectory, "identity.json");
  const legacyKeychain = join(keychains, "SpotiFlex-local-build.keychain-db");
  if (!existsSync(metadata) && existsSync(legacyMetadata)) {
    if (existsSync(directory)) {
      renameSync(legacyMetadata, metadata);
    } else {
      mkdirSync(join(support, "Lyssna"), { recursive: true, mode: 0o700 });
      renameSync(legacyDirectory, directory);
    }
  }
  if (!existsSync(keychain) && existsSync(legacyKeychain)) {
    renameSync(legacyKeychain, keychain);
  }
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
    const temporary = mkdtempSync(join(tmpdir(), "lyssna-signing-"));
    chmodSync(temporary, 0o700);
    const password = randomBytes(32).toString("hex");
    const env = { ...process.env, LYSSNA_CERT_PASSWORD: password };
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
CN = Lyssna Local Build
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
          "env:LYSSNA_CERT_PASSWORD",
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
  const searchList = prepare(
    "/usr/bin/security",
    ["list-keychains", "-d", "user"],
    "read the keychain search list",
  )
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (searchList.includes(legacyKeychain) || !searchList.includes(keychain)) {
    const kept = searchList.filter(
      (path) => path !== legacyKeychain && path !== keychain,
    );
    prepare(
      "/usr/bin/security",
      ["list-keychains", "-d", "user", "-s", ...kept, keychain],
      "register the local signing keychain",
    );
  }
  return identity.fingerprint;
}

async function installMacApp(args) {
  const options = args.slice(
    0,
    args.includes("--") ? args.indexOf("--") : args.length,
  );
  if (options.includes("--no-bundle")) return;
  const targetIndex = options.findIndex(
    (arg) => arg === "--target" || arg === "-t",
  );
  const target =
    targetIndex >= 0
      ? options[targetIndex + 1]
      : options
          .find((arg) => arg.startsWith("--target="))
          ?.slice("--target=".length);
  const output = resolve(
    process.env.CARGO_TARGET_DIR || "target",
    target || "",
    options.includes("--debug") || options.includes("-d") ? "debug" : "release",
    "bundle",
  );
  const source = join(output, "macos", "Lyssna.app");
  const destination = "/Applications/Lyssna.app";
  // The app was called SpotiFlex before; Lyssna replaces that install.
  const legacyDestination = "/Applications/SpotiFlex.app";
  if (!existsSync(source))
    throw new Error("The build did not produce Lyssna.app.");

  // Stage and validate before interrupting playback or replacing the installed app.
  const staging = mkdtempSync("/Applications/.Lyssna-install-");
  const stagedApp = join(staging, "Lyssna.app");
  let preservePrevious = false;
  try {
    prepare(
      "/usr/bin/ditto",
      [source, stagedApp],
      "stage Lyssna in Applications",
    );
    prepare(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", stagedApp],
      "verify the new app signature",
    );
    const executables = new Set([
      ...[source, destination].map((app) =>
        join(app, "Contents", "MacOS", "lyssna"),
      ),
      join(legacyDestination, "Contents", "MacOS", "spotiflex"),
    ]);
    const running = () =>
      prepare(
        "/bin/ps",
        ["-axo", "pid=,comm="],
        "find running Lyssna instances",
      )
        .split("\n")
        .flatMap((line) => {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          return match && executables.has(match[2]) ? [Number(match[1])] : [];
        });
    const stop = (signal) => {
      for (const pid of running()) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    };
    stop("SIGTERM");
    const deadline = Date.now() + 5000;
    while (running().length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    stop("SIGKILL");

    const previous = join(staging, "previous.app");
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(stagedApp, destination);
    } catch (error) {
      if (existsSync(previous)) {
        try {
          renameSync(previous, destination);
        } catch {
          preservePrevious = true;
          throw new Error(
            `Could not restore the previous app. It remains at ${previous}.`,
          );
        }
      }
      throw error;
    }
    rmSync(legacyDestination, { recursive: true, force: true });
    // Keep only the installed bundle. Old disk images are generated artifacts.
    rmSync(source, { recursive: true, force: true });
    rmSync(join(output, "dmg"), { recursive: true, force: true });
    prepare("/usr/bin/open", [destination], "open Lyssna from Applications");
    console.log(
      "Installed and opened /Applications/Lyssna.app. Removed the build copy.",
    );
  } finally {
    if (!preservePrevious) rmSync(staging, { recursive: true, force: true });
  }
}

try {
  const env = { ...process.env };
  if (
    process.platform === "darwin" &&
    !env.CI &&
    !env.APPLE_SIGNING_IDENTITY &&
    !env.APPLE_CERTIFICATE &&
    (env.LYSSNA_ADHOC_SIGNING ?? env.SPOTIFLEX_ADHOC_SIGNING) !== "1"
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
  child.on("exit", async (code) => {
    process.exitCode = code ?? 1;
    if (code === 0 && process.platform === "darwin" && !env.CI) {
      try {
        await installMacApp(process.argv.slice(2));
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : "Could not install Lyssna.",
        );
        process.exitCode = 1;
      }
    }
  });
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Could not prepare the desktop build.",
  );
  process.exitCode = 1;
}
