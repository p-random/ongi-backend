// functions/eslint.config.cjs  (ESLint v9 Flat Config - CJS)
/* eslint-env node */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */


const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = [
  // 빌드 산출물/생성물 무시
  { ignores: ["lib/**", "generated/**"] },

  // JS 권장
  js.configs.recommended,

  // TS 권장 (메타 패키지)
  ...tseslint.configs.recommended,

  // 프로젝트 규칙
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: "module",
      },
    },
    rules: {
      // 윈도우 호환
      "linebreak-style": "off",

      // 스타일(완화)
      quotes: ["error", "double"],
      indent: ["error", 2],
      "max-len": ["warn", { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
      "object-curly-spacing": ["warn", "always"],
      "comma-dangle": ["warn", "always-multiline"],
      "arrow-parens": ["warn", "always"],
      "no-multi-spaces": "off",

      // JSDoc 강제 해제
      "valid-jsdoc": "off",
      "require-jsdoc": "off",
    },
  },
];
