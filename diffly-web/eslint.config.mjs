import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    ignores: ["src/wasm/pkg/**"],
  },
  ...nextVitals,
];

export default config;
