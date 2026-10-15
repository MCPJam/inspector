---
"@mcpjam/sdk": minor
---

Plugin file sources can report POSIX `mode` bits, and the Node directory and ZIP sources now do; a ZIP entry whose mode marks it as a symbolic link, or as any other type that is neither a regular file nor a directory, is reported as a link, which the parser rejects, rather than as an executable file. `parsePluginBundle` lists the files that carry an executable bit (`executableFiles`; special bits are never kept), records the parser revision it applied (`interpretation.revision`, from the new `PLUGIN_PARSER_REVISIONS`), and returns an `executionDigest` over the bundle hash, the executable files, and the profile and revision. Two parses with the same digest can share a stored version and a runtime cache entry; different executable bits or a different interpretation of the same bytes cannot, while ZIP timestamps and compression do not matter. `bundleHash` keeps its meaning.
