"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaceScript = replaceScript;
exports.replaceCss = replaceCss;
exports.viteSingleFile = viteSingleFile;
const micromatch_1 = __importDefault(require("micromatch"));
const defaultConfig = { useRecommendedBuildConfig: true, removeViteModuleLoader: false, deleteInlinedFiles: true };
function replaceScript(html, scriptFilename, scriptCode, removeViteModuleLoader = false) {
    const f = scriptFilename.replaceAll(".", "\\.");
    const reScript = new RegExp(`<script([^>]*?) src="(?:[^"]*?/)?${f}"([^>]*)></script>`);
    const preloadMarker = /"?__VITE_PRELOAD__"?/g;
    const newCode = scriptCode.replace(preloadMarker, "void 0").replace(/<(\/script>|!--)/g, "\\x3C$1");
    const inlined = html.replace(reScript, (_, beforeSrc, afterSrc) => `<script${beforeSrc}${afterSrc}>${newCode.trim()}</script>`);
    return removeViteModuleLoader ? _removeViteModuleLoader(inlined) : inlined;
}
function replaceCss(html, scriptFilename, scriptCode) {
    const f = scriptFilename.replaceAll(".", "\\.");
    const reStyle = new RegExp(`<link([^>]*?) href="(?:[^"]*?/)?${f}"([^>]*)>`);
    const newCode = scriptCode.replace(`@charset "UTF-8";`, "");
    const inlined = html.replace(reStyle, (_, beforeSrc, afterSrc) => `<style${beforeSrc}${afterSrc}>${newCode.trim()}</style>`);
    return inlined;
}
const isJsFile = /\.[mc]?js$/;
const isCssFile = /\.css$/;
const isHtmlFile = /\.html?$/;
function viteSingleFile({ useRecommendedBuildConfig = true, removeViteModuleLoader = false, inlinePattern = [], deleteInlinedFiles = true, overrideConfig = {}, } = defaultConfig) {
    // Modifies the Vite build config to make this plugin work well.
    const _useRecommendedBuildConfig = (config) => {
        if (!config.build)
            config.build = {};
        // Ensures that even very large assets are inlined in your JavaScript.
        config.build.assetsInlineLimit = () => true;
        // Avoid warnings about large chunks.
        config.build.chunkSizeWarningLimit = 100000000;
        // Emit all CSS as a single file, which `vite-plugin-singlefile` can then inline.
        config.build.cssCodeSplit = false;
        // We need relative path to support any static files in public folder,
        // which are copied to ${build.outDir} by vite.
        config.base = "./";
        // Make generated files in ${build.outDir}'s root, instead of default ${build.outDir}/assets.
        // Then the embedded resources can be loaded by relative path.
        config.build.assetsDir = "";
        if (!config.build.rollupOptions)
            config.build.rollupOptions = {};
        if (!config.build.rollupOptions.output)
            config.build.rollupOptions.output = {};
        const updateOutputOptions = (out) => {
            // Ensure that as many resources as possible are inlined.
            out.inlineDynamicImports = true;
        };
        if (Array.isArray(config.build.rollupOptions.output)) {
            for (const o of config.build.rollupOptions.output)
                updateOutputOptions(o);
        }
        else {
            updateOutputOptions(config.build.rollupOptions.output);
        }
        Object.assign(config, overrideConfig);
    };
    return {
        name: "vite:singlefile",
        config: useRecommendedBuildConfig ? _useRecommendedBuildConfig : undefined,
        enforce: "post",
        generateBundle(_, bundle) {
            const warnNotInlined = (filename) => this.info(`NOTE: asset not inlined: ${filename}`);
            this.info("\n");
            const files = {
                html: [],
                css: [],
                js: [],
                other: [],
            };
            for (const i of Object.keys(bundle)) {
                if (isHtmlFile.test(i)) {
                    files.html.push(i);
                }
                else if (isCssFile.test(i)) {
                    files.css.push(i);
                }
                else if (isJsFile.test(i)) {
                    files.js.push(i);
                }
                else {
                    files.other.push(i);
                }
            }
            const bundlesToDelete = [];
            for (const name of files.html) {
                const htmlChunk = bundle[name];
                let replacedHtml = htmlChunk.source;
                for (const filename of files.js) {
                    if (inlinePattern.length && !micromatch_1.default.isMatch(filename, inlinePattern)) {
                        warnNotInlined(filename);
                        continue;
                    }
                    const jsChunk = bundle[filename];
                    if (jsChunk.code != null) {
                        this.info(`Inlining: ${filename}`);
                        bundlesToDelete.push(filename);
                        replacedHtml = replaceScript(replacedHtml, jsChunk.fileName, jsChunk.code, removeViteModuleLoader);
                    }
                }
                for (const filename of files.css) {
                    if (inlinePattern.length && !micromatch_1.default.isMatch(filename, inlinePattern)) {
                        warnNotInlined(filename);
                        continue;
                    }
                    const cssChunk = bundle[filename];
                    this.info(`Inlining: ${filename}`);
                    bundlesToDelete.push(filename);
                    replacedHtml = replaceCss(replacedHtml, cssChunk.fileName, cssChunk.source);
                }
                htmlChunk.source = replacedHtml;
            }
            if (deleteInlinedFiles) {
                for (const name of bundlesToDelete) {
                    delete bundle[name];
                }
            }
            for (const name of files.other) {
                warnNotInlined(name);
            }
        },
    };
}
// Optionally remove the Vite module loader since it's no longer needed because this plugin has inlined all code.
// This assumes that the Module Loader is (1) the FIRST function declared in the module, (2) an IIFE, (4) is within
// a script with no unexpected attribute values, and (5) that the containing script is the first script tag that
// matches the above criteria. Changes to the SCRIPT tag especially could break this again in the future. It should
// work whether `minify` is enabled or not.
// Update example:
// https://github.com/richardtallent/vite-plugin-singlefile/issues/57#issuecomment-1263950209
const _removeViteModuleLoader = (html) => html.replace(/(<script type="module" crossorigin>\s*)\(function(?: polyfill)?\(\)\s*\{[\s\S]*?\}\)\(\);/, '<script type="module">');
