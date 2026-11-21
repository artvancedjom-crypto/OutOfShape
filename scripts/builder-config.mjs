// electron-builder configuration, shared by the portable and the installer build.
// Used by scripts/dist.mjs; see docs/DESKTOP.md for the reasoning.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const NAME = 'OutOfShape-Lab'; // file-name friendly; the product name with a space is used for shortcuts

/**
 * @param {'portable'|'installer'} variant
 * @param {{outDir: string, editExecutable: boolean}} opts
 */
export function builderConfig(variant, { outDir, editExecutable }) {
  const artifact = (suffix) => `${NAME}-\${version}-win-\${arch}-${suffix}.\${ext}`;
  return {
    appId: 'com.outofshape.lab',
    productName: 'OutOfShape Lab',
    copyright: `Copyright © ${new Date().getFullYear()} ${pkg.author || 'OutOfShape'}`,
    directories: { output: outDir, buildResources: 'build' },
    // Only the static web build and the shell go into the app. All libraries are
    // already bundled into dist/ by Vite, so node_modules is left out completely.
    files: ['dist/**/*', 'electron/**/*', 'build/icon.ico', 'build/icon.png', 'package.json', '!node_modules/**/*'],
    asar: true,
    compression: 'normal',
    electronLanguages: ['en-US', 'de'], // drop ~40 unused Chromium locale packs
    // The portable folder/ZIP carries a marker next to the .exe (see electron/main.cjs).
    extraFiles: variant === 'portable' ? [{ from: 'build/portable.flag', to: 'portable.flag' }] : [],
    publish: null, // never upload from a local build

    win: {
      icon: 'build/icon.ico',
      // default name for targets without their own setting: the portable folder as ZIP
      artifactName: artifact('portable'),
      // false when cross-building without Wine: the .exe then keeps Electron's icon/version resource
      signAndEditExecutable: editExecutable,
      // ---- Code signing (prepared, not active) ---------------------------------------
      // Nothing is signed unless one of these is configured:
      //  a) certificate file: set the environment variables CSC_LINK (path or base64 of the
      //     .pfx/.p12) and CSC_KEY_PASSWORD before running `npm run dist`.
      //  b) certificate on a hardware token / in the Windows store:
      //     signtoolOptions: { certificateSubjectName: 'Your Company Name', signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'http://timestamp.digicert.com' },
      //  c) Azure Trusted Signing (cloud, no token):
      //     azureSignOptions: { publisherName: 'Your Company Name', endpoint: 'https://weu.codesigning.azure.net', certificateProfileName: '…', codeSigningAccountName: '…' },
      // To make an unsigned build fail instead of silently succeeding: forceCodeSigning: true
    },
    forceCodeSigning: false,

    // Single self-extracting .exe
    portable: { artifactName: artifact('portable') },

    nsis: {
      artifactName: artifact('setup'),
      oneClick: true, // no wizard pages: double-click, progress bar, app starts
      perMachine: false, // per-user install into %LOCALAPPDATA%\Programs: no admin rights, no UAC prompt
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: 'OutOfShape Lab',
      uninstallDisplayName: 'OutOfShape Lab ${version}',
      runAfterFinish: true,
      deleteAppDataOnUninstall: false, // uninstalling keeps documents and programs; see docs/DESKTOP.md
      installerIcon: 'build/icon.ico',
      uninstallerIcon: 'build/icon.ico',
    },
  };
}
