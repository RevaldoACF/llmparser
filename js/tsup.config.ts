import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    toolParser: "src/toolParser.ts",
    "react/useLLMStream": "src/react/useLLMStream.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  external: ["react"],
});
