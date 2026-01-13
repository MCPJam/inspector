# vite-plugin-singlefile

This Vite build plugin allows you to _inline_ all JavaScript and CSS resources directly into the final `dist/index.html` file. By doing this, your _entire web app_ can be embedded and distributed as a single HTML file.

## Why?

Bundling your _entire_ site into one file **isn't recommended for most situations**.

In particular, this is not a good idea, performance-wise, for hosting a site on a normal web server.

However, this can be _very_ handy for _offline_ web applications-- apps bundled into a single HTML file that you can double-click and open directly in your web browser, no server needed. This might include utilities, expert system tools, documentation, demos, and other situations where you want the full power of a web browser, without the need for a Cordova or Electron wrapper or the pain of normal application installation.

**This is a _single file_ plugin. As in, it creates _one HTML file_ and _no other files_. Hence the name. So, this either _will not work_ or _will not be optimized for_ apps that require multiple "entry points" (HTML files). Please see issue #51 for details. Issues opened requesting multiple entry points will be closed as `wontfix`.**

## What does work when running an HTML file locally

Local HTML files are now for most purposes considered to be a "secure context" and thus now have far more capabilities than when this project started, which is good!

You can use:

- `localStorage`
- Newer experimental Persistent Storage APIs
- FileSystem API
- Requests for _local files_ relative to the same folder (_i.e._, for Vue, resources from your `public` folder)
- Requests for images from external web sites
- Requests for fonts from external web sites
- Requests to external APIs (requires `{ mode: 'no-cors'}` in your `fetch` call)
- Following links to other files relative to the same folder
- SPA hash-based routing
- WebXR

_I've only tested some of the above in Chromium-based browsers. YMMV for WebKit and other browser engines. Some may require explicit user permission._

## What doesn't work

- SPA routing via Web History API
- Cookies (passed via HTTP headers, which don't exist for `file:///` URIs)
- WebXR Immersive Mode (theoretically could work, but not currently supported)
- Worklets (theoretically could work, but not currently supported)
- Sourcemaps (useless, since inlining happens after they are generated)

## Installation

```shell
npm install vite-plugin-singlefile --save-dev
```

or

```shell
yarn add vite-plugin-singlefile --dev
```

## How do I use it?

Here's an example `vite.config.ts` file using this plugin for a Vue.js app:

```ts
import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import { viteSingleFile } from "vite-plugin-singlefile"

export default defineConfig({
	plugins: [vue(), viteSingleFile()],
})
```

### Config

You can pass a configuration object to modify how this plugin works. The options are described below:

### useRecommendedBuildConfig

Defaults to `true`. This plugin will automatically adjust your vite configuration to allow assets to
be combined into a single file. To disable this:

```ts
viteSingleFile({ useRecommendedBuildConfig: false })
```

Refer to the `_useRecommendedBuildConfig` function in the `index.ts` file of this repository to see the
recommended configuration.

### removeViteModuleLoader

Defaults to `false`. Vite includes a function in your build to load other bundles. Since we're inlining
all bundles, you can use this option to have the bundle-loading function removed from your final build:

```ts
viteSingleFile({ removeViteModuleLoader: true })
```

### inlinePattern

Defaults to `[]`, which will inline all recognized JavaScript and CSS assets. You can provide a string
array of "glob" patterns to limit the inlining to certain assets. Any assets missed by your patterns will
generate a warning (same as any unrecognized assets).

### deleteInlinedFiles

Defaults to `true`, which deletes all inlined files that were inlined. A use case for turning this to `false` would be if you would like sourcemaps to be generated so you can upload them to an error tracking platform like Sentry.io.

### overrideConfig

The recommended configuration really is recommended, but if you need to tweak something it is doing, you can put your own partial rollup configuration in this object to override this plugin's defaults. For example, the default base URL for public non-inlined files is "./", but if you need it to be absolute, you can use `overrideConfig: { base: "/" }` to set it.

### Caveats

- Static resources in `public` folder (like `favicon`) are not inlined by Vite, and this plugin doesn't do that either. BUT the output single HTML file CAN work together with these resouces, using relative paths.
- Inlining of SVG isn't supported directly by Vite, so it isn't supported directly here either. You'll need to use something like `https://github.com/jpkleemans/vite-svg-loader`, or put your SVG directly into the template.
- There may be other situations where referenced files aren't inlined by Vite and aren't caught by this plugin either.
- This is my first Vite and first Rollup plugin. I have no idea what I'm doing. PRs welcome.
- This plugin uses dual packages to support both ESM and CommonJS users. This _should_ work automatically. Details:
  - <https://nodejs.org/api/packages.html#packages_dual_package_hazard>
  - <https://www.sensedeep.com/blog/posts/2021/how-to-create-single-source-npm-module.html>

## Contributing

- Please have PrettierJS installed so your IDE formatting doesn't overwrite the formatting in the source files
- Please clone [vite-plugin-singlefile-example](https://github.com/richardtallent/vite-plugin-singlefile-example) in a sister folder and use it to test your modifications to this plugin before submitting a PR. (I'm happy to take PRs for it as well if you want to add more edge cases to test, such as a large third-party dependency. It's pretty barebones for now.)
- I wasn't able to persuade Jest to run on the bare source file, so it instead compiles and runs the CommonJS distribution file.

## License

MIT
