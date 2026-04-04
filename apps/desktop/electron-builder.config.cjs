const path = require("path");

const signingIdentity = process.env.ORCHESTRUM_MAC_IDENTITY || undefined;
const signingEnabled = Boolean(
  signingIdentity
  || process.env.CSC_LINK
  || process.env.ORCHESTRUM_DESKTOP_ENABLE_SIGNING === "1"
);

module.exports = {
  appId: "local.orchestrum.desktop",
  productName: "Orchestrum",
  artifactName: "orchestrum-${version}-${os}-${arch}.${ext}",
  directories: {
    output: "dist"
  },
  files: [
    "main.js",
    "preload.js"
  ],
  extraResources: [
    {
      from: "build/runtime-bundle/ui",
      to: "bundle/ui",
      filter: [
        "**/*"
      ]
    },
    {
      from: "../../packages/service",
      to: "bundle/service",
      filter: [
        "dist/**/*",
        "package.json",
        "node_modules/**/*"
      ]
    },
    {
      from: "../../packages/core",
      to: "bundle/core",
      filter: [
        "dist/**/*",
        "src/**/*",
        "prompts/**/*",
        "package.json",
        "node_modules/**/*"
      ]
    },
    {
      from: "../..",
      to: "bundle",
      filter: [
        "version.json",
        "CHANGELOG.md",
        "LICENSE",
        "EULA.md"
      ]
    }
  ],
  asar: true,
  mac: {
    target: [
      "dmg",
      "zip"
    ],
    identity: signingEnabled ? signingIdentity : null,
    hardenedRuntime: signingEnabled,
    gatekeeperAssess: signingEnabled,
    entitlements: path.join(__dirname, "entitlements.mac.plist"),
    entitlementsInherit: path.join(__dirname, "entitlements.mac.plist")
  },
  linux: {
    target: [
      "AppImage",
      "tar.gz"
    ]
  },
  win: {
    target: [
      "nsis",
      "zip"
    ]
  }
};
