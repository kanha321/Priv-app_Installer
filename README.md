# PRIV_GEN — Priv-App Module Generator

A web-based tool to generate Magisk/KernelSU modules that install Android apps as privileged system apps with whitelisted permissions. Drop an APK, auto-detect permissions, and flash directly to your rooted device via ADB.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)
![Root](https://img.shields.io/badge/Root-Magisk%20%7C%20KernelSU-FF6F00)

---

## Features

- **Drag & Drop APK** — Extracts package name, app name, version, SDK levels, and permissions via `aapt2`
- **Auto Root Detection** — Detects Magisk or KernelSU on the connected device and sets the correct install mode
- **Dynamic Privileged Permissions** — Fetches the device's supported privileged permissions and cross-references them with the APK's manifest
- **Fuzzy Permission Search** — Quickly find and add permissions with intelligent fuzzy matching
- **Smart App Handling** — Detects if the app is already installed as a user app and prompts to uninstall (to ensure priv-app priority), complete with a data deletion warning
- **Metamodule Auto-Install** — Detects if a KernelSU system requires a mount metamodule and offers a one-click `meta-overlayfs` installation
- **One-Click Flash** — Builds the module ZIP, pushes it to the device, installs via the root manager, and prompts to reboot
- **Build ZIP Only** — Download the module as a `.zip` for manual installation
- **ADB Device Management** — Real-time device detection, selection, and terminal-style status monitoring

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| **Node.js** | v18+ | Runtime |
| **ADB** | ✓ | Must be in system PATH |
| **aapt2** | Bundled | Shipped in `tools/` |
| **Rooted Device** | ✓ | Magisk or KernelSU |
| **Metamodule** *(KernelSU only)* | ✓ | `magic_mount` or `meta-overlayfs` for system overlay support |

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. **Connect** your rooted Android device via USB (USB debugging enabled)
2. **Select** the device from the sidebar — root manager is auto-detected
3. **Resolve Warnings** — If KernelSU is detected without a metamodule, use the 1-click install prompt
4. **Drop** an APK file — metadata and privileged permissions are auto-extracted
5. **Review** module properties and permissions
6. **Flash** directly to the device (the tool will warn you if the app requires uninstalling first)
7. **Reboot** when prompted to activate the module

## Module Structure

The generated module follows the standard Magisk/KernelSU module format:

```
ModuleName/
├── module.prop                                    # Module metadata
├── customize.sh                                   # Installation script (sets permissions)
└── system/
    ├── priv-app/
    │   └── <package>/
    │       └── <AppName>.apk                      # The APK as a privileged app
    └── etc/
        └── permissions/
            └── privapp-permissions-<package>.xml   # Permission whitelist
```

## Tech Stack

- **Backend** — Node.js, Express, Multer, Archiver
- **Frontend** — Single-page HTML/CSS/JS (dark terminal theme)
- **Device Tools** — ADB, aapt2
- **Theming** — CSS custom properties for easy theme customization

## Important Notes

- **KernelSU users**: You must have a metamodule (`magic_mount` or `meta-overlayfs`) installed for system file overlays to work. Without it, modules will install but `mount` will remain `false`.
- **ADB**: Must be available in your system PATH.
- **aapt2**: Bundled in `tools/` — place `aapt2.exe` (Windows) or `aapt2` (Linux) in the `tools/` folder.
- The tool auto-uninstalls any existing user-installed copy of the app before flashing, so the privileged version takes priority.

## License

MIT
