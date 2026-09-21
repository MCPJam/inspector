---
"@mcpjam/inspector": patch
---

Desktop: fix an Update button that stopped working ten minutes after the update finished downloading. The app kept checking for updates even with a build already staged, and that extra check made Electron forget the staged build — after which clicking Update did nothing at all and quitting the app was refused, leaving the only way out a reinstall. The app now stops checking once a build is staged, always lets you quit, and if the staged build has gone missing a single click restarts the app, downloads it again and installs it.
