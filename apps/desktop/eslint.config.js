import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // Solid compiles constant style values into a style="" attribute on
      // the template, which the webview CSP blocks. Constant styling goes in
      // a class; only values computed at runtime belong in `style`.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='style'] > Literal",
          message:
            "Inline style attributes are blocked by the CSP; use a class.",
        },
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression > Property > Literal.value",
          message:
            "Constant style values become a style attribute the CSP blocks; move them to a class.",
        },
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "src-tauri/"],
  },
);
